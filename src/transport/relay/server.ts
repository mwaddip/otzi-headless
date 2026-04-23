/**
 * `RelayServer` — tiny Node.js relay that routes opaque frames between peers
 * grouped by `ringId`.
 *
 * Not responsible for:
 *   - Authenticating peers (Noise KK at the peer layer does that).
 *   - Validating frame contents (they're AES-GCM-encrypted blobs).
 *   - Session state, ACKs, reliability, ordering (the WebSocket provides
 *     ordered delivery per-connection; cross-peer ordering isn't needed for
 *     our ceremony protocols).
 *
 * Responsible for:
 *   - Per-ring connection roster + peer-joined/peer-left notifications.
 *   - Routing `frame { to, payload }` from sender's ring to the target peer.
 *   - First-come-first-served partyId slot per ring (rejects dup connects).
 *
 * Deployment: bind to loopback + front with TLS/firewall, or put on a VPN.
 * Anyone who reaches the port can claim a partyId slot — Noise KK still
 * protects the ceremony, but the squatter can DoS the slot until operator
 * kicks them.
 */

import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PartyId } from '../../core/types';
import { NOOP_LOGGER, type Logger } from '../../orchestrator/types';
import {
  encodeServerMsg,
  parseClientMsg,
  type RelayClientMsg,
  type RelayServerMsg,
} from './wire';

export interface RelayServerOptions {
  /** `"host:port"` — host required (no 0.0.0.0 default). */
  listen: string;
  logger?: Logger;
}

interface PartyConnection {
  partyId: PartyId;
  ws: WebSocket;
}

interface Ring {
  ringId: string;
  parties: Map<PartyId, PartyConnection>;
}

export class RelayServer {
  private readonly host: string;
  private readonly port: number;
  private readonly log: Logger;
  private readonly rings = new Map<string, Ring>();
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;

  constructor(options: RelayServerOptions) {
    const { host, port } = parseBind(options.listen);
    this.host = host;
    this.port = port;
    this.log = options.logger ?? NOOP_LOGGER;
  }

  async start(): Promise<void> {
    if (this.wss) return;
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    this.httpServer = httpServer;
    this.wss = wss;

    wss.on('connection', (ws) => this.handleConnection(ws));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(this.port, this.host);
    });

    this.log.info('RelayServer: listening', this.address() ?? {});
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    for (const ring of this.rings.values()) {
      for (const conn of ring.parties.values()) conn.ws.close();
    }
    this.rings.clear();
    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    this.log.info('RelayServer: stopped');
  }

  address(): { host: string; port: number } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  // ─────────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let state: { ringId: string; partyId: PartyId } | null = null;

    const send = (msg: RelayServerMsg) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeServerMsg(msg));
    };

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const msg = parseClientMsg(text);
      if (!msg) {
        send({ kind: 'error', message: 'malformed message' });
        return;
      }

      if (msg.kind === 'hello') {
        if (state) {
          send({ kind: 'error', message: 'already registered' });
          return;
        }
        const ring = this.getOrCreateRing(msg.ringId);
        if (ring.parties.has(msg.partyId)) {
          send({ kind: 'error', message: `partyId ${msg.partyId} already connected in this ring` });
          return;
        }
        const rosterBefore = [...ring.parties.keys()];
        ring.parties.set(msg.partyId, { partyId: msg.partyId, ws });
        state = { ringId: msg.ringId, partyId: msg.partyId };
        this.log.info('relay: hello', { ringId: msg.ringId, partyId: msg.partyId, rosterSize: ring.parties.size });
        send({ kind: 'ack', roster: rosterBefore });
        this.broadcastToRing(ring, { kind: 'peer-joined', partyId: msg.partyId }, msg.partyId);
        return;
      }

      if (!state) {
        send({ kind: 'error', message: 'hello required first' });
        return;
      }

      if (msg.kind === 'frame') {
        this.handleFrame(state, msg, send);
        return;
      }
    });

    ws.on('close', () => {
      if (!state) return;
      const ring = this.rings.get(state.ringId);
      if (!ring) return;
      const existing = ring.parties.get(state.partyId);
      if (existing && existing.ws === ws) {
        ring.parties.delete(state.partyId);
        this.broadcastToRing(ring, { kind: 'peer-left', partyId: state.partyId }, state.partyId);
        this.log.info('relay: peer-left', { ringId: state.ringId, partyId: state.partyId });
        if (ring.parties.size === 0) this.rings.delete(ring.ringId);
      }
    });

    ws.on('error', () => {
      /* handled by close */
    });
  }

  private handleFrame(
    state: { ringId: string; partyId: PartyId },
    msg: { kind: 'frame'; to: PartyId; payloadHex: string },
    reply: (m: RelayServerMsg) => void,
  ): void {
    const ring = this.rings.get(state.ringId);
    if (!ring) return;
    if (msg.to === state.partyId) {
      reply({ kind: 'error', message: 'cannot frame to self' });
      return;
    }
    const target = ring.parties.get(msg.to);
    if (!target) {
      // Target not connected — silently drop. Sender gets no error; relies on
      // peer-joined notifications to know when to retry.
      return;
    }
    if (target.ws.readyState === target.ws.OPEN) {
      target.ws.send(
        encodeServerMsg({
          kind: 'incoming',
          from: state.partyId,
          payloadHex: msg.payloadHex,
        }),
      );
    }
  }

  private broadcastToRing(ring: Ring, msg: RelayServerMsg, exclude: PartyId): void {
    const text = encodeServerMsg(msg);
    for (const conn of ring.parties.values()) {
      if (conn.partyId === exclude) continue;
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(text);
    }
  }

  private getOrCreateRing(ringId: string): Ring {
    let ring = this.rings.get(ringId);
    if (!ring) {
      ring = { ringId, parties: new Map() };
      this.rings.set(ringId, ring);
    }
    return ring;
  }
}

function parseBind(bind: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(bind);
  if (!m) throw new Error(`RelayServer: invalid listen '${bind}' — expected 'host:port'`);
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`RelayServer: invalid port '${m[2]}'`);
  if (host.length === 0) throw new Error('RelayServer: host required');
  return { host, port };
}
