/**
 * Single peer-to-peer encrypted connection.
 *
 * Wraps one `ws` WebSocket. Two factories:
 *   - `dial(...)` — this daemon is the initiator (lower partyId).
 *   - `acceptInbound(...)` — this daemon is the responder (higher partyId).
 *
 * Both factories run the Noise-KK-style handshake (phase 3b) before
 * returning, so a returned `PeerConnection` is always ready to send + receive
 * encrypted `AppMessage`s.
 *
 * Connection lifetime: close on any of (peer close, record-layer auth fail,
 * ws error). Callers subscribe via `onClose` to drive reconnect logic.
 *
 * Message-loss safety:
 *   - The handshake attaches a persistent `on('message')` queue listener
 *     IMMEDIATELY (before sending hs1 / after receiving inbound). Any frame
 *     arriving on the wire during handshake's async awaits is captured there.
 *   - PeerConnection's constructor takes ownership of the queue — replays
 *     prebuffered frames through the sequential processing pipeline — and
 *     switches over to the decrypt+dispatch path for all subsequent frames.
 *   - Processing is serialized per-connection (via an async chain) so
 *     concurrent arriving frames don't race the RecordSession counter.
 */

import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { PartyId, Unsubscribe } from '../../core/types';
import {
  initiatorBegin,
  initiatorFinish,
  responderRespond,
} from '../handshake';
import type { IdentityKeyPair } from '../identity';
import { RecordSession } from '../record';
import {
  encodeHandshake1,
  encodeHandshake2,
  ephemeralFromHandshake,
  parseAppMessage,
  parseHandshake,
  type AppMessage,
} from './wire';

const HANDSHAKE_TIMEOUT_MS = 10_000;

interface PeerConnectionOptions {
  ws: WebSocket;
  session: RecordSession;
  peerPartyId: PartyId;
  /** Raw frames received during handshake setup; replayed on construction. */
  prebuffered: Uint8Array[];
}

export class PeerConnection {
  readonly peerPartyId: PartyId;
  private readonly ws: WebSocket;
  private readonly session: RecordSession;
  private readonly events = new EventEmitter();
  /** AppMessages decrypted before any `onMessage` subscriber registers. */
  private bufferedAppMessages: AppMessage[] = [];
  /** Serializes per-connection processing so concurrent arrivals don't race the record counter. */
  private processingChain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(opts: PeerConnectionOptions) {
    this.ws = opts.ws;
    this.session = opts.session;
    this.peerPartyId = opts.peerPartyId;
    this.ws.on('message', (data) => {
      this.enqueue(toBytes(data));
    });
    this.ws.on('close', () => this.handleTeardown());
    this.ws.on('error', () => this.handleTeardown());
    // Replay frames that arrived during handshake setup.
    for (const bytes of opts.prebuffered) this.enqueue(bytes);
  }

  static async dial(options: {
    me: { partyId: PartyId; identity: IdentityKeyPair };
    peerPartyId: PartyId;
    peerPublicKey: Uint8Array;
    url: string;
    wsCtor: typeof WebSocket;
  }): Promise<PeerConnection> {
    const ws = new options.wsCtor(options.url);
    await waitFor(ws, 'open', HANDSHAKE_TIMEOUT_MS);
    const queue = new HandshakeQueue(ws);
    try {
      const { state, message1 } = await initiatorBegin(options.me.identity);
      ws.send(encodeHandshake1(options.me.partyId, state.ephemeralPubRaw));
      const msg2Raw = await queue.take(HANDSHAKE_TIMEOUT_MS);
      const msg2 = parseHandshake(msg2Raw);
      if (!msg2 || msg2.kind !== 'hs2')
        throw new Error(`dial: expected hs2, got ${msg2 ? msg2.kind : 'invalid JSON'}`);
      if (msg2.partyId !== options.peerPartyId)
        throw new Error(
          `dial: hs2 claimed partyId=${msg2.partyId}, expected ${options.peerPartyId}`,
        );
      const secrets = await initiatorFinish(
        state,
        ephemeralFromHandshake(msg2),
        options.peerPublicKey,
      );
      const session = await RecordSession.create(secrets);
      const prebuffered = queue.detach();
      return new PeerConnection({ ws, session, peerPartyId: options.peerPartyId, prebuffered });
    } catch (err) {
      queue.detach();
      throw err;
    }
  }

  static async acceptInbound(options: {
    me: { partyId: PartyId; identity: IdentityKeyPair };
    ws: WebSocket;
    resolvePublicKey: (peerPartyId: PartyId) => Uint8Array | null;
  }): Promise<PeerConnection> {
    const queue = new HandshakeQueue(options.ws);
    try {
      const msg1Raw = await queue.take(HANDSHAKE_TIMEOUT_MS);
      const msg1 = parseHandshake(msg1Raw);
      if (!msg1 || msg1.kind !== 'hs1')
        throw new Error(`acceptInbound: expected hs1, got ${msg1 ? msg1.kind : 'invalid JSON'}`);
      const peerPublicKey = options.resolvePublicKey(msg1.partyId);
      if (!peerPublicKey)
        throw new Error(`acceptInbound: unknown peer partyId ${msg1.partyId}`);
      const { message2, secrets } = await responderRespond(
        options.me.identity,
        ephemeralFromHandshake(msg1),
        peerPublicKey,
      );
      options.ws.send(encodeHandshake2(options.me.partyId, message2));
      const session = await RecordSession.create(secrets);
      const prebuffered = queue.detach();
      return new PeerConnection({
        ws: options.ws,
        session,
        peerPartyId: msg1.partyId,
        prebuffered,
      });
    } catch (err) {
      queue.detach();
      throw err;
    }
  }

  async send(msg: AppMessage): Promise<void> {
    if (this.closed) throw new Error('PeerConnection: cannot send on closed connection');
    const plaintext = new TextEncoder().encode(JSON.stringify(msg));
    const ct = await this.session.seal(plaintext);
    await new Promise<void>((resolve, reject) => {
      this.ws.send(ct, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: (msg: AppMessage) => void): Unsubscribe {
    this.events.on('message', handler);
    if (this.bufferedAppMessages.length > 0) {
      const toFlush = this.bufferedAppMessages;
      this.bufferedAppMessages = [];
      for (const m of toFlush) this.events.emit('message', m);
    }
    return () => this.events.off('message', handler);
  }

  onClose(handler: () => void): Unsubscribe {
    this.events.on('close', handler);
    return () => this.events.off('close', handler);
  }

  async close(): Promise<void> {
    this.handleTeardown();
    this.ws.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private enqueue(bytes: Uint8Array): void {
    this.processingChain = this.processingChain.then(() => this.processOne(bytes));
  }

  private async processOne(bytes: Uint8Array): Promise<void> {
    if (this.closed) return;
    let plaintext: Uint8Array;
    try {
      plaintext = await this.session.open(bytes);
    } catch {
      this.handleTeardown();
      this.ws.close();
      return;
    }
    const msg = parseAppMessage(plaintext);
    if (!msg) {
      this.handleTeardown();
      this.ws.close();
      return;
    }
    if (this.events.listenerCount('message') > 0) {
      this.events.emit('message', msg);
    } else {
      this.bufferedAppMessages.push(msg);
    }
  }

  private handleTeardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.emit('close');
    this.events.removeAllListeners();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HandshakeQueue — persistent ws 'message' listener during handshake setup.
// ─────────────────────────────────────────────────────────────────────────

class HandshakeQueue {
  private buffer: Uint8Array[] = [];
  private waiter: { resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  private detached = false;
  private readonly onMsg: (data: unknown) => void;
  private readonly onClose: () => void;
  private readonly onError: (err: Error) => void;

  constructor(private readonly ws: WebSocket) {
    this.onMsg = (data) => {
      if (this.detached) return;
      const bytes = toBytes(data);
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        w.resolve(bytes);
      } else {
        this.buffer.push(bytes);
      }
    };
    this.onClose = () => {
      this.failWaiter(new Error('socket closed during handshake'));
    };
    this.onError = (err) => {
      this.failWaiter(err);
    };
    ws.on('message', this.onMsg);
    ws.on('close', this.onClose);
    ws.on('error', this.onError);
  }

  async take(timeoutMs: number): Promise<Uint8Array> {
    const immediate = this.buffer.shift();
    if (immediate) return immediate;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('handshake: timeout waiting for message'));
      }, timeoutMs);
      this.waiter = {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  /** Remove the handshake listeners. Returns any pending buffered frames for replay. */
  detach(): Uint8Array[] {
    if (this.detached) return [];
    this.detached = true;
    this.ws.off('message', this.onMsg);
    this.ws.off('close', this.onClose);
    this.ws.off('error', this.onError);
    return this.buffer;
  }

  private failWaiter(err: Error): void {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w.reject(err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function waitFor(ws: WebSocket, event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ws '${event}' event`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off(event, onEvent);
      ws.off('error', onError);
    };
    ws.once(event, onEvent);
    ws.once('error', onError);
  });
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    let total = 0;
    for (const chunk of data) total += (chunk as Uint8Array).length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of data) {
      const u = chunk as Uint8Array;
      out.set(u, offset);
      offset += u.length;
    }
    return out;
  }
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error(`cannot convert ws data of type ${typeof data} to Uint8Array`);
}
