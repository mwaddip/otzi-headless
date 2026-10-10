/**
 * `WebhookGate` — operator-in-the-loop strategy backed by an HTTP POST.
 *
 * Daemon POSTs the `CeremonySpec` as JSON to `url` and expects a JSON body
 * `{"decision": "approve" | "reject"}` in response. `timeout_sec` is ONE
 * deadline for the whole exchange — connect, response headers and the full
 * body read — so an approver that answers early but never finishes cannot
 * outlast it. For human-in-the-loop the approver endpoint is expected to hold
 * the connection open until the operator responds.
 *
 * TOML shape (under `[gate]`, parameters sit directly next to `strategy`):
 *   strategy = "webhook"
 *   url = "https://approver.internal/otzi"
 *   timeout_sec = 86400
 *   bearer_token_env = "APPROVER_TOKEN"   # optional: env var carrying the token
 *
 * The request goes through `node:http` / `node:https` rather than `fetch`:
 * fetch's undici client gives up on a response that is silent for 5 minutes
 * (headers and body timeouts) whatever `timeout_sec` says, which would cap
 * every human approval at 5 minutes.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ConfigError } from '../config/parse';
import { serializeSpec } from './exec';
import type { ApprovalGate, CeremonySpec, Decision } from './types';

/** Response bodies are `{"decision": …}`; anything past this is a misbehaving approver. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** The longest timer Node can set. A larger `timeout_sec` is capped to it instead of firing at once. */
const MAX_TIMER_MS = 2_147_483_647;

export interface WebhookGateConfig {
  url: string;
  timeoutSec: number;
  /** Env var from which to read a Bearer token; sent as `Authorization: Bearer …` when set. */
  bearerTokenEnv?: string;
}

interface HttpResult {
  status: number;
  statusText: string;
  body: string;
}

export class WebhookGate implements ApprovalGate {
  constructor(private readonly config: WebhookGateConfig) {}

  async approve(spec: CeremonySpec): Promise<Decision> {
    const { url, timeoutSec, bearerTokenEnv } = this.config;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearerTokenEnv) {
      const token = process.env[bearerTokenEnv];
      if (!token) throw new Error(`WebhookGate: env var '${bearerTokenEnv}' is empty or unset`);
      headers.authorization = `Bearer ${token}`;
    }

    const res = await postJson(url, headers, serializeSpec(spec), timeoutSec);

    if (res.status < 200 || res.status > 299) {
      const body = res.body.slice(0, 500);
      throw new Error(`WebhookGate: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      throw new Error(`WebhookGate: response is not JSON: ${(err as Error).message}`);
    }
    const decision = (parsed as Record<string, unknown>)?.decision;
    if (decision === 'approve' || decision === 'reject') return decision;
    throw new Error(`WebhookGate: unexpected decision ${JSON.stringify(decision)} — expected 'approve' or 'reject'`);
  }
}

/**
 * POST `payload` to `url` and collect the response, all within `timeoutSec`.
 * On expiry the request is destroyed. Redirects are not followed (a 3xx is a
 * non-2xx result). The body is read up to `MAX_RESPONSE_BYTES`.
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  payload: string,
  timeoutSec: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`WebhookGate: request failed: ${(err as Error).message}`));
      return;
    }
    const send = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : undefined;
    if (!send) {
      reject(new Error(`WebhookGate: request failed: unsupported protocol '${target.protocol}'`));
      return;
    }

    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle();
    };
    const fail = (message: string): void =>
      finish(() => {
        req.destroy();
        reject(new Error(message));
      });

    const timer = setTimeout(
      () => fail(`WebhookGate: timed out after ${timeoutSec}s`),
      Math.min(timeoutSec * 1000, MAX_TIMER_MS),
    );

    const req = send(
      target,
      // A fresh connection per ceremony: no pooled socket to go stale during a long hold.
      { method: 'POST', agent: false, headers: { ...headers, 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
            return;
          }
          // Too much. An error status still reports itself, truncated; a 2xx body is refused.
          if (status >= 200 && status <= 299) fail(`WebhookGate: response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
          else
            finish(() => {
              req.destroy();
              resolve({ status, statusText: res.statusMessage ?? '', body: Buffer.concat(chunks).toString('utf8') });
            });
        });
        res.on('end', () =>
          finish(() =>
            resolve({ status, statusText: res.statusMessage ?? '', body: Buffer.concat(chunks).toString('utf8') }),
          ),
        );
        res.on('error', (err) => fail(`WebhookGate: request failed: ${err.message}`));
        res.on('close', () => {
          if (!res.complete) fail('WebhookGate: request failed: connection closed before the response ended');
        });
      },
    );
    req.on('error', (err) => fail(`WebhookGate: request failed: ${err.message}`));
    req.end(payload);
  });
}

const KNOWN_KEYS = new Set(['url', 'timeout_sec', 'bearer_token_env']);

export function parseWebhookParams(params: Record<string, unknown>): WebhookGateConfig {
  for (const key of Object.keys(params)) {
    if (!KNOWN_KEYS.has(key))
      throw new ConfigError(`gate.${key}`, `unknown webhook field (expected one of ${[...KNOWN_KEYS].join(', ')})`);
  }

  if (typeof params.url !== 'string' || params.url.length === 0)
    throw new ConfigError('gate.url', 'must be a non-empty string');
  if (typeof params.timeout_sec !== 'number' || !Number.isFinite(params.timeout_sec) || params.timeout_sec <= 0)
    throw new ConfigError('gate.timeout_sec', 'must be a positive number (seconds)');

  const out: WebhookGateConfig = {
    url: params.url,
    timeoutSec: params.timeout_sec,
  };
  if (params.bearer_token_env !== undefined) {
    if (typeof params.bearer_token_env !== 'string')
      throw new ConfigError('gate.bearer_token_env', 'must be a string');
    out.bearerTokenEnv = params.bearer_token_env;
  }
  return out;
}
