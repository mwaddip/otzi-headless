/**
 * `PolicyGate` — deterministic rule check.
 *
 * Strict-by-default: if the operator sets an allowlist / cap and the spec lacks the
 * corresponding field, the gate rejects. Rationale: the operator explicitly opted in
 * to a constraint; they shouldn't be surprised by a no-field-means-bypass loophole.
 *
 * Rules split into "generic" (apply across protocols) and "protocol-scoped"
 * (only active when the spec's operation matches). A rate limiter applies
 * to every signing ceremony; DKG has its own leader allowlist.
 *
 * TOML shape (under `[gate]`):
 *   strategy = "policy"
 *   [gate.params]
 *   # Generic signing rules — match any signing spec (BTC or OPNet):
 *   max_amount = 100000                           # u64 or decimal string
 *   destination_allowlist = ["bc1p...", "0x..."]
 *   method_allowlist = ["transfer", "approve"]
 *
 *   # BTC-scoped (active iff operation='btc-transfer'):
 *   max_btc_per_tx = 100000000                    # 1 BTC cap on sum of non-self outputs
 *   allowed_btc_recipients = ["bc1p...", "bc1q..."]
 *                                                 # every non-self output must be in this list
 *
 *   # OPNet-scoped (active iff operation='opnet-call'):
 *   allowed_contracts = ["0xcontract..."]
 *
 *   # Signing rate limit — sliding window, in-memory, resets on restart:
 *   max_ceremonies_per_hour = 10
 *
 *   # DKG-scoped:
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
  /**
   * BTC-only: cap on sum of non-self output amounts (sats). Active only
   * when `operation === 'btc-transfer'`. Rejects if outputs missing.
   */
  maxBtcPerTx?: bigint;
  /**
   * BTC-only: every non-self output address must be in this list. Rejects
   * if outputs missing or any output has `address: null` (OP_RETURN etc.).
   */
  allowedBtcRecipients?: string[];
  /**
   * OPNet-only: spec.destination (the contract address hint) must be in this list.
   * Active only when `operation === 'opnet-call'`. Rejects if destination missing.
   */
  allowedContracts?: string[];
  /** Max signing ceremonies approved per rolling hour. Rejects when exceeded. */
  maxCeremoniesPerHour?: number;
  /** DKG leader must be in this list if set. */
  dkgLeaderAllowlist?: string[];
}

const HOUR_MS = 60 * 60 * 1000;

export class PolicyGate implements ApprovalGate {
  /** Approval timestamps for the signing-rate-limit sliding window (ms since epoch). */
  private readonly signingApprovals: number[] = [];

  constructor(private readonly config: PolicyConfig, private readonly now: () => number = Date.now) {}

  async approve(spec: CeremonySpec): Promise<Decision> {
    if (spec.kind === 'dkg') {
      if (this.config.dkgLeaderAllowlist !== undefined) {
        if (!this.config.dkgLeaderAllowlist.includes(spec.leader)) return 'reject';
      }
      return 'approve';
    }

    // Generic rules — apply to any signing spec.
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

    // BTC-scoped rules.
    if (spec.operation === 'btc-transfer') {
      if (this.config.maxBtcPerTx !== undefined) {
        if (!spec.outputs) return 'reject';
        const total = spec.outputs.reduce((sum, o) => sum + o.amountSat, 0n);
        if (total > this.config.maxBtcPerTx) return 'reject';
      }
      if (this.config.allowedBtcRecipients !== undefined) {
        if (!spec.outputs) return 'reject';
        for (const out of spec.outputs) {
          if (out.address === null) return 'reject';
          if (!this.config.allowedBtcRecipients.includes(out.address)) return 'reject';
        }
      }
    }

    // OPNet-scoped rules.
    if (spec.operation === 'opnet-call') {
      if (this.config.allowedContracts !== undefined) {
        if (spec.destination === undefined) return 'reject';
        if (!this.config.allowedContracts.includes(spec.destination)) return 'reject';
      }
    }

    // Rate limit (sliding window). Check + record atomically (no async gap).
    if (this.config.maxCeremoniesPerHour !== undefined) {
      const cutoff = this.now() - HOUR_MS;
      // Prune old entries.
      while (this.signingApprovals.length > 0 && this.signingApprovals[0]! < cutoff) {
        this.signingApprovals.shift();
      }
      if (this.signingApprovals.length >= this.config.maxCeremoniesPerHour) return 'reject';
      this.signingApprovals.push(this.now());
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
  'max_btc_per_tx',
  'allowed_btc_recipients',
  'allowed_contracts',
  'max_ceremonies_per_hour',
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
  if (params.max_btc_per_tx !== undefined) {
    out.maxBtcPerTx = coerceAmount(params.max_btc_per_tx, 'gate.max_btc_per_tx');
  }
  if (params.allowed_btc_recipients !== undefined) {
    out.allowedBtcRecipients = coerceStringArray(params.allowed_btc_recipients, 'gate.allowed_btc_recipients');
  }
  if (params.allowed_contracts !== undefined) {
    out.allowedContracts = coerceStringArray(params.allowed_contracts, 'gate.allowed_contracts');
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
