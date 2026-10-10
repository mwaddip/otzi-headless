// Standalone external gate approver for the otzi-headless daemon.
//
// The daemon's `webhook` gate POSTs the ceremony spec (JSON) to this service and
// waits for `{ "decision": "approve" | "reject" }` in the response. This service
// holds that response open until the operator signs the decision with a Bitcoin
// message signature from one pinned address, in any wallet that signs messages.
//
// The daemon knows nothing about message signatures: it sees only the decision.
// The verification lives here, so the auth scheme can be swapped without touching
// the daemon.
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
//
// `createApprover` builds the server without listening, for tests and for embedding.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isValidSignInAddress } from '../../src/otzi/backend/btc-message.ts';
import { decisionMessage, verifyDecision } from './decision.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SIGNATURE_CHARS = 4096;
const MAX_PENDING = 100;
/** Ceremony ids on the wire (`^[A-Za-z0-9._:-]{1,128}$`); also keeps the signed message free of odd characters. */
const CEREMONY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;

export interface ApproverOptions {
  /** The one Bitcoin address whose message signatures count. */
  address: string;
  /** When set, `POST /webhook` requires `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * The host the server will listen on (default `127.0.0.1`). On a loopback host the
   * approver also refuses requests whose `Host` header is not a loopback name for its
   * port, which stops DNS rebinding from reading `/pending` through a browser.
   */
  host?: string;
  /** The operator page. Defaults to the sibling `index.html`. */
  html?: string;
  /** Receives one line per event. Defaults to `console.log`. */
  log?: (line: string) => void;
}

export interface Approver {
  /** Not listening yet: call `server.listen(port, host)`. */
  server: Server;
  /** Answers every held request with 503 (the daemon's gate rejects) and stops accepting connections. */
  shutdown(): void;
}

interface Pending {
  ceremonyId: string;
  spec: Record<string, unknown>;
  receivedAt: string;
  /** The daemon's held webhook response. */
  res: ServerResponse;
}

export function createApprover(opts: ApproverOptions): Approver {
  const { address, token } = opts;
  if (!isValidSignInAddress(address)) throw new Error(`not a valid Bitcoin address: '${address}'`);
  const html = opts.html ?? readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
  const log = opts.log ?? ((line: string) => console.log(line));
  const loopbackOnly = isLoopbackHost(opts.host ?? '127.0.0.1');

  /** nonce → held webhook request. A nonce is deleted when its decision lands, so it works once. */
  const pending = new Map<string, Pending>();

  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      log(`approver: internal error: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { error: 'internal error' });
    }
  });

  function route(req: IncomingMessage, res: ServerResponse): void {
    const refusal = browserBoundary(req);
    if (refusal) return sendJson(res, 403, { error: refusal });

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://approver.invalid').pathname;
    } catch {
      return sendJson(res, 400, { error: 'bad request target' });
    }
    const target = `${req.method} ${pathname}`;

    if (target === 'GET /' || target === 'GET /index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // The page makes same-origin requests only and loads nothing external.
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(html);
    } else if (target === 'GET /pending') {
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
    } else if (target === 'POST /webhook') {
      handle(res, () => onWebhook(req, res));
    } else if (target === 'POST /decide') {
      handle(res, () => onDecide(req, res));
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  }

  /**
   * What a web page could do that the daemon and the operator's own page do not. The
   * daemon sends no `Origin` header; the page's same-origin requests send their own.
   * Returns the refusal reason, or undefined when the request may proceed.
   */
  function browserBoundary(req: IncomingMessage): string | undefined {
    const host = req.headers.host?.toLowerCase();
    if (loopbackOnly) {
      const port = (server.address() as AddressInfo | null)?.port;
      const names = ['localhost', '127.0.0.1', '[::1]'];
      const allowed = new Set(names.map((n) => `${n}:${port}`));
      if (port === 80) for (const n of names) allowed.add(n);
      if (host === undefined || !allowed.has(host))
        return 'Host header is not a loopback name for this port (this approver listens on a loopback address)';
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ownOrigin = false;
      try {
        ownOrigin = host !== undefined && new URL(origin).host.toLowerCase() === host;
      } catch {
        /* an unparseable Origin, such as "null", is not ours */
      }
      if (!ownOrigin) return 'cross-origin request refused';
    }
    return undefined;
  }

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
    pending.set(nonce, { ceremonyId, spec, receivedAt: new Date().toISOString(), res });
    log(`approver: pending ${spec.kind} '${ceremonyId}' (nonce ${nonce})`);

    // The daemon gave up (its timeout_sec passed or it restarted): nothing left to answer.
    res.on('close', () => {
      if (pending.delete(nonce)) log(`approver: daemon closed the request, dropped '${ceremonyId}' (nonce ${nonce})`);
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
    if (!entry)
      return sendJson(res, 404, { error: 'no pending request with this nonce (decided already, or the daemon gave up)' });

    const ok = verifyDecision({ address, decision, ceremonyId: entry.ceremonyId, nonce, signature });
    if (!ok) {
      log(`approver: rejected a bad ${decision} signature for '${entry.ceremonyId}'`);
      return sendJson(res, 403, { error: 'signature does not verify for this address, decision, ceremony and nonce' });
    }

    pending.delete(nonce);
    sendJson(entry.res, 200, { decision });
    log(`approver: ${decision} '${entry.ceremonyId}' (nonce ${nonce})`);
    sendJson(res, 200, { ok: true, ceremonyId: entry.ceremonyId, decision });
  }

  /** Runs an async handler; an escaped HttpError or other error becomes an error response. */
  function handle(res: ServerResponse, fn: () => Promise<void>): void {
    fn().catch((err: unknown) => {
      if (err instanceof HttpError) {
        res.setHeader('connection', 'close');
        sendJson(res, err.status, { error: err.message });
      } else {
        log(`approver: internal error: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: 'internal error' });
      }
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

  return {
    server,
    shutdown() {
      for (const p of pending.values()) sendJson(p.res, 503, { error: 'approver shutting down' });
      pending.clear();
      server.close();
      server.closeIdleConnections();
    },
  };
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** localhost, 127.0.0.0/8 or ::1. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
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

function fail(message: string): never {
  console.error(`approver: ${message}`);
  process.exit(1);
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

// ── Running it ───────────────────────────────────────────────────────────────

function main(): void {
  const address = process.env.APPROVER_ADDRESS?.trim() ?? '';
  if (!address) fail('APPROVER_ADDRESS is required (the Bitcoin address whose message signatures count)');
  if (!isValidSignInAddress(address)) fail(`APPROVER_ADDRESS is not a valid Bitcoin address: '${address}'`);
  const token = process.env.APPROVER_TOKEN || undefined;
  const { host, port } = parseListen(process.env.APPROVER_LISTEN ?? '127.0.0.1:8181');

  const approver = createApprover({ address, ...(token !== undefined ? { token } : {}), host });
  approver.server.on('error', (err) => fail(`cannot listen on ${host}:${port}: ${err.message}`));
  approver.server.listen(port, host, () => {
    const a = approver.server.address();
    const where = a && typeof a === 'object' ? `${a.address}:${a.port}` : `${host}:${port}`;
    console.log(`approver: listening on http://${where}, pinned operator address ${address}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`approver: ${sig}, shutting down`);
      approver.server.once('close', () => process.exit(0));
      approver.shutdown();
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

/** True when this file is the entry point (`npx tsx …/approver.ts`), not when a test imports it. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
