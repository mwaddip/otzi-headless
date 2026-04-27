/**
 * Master-side bootstrap.
 *
 * Stands up a short-lived HTTP server on `bind`. Each leaf POSTs its
 * `{ public_key_hex, advertised_endpoint }` to `/register`. Master
 * canonicalizes the incoming `advertised_endpoint` and validates it against
 * an operator-supplied allowlist. Once all expected peers + self have
 * registered, master sorts the collected entries by raw pubkey bytes
 * ascending, assigns `partyId = index`, builds the book, and fans it out
 * as the response to every waiting registration handler.
 *
 * Error responses:
 *   400 — bad body / pubkey format / non-canonical or wildcard endpoint /
 *         legacy `node_id` field present
 *   404 — advertised_endpoint not on the operator's allowlist
 *   409 — endpoint already registered OR pubkey already registered
 *   408 — server-side bootstrap timeout
 */

import * as http from 'node:http';
import type { PartyId } from '../core/types';
import type { IdentityKeyPair } from '../transport/identity';
import { toHex } from '../wire/hex';
import { canonicalizeEndpoint, EndpointParseError } from '../util/endpoint';
import {
  buildBook,
  computeFingerprint,
  type PubkeyBook,
  type PubkeyBookEntry,
} from './pubkey-book';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';

export interface MasterBootstrapInputs {
  self: {
    identity: IdentityKeyPair;
    /** Canonical `host:port` form (post-`canonicalizeEndpoint`). */
    advertisedEndpoint: string;
  };
  /**
   * Allowlist of advertised endpoints master expects to register. Caller
   * MUST pass canonical-form strings (apply `canonicalizeEndpoint` upstream).
   * Does NOT include self.
   */
  expectedPeers: ReadonlyArray<{ advertisedEndpoint: string }>;
  bind: string;
  /** Defaults to 30 min. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface MasterBootstrapResult {
  book: PubkeyBook;
  fingerprint: string;
}

interface RegisteredEntry {
  publicKey: Uint8Array;
  /** Canonical form. */
  advertisedEndpoint: string;
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

  // Allowlist of canonical advertised endpoints (excludes self).
  const expectedAllowlist = new Set<string>(input.expectedPeers.map((p) => p.advertisedEndpoint));
  const expectedTotal = expectedAllowlist.size + 1; // +1 for self

  // registered keyed by canonical advertisedEndpoint
  const registered = new Map<string, RegisteredEntry>();
  registered.set(input.self.advertisedEndpoint, {
    publicKey: input.self.identity.publicKeyRaw,
    advertisedEndpoint: input.self.advertisedEndpoint,
  });

  const gate = new CompletionGate();

  const completeIfReady = (): void => {
    if (gate.isSettled) return;
    if (registered.size < expectedTotal) return;

    // Sort registered entries by raw pubkey bytes ascending — deterministic
    // partyId assignment that all peers reproduce locally from the same book.
    const sorted = [...registered.values()].sort((a, b) =>
      Buffer.compare(Buffer.from(a.publicKey), Buffer.from(b.publicKey)),
    );
    const entries: PubkeyBookEntry[] = sorted.map((r, idx) => ({
      partyId: idx as PartyId,
      publicKeyHex: toHex(r.publicKey),
      advertisedEndpoint: r.advertisedEndpoint,
    }));
    gate.resolve(buildBook(entries));
  };

  // Single-peer ring: master alone satisfies expectedTotal=1.
  completeIfReady();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, {
      expectedAllowlist,
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────

interface HandlerContext {
  expectedAllowlist: Set<string>;
  registered: Map<string, RegisteredEntry>;
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

  if ('node_id' in body || 'nodeId' in body) {
    respondJson(res, 400, {
      error: "'node_id' is no longer supported in the register payload",
    });
    return;
  }

  const publicKeyHex = body.public_key_hex ?? body.publicKeyHex;
  const rawEndpoint = body.advertised_endpoint ?? body.advertisedEndpoint;

  if (typeof publicKeyHex !== 'string' || publicKeyHex.length !== 65 * 2) {
    respondJson(res, 400, { error: "'public_key_hex' must be 130 hex chars (65 bytes)" });
    return;
  }
  if (!/^04[0-9a-fA-F]{128}$/.test(publicKeyHex)) {
    respondJson(res, 400, { error: "'public_key_hex' must start with 04 (uncompressed P-256)" });
    return;
  }
  if (typeof rawEndpoint !== 'string' || rawEndpoint.length === 0) {
    respondJson(res, 400, { error: "'advertised_endpoint' missing or empty" });
    return;
  }

  let advertisedEndpoint: string;
  try {
    advertisedEndpoint = canonicalizeEndpoint(rawEndpoint);
  } catch (err) {
    if (err instanceof EndpointParseError) {
      respondJson(res, 400, { error: `invalid advertised_endpoint: ${err.message}` });
      return;
    }
    throw err;
  }

  if (!ctx.expectedAllowlist.has(advertisedEndpoint)) {
    respondJson(res, 404, {
      error: `advertised_endpoint '${advertisedEndpoint}' not on expected-peer allowlist`,
    });
    return;
  }
  if (ctx.registered.has(advertisedEndpoint)) {
    respondJson(res, 409, { error: `endpoint '${advertisedEndpoint}' already registered` });
    return;
  }

  // Pubkey-collision check across already-registered entries (incl. self).
  const lowerHex = publicKeyHex.toLowerCase();
  for (const r of ctx.registered.values()) {
    if (toHex(r.publicKey).toLowerCase() === lowerHex) {
      respondJson(res, 409, { error: `publicKey already registered for a different endpoint` });
      return;
    }
  }

  ctx.registered.set(advertisedEndpoint, {
    publicKey: new Uint8Array(Buffer.from(lowerHex, 'hex')),
    advertisedEndpoint,
  });
  ctx.log.info('master bootstrap: registered', { advertisedEndpoint });
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
