/**
 * `PolicyGate` — deterministic rule check on Bitcoin ceremony specs (facts/gate.md).
 *
 * Strict-by-default: if the operator sets a cap / allowlist and the spec lacks the
 * corresponding input, the gate rejects. Rationale: the operator explicitly opted in
 * to a constraint; they shouldn't be surprised by a no-field-means-bypass loophole.
 *
 * TOML shape — flat keys under `[gate]`:
 *   [gate]
 *   strategy = "policy"
 *
 *   # Signing rules (never applied to a DKG spec). Caps are non-negative safe
 *   # integers, given as a TOML integer or a decimal string:
 *   max_sats_per_tx = 100000              # sum of non-change outputs
 *   max_sats_per_24h = 1000000            # rolling 24 h, this node's approvals
 *   allowed_recipients = ["bc1q...", "bc1p..."]
 *                                         # every non-change output must be listed
 *   max_fee_sats = 20000
 *   max_fee_rate = 25.5                   # sat/vB, may be fractional
 *   max_ceremonies_per_hour = 10          # rolling hour, this node's approvals
 *
 *   # DKG rule:
 *   dkg_leader_allowlist = ["node-a"]
 *
 * Both rolling windows live in memory and count approvals only; they reset on
 * daemon restart.
 */

import { ConfigError } from '../config/parse';
import type { ApprovalGate, CeremonySpec, Decision, DkgSpec, SigningSpec } from './types';

export interface PolicyConfig {
  /** Cap on `spec.amount` (sats): the sum of the non-change outputs. */
  maxSatsPerTx?: number;
  /** Cap on the 24 h sum of `amount` over this node's approvals plus the spec under test. */
  maxSatsPer24h?: number;
  /** Every non-change output address must be in this list. Change outputs are ignored. */
  allowedRecipients?: string[];
  /** Cap on `spec.fee` (sats). */
  maxFeeSats?: number;
  /** Cap on `spec.feeRate` (sat/vB, may be fractional). */
  maxFeeRate?: number;
  /** Signing approvals by this node per rolling hour must stay below this. */
  maxCeremoniesPerHour?: number;
  /** DKG leader must be in this list if set. */
  dkgLeaderAllowlist?: string[];
}

export interface PolicyGateOptions {
  /** Clock in ms since epoch; defaults to `Date.now`. Injectable for window tests. */
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface SatApproval {
  at: number;
  amount: number;
}

function isSats(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function isFeeRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export class PolicyGate implements ApprovalGate {
  /** Approval timestamps for the signing-rate-limit window (ms since epoch). */
  private hourly: number[] = [];
  /** Approved amounts for the rolling 24 h sats window. */
  private daily: SatApproval[] = [];
  private readonly now: () => number;

  constructor(private readonly config: PolicyConfig, opts: PolicyGateOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  async approve(spec: CeremonySpec): Promise<Decision> {
    // No await: every rule is checked and the approval recorded in one synchronous
    // section, so concurrent evaluations cannot both pass a cap.
    return spec.kind === 'dkg' ? this.approveDkg(spec) : this.approveSigning(spec);
  }

  private approveDkg(spec: DkgSpec): Decision {
    const allow = this.config.dkgLeaderAllowlist;
    if (allow !== undefined && !allow.includes(spec.leader)) return 'reject';
    return 'approve';
  }

  private approveSigning(spec: SigningSpec): Decision {
    const c = this.config;
    const now = this.now();
    this.hourly = this.hourly.filter((at) => at >= now - HOUR_MS);
    this.daily = this.daily.filter((e) => e.at >= now - DAY_MS);

    if (c.maxSatsPerTx !== undefined) {
      if (!isSats(spec.amount) || spec.amount > c.maxSatsPerTx) return 'reject';
    }

    if (c.maxSatsPer24h !== undefined) {
      if (!isSats(spec.amount)) return 'reject';
      const spent = this.daily.reduce((sum, e) => sum + e.amount, 0);
      if (spent + spec.amount > c.maxSatsPer24h) return 'reject';
    }

    if (c.allowedRecipients !== undefined) {
      if (!Array.isArray(spec.outputs)) return 'reject';
      for (const out of spec.outputs) {
        if (out.isChange === true) continue;
        if (typeof out.address !== 'string' || !c.allowedRecipients.includes(out.address)) return 'reject';
      }
    }

    if (c.maxFeeSats !== undefined) {
      if (!isSats(spec.fee) || spec.fee > c.maxFeeSats) return 'reject';
    }

    if (c.maxFeeRate !== undefined) {
      if (!isFeeRate(spec.feeRate) || spec.feeRate > c.maxFeeRate) return 'reject';
    }

    if (c.maxCeremoniesPerHour !== undefined) {
      if (this.hourly.length >= c.maxCeremoniesPerHour) return 'reject';
    }

    // Final approval: record it in each active window. A rejected spec records nothing.
    if (c.maxSatsPer24h !== undefined) this.daily.push({ at: now, amount: spec.amount });
    if (c.maxCeremoniesPerHour !== undefined) this.hourly.push(now);
    return 'approve';
  }
}

// ---------------------------------------------------------------------------
// TOML params → PolicyConfig
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
  'max_sats_per_tx',
  'max_sats_per_24h',
  'allowed_recipients',
  'max_fee_sats',
  'max_fee_rate',
  'max_ceremonies_per_hour',
  'dkg_leader_allowlist',
]);

/** Keys of the earlier policy vocabulary, with the message naming the replacement. */
const LEGACY_KEYS = new Map<string, string>([
  ['max_amount', 'use max_sats_per_tx'],
  ['max_btc_per_tx', 'use max_sats_per_tx'],
  ['allowed_btc_recipients', 'use allowed_recipients'],
  ['destination_allowlist', 'use allowed_recipients'],
  ['method_allowlist', 'no longer supported'],
  ['allowed_contracts', 'no longer supported'],
]);

export function parsePolicyParams(params: Record<string, unknown>): PolicyConfig {
  for (const key of Object.keys(params)) {
    const legacy = LEGACY_KEYS.get(key);
    if (legacy !== undefined) throw new ConfigError(`gate.${key}`, legacy);
    if (!KNOWN_KEYS.has(key))
      throw new ConfigError(`gate.${key}`, `unknown policy field (expected one of ${[...KNOWN_KEYS].join(', ')})`);
  }

  const out: PolicyConfig = {};

  if (params.max_sats_per_tx !== undefined) {
    out.maxSatsPerTx = coerceSats(params.max_sats_per_tx, 'gate.max_sats_per_tx');
  }
  if (params.max_sats_per_24h !== undefined) {
    out.maxSatsPer24h = coerceSats(params.max_sats_per_24h, 'gate.max_sats_per_24h');
  }
  if (params.allowed_recipients !== undefined) {
    out.allowedRecipients = coerceAddressArray(params.allowed_recipients, 'gate.allowed_recipients');
  }
  if (params.max_fee_sats !== undefined) {
    out.maxFeeSats = coerceSats(params.max_fee_sats, 'gate.max_fee_sats');
  }
  if (params.max_fee_rate !== undefined) {
    out.maxFeeRate = coerceFeeRate(params.max_fee_rate, 'gate.max_fee_rate');
  }
  if (params.max_ceremonies_per_hour !== undefined) {
    out.maxCeremoniesPerHour = coercePositiveInt(params.max_ceremonies_per_hour, 'gate.max_ceremonies_per_hour');
  }
  if (params.dkg_leader_allowlist !== undefined) {
    out.dkgLeaderAllowlist = coerceStringArray(params.dkg_leader_allowlist, 'gate.dkg_leader_allowlist');
  }

  return out;
}

function coercePositiveInt(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v))
    throw new ConfigError(path, `must be a positive integer (got ${describe(v)})`);
  if (v <= 0)
    throw new ConfigError(path, `must be >= 1 (got ${v})`);
  return v;
}

/** A non-negative safe integer from a TOML integer or a decimal string. */
function coerceSats(v: unknown, path: string): number {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new ConfigError(path, `must be >= 0 (got ${v})`);
    if (v > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ConfigError(path, `must be <= ${Number.MAX_SAFE_INTEGER} (got ${v})`);
    return Number(v);
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v))
      throw new ConfigError(path, `must be an integer (got ${v})`);
    if (v < 0) throw new ConfigError(path, `must be >= 0 (got ${v})`);
    if (!Number.isSafeInteger(v))
      throw new ConfigError(path, `must be <= ${Number.MAX_SAFE_INTEGER} (got ${v})`);
    return v === 0 ? 0 : v;
  }
  if (typeof v === 'string') {
    if (!/^\d+$/.test(v))
      throw new ConfigError(path, `must be a non-negative decimal string (got '${v}')`);
    if (BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ConfigError(path, `must be <= ${Number.MAX_SAFE_INTEGER} (got '${v}')`);
    return Number(v);
  }
  throw new ConfigError(path, `must be an integer or decimal string (got ${describe(v)})`);
}

/** A finite, non-negative number (fractional allowed) from a TOML number or a decimal string. */
function coerceFeeRate(v: unknown, path: string): number {
  if (typeof v === 'bigint') return coerceSats(v, path);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ConfigError(path, `must be a finite number (got ${v})`);
    if (v < 0) throw new ConfigError(path, `must be >= 0 (got ${v})`);
    return v === 0 ? 0 : v;
  }
  if (typeof v === 'string') {
    if (!/^\d+(\.\d+)?$/.test(v))
      throw new ConfigError(path, `must be a non-negative decimal string (got '${v}')`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(path, `must be a finite number (got '${v}')`);
    return n;
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

function coerceAddressArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v))
    throw new ConfigError(path, `must be an array of addresses (got ${describe(v)})`);
  return v.map((item, i) => {
    if (typeof item !== 'string')
      throw new ConfigError(`${path}[${i}]`, `must be a string (got ${describe(item)})`);
    if (item === '')
      throw new ConfigError(`${path}[${i}]`, 'must not be empty');
    return item;
  });
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
