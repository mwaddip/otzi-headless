/**
 * `RelayTransport` — the `Transport` interface over a shared relay server.
 *
 * One WebSocket per daemon goes to the relay. The relay routes frames between
 * peers by `partyId`. On top of that routing, each peer pair runs its own
 * Noise-KK handshake (phase 3b) and AES-GCM record session (3a), just like
 * peer-mesh — the relay never sees plaintext.
 *
 * Role convention matches peer-mesh: lower partyId initiates. But instead of
 * dialing a peer directly, the initiator sends its handshake-1 as a `frame`
 * to the relay, targeted at the higher-partyId peer; the responder receives
 * it as `incoming` from the relay.
 *
 * Peer state discovery: when a daemon connects, the relay answers `hello`
 * with an `ack { roster }` listing currently-connected peers. Subsequent
 * `peer-joined` / `peer-left` events push roster changes. Initiators start
 * their handshake when the roster learns of a higher-partyId peer.
 */

import { WebSocket } from 'ws';
import type { BlobKey, PartyId, Unsubscribe } from '../../core/types';
import type { Transport } from '../../core/transport';
import type { IdentityKeyPair } from '../identity';
import {
  initiatorBegin,
  initiatorFinish,
  responderRespond,
  type InitiatorState,
} from '../handshake';
import { RecordSession } from '../record';
import {
  broadcastBytes,
  encodeBroadcast,
  encodePullRequest,
  encodePullResponse,
  parseAppMessage,
  pullRequestKey,
  pullResponseBlob,
  type AppMessage,
} from '../peer-mesh/wire';
import { NOOP_LOGGER, type Logger } from '../../orchestrator/types';
import { fromHex, toHex } from '../../wire/hex';
import {
  encodeClientMsg,
  parseServerMsg,
  type RelayClientMsg,
  type RelayServerMsg,
} from './wire';

export interface RelayTransportPeer {
  partyId: PartyId;
  publicKey: Uint8Array;
}

export interface RelayTransportOptions {
  self: { partyId: PartyId; identity: IdentityKeyPair };
  relayUrl: string;
  /** Shared ring identifier — derived from the pubkey book so all peers agree. */
  ringId: string;
  peers: ReadonlyArray<RelayTransportPeer>;
  wsCtor?: typeof WebSocket;
  pullTimeoutMs?: number;
  logger?: Logger;
}

type PeerStatus = 'disconnected' | 'waiting-for-hs1' | 'waiting-for-hs2' | 'connected';

interface PeerState {
  partyId: PartyId;
  publicKey: Uint8Array;
  role: 'initiator' | 'responder';
  status: PeerStatus;
  session: RecordSession | null;
  initiatorState: InitiatorState | null;
  /**
   * Per-peer FIFO queue of raw payloads awaiting dispatch. `processing` guards
   * against interleaving state transitions — if a second message arrives while
   * the first is still inside `completeInitiatorHandshake` / etc., the second
   * waits until the first finishes rather than racing against stale state.
   */
  pending: Uint8Array[];
  processing: boolean;
}

interface PendingPull {
  resolve: (blob: Uint8Array | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_PULL_TIMEOUT_MS = 30_000;

export class RelayTransport implements Transport {
  readonly partyId: PartyId;
  readonly peers: readonly PartyId[];

  private readonly self: { partyId: PartyId; identity: IdentityKeyPair };
  private readonly relayUrl: string;
  private readonly ringId: string;
  private readonly peerStates = new Map<PartyId, PeerState>();
  private readonly broadcastHandlers = new Set<(from: PartyId, msg: Uint8Array) => void>();
  private pullHandler: ((from: PartyId, key: BlobKey) => Uint8Array | null) | null = null;
  private readonly pendingPulls = new Map<string, PendingPull>();
  private ws: WebSocket | null = null;
  private readonly wsCtor: typeof WebSocket;
  private readonly log: Logger;
  private readonly pullTimeoutMs: number;
  private stopped = false;

  constructor(options: RelayTransportOptions) {
    this.self = options.self;
    this.partyId = options.self.partyId;
    this.peers = options.peers.map((p) => p.partyId);
    this.relayUrl = options.relayUrl;
    this.ringId = options.ringId;
    this.wsCtor = options.wsCtor ?? WebSocket;
    this.log = options.logger ?? NOOP_LOGGER;
    this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;

    for (const peer of options.peers) {
      if (peer.partyId === this.partyId)
        throw new Error(`RelayTransport: peer list includes self (partyId ${peer.partyId})`);
      this.peerStates.set(peer.partyId, {
        partyId: peer.partyId,
        publicKey: peer.publicKey,
        role: peer.partyId > this.partyId ? 'initiator' : 'responder',
        status: 'disconnected',
        session: null,
        initiatorState: null,
        pending: [],
        processing: false,
      });
    }
  }

  async start(): Promise<void> {
    if (this.ws) return;
    const ws = new this.wsCtor(this.relayUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      const onOpen = () => {
        ws.off('error', onError);
        resolve();
      };
      ws.once('error', onError);
      ws.once('open', onOpen);
    });

    ws.on('message', (data) => {
      void this.onRelayMessage(data);
    });
    ws.on('close', () => this.handleRelayClose());
    ws.on('error', () => this.handleRelayClose());

    await this.sendToRelay({
      kind: 'hello',
      ringId: this.ringId,
      partyId: this.self.partyId,
    });

    this.log.info('relay-transport: started', { ringId: this.ringId, partyId: this.self.partyId });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pendingPulls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('relay-transport: stopping'));
    }
    this.pendingPulls.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    for (const peer of this.peerStates.values()) {
      peer.status = 'disconnected';
      peer.session = null;
      peer.initiatorState = null;
    }
    this.log.info('relay-transport: stopped');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Transport interface
  // ─────────────────────────────────────────────────────────────────────

  async broadcast(msg: Uint8Array): Promise<void> {
    // Fan-out: each peer gets its own AES-GCM seal (each session has distinct keys).
    await Promise.all(
      [...this.peerStates.values()].map(async (peer) => {
        if (peer.status !== 'connected' || !peer.session) return;
        try {
          const appMessage = encodeBroadcast(msg);
          const ct = await peer.session.seal(appMessage);
          await this.sendFrame(peer.partyId, ct);
        } catch (err) {
          this.log.warn('relay-transport: broadcast seal/send failed', {
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
    if (!peer) throw new Error(`relay-transport: pull target partyId=${key.from} is not in the ring`);
    if (peer.status !== 'connected' || !peer.session) return null;

    const requestId = randomId();
    const result = new Promise<Uint8Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPulls.delete(requestId);
        // Timeout is transient — BlobPuller's retry loop handles it.
        resolve(null);
      }, this.pullTimeoutMs);
      this.pendingPulls.set(requestId, { resolve, reject, timer });
    });

    try {
      const appMessage = encodePullRequest(requestId, key);
      const ct = await peer.session.seal(appMessage);
      await this.sendFrame(peer.partyId, ct);
    } catch (err) {
      const pending = this.pendingPulls.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPulls.delete(requestId);
      }
      throw new Error(`relay-transport: pull send failed: ${errMsg(err)}`);
    }

    return result;
  }

  servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe {
    if (this.pullHandler) throw new Error('relay-transport: servePulls handler already registered');
    this.pullHandler = handler;
    return () => {
      this.pullHandler = null;
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Relay message dispatch
  // ─────────────────────────────────────────────────────────────────────

  private async onRelayMessage(data: unknown): Promise<void> {
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
    const msg = parseServerMsg(text);
    if (!msg) {
      this.log.warn('relay-transport: malformed server message');
      return;
    }
    switch (msg.kind) {
      case 'ack':
        await this.onAck(msg.roster);
        return;
      case 'peer-joined':
        await this.onPeerJoined(msg.partyId);
        return;
      case 'peer-left':
        this.onPeerLeft(msg.partyId);
        return;
      case 'incoming':
        await this.onIncoming(msg.from, fromHex(msg.payloadHex));
        return;
      case 'error':
        this.log.warn('relay-transport: relay error', { message: msg.message });
        return;
    }
  }

  private async onAck(roster: PartyId[]): Promise<void> {
    for (const partyId of roster) {
      const peer = this.peerStates.get(partyId);
      if (!peer) continue;
      if (peer.role === 'initiator') void this.startInitiatorHandshake(peer);
      else peer.status = 'waiting-for-hs1';
    }
  }

  private async onPeerJoined(partyId: PartyId): Promise<void> {
    const peer = this.peerStates.get(partyId);
    if (!peer) return;
    if (peer.role === 'initiator') void this.startInitiatorHandshake(peer);
    else peer.status = 'waiting-for-hs1';
  }

  private onPeerLeft(partyId: PartyId): void {
    const peer = this.peerStates.get(partyId);
    if (!peer) return;
    peer.status = 'disconnected';
    peer.session = null;
    peer.initiatorState = null;
    peer.pending.length = 0;
    this.log.info('relay-transport: peer left', { partyId });
  }

  private async onIncoming(from: PartyId, payload: Uint8Array): Promise<void> {
    const peer = this.peerStates.get(from);
    if (!peer) {
      this.log.warn('relay-transport: incoming from unknown partyId', { from });
      return;
    }
    peer.pending.push(payload);
    if (peer.processing) return;
    peer.processing = true;
    try {
      while (peer.pending.length > 0) {
        const next = peer.pending.shift()!;
        await this.dispatchIncoming(peer, next);
      }
    } finally {
      peer.processing = false;
    }
  }

  private async dispatchIncoming(peer: PeerState, payload: Uint8Array): Promise<void> {
    if (peer.status === 'waiting-for-hs1') {
      await this.completeResponderHandshake(peer, payload);
      return;
    }
    if (peer.status === 'waiting-for-hs2') {
      await this.completeInitiatorHandshake(peer, payload);
      return;
    }
    if (peer.status === 'connected' && peer.session) {
      await this.handleConnectedIncoming(peer, payload);
      return;
    }
    this.log.warn('relay-transport: incoming in unexpected state', {
      from: peer.partyId,
      status: peer.status,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Handshake
  // ─────────────────────────────────────────────────────────────────────

  private async startInitiatorHandshake(peer: PeerState): Promise<void> {
    if (peer.status !== 'disconnected') return;
    try {
      const { state, message1 } = await initiatorBegin(this.self.identity);
      peer.initiatorState = state;
      peer.status = 'waiting-for-hs2';
      await this.sendFrame(peer.partyId, message1);
      this.log.info('relay-transport: sent hs1', { peerPartyId: peer.partyId });
    } catch (err) {
      this.log.warn('relay-transport: initiator handshake start failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      });
      peer.status = 'disconnected';
      peer.initiatorState = null;
    }
  }

  private async completeInitiatorHandshake(peer: PeerState, message2: Uint8Array): Promise<void> {
    if (!peer.initiatorState) {
      peer.status = 'disconnected';
      return;
    }
    try {
      const secrets = await initiatorFinish(peer.initiatorState, message2, peer.publicKey);
      peer.session = await RecordSession.create(secrets);
      peer.status = 'connected';
      peer.initiatorState = null;
      this.log.info('relay-transport: handshake complete (initiator)', { peerPartyId: peer.partyId });
    } catch (err) {
      this.log.warn('relay-transport: initiator finish failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      });
      peer.status = 'disconnected';
      peer.initiatorState = null;
    }
  }

  private async completeResponderHandshake(peer: PeerState, message1: Uint8Array): Promise<void> {
    try {
      const { message2, secrets } = await responderRespond(
        this.self.identity,
        message1,
        peer.publicKey,
      );
      peer.session = await RecordSession.create(secrets);
      peer.status = 'connected';
      await this.sendFrame(peer.partyId, message2);
      this.log.info('relay-transport: handshake complete (responder)', { peerPartyId: peer.partyId });
    } catch (err) {
      this.log.warn('relay-transport: responder handshake failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      });
      peer.status = 'disconnected';
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Connected traffic
  // ─────────────────────────────────────────────────────────────────────

  private async handleConnectedIncoming(peer: PeerState, ciphertext: Uint8Array): Promise<void> {
    if (!peer.session) return;
    let plaintext: Uint8Array;
    try {
      plaintext = await peer.session.open(ciphertext);
    } catch {
      this.log.warn('relay-transport: record auth failed; tearing down peer', {
        peerPartyId: peer.partyId,
      });
      peer.status = 'disconnected';
      peer.session = null;
      return;
    }
    const msg = parseAppMessage(plaintext);
    if (!msg) {
      this.log.warn('relay-transport: malformed app message', { peerPartyId: peer.partyId });
      return;
    }
    this.dispatchAppMessage(peer, msg);
  }

  private dispatchAppMessage(peer: PeerState, msg: AppMessage): void {
    switch (msg.kind) {
      case 'broadcast': {
        const bytes = broadcastBytes(msg);
        for (const h of this.broadcastHandlers) h(peer.partyId, bytes);
        return;
      }
      case 'pull-req': {
        const key = pullRequestKey(msg);
        const blob = this.pullHandler ? this.pullHandler(peer.partyId, key) : null;
        void this.sendAppMessage(peer, encodePullResponse(msg.requestId, blob)).catch((err) =>
          this.log.warn('relay-transport: pull-resp send failed', {
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

  private async sendAppMessage(peer: PeerState, appBytes: Uint8Array): Promise<void> {
    if (!peer.session || peer.status !== 'connected')
      throw new Error(`relay-transport: peer ${peer.partyId} not connected`);
    const ct = await peer.session.seal(appBytes);
    await this.sendFrame(peer.partyId, ct);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Relay-level IO
  // ─────────────────────────────────────────────────────────────────────

  private async sendFrame(to: PartyId, payload: Uint8Array): Promise<void> {
    await this.sendToRelay({ kind: 'frame', to, payloadHex: toHex(payload) });
  }

  private async sendToRelay(msg: RelayClientMsg): Promise<void> {
    const ws = this.ws;
    if (!ws) throw new Error('relay-transport: not started');
    await new Promise<void>((resolve, reject) => {
      ws.send(encodeClientMsg(msg), (err) => (err ? reject(err) : resolve()));
    });
  }

  private handleRelayClose(): void {
    if (this.stopped) return;
    this.log.warn('relay-transport: relay connection closed');
    for (const peer of this.peerStates.values()) {
      peer.status = 'disconnected';
      peer.session = null;
      peer.initiatorState = null;
    }
    this.ws = null;
    // Reconnection to the relay is not implemented in phase 3e — operator
    // restarts the daemon. Phase 3f integration can add exponential backoff
    // if real deployments want it.
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
