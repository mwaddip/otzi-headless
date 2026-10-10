// Standalone external gate approver for the otzi-headless daemon.
//
// The daemon's `webhook` gate POSTs the ceremony spec (JSON) to this service and
// waits for `{ "decision": "approve" | "reject" }` in the response. This service
// holds that response open until the operator signs the decision with a Bitcoin
// message signature from one pinned address, in any wallet that signs messages.
//
// The daemon knows nothing about message signatures: it sees only the decision.
// The verification lives here, so the auth scheme can be swapped without touching
// the daemon. A held request sends its 200 headers at once and a space every 30 s
// (see KEEPALIVE_MS), then the JSON body when the operator decides.
//
//   daemon ──POST /webhook (spec)──▶ approver ── holds the response ──┐
//                                       ▲                             │
//   operator's browser: GET /  GET /pending  POST /decide (signed)    │
//                                       └──── verifies, then ─────────┘
//                                             { decision } ──▶ daemon
//
// Daemon config (parameters sit directly under [gate]):
//
//   [gate]
//   strategy         = "webhook"
//   url              = "http://approver:8181/webhook"
//   timeout_sec      = 86400
//   bearer_token_env = "APPROVER_TOKEN"     # optional
//
// Environment:
//   APPROVER_ADDRESS   Bitcoin address whose signatures count (REQUIRED).
//   APPROVER_LISTEN    host:port to listen on (default 127.0.0.1:8181).
//   APPROVER_TOKEN     optional; when set, POST /webhook requires
//                      `Authorization: Bearer <token>`.
//
// Run from the repo root:  npx tsx examples/gate-web-btc-message/approver.ts

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { isValidSignInAddress } from '../../src/otzi/backend/btc-message.ts';
import { decisionMessage, verifyDecision } from './decision.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SIGNATURE_CHARS = 4096;
const MAX_PENDING = 100;
/**
 * The daemon's HTTP client (Node's fetch) abandons a request that receives no response
 * headers, or no body bytes, for 5 minutes, whatever `timeout_sec` says. A held request
 * therefore sends its headers at once and a space every 30 s (JSON allows leading
 * whitespace) until the decision arrives.
 */
const KEEPALIVE_MS = 30_000;
/** Ceremony ids on the wire (`^[A-Za-z0-9._:-]{1,128}$`); also keeps the signed message free of odd characters. */
const CEREMONY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;

// ── Configuration ────────────────────────────────────────────────────────────

const address = process.env.APPROVER_ADDRESS?.trim() ?? '';
if (!address) fail('APPROVER_ADDRESS is required (the Bitcoin address whose message signatures count)');
if (!isValidSignInAddress(address)) fail(`APPROVER_ADDRESS is not a valid Bitcoin address: '${address}'`);

const token = process.env.APPROVER_TOKEN || undefined;
const { host, port } = parseListen(process.env.APPROVER_LISTEN ?? '127.0.0.1:8181');
const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');

// ── State ────────────────────────────────────────────────────────────────────

interface Pending {
  ceremonyId: string;
  spec: Record<string, unknown>;
  receivedAt: string;
  /** The daemon's held webhook response: 200 headers are out, the JSON body is not. */
  res: ServerResponse;
  keepAlive: NodeJS.Timeout;
}

/** nonce → held webhook request. A nonce is deleted when its decision lands, so it works once. */
const pending = new Map<string, Pending>();

// ── Server ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://approver.invalid');
  const route = `${req.method} ${pathname}`;

  if (route === 'GET /' || route === 'GET /index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // The page makes same-origin requests only and loads nothing external.
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(html);
  } else if (route === 'GET /pending') {
    const items = [...pending].map(([nonce, p]) => ({
      nonce,
      ceremonyId: p.ceremonyId,
      receivedAt: p.receivedAt,
      spec: p.spec,
      // The exact text to sign for each decision.
      messages: {
        approve: decisionMessage('approve', p.ceremonyId, nonce),
        reject: decisionMessage('reject', p.ceremonyId, nonce),
      },
    }));
    sendJson(res, 200, { address, pending: items });
  } else if (route === 'POST /webhook') {
    handle(res, () => onWebhook(req, res));
  } else if (route === 'POST /decide') {
    handle(res, () => onDecide(req, res));
  } else {
    sendJson(res, 404, { error: 'not found' });
  }
});

server.on('error', (err) => fail(`cannot listen on ${host}:${port}: ${err.message}`));
server.listen(port, host, () => {
  const a = server.address();
  const where = a && typeof a === 'object' ? `${a.address}:${a.port}` : `${host}:${port}`;
  console.log(`approver: listening on http://${where}, pinned operator address ${address}`);
});

// The daemon's webhook gate. The response stays open until /decide resolves it.
async function onWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!bearerOk(req)) return sendJson(res, 401, { error: 'missing or wrong bearer token' });

  const body = await readBody(req);
  let spec: unknown;
  try {
    spec = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body is not JSON' });
  }
  if (!isRecord(spec) || typeof spec.ceremonyId !== 'string' || !CEREMONY_ID.test(spec.ceremonyId))
    return sendJson(res, 400, { error: 'spec.ceremonyId is missing or malformed' });
  if (spec.kind !== 'signing' && spec.kind !== 'dkg')
    return sendJson(res, 400, { error: "spec.kind must be 'signing' or 'dkg'" });
  if (pending.size >= MAX_PENDING) return sendJson(res, 503, { error: 'too many pending requests' });
  if (res.destroyed) return; // the daemon already hung up

  const ceremonyId = spec.ceremonyId;
  const nonce = randomBytes(16).toString('hex');
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.flushHeaders();
  const keepAlive = setInterval(() => {
    if (!res.destroyed) res.write(' ');
  }, KEEPALIVE_MS);
  pending.set(nonce, { ceremonyId, spec, receivedAt: new Date().toISOString(), res, keepAlive });
  console.log(`approver: pending ${spec.kind} '${ceremonyId}' (nonce ${nonce})`);

  // The daemon gave up (its timeout_sec passed or it restarted): nothing left to answer.
  res.on('close', () => {
    clearInterval(keepAlive);
    if (pending.delete(nonce)) console.log(`approver: daemon closed the request, dropped '${ceremonyId}' (nonce ${nonce})`);
  });
}

// The operator's signed decision. A decision that does not verify changes nothing.
async function onDecide(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body is not JSON' });
  }
  const { nonce, decision, signature } = isRecord(parsed) ? parsed : ({} as Record<string, unknown>);
  if (typeof nonce !== 'string' || !NONCE_HEX.test(nonce))
    return sendJson(res, 400, { error: 'nonce must be 32 lowercase hex characters' });
  if (decision !== 'approve' && decision !== 'reject')
    return sendJson(res, 400, { error: "decision must be 'approve' or 'reject'" });
  if (typeof signature !== 'string' || signature.trim() === '' || signature.length > MAX_SIGNATURE_CHARS)
    return sendJson(res, 400, { error: 'signature must be a base64 string' });

  const entry = pending.get(nonce);
  if (!entry) return sendJson(res, 404, { error: 'no pending request with this nonce (decided already, or the daemon gave up)' });

  const ok = verifyDecision({ address, decision, ceremonyId: entry.ceremonyId, nonce, signature });
  if (!ok) {
    console.log(`approver: rejected a bad ${decision} signature for '${entry.ceremonyId}'`);
    return sendJson(res, 403, { error: 'signature does not verify for this address, decision, ceremony and nonce' });
  }

  pending.delete(nonce);
  settle(entry, { decision });
  console.log(`approver: ${decision} '${entry.ceremonyId}' (nonce ${nonce})`);
  sendJson(res, 200, { ok: true, ceremonyId: entry.ceremonyId, decision });
}

// Answer held requests with an error body (no `decision`, so the daemon rejects), not a hang.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`approver: ${sig}, shutting down`);
    for (const p of pending.values()) settle(p, { error: 'approver shutting down' });
    pending.clear();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(message: string): never {
  console.error(`approver: ${message}`);
  process.exit(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Runs a handler; an escaped HttpError or other error becomes an error response. */
function handle(res: ServerResponse, fn: () => Promise<void>): void {
  fn().catch((err: unknown) => {
    if (err instanceof HttpError) {
      res.setHeader('connection', 'close');
      sendJson(res, err.status, { error: err.message });
    } else {
      console.error('approver: internal error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  });
}

/** Ends a held webhook response with its JSON body. */
function settle(p: Pending, body: unknown): void {
  clearInterval(p.keepAlive);
  if (!p.res.destroyed && !p.res.writableEnded) p.res.end(JSON.stringify(body));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearerOk(req: IncomingMessage): boolean {
  if (token === undefined) return true;
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Hash first so the comparison is constant-time whatever the lengths.
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

function parseListen(s: string): { host: string; port: number } {
  const idx = s.lastIndexOf(':');
  const rawHost = idx <= 0 ? '' : s.slice(0, idx);
  const port = Number(s.slice(idx + 1));
  if (idx < 0 || !Number.isInteger(port) || port < 0 || port > 65535)
    fail(`APPROVER_LISTEN must be host:port (got '${s}')`);
  // `[::1]:8181` → `::1`
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  return { host: host || '127.0.0.1', port };
}
