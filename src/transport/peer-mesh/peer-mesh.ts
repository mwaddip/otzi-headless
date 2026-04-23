/**
 * `PeerMeshTransport` — real-network implementation of the `Transport`
 * interface over long-lived WebSocket connections, one per peer pair.
 *
 * Role convention: the peer with the lower partyId dials; the higher
 * partyId listens. Connections carry the Noise-KK handshake + AES-GCM
 * record layer wired through `PeerConnection`.
 *
 * Reconnect: initiator side redials on disconnect with exponential
 * backoff (1s → 2s → 4s → 8s → cap 10s). Responder side waits for peer
 * to reconnect — responder has no way to initiate.
 *
 * Pull: correlates request/response by `requestId`. If the target peer
 * isn't currently connected, `pull` returns `null` (treated as "blob not
 * yet available" — caller's retry + deadline takes over). `pull` throws
 * only when `key.from` isn't in the peer list (config-level error).
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { BlobKey, PartyId, Unsubscribe } from '../../core/types';
import type { Transport } from '../../core/transport';
import type { IdentityKeyPair } from '../identity';
import { PeerConnection } from './connection';
import {
  broadcastBytes,
  encodeBroadcast,
  encodePullRequest,
  encodePullResponse,
  pullRequestKey,
  pullResponseBlob,
  type AppMessage,
} from './wire';
import { NOOP_LOGGER, type Logger } from '../../orchestrator/types';

export interface PeerMeshPeer {
  partyId: PartyId;
  /** 65-byte uncompressed P-256 pubkey from the pubkey book. */
  publicKey: Uint8Array;
  /** `ws://host:port` or `wss://...`. Only required when we dial (i.e. when our partyId is lower). */
  endpoint?: string;
}

export interface PeerMeshOptions {
  self: { partyId: PartyId; identity: IdentityKeyPair };
  /** "host:port" for our WebSocket server. Pass "127.0.0.1:0" in tests to get an ephemeral port. */
  listen: string;
  peers: ReadonlyArray<PeerMeshPeer>;
  /** Defaults to the `ws` library's stock WebSocket (Node). Tests can inject a mock. */
  wsCtor?: typeof WebSocket;
  logger?: Logger;
  /** Pull request timeout. Defaults to 30s. */
  pullTimeoutMs?: number;
}

interface PeerState {
  partyId: PartyId;
  publicKey: Uint8Array;
  endpoint: string | null;
  role: 'initiator' | 'responder';
  connection: PeerConnection | null;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
}

interface PendingPull {
  resolve: (blob: Uint8Array | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_CAP_MS = 10_000;
const DEFAULT_PULL_TIMEOUT_MS = 30_000;

export class PeerMeshTransport implements Transport {
  readonly partyId: PartyId;
  readonly peers: readonly PartyId[];

  private readonly self: { partyId: PartyId; identity: IdentityKeyPair };
  private readonly peerStates = new Map<PartyId, PeerState>();
  private readonly broadcastHandlers = new Set<(from: PartyId, msg: Uint8Array) => void>();
  private pullHandler: ((from: PartyId, key: BlobKey) => Uint8Array | null) | null = null;
  private readonly pendingPulls = new Map<string, PendingPull>();
  private server: WebSocketServer | null = null;
  private readonly listenHost: string;
  private readonly listenPort: number;
  private readonly wsCtor: typeof WebSocket;
  private readonly log: Logger;
  private readonly pullTimeoutMs: number;
  private stopped = false;

  constructor(options: PeerMeshOptions) {
    this.self = options.self;
    this.partyId = options.self.partyId;
    this.peers = options.peers.map((p) => p.partyId);
    this.wsCtor = options.wsCtor ?? WebSocket;
    this.log = options.logger ?? NOOP_LOGGER;
    this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;

    const parsed = parseBind(options.listen);
    this.listenHost = parsed.host;
    this.listenPort = parsed.port;

    for (const peer of options.peers) {
      if (peer.partyId === this.partyId)
        throw new Error(`PeerMeshTransport: peer list includes self (partyId ${peer.partyId})`);
      const role = peer.partyId > this.partyId ? 'initiator' : 'responder';
      if (role === 'initiator' && !peer.endpoint)
        throw new Error(
          `PeerMeshTransport: peer partyId=${peer.partyId} is higher than self — endpoint required to dial`,
        );
      this.peerStates.set(peer.partyId, {
        partyId: peer.partyId,
        publicKey: peer.publicKey,
        endpoint: peer.endpoint ?? null,
        role,
        connection: null,
        reconnectAttempt: 0,
        reconnectTimer: null,
      });
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = new WebSocketServer({ host: this.listenHost, port: this.listenPort });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
    });
    this.server = server;
    server.on('connection', (ws) => {
      void this.handleInbound(ws);
    });
    server.on('error', (err) => {
      this.log.warn('peer-mesh: server error', { err: errMsg(err) });
    });

    // Kick off initiator-side dials.
    for (const peer of this.peerStates.values()) {
      if (peer.role === 'initiator') void this.dialPeer(peer);
    }

    this.log.info('peer-mesh: started', { partyId: this.partyId, listen: this.address() });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    for (const peer of this.peerStates.values()) {
      if (peer.reconnectTimer) {
        clearTimeout(peer.reconnectTimer);
        peer.reconnectTimer = null;
      }
      if (peer.connection) {
        await peer.connection.close().catch(() => {});
        peer.connection = null;
      }
    }
    for (const pending of this.pendingPulls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('peer-mesh: transport stopping'));
    }
    this.pendingPulls.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.log.info('peer-mesh: stopped');
  }

  address(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Transport interface
  // ─────────────────────────────────────────────────────────────────────

  async broadcast(msg: Uint8Array): Promise<void> {
    const packet = encodeBroadcast(msg);
    await Promise.all(
      [...this.peerStates.values()].map(async (peer) => {
        if (!peer.connection) return; // silently skip offline peers
        try {
          // Re-parse packet as AppMessage for typed send API.
          await peer.connection.send({
            kind: 'broadcast',
            msgB64: bytesToBase64(msg),
          });
        } catch (err) {
          this.log.warn('peer-mesh: broadcast failed for peer', {
            peerPartyId: peer.partyId,
            err: errMsg(err),
          });
        }
      }),
    );
  }

  onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void): Unsubscribe {
    this.broadcastHandlers.add(handler);
    return () => {
      this.broadcastHandlers.delete(handler);
    };
  }

  async pull(key: BlobKey): Promise<Uint8Array | null> {
    const peer = this.peerStates.get(key.from);
    if (!peer) throw new Error(`peer-mesh: pull target partyId=${key.from} is not in the ring`);
    if (!peer.connection) return null; // peer offline — treat as "not yet available"

    const requestId = randomId();
    const result = new Promise<Uint8Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPulls.delete(requestId);
        // Timeout is transient — BlobPuller's retry loop handles it. Do NOT
        // throw; that would abort the whole ceremony on one unlucky pull.
        resolve(null);
      }, this.pullTimeoutMs);
      this.pendingPulls.set(requestId, { resolve, reject, timer });
    });

    try {
      await peer.connection.send({
        kind: 'pull-req',
        requestId,
        ceremonyId: key.ceremonyId,
        round: key.round,
        from: key.from,
        to: key.to,
      });
    } catch (err) {
      const pending = this.pendingPulls.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPulls.delete(requestId);
      }
      throw new Error(`peer-mesh: pull send failed: ${errMsg(err)}`);
    }

    return result;
  }

  servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe {
    if (this.pullHandler)
      throw new Error('peer-mesh: servePulls handler already registered');
    this.pullHandler = handler;
    return () => {
      this.pullHandler = null;
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internal — connection lifecycle
  // ─────────────────────────────────────────────────────────────────────

  private async dialPeer(peer: PeerState): Promise<void> {
    if (this.stopped) return;
    if (!peer.endpoint) return;
    try {
      const conn = await PeerConnection.dial({
        me: { partyId: this.self.partyId, identity: this.self.identity },
        peerPartyId: peer.partyId,
        peerPublicKey: peer.publicKey,
        url: peer.endpoint,
        wsCtor: this.wsCtor,
      });
      this.attachConnection(peer, conn);
    } catch (err) {
      this.log.warn('peer-mesh: dial failed', { peerPartyId: peer.partyId, err: errMsg(err) });
      this.scheduleReconnect(peer);
    }
  }

  private async handleInbound(ws: WebSocket): Promise<void> {
    if (this.stopped) {
      ws.close();
      return;
    }
    try {
      const conn = await PeerConnection.acceptInbound({
        me: { partyId: this.self.partyId, identity: this.self.identity },
        ws,
        resolvePublicKey: (partyId) => {
          const peer = this.peerStates.get(partyId);
          return peer ? peer.publicKey : null;
        },
      });
      const peer = this.peerStates.get(conn.peerPartyId);
      if (!peer) {
        await conn.close();
        this.log.warn('peer-mesh: inbound from unknown peer', { partyId: conn.peerPartyId });
        return;
      }
      if (peer.role !== 'responder') {
        // Unexpected — the lower-partyId side should dial, not listen.
        await conn.close();
        this.log.warn('peer-mesh: inbound from a peer we should be dialing', {
          partyId: conn.peerPartyId,
        });
        return;
      }
      this.attachConnection(peer, conn);
    } catch (err) {
      this.log.warn('peer-mesh: inbound handshake failed', { err: errMsg(err) });
      ws.close();
    }
  }

  private attachConnection(peer: PeerState, conn: PeerConnection): void {
    // If an older connection exists (race), close it.
    if (peer.connection) {
      void peer.connection.close().catch(() => {});
    }
    peer.connection = conn;
    peer.reconnectAttempt = 0;
    if (peer.reconnectTimer) {
      clearTimeout(peer.reconnectTimer);
      peer.reconnectTimer = null;
    }

    conn.onMessage((msg) => {
      this.handleAppMessage(peer, msg);
    });
    conn.onClose(() => {
      if (peer.connection === conn) {
        this.log.warn('peer-mesh: peer connection closed', { peerPartyId: peer.partyId });
        peer.connection = null;
        if (peer.role === 'initiator' && !this.stopped) this.scheduleReconnect(peer);
      }
    });

    this.log.info('peer-mesh: peer connected', {
      peerPartyId: peer.partyId,
      role: peer.role,
    });
  }

  private scheduleReconnect(peer: PeerState): void {
    if (this.stopped || peer.role !== 'initiator') return;
    peer.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_INITIAL_MS * 2 ** (peer.reconnectAttempt - 1),
      RECONNECT_CAP_MS,
    );
    peer.reconnectTimer = setTimeout(() => {
      peer.reconnectTimer = null;
      void this.dialPeer(peer);
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internal — message dispatch
  // ─────────────────────────────────────────────────────────────────────

  private handleAppMessage(peer: PeerState, msg: AppMessage): void {
    switch (msg.kind) {
      case 'broadcast': {
        const payload = broadcastBytes(msg);
        for (const h of this.broadcastHandlers) h(peer.partyId, payload);
        return;
      }
      case 'pull-req': {
        const key = pullRequestKey(msg);
        const blob = this.pullHandler ? this.pullHandler(peer.partyId, key) : null;
        if (!peer.connection) return;
        // best-effort response; failures are logged (recipient will time out their pull)
        peer.connection
          .send({
            kind: 'pull-resp',
            requestId: msg.requestId,
            blobB64: blob === null ? null : bytesToBase64(blob),
          })
          .catch((err) =>
            this.log.warn('peer-mesh: pull-resp send failed', {
              peerPartyId: peer.partyId,
              err: errMsg(err),
            }),
          );
        return;
      }
      case 'pull-resp': {
        const pending = this.pendingPulls.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingPulls.delete(msg.requestId);
        pending.resolve(pullResponseBlob(msg));
        return;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function parseBind(bind: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(bind);
  if (!m) throw new Error(`PeerMeshTransport: invalid listen '${bind}' — expected 'host:port'`);
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`PeerMeshTransport: invalid listen port '${m[2]}'`);
  if (host.length === 0) throw new Error(`PeerMeshTransport: listen host required`);
  return { host, port };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
