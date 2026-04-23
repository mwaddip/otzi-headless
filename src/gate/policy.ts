/**
 * `PolicyGate` — deterministic rule check.
 *
 * Strict-by-default: if the operator sets an allowlist / cap and the spec lacks the
 * corresponding field, the gate rejects. Rationale: the operator explicitly opted in
 * to a constraint; they shouldn't be surprised by a no-field-means-bypass loophole.
 *
 * TOML shape (under `[gate]`):
 *   strategy = "policy"
 *   max_amount = 100000                              # u64 or decimal string (for u256)
 *   destination_allowlist = ["bc1p...", "bc1q..."]
 *   method_allowlist = ["transfer", "approve"]
 *   dkg_leader_allowlist = ["node-a"]
 */

import { ConfigError } from '../config/parse';
import type { ApprovalGate, CeremonySpec, Decision } from './types';

export interface PolicyConfig {
  /** Cap on `spec.amount`. Spec rejected if amount missing or > this. */
  maxAmount?: bigint;
  /** Destination must be in this list if set. Spec rejected if destination missing. */
  destinationAllowlist?: string[];
  /** Method must be in this list if set. Spec rejected if method missing. */
  methodAllowlist?: string[];
  /** DKG leader must be in this list if set. */
  dkgLeaderAllowlist?: string[];
}

export class PolicyGate implements ApprovalGate {
  constructor(private readonly config: PolicyConfig) {}

  async approve(spec: CeremonySpec): Promise<Decision> {
    if (spec.kind === 'dkg') {
      if (this.config.dkgLeaderAllowlist !== undefined) {
        if (!this.config.dkgLeaderAllowlist.includes(spec.leader)) return 'reject';
      }
      return 'approve';
    }

    if (this.config.maxAmount !== undefined) {
      if (spec.amount === undefined) return 'reject';
      if (spec.amount > this.config.maxAmount) return 'reject';
    }

    if (this.config.destinationAllowlist !== undefined) {
      if (spec.destination === undefined) return 'reject';
      if (!this.config.destinationAllowlist.includes(spec.destination)) return 'reject';
    }

    if (this.config.methodAllowlist !== undefined) {
      if (spec.method === undefined) return 'reject';
      if (!this.config.methodAllowlist.includes(spec.method)) return 'reject';
    }

    return 'approve';
  }
}

// ---------------------------------------------------------------------------
// TOML params → PolicyConfig
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
  'max_amount',
  'destination_allowlist',
  'method_allowlist',
  'dkg_leader_allowlist',
]);

export function parsePolicyParams(params: Record<string, unknown>): PolicyConfig {
  for (const key of Object.keys(params)) {
    if (!KNOWN_KEYS.has(key))
      throw new ConfigError(`gate.${key}`, `unknown policy field (expected one of ${[...KNOWN_KEYS].join(', ')})`);
  }

  const out: PolicyConfig = {};

  if (params.max_amount !== undefined) {
    out.maxAmount = coerceAmount(params.max_amount, 'gate.max_amount');
  }
  if (params.destination_allowlist !== undefined) {
    out.destinationAllowlist = coerceStringArray(params.destination_allowlist, 'gate.destination_allowlist');
  }
  if (params.method_allowlist !== undefined) {
    out.methodAllowlist = coerceStringArray(params.method_allowlist, 'gate.method_allowlist');
  }
  if (params.dkg_leader_allowlist !== undefined) {
    out.dkgLeaderAllowlist = coerceStringArray(params.dkg_leader_allowlist, 'gate.dkg_leader_allowlist');
  }

  return out;
}

function coerceAmount(v: unknown, path: string): bigint {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new ConfigError(path, `must be >= 0 (got ${v})`);
    return v;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v))
      throw new ConfigError(path, `must be an integer (got ${v})`);
    if (v < 0) throw new ConfigError(path, `must be >= 0 (got ${v})`);
    return BigInt(v);
  }
  if (typeof v === 'string') {
    if (!/^\d+$/.test(v))
      throw new ConfigError(path, `must be a non-negative decimal string (got '${v}')`);
    return BigInt(v);
  }
  throw new ConfigError(path, `must be a number or decimal string (got ${describe(v)})`);
}

function coerceStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v))
    throw new ConfigError(path, `must be an array of strings (got ${describe(v)})`);
  return v.map((item, i) => {
    if (typeof item !== 'string')
      throw new ConfigError(`${path}[${i}]`, `must be a string (got ${describe(item)})`);
    return item;
  });
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
