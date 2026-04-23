/**
 * `HttpTrigger` — small local HTTP endpoint that forwards incoming requests
 * to a caller-supplied handler. Built on `node:http` (zero deps).
 *
 * Scope:
 *   - Bind to a specific `host:port` (host required — no 0.0.0.0 defaults).
 *   - Optional Bearer-token auth, token read from a named env var at start.
 *   - JSON request bodies (up to `MAX_BODY_BYTES`).
 *   - The handler owns all ceremony-specific logic; this module is generic.
 *
 * Not in scope: HTTPS / mTLS / HTTP/2 — operator configures those via a
 * fronting reverse proxy or an OS-level firewall. Phase 5d sticks with
 * loopback HTTP + optional shared-secret auth; that's the common daemon
 * shape and it composes with standard infra.
 */

import * as http from 'node:http';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import type { HttpHandler, HttpRequest, HttpResponse, HttpTriggerConfig, TriggerSource } from './types';

const MAX_BODY_BYTES = 1 << 20; // 1 MB

export class HttpTrigger implements TriggerSource {
  private readonly host: string;
  private readonly port: number;
  private readonly handler: HttpHandler;
  private readonly authTokenEnv: string | undefined;
  private readonly log: Logger;
  private server: http.Server | null = null;
  private authToken: string | undefined;

  constructor(config: HttpTriggerConfig) {
    const { host, port } = parseBind(config.bind);
    this.host = host;
    this.port = port;
    this.handler = config.handler;
    this.authTokenEnv = config.authTokenEnv;
    this.log = config.logger ?? NOOP_LOGGER;
  }

  async start(): Promise<void> {
    if (this.server) return;

    if (this.authTokenEnv) {
      const token = process.env[this.authTokenEnv];
      if (!token)
        throw new Error(`HttpTrigger: env var '${this.authTokenEnv}' is not set — cannot start without auth token`);
      this.authToken = token;
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

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
      server.listen(this.port, this.host);
    });

    this.log.info('HttpTrigger: listening', { host: this.host, port: this.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      // Don't wait for idle connections — cut them loose for fast shutdown.
      server.closeAllConnections?.();
    });
    this.log.info('HttpTrigger: stopped');
  }

  /** Active listen address, only valid after `start()` completes. Useful for tests binding to port 0. */
  address(): { host: string; port: number } | null {
    const server = this.server;
    if (!server) return null;
    const addr = server.address();
    if (addr === null || typeof addr === 'string') return null;
    return { host: addr.address, port: addr.port };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    try {
      if (this.authToken) {
        const auth = headerString(req.headers.authorization);
        if (auth !== `Bearer ${this.authToken}`) {
          return respondJson(res, 401, { error: 'unauthorized' });
        }
      }

      const body = await readBody(req);
      const parsedBody = parseBody(req, body);
      if (parsedBody === JSON_PARSE_ERROR) {
        return respondJson(res, 400, { error: 'invalid JSON body' });
      }

      const normalizedHeaders = Object.freeze(
        Object.fromEntries(
          Object.entries(req.headers)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]),
        ),
      );

      const httpReq: HttpRequest = {
        requestId,
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: normalizedHeaders,
        body: parsedBody,
      };

      let response: HttpResponse;
      try {
        response = await this.handler(httpReq);
      } catch (err) {
        this.log.error('HttpTrigger: handler threw', { requestId, err: errString(err) });
        return respondJson(res, 500, { error: 'internal handler error' });
      }

      respondJson(res, response.status, response.body);
    } catch (err) {
      this.log.error('HttpTrigger: request pipeline errored', { requestId, err: errString(err) });
      if (!res.headersSent) respondJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function parseBind(bind: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(bind);
  if (!m)
    throw new Error(`HttpTrigger: invalid bind '${bind}' — expected 'host:port'`);
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`HttpTrigger: invalid port '${m[2]}' in bind '${bind}'`);
  if (host.length === 0)
    throw new Error(`HttpTrigger: host required in bind '${bind}' (no binding to all interfaces)`);
  return { host, port };
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

const JSON_PARSE_ERROR = Symbol('JSON_PARSE_ERROR');

function parseBody(req: http.IncomingMessage, raw: Buffer): unknown | typeof JSON_PARSE_ERROR {
  if (raw.length === 0) return null;
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (ct.startsWith('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return JSON_PARSE_ERROR;
    }
  }
  return raw.toString('utf8');
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
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
  if (body === undefined) res.end();
  else res.end(JSON.stringify(body));
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
