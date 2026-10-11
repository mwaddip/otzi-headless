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
 *
 * Ordering: every frame to a peer (hs1, hs2, records) takes its turn in that
 * peer's send chain, sealing and reaching the relay socket in counter order.
 *
 * Re-handshake: a broken session is replaced by a fresh handshake, always
 * started by the initiator — on its own record failure, on the next send or
 * pull, or on a re-handshake request (an empty frame) from the responder,
 * which a responder also sends when its own handshake fails. A request
 * restarts the handshake from any state. Restarts a request triggers are
 * limited to one per peer per `REHANDSHAKE_MIN_INTERVAL_MS` after the last
 * restart of any kind; a request inside that window is deferred to its end,
 * not dropped (the responder sends it once). A responder accepts a fresh hs1
 * in any state.
 *
 * Reconnect: a relay socket that fails to open, drops, or has its hello
 * refused ends every peer session and schedules the next attempt with
 * exponential backoff (`reconnect`); the relay's ack to a hello resets it.
 * `start()` resolves after the first attempt either way; `stop()` cancels.
 *
 * Liveness (`liveness`): the upgrade must complete within `connectMs`, the
 * relay must ack our hello within `ackMs`, and an open socket pings the relay
 * every `pingIntervalMs`, dropping it when a pong takes longer than `pongMs`.
 * Each miss ends the socket as a failed attempt.
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
  MAX_FRAME_BYTES,
  encodeBroadcast,
  encodePullRequest,
  encodePullResponse,
  parseAppMessage,
  pullRequestKey,
  pullResponseBlob,
  type AppMessage,
} from '../peer-mesh/wire';
import { NOOP_LOGGER, type Logger } from '../../orchestrator/types';
import { fromHex, toHex } from '../../otzi/lib/hex';
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
  /**
   * Relay reconnect backoff: attempt k (from 0) waits min(maxMs, initialMs·2^k)
   * plus up to 10 % jitter. Defaults 1000 / 30000 ms.
   */
  reconnect?: { initialMs?: number; maxMs?: number };
  /**
   * Relay socket liveness, in ms: `connectMs` bounds the TCP connect and the
   * WebSocket upgrade (default 10 000); `ackMs` the wait from our hello to the
   * relay's ack (10 000); an open socket pings the relay every `pingIntervalMs`
   * (20 000) and drops it when a pong takes longer than `pongMs` (10 000).
   */
  liveness?: { connectMs?: number; ackMs?: number; pingIntervalMs?: number; pongMs?: number };
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
  /** On the relay roster (ack / peer-joined, until peer-left or relay close). */
  online: boolean;
  /** Initiator: when the current handshake started, and which one it is. */
  handshakeStartedAt: number;
  handshakeAttempt: number;
  /** Initiator: when the handshake last (re)started, for any reason (rate limit on requests). */
  lastRestartAt: number;
  /**
   * Initiator: the timer that restarts the handshake at the end of the rate-limit window, for the
   * re-handshake requests that arrived inside it (merged: at most one per peer), and the session
   * the initiator held when the latest of them arrived.
   */
  deferredRestart: NodeJS.Timeout | null;
  deferredForSession: RecordSession | null;
  /** Serialises every frame to this peer (handshake and records): the relay sees them in counter order. */
  sendChain: Promise<void>;
  /**
   * Per-peer FIFO queue of raw payloads awaiting dispatch. `processing` guards
   * against interleaving state transitions — if a second message arrives while
   * the first is still inside `completeInitiatorHandshake` / etc., the second
   * waits until the first finishes rather than racing against stale state.
   */
  pending: Uint8Array[];
  processing: boolean;
}

/** One relay socket's timers. Cleared on that socket's close, on a drop, and on `stop()`. */
interface SocketTimers {
  ping: NodeJS.Timeout | null;
  pong: NodeJS.Timeout | null;
  ack: NodeJS.Timeout | null;
}

interface PendingPull {
  resolve: (blob: Uint8Array | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** The producer asked; the end of its session resolves the pull with null. */
  peer: PartyId;
}

const DEFAULT_PULL_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
/** A reconnect delay grows by up to this fraction, so a ring that lost its relay does not redial in lockstep. */
const RECONNECT_JITTER = 0.1;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 20_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
/** An initiator handshake without hs2 for this long may be restarted. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Re-handshake requests restart the handshake at most this often after a restart; a pair that cannot agree must not spin. */
const REHANDSHAKE_MIN_INTERVAL_MS = 1_000;
/** Handshake messages are raw uncompressed P-256 points. */
const HANDSHAKE_FRAME_BYTES = 65;
const EMPTY = new Uint8Array(0);

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
  /** The current relay socket, from its connection attempt until it drops or `stop()`. */
  private ws: WebSocket | null = null;
  /** The relay acked this socket's hello. */
  private registered = false;
  private readonly wsCtor: typeof WebSocket;
  private readonly log: Logger;
  private readonly pullTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  /** Failed attempts since the last ack: the exponent of the next delay. */
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  /** The current socket's timers. */
  private timers: SocketTimers | null = null;
  private started = false;
  private stopped = false;

  constructor(options: RelayTransportOptions) {
    this.self = options.self;
    this.partyId = options.self.partyId;
    // Every ring member, self included (the Transport contract); `options.peers` lists the others.
    this.peers = [this.partyId, ...options.peers.map((p) => p.partyId)].sort((a, b) => a - b);
    this.relayUrl = options.relayUrl;
    this.ringId = options.ringId;
    this.wsCtor = options.wsCtor ?? WebSocket;
    this.log = options.logger ?? NOOP_LOGGER;
    this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
    this.reconnectInitialMs = durationMs(options.reconnect?.initialMs, DEFAULT_RECONNECT_INITIAL_MS, 'reconnect.initialMs');
    this.reconnectMaxMs = durationMs(options.reconnect?.maxMs, DEFAULT_RECONNECT_MAX_MS, 'reconnect.maxMs');
    if (this.reconnectMaxMs < this.reconnectInitialMs)
      throw new Error(
        `RelayTransport: reconnect.maxMs (${this.reconnectMaxMs}) is below reconnect.initialMs (${this.reconnectInitialMs})`,
      );
    const liveness = options.liveness ?? {};
    this.connectTimeoutMs = durationMs(liveness.connectMs, DEFAULT_CONNECT_TIMEOUT_MS, 'liveness.connectMs');
    this.ackTimeoutMs = durationMs(liveness.ackMs, DEFAULT_ACK_TIMEOUT_MS, 'liveness.ackMs');
    this.pingIntervalMs = durationMs(liveness.pingIntervalMs, DEFAULT_PING_INTERVAL_MS, 'liveness.pingIntervalMs');
    this.pongTimeoutMs = durationMs(liveness.pongMs, DEFAULT_PONG_TIMEOUT_MS, 'liveness.pongMs');

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
        online: false,
        handshakeStartedAt: 0,
        handshakeAttempt: 0,
        lastRestartAt: 0,
        deferredRestart: null,
        deferredForSession: null,
        sendChain: Promise.resolve(),
        pending: [],
        processing: false,
      });
    }
  }

  /** Resolves after the first connection attempt, whether or not it reached the relay; later attempts follow the backoff. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.connect();
    // A stop() during the first attempt ended it: nothing started.
    if (!this.stopped) this.log.info('relay-transport: started', { ringId: this.ringId, partyId: this.self.partyId });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Now, not on the close event: a graceful close may take up to 30 s to report.
    this.clearSocketTimers();
    for (const pending of this.pendingPulls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('relay-transport: stopping'));
    }
    this.pendingPulls.clear();
    if (this.ws) {
      // Open or still connecting: either way it closes, and its close event is ignored (stopped).
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    for (const peer of this.peerStates.values()) {
      peer.online = false;
      this.clearDeferredRestart(peer);
      this.endSession(peer, 'disconnected');
    }
    this.log.info('relay-transport: stopped');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Transport interface
  // ─────────────────────────────────────────────────────────────────────

  async broadcast(msg: Uint8Array): Promise<void> {
    // Fan-out: each peer gets its own AES-GCM seal (each session has distinct keys).
    const appMessage = encodeBroadcast(msg);
    await Promise.all(
      [...this.peerStates.values()].map(async (peer) => {
        if (peer.status !== 'connected' || !peer.session) {
          this.maybeStartHandshake(peer);
          return;
        }
        try {
          await this.sendAppMessage(peer, appMessage);
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
    if (peer.status !== 'connected' || !peer.session) {
      this.maybeStartHandshake(peer);
      return null;
    }

    const requestId = randomId();
    const result = new Promise<Uint8Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPulls.delete(requestId);
        // Timeout is transient — BlobPuller's retry loop handles it.
        resolve(null);
      }, this.pullTimeoutMs);
      this.pendingPulls.set(requestId, { resolve, reject, timer, peer: peer.partyId });
    });

    try {
      await this.sendAppMessage(peer, encodePullRequest(requestId, key));
    } catch (err) {
      // Transient as well: the session is gone or being replaced; the caller retries.
      this.log.warn('relay-transport: pull request send failed', { peerPartyId: peer.partyId, err: errMsg(err) });
      this.settlePull(requestId, null);
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

  private async onRelayMessage(ws: WebSocket, data: unknown): Promise<void> {
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
        if (!this.registered) {
          // An error before the ack: the relay refused our hello (say, a connection it has
          // not yet seen drop still holds our partyId). A failed attempt: drop it and retry.
          this.dropSocket(ws, 'relay refused hello', { message: msg.message });
          return;
        }
        this.log.warn('relay-transport: relay error', { message: msg.message });
        return;
    }
  }

  private async onAck(roster: PartyId[]): Promise<void> {
    if (this.timers?.ack) {
      clearTimeout(this.timers.ack);
      this.timers.ack = null;
    }
    this.registered = true;
    this.reconnectAttempt = 0;
    this.log.info('relay-transport: registered with the relay', { roster });
    for (const partyId of roster) {
      const peer = this.peerStates.get(partyId);
      if (!peer) continue;
      peer.online = true;
      if (peer.role === 'initiator') void this.startInitiatorHandshake(peer);
      else peer.status = 'waiting-for-hs1';
    }
  }

  private async onPeerJoined(partyId: PartyId): Promise<void> {
    const peer = this.peerStates.get(partyId);
    if (!peer) return;
    peer.online = true;
    // A (re)joined peer holds no session: any handshake in flight went to its previous connection.
    if (peer.role === 'initiator') void this.startInitiatorHandshake(peer, { restart: true });
    else this.endSession(peer, 'waiting-for-hs1');
  }

  private onPeerLeft(partyId: PartyId): void {
    const peer = this.peerStates.get(partyId);
    if (!peer) return;
    peer.online = false;
    this.clearDeferredRestart(peer);
    this.endSession(peer, 'disconnected');
    peer.pending.length = 0;
    this.log.info('relay-transport: peer left', { partyId });
  }

  private async onIncoming(from: PartyId, payload: Uint8Array): Promise<void> {
    const peer = this.peerStates.get(from);
    if (!peer) {
      this.log.warn('relay-transport: incoming from unknown partyId', { from });
      return;
    }
    // The relay forwards only from connected ring members.
    peer.online = true;
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
    if (payload.length === 0) {
      // A re-handshake request: the responder lost the session.
      if (peer.role === 'initiator') this.onRehandshakeRequest(peer);
      return;
    }
    if (peer.role === 'responder') {
      if (peer.status === 'connected' && peer.session) {
        if (await this.handleConnectedIncoming(peer, payload)) return;
        // Not a record of this session: a fresh hs1 from the initiator, or a broken session.
        if (isHandshakeFrame(payload)) {
          await this.completeResponderHandshake(peer, payload);
          return;
        }
        this.log.warn('relay-transport: record auth failed; asking the initiator to re-handshake', {
          peerPartyId: peer.partyId,
        });
        this.endSession(peer, 'waiting-for-hs1');
        this.requestRehandshake(peer);
        return;
      }
      if (isHandshakeFrame(payload)) {
        await this.completeResponderHandshake(peer, payload);
        return;
      }
      // A record while this node holds no session: the initiator still holds one.
      this.requestRehandshake(peer);
      return;
    }

    // Initiator.
    if (peer.status === 'waiting-for-hs2') {
      if (isHandshakeFrame(payload)) {
        if (peer.initiatorState) await this.completeInitiatorHandshake(peer, payload);
        return;
      }
      // A record the responder sealed under the old session: it holds a session, so our hs1 may
      // have been lost. The record is dropped; a handshake under way for too long restarts.
      this.maybeStartHandshake(peer);
      return;
    }
    if (peer.status === 'connected' && peer.session) {
      if (await this.handleConnectedIncoming(peer, payload)) return;
      this.log.warn('relay-transport: record auth failed; re-handshaking', { peerPartyId: peer.partyId });
      void this.startInitiatorHandshake(peer, { restart: true });
      return;
    }
    // A record while this node holds no session: the responder still holds one.
    this.maybeStartHandshake(peer);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Handshake
  // ─────────────────────────────────────────────────────────────────────

  /** Initiator: start a handshake to an online peer that has none, or whose handshake went stale. */
  private maybeStartHandshake(peer: PeerState): void {
    if (peer.role !== 'initiator' || !peer.online) return;
    const stale =
      peer.status === 'waiting-for-hs2' && Date.now() - peer.handshakeStartedAt > HANDSHAKE_TIMEOUT_MS;
    if (peer.status === 'disconnected' || stale) void this.startInitiatorHandshake(peer, { restart: true });
  }

  /**
   * The responder discarded whatever it held, our hs1 included, so waiting for
   * an hs2 cannot succeed: restart from any state. A request inside
   * `REHANDSHAKE_MIN_INTERVAL_MS` of the last restart (of any kind) is not
   * dropped, since the responder sends it once and nothing else would tell us
   * (our own traffic may be idle): it is deferred to the end of the window.
   * So a pair whose handshakes keep failing (say, mismatched keys) retries
   * once per window, not at network speed.
   */
  private onRehandshakeRequest(peer: PeerState): void {
    const sinceLast = Date.now() - peer.lastRestartAt;
    // A negative interval is a clock that stepped back: not a reason to hold requests off.
    if (sinceLast >= 0 && sinceLast < REHANDSHAKE_MIN_INTERVAL_MS) {
      this.deferRestart(peer, REHANDSHAKE_MIN_INTERVAL_MS - sinceLast);
      return;
    }
    this.log.info('relay-transport: re-handshake requested', { peerPartyId: peer.partyId });
    void this.startInitiatorHandshake(peer, { restart: true });
  }

  /** Restart `delayMs` from now unless something else restarts first; repeated requests share one timer. */
  private deferRestart(peer: PeerState, delayMs: number): void {
    // The session this request is about. One that replaces it before the timer fires has answered it.
    peer.deferredForSession = peer.session;
    if (peer.deferredRestart) {
      this.log.debug('relay-transport: re-handshake request deferred (rate limit)', {
        peerPartyId: peer.partyId,
        delayMs,
        merged: true,
      });
      return;
    }
    this.log.debug('relay-transport: re-handshake request deferred (rate limit)', {
      peerPartyId: peer.partyId,
      delayMs,
    });
    peer.deferredRestart = setTimeout(() => {
      const since = peer.deferredForSession;
      peer.deferredRestart = null;
      peer.deferredForSession = null;
      if (this.stopped) return;
      if (peer.status === 'connected' && peer.session && peer.session !== since) {
        this.log.debug('relay-transport: deferred re-handshake request already answered by a newer session', {
          peerPartyId: peer.partyId,
        });
        return;
      }
      this.log.info('relay-transport: re-handshake requested (deferred)', { peerPartyId: peer.partyId });
      void this.startInitiatorHandshake(peer, { restart: true });
    }, delayMs);
  }

  private clearDeferredRestart(peer: PeerState): void {
    if (peer.deferredRestart) clearTimeout(peer.deferredRestart);
    peer.deferredRestart = null;
    peer.deferredForSession = null;
  }

  /** Responder: ask the initiator for a fresh handshake (an empty frame). */
  private requestRehandshake(peer: PeerState): void {
    this.enqueueFrame(peer, async () => EMPTY).catch((err) =>
      this.log.warn('relay-transport: re-handshake request send failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      }),
    );
  }

  private async startInitiatorHandshake(peer: PeerState, opts: { restart?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.ws || peer.role !== 'initiator') return;
    if (peer.status !== 'disconnected' && !opts.restart) return;
    // Synchronously: the old session ends (its pulls resolve null) and later triggers see a handshake under way.
    // A request deferred until now is answered by this restart (a later one will be deferred anew).
    this.clearDeferredRestart(peer);
    this.endSession(peer, 'waiting-for-hs2');
    peer.handshakeStartedAt = peer.lastRestartAt = Date.now();
    const attempt = ++peer.handshakeAttempt;
    try {
      const { state, message1 } = await initiatorBegin(this.self.identity);
      if (peer.handshakeAttempt !== attempt || peer.status !== 'waiting-for-hs2') return; // superseded
      peer.initiatorState = state;
      await this.enqueueFrame(peer, async () => message1);
      this.log.info('relay-transport: sent hs1', { peerPartyId: peer.partyId });
    } catch (err) {
      if (peer.handshakeAttempt !== attempt) return;
      this.log.warn('relay-transport: initiator handshake start failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      });
      this.endSession(peer, 'disconnected');
    }
  }

  private async completeInitiatorHandshake(peer: PeerState, message2: Uint8Array): Promise<void> {
    const state = peer.initiatorState;
    if (!state) return;
    const attempt = peer.handshakeAttempt;
    try {
      const secrets = await initiatorFinish(state, message2, peer.publicKey);
      const session = await RecordSession.create(secrets);
      if (peer.handshakeAttempt !== attempt || peer.initiatorState !== state) return; // superseded
      peer.session = session;
      peer.status = 'connected';
      peer.initiatorState = null;
      this.log.info('relay-transport: handshake complete (initiator)', { peerPartyId: peer.partyId });
    } catch (err) {
      if (peer.handshakeAttempt !== attempt) return;
      this.log.warn('relay-transport: initiator finish failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      });
      this.endSession(peer, 'disconnected');
    }
  }

  private async completeResponderHandshake(peer: PeerState, message1: Uint8Array): Promise<void> {
    // The relay socket the hs1 came in on. If it is gone when the answer is ready, the relay close
    // already ended this peer's session: hs2 has nowhere to go and the initiator will start over.
    const ws = this.ws;
    try {
      const { message2, secrets } = await responderRespond(
        this.self.identity,
        message1,
        peer.publicKey,
      );
      const session = await RecordSession.create(secrets);
      if (!ws || this.ws !== ws) return;
      // One synchronous step: the old session ends, the new one is usable, and hs2
      // takes its place in the send chain ahead of every record sealed under it.
      this.endSession(peer, 'connected');
      peer.session = session;
      const sent = this.enqueueFrame(peer, async () => message2);
      await sent;
      this.log.info('relay-transport: handshake complete (responder)', { peerPartyId: peer.partyId });
    } catch (err) {
      this.log.warn('relay-transport: responder handshake failed', {
        peerPartyId: peer.partyId,
        err: errMsg(err),
      });
      if (!ws || this.ws !== ws) return; // the relay is gone (or was before): nothing to answer over
      // The initiator waits for an hs2 that will not come (or holds a session we no longer have):
      // ask it to start over, as for any other session we could not keep.
      this.endSession(peer, 'waiting-for-hs1');
      this.requestRehandshake(peer);
    }
  }

  /** Drop the peer's session and handshake state; its pending pulls resolve null. */
  private endSession(peer: PeerState, status: PeerStatus): void {
    peer.status = status;
    peer.session = null;
    peer.initiatorState = null;
    for (const [requestId, pending] of this.pendingPulls) {
      if (pending.peer === peer.partyId) this.settlePull(requestId, null);
    }
  }

  /** A sealed record never reached the peer: the counters diverged, so the session is useless. */
  private sessionBroken(peer: PeerState, reason: string): void {
    this.log.warn('relay-transport: session broken', { peerPartyId: peer.partyId, reason });
    if (peer.role === 'initiator') {
      void this.startInitiatorHandshake(peer, { restart: true });
    } else {
      this.endSession(peer, 'waiting-for-hs1');
      this.requestRehandshake(peer);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Connected traffic
  // ─────────────────────────────────────────────────────────────────────

  /** False when the frame does not open under the current session (nothing is dispatched). */
  private async handleConnectedIncoming(peer: PeerState, ciphertext: Uint8Array): Promise<boolean> {
    const session = peer.session;
    if (!session) return false;
    let plaintext: Uint8Array;
    try {
      plaintext = await session.open(ciphertext);
    } catch {
      return false;
    }
    const msg = parseAppMessage(plaintext);
    if (!msg) {
      this.log.warn('relay-transport: malformed app message', { peerPartyId: peer.partyId });
      return true;
    }
    this.dispatchAppMessage(peer, msg);
    return true;
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
        // Only the peer that was asked may answer.
        if (pending.peer !== peer.partyId) {
          this.log.warn('relay-transport: dropped a pull response from a peer the pull was not sent to', {
            peerPartyId: peer.partyId,
          });
          return;
        }
        this.settlePull(msg.requestId, pullResponseBlob(msg));
        return;
      }
    }
  }

  /** Resolve a pending pull (idempotent). */
  private settlePull(requestId: string, blob: Uint8Array | null): void {
    const pending = this.pendingPulls.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPulls.delete(requestId);
    pending.resolve(blob);
  }

  /** Seal under the current session and send, in this peer's send chain. */
  private async sendAppMessage(peer: PeerState, appBytes: Uint8Array): Promise<void> {
    const session = peer.session;
    if (!session || peer.status !== 'connected')
      throw new Error(`relay-transport: peer ${peer.partyId} not connected`);
    let sealed = false;
    try {
      await this.enqueueFrame(peer, async () => {
        // Queued behind a re-handshake: a record of the old session would only fail at the peer.
        if (peer.session !== session) throw new Error(`relay-transport: session with peer ${peer.partyId} was replaced`);
        const ct = await session.seal(appBytes);
        sealed = true;
        return ct;
      });
    } catch (err) {
      if (sealed && peer.session === session) this.sessionBroken(peer, `send failed: ${errMsg(err)}`);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Relay-level IO
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Take this frame's turn in the peer's send chain: produce it (seal, or a
   * handshake message) and hand it to the relay socket before the next frame
   * may produce. Resolves when the write completes.
   */
  private enqueueFrame(peer: PeerState, produce: () => Promise<Uint8Array>): Promise<void> {
    let written: Promise<void> | undefined;
    const turn = peer.sendChain.then(async () => {
      const payload = await produce();
      written = this.sendFrame(peer.partyId, payload);
    });
    peer.sendChain = turn.catch(() => {});
    return turn.then(() => written);
  }

  /** Calls `ws.send` synchronously (frame order = call order); resolves on write completion. */
  private sendFrame(to: PartyId, payload: Uint8Array): Promise<void> {
    return this.sendToRelay({ kind: 'frame', to, payloadHex: toHex(payload) });
  }

  private sendToRelay(msg: RelayClientMsg): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('relay-transport: not connected to the relay'));
    return new Promise<void>((resolve, reject) => {
      ws.send(encodeClientMsg(msg), (err) => (err ? reject(err) : resolve()));
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Relay connection lifecycle
  // ─────────────────────────────────────────────────────────────────────

  /**
   * One connection attempt: open a socket to the relay and send `hello`.
   * Resolves once the hello is written or the attempt has failed. A failure,
   * and any later drop, schedules the next attempt (`handleRelayClose`).
   */
  private async connect(): Promise<void> {
    if (this.stopped) return;
    // `handshakeTimeout` bounds the TCP connect and the HTTP 101 together.
    const ws = new this.wsCtor(this.relayUrl, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: this.connectTimeoutMs });
    const timers: SocketTimers = { ping: null, pong: null, ack: null };
    this.ws = ws;
    this.timers = timers;
    this.registered = false;
    let opened = false;
    ws.once('open', () => {
      opened = true;
      if (this.ws === ws) this.startKeepalive(ws, timers);
    });
    ws.on('close', () => clearTimers(timers));
    ws.on('pong', () => {
      if (timers.pong) clearTimeout(timers.pong);
      timers.pong = null;
    });
    ws.on('message', (data) => {
      if (this.ws === ws) void this.onRelayMessage(ws, data);
    });
    // One drop can fire both `error` and `close`: the first one handles it.
    ws.on('error', (err) =>
      this.handleRelayClose(ws, opened ? 'relay connection failed' : 'relay connection attempt failed', {
        err: errMsg(err),
      }),
    );
    ws.on('close', (code) =>
      this.handleRelayClose(ws, opened ? 'relay connection closed' : 'relay connection attempt failed', { code }),
    );

    await new Promise<void>((resolve) => {
      ws.once('open', resolve);
      ws.once('error', () => resolve());
      ws.once('close', () => resolve());
    });
    if (!opened || this.ws !== ws) return; // failed (next attempt scheduled) or stopped

    // No ack in time is a failed attempt: the backoff is not reset.
    timers.ack = setTimeout(() => {
      timers.ack = null;
      this.dropSocket(ws, 'relay did not acknowledge hello', { ackMs: this.ackTimeoutMs });
    }, this.ackTimeoutMs);
    try {
      await this.sendToRelay({ kind: 'hello', ringId: this.ringId, partyId: this.self.partyId });
    } catch (err) {
      this.dropSocket(ws, 'relay hello send failed', { err: errMsg(err) });
    }
  }

  /** Ping the relay every `pingIntervalMs`; a ping unanswered after `pongMs` drops the socket. */
  private startKeepalive(ws: WebSocket, timers: SocketTimers): void {
    timers.ping = setInterval(() => {
      if (this.ws !== ws || timers.pong) return; // an unanswered ping's own deadline decides
      timers.pong = setTimeout(() => {
        timers.pong = null;
        this.dropSocket(ws, 'relay did not answer a ping', { pongMs: this.pongTimeoutMs });
      }, this.pongTimeoutMs);
      try {
        ws.ping();
      } catch {
        /* not open any more: its close event drops it */
      }
    }, this.pingIntervalMs);
  }

  /** End this socket as a failed attempt, then kill it at once (no close handshake to wait for). */
  private dropSocket(ws: WebSocket, reason: string, details: Record<string, unknown>): void {
    this.handleRelayClose(ws, reason, details);
    ws.terminate();
  }

  private clearSocketTimers(): void {
    if (this.timers) clearTimers(this.timers);
    this.timers = null;
  }

  /**
   * The current relay socket failed to open, dropped, or had its hello refused:
   * every peer goes offline (sessions end, pending pulls resolve null, queued
   * frames from the old socket are discarded) and the next attempt is scheduled.
   * Events from any other socket, and anything after `stop()`, are ignored.
   */
  private handleRelayClose(ws: WebSocket, reason: string, details: Record<string, unknown>): void {
    if (this.stopped || this.ws !== ws) return;
    this.ws = null;
    this.registered = false;
    this.clearSocketTimers();
    for (const peer of this.peerStates.values()) {
      peer.online = false;
      peer.pending.length = 0;
      this.clearDeferredRestart(peer);
      this.endSession(peer, 'disconnected');
    }
    this.scheduleReconnect(reason, details);
  }

  /** Attempt k (from 0) waits min(maxMs, initialMs·2^k) plus up to 10 % jitter. */
  private scheduleReconnect(reason: string, details: Record<string, unknown>): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(this.reconnectMaxMs, this.reconnectInitialMs * 2 ** this.reconnectAttempt);
    const delayMs = base + Math.floor(Math.random() * base * RECONNECT_JITTER);
    this.reconnectAttempt += 1;
    this.log.warn(`relay-transport: ${reason}; reconnecting`, {
      ...details,
      attempt: this.reconnectAttempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err) =>
        this.log.error('relay-transport: reconnect failed to start', { err: errMsg(err) }),
      );
    }, delayMs);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clearTimers(t: SocketTimers): void {
  if (t.ping) clearInterval(t.ping);
  if (t.pong) clearTimeout(t.pong);
  if (t.ack) clearTimeout(t.ack);
  t.ping = t.pong = t.ack = null;
}

/** A configured duration, or the default: finite and at least 1 ms. */
function durationMs(value: number | undefined, fallback: number, name: string): number {
  const ms = value ?? fallback;
  if (!Number.isFinite(ms) || ms < 1) throw new Error(`RelayTransport: ${name} must be a finite number of ms, at least 1 (got ${ms})`);
  return ms;
}

/**
 * The shape of hs1 / hs2: a raw uncompressed P-256 point. It is only consulted
 * for frames that do not open under a session; a stray frame of this shape
 * fails the handshake step (not a valid point), and the initiator retries.
 */
function isHandshakeFrame(payload: Uint8Array): boolean {
  return payload.length === HANDSHAKE_FRAME_BYTES && payload[0] === 0x04;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
