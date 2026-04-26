/**
 * `UdsTrigger` — operator API endpoint over a Unix domain socket.
 *
 * Mirrors `HttpTrigger`'s shape (same `HttpHandler` contract, same JSON body
 * parsing, same 1 MB cap) but binds to a UDS path instead of host:port. The
 * filesystem permission of the socket file IS the auth model — no Bearer
 * token, no host check, no peer-credential introspection. Group membership
 * (e.g. `otzi`) gates access via parent-dir setgid + 0660 socket mode.
 *
 * The CLI talks to this via Node's `http.request({ socketPath })` — HTTP/1.1
 * framing over a Unix socket, identical to TCP loopback in terms of wire
 * shape.
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import type {
  HttpHandler,
  HttpRequest,
  HttpResponse,
  TriggerSource,
  UdsTriggerConfig,
} from './types';

const MAX_BODY_BYTES = 1 << 20; // 1 MB; matches HttpTrigger.

export class UdsTrigger implements TriggerSource {
  private readonly socketPath: string;
  private readonly handler: HttpHandler;
  private readonly log: Logger;
  private server: http.Server | null = null;

  constructor(config: UdsTriggerConfig) {
    if (typeof config.path !== 'string' || !config.path.startsWith('/'))
      throw new Error(`UdsTrigger: path must be an absolute string (got '${config.path}')`);
    this.socketPath = config.path;
    this.handler = config.handler;
    this.log = config.logger ?? NOOP_LOGGER;
  }

  async start(): Promise<void> {
    if (this.server) return;

    // Remove any stale socket file from an unclean prior shutdown. Ignore
    // ENOENT; rethrow other errors (permission, EISDIR, etc.).
    try {
      await fs.unlink(this.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
      server.listen(this.socketPath);
    });

    this.log.info('UdsTrigger: listening', { path: this.socketPath });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
    try {
      await fs.unlink(this.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.log.info('UdsTrigger: stopped');
  }

  address(): { path: string } | null {
    if (!this.server) return null;
    return { path: this.socketPath };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    try {
      const body = await readBody(req);
      const parsed = parseBody(req, body);
      if (parsed === JSON_PARSE_ERROR) {
        return respondJson(res, 400, { error: 'invalid JSON body' });
      }

      const headers = Object.freeze(
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
        headers,
        body: parsed,
      };

      let response: HttpResponse;
      try {
        response = await this.handler(httpReq);
      } catch (err) {
        this.log.error('UdsTrigger: handler threw', { requestId, err: errString(err) });
        return respondJson(res, 500, { error: 'internal handler error' });
      }
      respondJson(res, response.status, response.body);
    } catch (err) {
      this.log.error('UdsTrigger: pipeline errored', { requestId, err: errString(err) });
      if (!res.headersSent) respondJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  }
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
