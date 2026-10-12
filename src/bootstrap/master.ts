/**
 * Master-side bootstrap.
 *
 * Stands up a short-lived HTTP server on `bind`. Each leaf POSTs its
 * `public_key_hex` to `/register`, and admission decides who gets in:
 *
 *   - `endpoints` (peer-mesh): the leaf also sends `advertised_endpoint`,
 *     which master canonicalizes and checks against the operator-supplied
 *     allowlist (`[[peers]]`). Every book entry carries its endpoint.
 *   - `count` (relay): the leaf sends no endpoint; master admits the first
 *     `parties − 1` distinct pubkeys. No book entry carries an endpoint.
 *
 * Once the expected total (self included) has registered, master sorts the
 * collected entries by raw pubkey bytes ascending, assigns
 * `partyId = index`, builds the book, and fans it out as the response to
 * every waiting registration handler.
 *
 * Error responses:
 *   400 — bad body / pubkey format / legacy `node_id` field present;
 *         endpoints: missing, non-canonical or wildcard endpoint;
 *         count: any `advertised_endpoint` key
 *   404 — endpoints: advertised_endpoint not on the operator's allowlist
 *   409 — endpoints: endpoint OR pubkey already registered;
 *         count: pubkey already registered (the leader's own included),
 *         or `bootstrap is full`
 *   408 — server-side bootstrap timeout (names received vs expected)
 */

import * as http from 'node:http';
import type { PartyId } from '../core/types';
import type { IdentityKeyPair } from '../transport/identity';
import { toHex } from '../otzi/lib/hex';
import { canonicalizeEndpoint, EndpointParseError } from '../util/endpoint';
import {
  buildBook,
  computeFingerprint,
  keyId,
  type PubkeyBook,
  type PubkeyBookEntry,
} from './pubkey-book';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';

/**
 * Refusals `register.ts` maps to operator messages. The member matches these
 * constants, so a rewording here cannot silently break the mapping.
 */
/** 400, endpoints admission: the registration carries no endpoint (a relay member at a peer-mesh leader). */
export const ENDPOINT_MISSING_ERROR = "'advertised_endpoint' missing or empty";
/** 400, count admission: the registration carries an endpoint (a peer-mesh member at a relay leader). */
export const ENDPOINT_IN_RELAY_ERROR = "'advertised_endpoint' not used in relay mode";
/** 409, count admission: `parties` registrations are already in. */
export const BOOTSTRAP_FULL_ERROR = 'bootstrap is full';

/** Who the leader admits. */
export type MasterAdmission =
  | {
      /** Peer-mesh: an allowlist of advertised endpoints. */
      kind: 'endpoints';
      /** This node's endpoint, canonical `host:port` (post-`canonicalizeEndpoint`). */
      selfEndpoint: string;
      /**
       * Every other node's endpoint (from `[[peers]]`). Caller MUST pass
       * canonical-form strings. Does NOT include self.
       */
      expectedPeers: ReadonlyArray<{ advertisedEndpoint: string }>;
    }
  | {
      /** Relay: the first `parties − 1` distinct pubkeys, registering with no endpoint. */
      kind: 'count';
      /** Ring size, self included. An integer ≥ 2. */
      parties: number;
    };

export interface MasterBootstrapInputs {
  self: { identity: IdentityKeyPair };
  admission: MasterAdmission;
  bind: string;
  /** Defaults to 30 min. */
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Registrations the leader refused, one per refused request, by reason (facts/bootstrap.md,
 * `MasterRefusals`). Requests refused before admission (wrong path, invalid JSON, a legacy
 * `node_id`, a malformed pubkey) are not registrations and are not counted.
 */
export interface MasterRefusals {
  /** Count admission: 409 `bootstrap is full`. */
  full: number;
  /** 409: a pubkey already registered or the leader's own; endpoints admission: an endpoint already registered. */
  duplicate: number;
  /** Count admission: 400, the body carried an endpoint. */
  endpointPresent: number;
  /** Endpoints admission: 404 off the allowlist, or 400 for a missing or invalid endpoint. */
  notAllowed: number;
}

export interface MasterBootstrapResult {
  book: PubkeyBook;
  fingerprint: string;
  /** Taken after the server closed: it includes refusals answered while connections drained. */
  refused: MasterRefusals;
}

interface RegisteredEntry {
  publicKey: Uint8Array;
  /** Canonical form. Endpoints admission only; absent under count admission. */
  advertisedEndpoint?: string;
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
  const { admission } = input;
  const selfPublicKey = input.self.identity.publicKeyRaw;

  // Endpoints: the allowlist of canonical advertised endpoints (excludes self).
  // Count: no allowlist; `parties` registrations in total.
  let expectedAllowlist: Set<string> | null = null;
  let expectedTotal: number; // self included
  // Registrations, self pre-registered: keyed by canonical endpoint
  // (endpoints admission) or by lowercase pubkey hex (count admission).
  const registered = new Map<string, RegisteredEntry>();
  if (admission.kind === 'endpoints') {
    expectedAllowlist = new Set<string>(admission.expectedPeers.map((p) => p.advertisedEndpoint));
    expectedTotal = expectedAllowlist.size + 1;
    registered.set(admission.selfEndpoint, {
      publicKey: selfPublicKey,
      advertisedEndpoint: admission.selfEndpoint,
    });
  } else {
    if (!Number.isInteger(admission.parties) || admission.parties < 2)
      throw new Error(
        `runMasterBootstrap: count admission needs parties to be an integer >= 2 (got ${admission.parties})`,
      );
    expectedTotal = admission.parties;
    registered.set(toHex(selfPublicKey), { publicKey: selfPublicKey });
  }

  const gate = new CompletionGate();
  const refused: MasterRefusals = { full: 0, duplicate: 0, endpointPresent: 0, notAllowed: 0 };

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
      ...(r.advertisedEndpoint !== undefined ? { advertisedEndpoint: r.advertisedEndpoint } : {}),
    }));
    gate.resolve(buildBook(entries));
  };

  // Single-peer ring (endpoints admission, no expected peers): master alone
  // satisfies expectedTotal=1.
  completeIfReady();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, {
      expectedAllowlist,
      expectedTotal,
      selfPublicKeyHex: toHex(selfPublicKey),
      registered,
      gate,
      completeIfReady,
      refused,
      log,
    });
  });

  const timer = setTimeout(() => {
    // Counts exclude self, so a leader whose `parties` is too high sees the shortfall.
    gate.reject(
      new Error(
        `master bootstrap timed out after ${timeoutMs}ms: received ${registered.size - 1} of ${expectedTotal - 1} registrations`,
      ),
    );
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
    admission: admission.kind,
    expectedTotal,
    alreadyRegistered: registered.size,
  });

  let book: PubkeyBook;
  let fingerprint: string;
  try {
    book = await gate.promise;
    fingerprint = await computeFingerprint(book);
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  // After the close: a registration that was still in flight has been answered and counted.
  return { book, fingerprint, refused: { ...refused } };
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────

interface HandlerContext {
  /** Endpoints admission: the allowlist. `null` under count admission. */
  expectedAllowlist: Set<string> | null;
  /** Registrations needed in total, self included. */
  expectedTotal: number;
  /** Lowercase. */
  selfPublicKeyHex: string;
  registered: Map<string, RegisteredEntry>;
  gate: CompletionGate;
  completeIfReady: () => void;
  /** Counted per refused registration. */
  refused: MasterRefusals;
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

  if (typeof publicKeyHex !== 'string' || publicKeyHex.length !== 65 * 2) {
    respondJson(res, 400, { error: "'public_key_hex' must be 130 hex chars (65 bytes)" });
    return;
  }
  if (!/^04[0-9a-fA-F]{128}$/.test(publicKeyHex)) {
    respondJson(res, 400, { error: "'public_key_hex' must start with 04 (uncompressed P-256)" });
    return;
  }

  const lowerHex = publicKeyHex.toLowerCase();
  const admitted =
    ctx.expectedAllowlist === null
      ? admitByCount(res, body, lowerHex, ctx)
      : admitByEndpoint(res, body, lowerHex, ctx.expectedAllowlist, ctx);
  if (!admitted) return;

  // Long-poll: await the single-shot completion gate, respond when it fires.
  try {
    const book = await ctx.gate.promise;
    const fingerprint = await computeFingerprint(book);
    respondJson(res, 200, { book, fingerprint });
  } catch (err) {
    respondJson(res, 408, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Count admission (relay): no endpoint, a pubkey not yet registered, and a
 * free slot. Registers and returns `true`, or responds with the refusal and
 * returns `false`.
 */
function admitByCount(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  lowerHex: string,
  ctx: HandlerContext,
): boolean {
  if ('advertised_endpoint' in body || 'advertisedEndpoint' in body) {
    ctx.refused.endpointPresent++;
    respondJson(res, 400, { error: ENDPOINT_IN_RELAY_ERROR });
    return false;
  }
  // Before the count: a node that registers twice is told it is already in.
  if (lowerHex === ctx.selfPublicKeyHex) {
    ctx.refused.duplicate++;
    respondJson(res, 409, { error: "publicKey already registered (it is the leader's own key)" });
    return false;
  }
  if (ctx.registered.has(lowerHex)) {
    ctx.refused.duplicate++;
    respondJson(res, 409, { error: 'publicKey already registered' });
    return false;
  }
  if (ctx.registered.size >= ctx.expectedTotal) {
    ctx.refused.full++;
    ctx.log.warn('master bootstrap: refused a registration, the ring is full', { keyId: keyId(lowerHex) });
    respondJson(res, 409, { error: BOOTSTRAP_FULL_ERROR });
    return false;
  }

  ctx.registered.set(lowerHex, { publicKey: new Uint8Array(Buffer.from(lowerHex, 'hex')) });
  ctx.log.info('master bootstrap: registered', {
    keyId: keyId(lowerHex),
    registered: ctx.registered.size,
    expectedTotal: ctx.expectedTotal,
  });
  ctx.completeIfReady();
  return true;
}

/**
 * Endpoints admission (peer-mesh): a canonical endpoint on the allowlist, not
 * yet registered, with a pubkey not yet registered. Registers and returns
 * `true`, or responds with the refusal and returns `false`.
 */
function admitByEndpoint(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  lowerHex: string,
  expectedAllowlist: Set<string>,
  ctx: HandlerContext,
): boolean {
  const rawEndpoint = body.advertised_endpoint ?? body.advertisedEndpoint;
  if (typeof rawEndpoint !== 'string' || rawEndpoint.length === 0) {
    ctx.refused.notAllowed++;
    respondJson(res, 400, { error: ENDPOINT_MISSING_ERROR });
    return false;
  }

  let advertisedEndpoint: string;
  try {
    advertisedEndpoint = canonicalizeEndpoint(rawEndpoint);
  } catch (err) {
    if (err instanceof EndpointParseError) {
      ctx.refused.notAllowed++;
      respondJson(res, 400, { error: `invalid advertised_endpoint: ${err.message}` });
      return false;
    }
    throw err;
  }

  if (!expectedAllowlist.has(advertisedEndpoint)) {
    ctx.refused.notAllowed++;
    respondJson(res, 404, {
      error: `advertised_endpoint '${advertisedEndpoint}' not on expected-peer allowlist`,
    });
    return false;
  }
  if (ctx.registered.has(advertisedEndpoint)) {
    ctx.refused.duplicate++;
    respondJson(res, 409, { error: `endpoint '${advertisedEndpoint}' already registered` });
    return false;
  }

  // Pubkey-collision check across already-registered entries (incl. self).
  for (const r of ctx.registered.values()) {
    if (toHex(r.publicKey).toLowerCase() === lowerHex) {
      ctx.refused.duplicate++;
      respondJson(res, 409, { error: `publicKey already registered for a different endpoint` });
      return false;
    }
  }

  ctx.registered.set(advertisedEndpoint, {
    publicKey: new Uint8Array(Buffer.from(lowerHex, 'hex')),
    advertisedEndpoint,
  });
  ctx.log.info('master bootstrap: registered', { advertisedEndpoint });
  ctx.completeIfReady();
  return true;
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
