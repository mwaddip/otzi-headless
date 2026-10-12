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
 *   - Heartbeat: every connection is pinged each `heartbeatMs`; one that has
 *     not answered the previous ping is terminated, which frees its slot and
 *     tells the ring `peer-left` like any close.
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
import { MAX_FRAME_BYTES } from '../peer-mesh/wire';
import {
  encodeServerMsg,
  parseClientMsg,
  type RelayClientMsg,
  type RelayServerMsg,
} from './wire';

export interface RelayServerOptions {
  /** `"host:port"` — host required (no 0.0.0.0 default). */
  listen: string;
  /** Ping interval; a connection that missed the previous ping's pong is terminated. Default 20 000 ms. */
  heartbeatMs?: number;
  logger?: Logger;
}

const DEFAULT_HEARTBEAT_MS = 20_000;
/** How long `stop()` gives registered clients to finish the close handshake before it terminates them. */
const STOP_GRACE_MS = 2_000;

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
  private readonly heartbeatMs: number;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Connections that have not answered the latest ping. */
  private readonly awaitingPong = new WeakSet<WebSocket>();

  constructor(options: RelayServerOptions) {
    const { host, port } = parseBind(options.listen);
    this.host = host;
    this.port = port;
    this.log = options.logger ?? NOOP_LOGGER;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs < 1)
      throw new Error(`RelayServer: heartbeatMs must be a finite number of ms, at least 1 (got ${this.heartbeatMs})`);
  }

  async start(): Promise<void> {
    if (this.wss) return;
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });
    this.httpServer = httpServer;
    this.wss = wss;

    wss.on('connection', (ws) => this.handleConnection(ws));
    // `ws` re-emits the HTTP server's 'error' on `wss` first, and an 'error' event with no listener
    // throws before the bind promise below sees it: a taken address would crash the process and
    // `start()` would never settle. A failed bind is reported through that promise, not here.
    wss.on('error', (err) => {
      if (httpServer.listening) this.log.warn('RelayServer: server error', { err: err.message });
    });

    try {
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
    } catch (err) {
      // Nothing is bound: leave the instance as if `start()` had not run, so it can be started again.
      if (this.wss === wss) {
        this.wss = null;
        this.httpServer = null;
      }
      wss.close();
      throw err;
    }

    if (this.wss !== wss) {
      // stop() ran while we were binding: it could not close a listener that did not exist yet.
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      return;
    }
    this.heartbeat = setInterval(() => this.beat(wss), this.heartbeatMs);
    this.log.info('RelayServer: listening', this.address() ?? {});
  }

  /**
   * Resolves once nothing is left (facts/transport.md, `stop()`). No client can
   * hold it: unregistered clients and connections that never upgraded have
   * nothing to flush and are dropped, and registered clients get the grace
   * period for their close handshake, then are terminated.
   */
  async stop(): Promise<void> {
    if (!this.wss) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = null;
    this.httpServer = null;

    const registered = new Set<WebSocket>();
    for (const ring of this.rings.values()) {
      for (const conn of ring.parties.values()) registered.add(conn.ws);
    }
    this.rings.clear();
    // With an external HTTP server, `ws` reports closed only once every client is gone: a client
    // that connected and never sent hello would hold stop() forever. It has nothing to flush.
    for (const ws of wss.clients) if (!registered.has(ws)) ws.terminate();
    for (const ws of registered) ws.close();
    // No new upgrades from here (`ws` drops its upgrade listener).
    const wssClosed = new Promise<void>((resolve) => wss.close(() => resolve()));
    if (!(await settlesWithin(wssClosed, STOP_GRACE_MS))) {
      this.log.warn('RelayServer: terminating connections that did not close within the grace period', {
        connections: wss.clients.size,
        graceMs: STOP_GRACE_MS,
      });
      for (const ws of wss.clients) ws.terminate();
      await wssClosed;
    }
    if (httpServer) {
      // After the WebSockets, so a stop() during the bind lets start() see its listener first.
      const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      // What is left never upgraded (a bare TCP connection, a plain HTTP request the relay never
      // answers): nothing to flush, and `close()` alone would wait for it.
      httpServer.closeAllConnections();
      await httpClosed;
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

  /** Terminate every connection that missed the previous ping; ping the rest. */
  private beat(wss: WebSocketServer): void {
    for (const ws of wss.clients) {
      if (this.awaitingPong.has(ws)) {
        // Its close handler frees the slot and sends peer-left.
        this.log.warn('relay: terminating a connection that did not answer a ping');
        ws.terminate();
        continue;
      }
      this.awaitingPong.add(ws);
      try {
        ws.ping();
      } catch {
        /* closing: its close event cleans up */
      }
    }
  }

  private handleConnection(ws: WebSocket): void {
    ws.on('pong', () => this.awaitingPong.delete(ws));

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

/** Whether `p` settles within `ms`; the timer is cleared either way. */
async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

function parseBind(bind: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(bind);
  if (!m) throw new Error(`RelayServer: invalid listen '${bind}' — expected 'host:port'`);
  let host = m[1]!;
  // An IPv6 literal is written in brackets (`[::1]:7100`); `listen` and DNS take it without them.
  // One enclosing pair is stripped. A bracket left in the host (a lone one, or nested ones as in
  // `[[::1]]`) is a malformed address, never a name to resolve.
  const bracketed = /^\[(.+)\]$/.exec(host);
  if (bracketed) host = bracketed[1]!;
  if (/[[\]]/.test(host))
    throw new Error(`RelayServer: invalid listen '${bind}' — brackets must enclose the whole host, once ('[::1]:7100')`);
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`RelayServer: invalid port '${m[2]}'`);
  if (host.length === 0) throw new Error('RelayServer: host required');
  return { host, port };
}
