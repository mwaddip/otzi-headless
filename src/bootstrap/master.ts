/**
 * Master-side bootstrap.
 *
 * Stands up a short-lived HTTP server on `bind`. Each non-master daemon's
 * `register` command POSTs its `{ nodeId, partyId, publicKeyHex }` to
 * `/register`. Master validates against its expected-peer list, parks the
 * connection, and once all peers have registered, fans out the complete
 * pubkey book as the response body to every waiting registration (and to
 * master's own caller). Then the HTTP server shuts down.
 *
 * The long-poll pattern means first peers to register wait for the last —
 * one-time bootstrap cost, simpler than separate "fan-out" endpoints.
 *
 * Error responses:
 *   400 — bad body / pubkey format / partyId mismatch
 *   404 — nodeId not in expected peer list
 *   409 — nodeId already registered
 *   408 — server-side bootstrap timeout (all in-flight waiters get this)
 */

import * as http from 'node:http';
import type { PartyId } from '../core/types';
import type { IdentityKeyPair } from '../transport/identity';
import { toHex } from '../wire/hex';
import {
  buildBook,
  computeFingerprint,
  type PubkeyBook,
  type PubkeyBookEntry,
} from './pubkey-book';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';

export interface MasterBootstrapInputs {
  self: { nodeId: string; partyId: PartyId; identity: IdentityKeyPair };
  /** Peers master expects to register. Does NOT include self. */
  expectedPeers: ReadonlyArray<{ nodeId: string; partyId: PartyId }>;
  bind: string;
  /** Defaults to 30 min. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface MasterBootstrapResult {
  book: PubkeyBook;
  fingerprint: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

/** Single-shot Promise that all registration handlers (and master itself) await. */
class CompletionGate {
  private resolveFn!: (book: PubkeyBook) => void;
  private rejectFn!: (err: Error) => void;
  private settled = false;
  readonly promise: Promise<PubkeyBook>;

  constructor() {
    this.promise = new Promise<PubkeyBook>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // Swallow unhandled rejection until someone awaits — tests spin registrations
    // concurrently with the master, and their register() may throw before anyone
    // attaches the gate's catch.
    this.promise.catch(() => {});
  }

  resolve(book: PubkeyBook): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(book);
  }

  reject(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(err);
  }

  get isSettled(): boolean {
    return this.settled;
  }
}

export async function runMasterBootstrap(
  input: MasterBootstrapInputs,
): Promise<MasterBootstrapResult> {
  const log = input.logger ?? NOOP_LOGGER;
  const { host, port } = parseBind(input.bind);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const expected = new Map<string, PartyId>();
  for (const p of input.expectedPeers) expected.set(p.nodeId, p.partyId);
  const expectedTotal = expected.size + 1; // +1 for master itself

  const registered = new Map<string, PubkeyBookEntry>();
  registered.set(input.self.nodeId, {
    nodeId: input.self.nodeId,
    partyId: input.self.partyId,
    publicKeyHex: toHex(input.self.identity.publicKeyRaw),
  });

  const gate = new CompletionGate();

  const completeIfReady = (): void => {
    if (gate.isSettled) return;
    if (registered.size < expectedTotal) return;
    gate.resolve(buildBook(registered.values()));
  };

  // Single-peer ring: master is already satisfied; resolve before even listening.
  completeIfReady();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, {
      expected,
      registered,
      gate,
      completeIfReady,
      log,
    });
  });

  const timer = setTimeout(() => {
    gate.reject(new Error(`master bootstrap timed out after ${timeoutMs}ms`));
  }, timeoutMs);

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
    server.listen(port, host);
  });

  log.info('master bootstrap: listening', {
    host,
    port,
    expectedTotal,
    alreadyRegistered: registered.size,
  });

  try {
    const book = await gate.promise;
    const fingerprint = await computeFingerprint(book);
    return { book, fingerprint };
  } finally {
    clearTimeout(timer);
    // Graceful shutdown: server.close() stops accepting new connections and
    // closes idle keep-alive conns, but leaves in-flight request handlers
    // alone — they finish writing their responses, THEN the callback fires.
    // Do NOT use closeAllConnections here (that would cut off peer
    // registration responses that haven't flushed yet).
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────

interface HandlerContext {
  expected: Map<string, PartyId>;
  registered: Map<string, PubkeyBookEntry>;
  gate: CompletionGate;
  completeIfReady: () => void;
  log: Logger;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/register') {
    respondJson(res, 404, { error: 'expected POST /register' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    respondJson(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const nodeId = body.node_id ?? body.nodeId;
  const partyIdRaw = body.party_id ?? body.partyId;
  const publicKeyHex = body.public_key_hex ?? body.publicKeyHex;

  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    respondJson(res, 400, { error: "'node_id' missing or empty" });
    return;
  }
  if (typeof partyIdRaw !== 'number' || !Number.isInteger(partyIdRaw) || partyIdRaw < 0) {
    respondJson(res, 400, { error: "'party_id' must be a non-negative integer" });
    return;
  }
  const partyId = partyIdRaw as PartyId;
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length !== 65 * 2) {
    respondJson(res, 400, { error: "'public_key_hex' must be 130 hex chars (65 bytes)" });
    return;
  }
  if (!/^04[0-9a-fA-F]{128}$/.test(publicKeyHex)) {
    respondJson(res, 400, { error: "'public_key_hex' must start with 04 (uncompressed P-256)" });
    return;
  }

  const expectedPartyId = ctx.expected.get(nodeId);
  if (expectedPartyId === undefined) {
    respondJson(res, 404, { error: `unknown node_id '${nodeId}'` });
    return;
  }
  if (expectedPartyId !== partyId) {
    respondJson(res, 400, {
      error: `party_id mismatch for '${nodeId}': expected ${expectedPartyId}, got ${partyId}`,
    });
    return;
  }
  if (ctx.registered.has(nodeId)) {
    respondJson(res, 409, { error: `'${nodeId}' already registered` });
    return;
  }

  ctx.registered.set(nodeId, {
    nodeId,
    partyId,
    publicKeyHex: publicKeyHex.toLowerCase(),
  });
  ctx.log.info('master bootstrap: registered', { nodeId, partyId });
  ctx.completeIfReady();

  // Long-poll: await the single-shot completion gate, respond when it fires.
  try {
    const book = await ctx.gate.promise;
    const fingerprint = await computeFingerprint(book);
    respondJson(res, 200, { book, fingerprint });
  } catch (err) {
    respondJson(res, 408, { error: err instanceof Error ? err.message : String(err) });
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error(`body exceeds ${MAX_BODY_BYTES}`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // Force connection close so the server's `close()` wait doesn't hang on
  // idle keep-alive sockets.
  res.setHeader('connection', 'close');
  res.end(JSON.stringify(body));
}

function parseBind(bind: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(bind);
  if (!m) throw new Error(`runMasterBootstrap: invalid bind '${bind}' — expected 'host:port'`);
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`runMasterBootstrap: invalid port '${m[2]}'`);
  if (host.length === 0) throw new Error(`runMasterBootstrap: host required`);
  return { host, port };
}
