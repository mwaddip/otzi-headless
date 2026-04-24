/**
 * `WebhookGate` — operator-in-the-loop strategy backed by an HTTP POST.
 *
 * Daemon POSTs the `CeremonySpec` as JSON to `url` and expects a JSON body
 * `{"decision": "approve" | "reject"}` in response. The request blocks for
 * up to `timeout_sec` — for human-in-the-loop the approver endpoint is
 * expected to hold the connection open until the operator responds.
 *
 * TOML shape (under `[gate]`):
 *   strategy = "webhook"
 *   [gate.params]
 *   url = "https://approver.internal/otzi"
 *   timeout_sec = 86400
 *   bearer_token_env = "APPROVER_TOKEN"   # optional: env var carrying the token
 */

import { ConfigError } from '../config/parse';
import { serializeSpec } from './exec';
import type { ApprovalGate, CeremonySpec, Decision } from './types';

export interface WebhookGateConfig {
  url: string;
  timeoutSec: number;
  /** Env var from which to read a Bearer token; sent as `Authorization: Bearer …` when set. */
  bearerTokenEnv?: string;
}

export class WebhookGate implements ApprovalGate {
  constructor(private readonly config: WebhookGateConfig) {}

  async approve(spec: CeremonySpec): Promise<Decision> {
    const { url, timeoutSec, bearerTokenEnv } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearerTokenEnv) {
      const token = process.env[bearerTokenEnv];
      if (!token) throw new Error(`WebhookGate: env var '${bearerTokenEnv}' is empty or unset`);
      headers.authorization = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: serializeSpec(spec),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError')
        throw new Error(`WebhookGate: timed out after ${timeoutSec}s`);
      throw new Error(`WebhookGate: request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WebhookGate: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error(`WebhookGate: response is not JSON: ${(err as Error).message}`);
    }
    const decision = (parsed as Record<string, unknown>)?.decision;
    if (decision === 'approve' || decision === 'reject') return decision;
    throw new Error(`WebhookGate: unexpected decision ${JSON.stringify(decision)} — expected 'approve' or 'reject'`);
  }
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
