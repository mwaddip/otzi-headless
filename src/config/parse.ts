/**
 * Pure parser for daemon TOML config. No file I/O — see `load.ts` for that.
 *
 * TOML uses `snake_case`, TS types are `camelCase`; mapping happens here.
 * Strategy-specific sub-fields under `[gate]` and `[[triggers]]` are stored
 * raw in `params` and narrowed by phases 5b / 5d when those strategies land.
 */

import { parse as parseToml } from 'smol-toml';
import {
  DaemonConfig,
  DeadlineConfig,
  GateConfig,
  GATE_STRATEGIES,
  NodeConfig,
  PeerEntry,
  ShareConfig,
  TransportConfig,
  TRANSPORT_KINDS,
  TriggerEntry,
  TRIGGER_KINDS,
  DEFAULT_DKG_DEADLINE_MS,
  DEFAULT_SIGNING_DEADLINE_MS,
} from './types';

export class ConfigError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`config ${path}: ${message}`);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Primitive coercion helpers
// ---------------------------------------------------------------------------

function asObject(v: unknown, path: string): Record<string, unknown> {
  if (v === null || v === undefined)
    throw new ConfigError(path, 'missing required table');
  if (typeof v !== 'object' || Array.isArray(v))
    throw new ConfigError(path, 'must be a table');
  return v as Record<string, unknown>;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string')
    throw new ConfigError(path, `must be a string (got ${describe(v)})`);
  return v;
}

function asInteger(v: unknown, path: string, min?: number): number {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))
      throw new ConfigError(path, `integer out of safe range (${v})`);
    const n = Number(v);
    if (min !== undefined && n < min)
      throw new ConfigError(path, `must be >= ${min} (got ${n})`);
    return n;
  }
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new ConfigError(path, `must be a number (got ${describe(v)})`);
  if (!Number.isInteger(v))
    throw new ConfigError(path, `must be an integer (got ${v})`);
  if (min !== undefined && v < min)
    throw new ConfigError(path, `must be >= ${min} (got ${v})`);
  return v;
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v))
    throw new ConfigError(path, `must be an array (got ${describe(v)})`);
  return v;
}

function asEnum<T extends string>(v: unknown, path: string, choices: readonly T[]): T {
  const s = asString(v, path);
  if (!(choices as readonly string[]).includes(s))
    throw new ConfigError(path, `must be one of ${choices.join(' | ')} (got '${s}')`);
  return s as T;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function parseShare(raw: unknown): ShareConfig {
  const o = asObject(raw, 'share');
  return {
    path: asString(o.path, 'share.path'),
    passwordEnv: asString(o.password_env, 'share.password_env'),
  };
}

function parseNode(raw: unknown): NodeConfig {
  const o = asObject(raw, 'node');
  const out: NodeConfig = {
    id: asString(o.id, 'node.id'),
    partyId: asInteger(o.party_id, 'node.party_id', 0),
  };
  if (o.identity_key_file !== undefined)
    out.identityKeyFile = asString(o.identity_key_file, 'node.identity_key_file');
  if (o.pubkey_book_file !== undefined)
    out.pubkeyBookFile = asString(o.pubkey_book_file, 'node.pubkey_book_file');
  return out;
}

function parseTransport(raw: unknown): TransportConfig {
  const o = asObject(raw, 'transport');
  const kind = asEnum(o.kind, 'transport.kind', TRANSPORT_KINDS);
  if (kind === 'relay') {
    if (o.url === undefined)
      throw new ConfigError('transport.url', 'required when transport.kind = "relay"');
    return { kind, url: asString(o.url, 'transport.url') };
  }
  // peer-mesh — `listen` is optional at parse time (in-memory tests omit it);
  // consumer (transport factory) errors if missing at construction time.
  const out: TransportConfig = { kind };
  if (o.listen !== undefined) out.listen = asString(o.listen, 'transport.listen');
  return out;
}

function parsePeer(raw: unknown, i: number): PeerEntry {
  const path = `peers[${i}]`;
  const o = asObject(raw, path);
  return {
    id: asString(o.id, `${path}.id`),
    partyId: asInteger(o.party_id, `${path}.party_id`, 0),
    walletAddress:
      o.wallet_address === undefined
        ? undefined
        : asString(o.wallet_address, `${path}.wallet_address`),
    endpoint:
      o.endpoint === undefined ? undefined : asString(o.endpoint, `${path}.endpoint`),
  };
}

function parsePeers(raw: unknown): PeerEntry[] {
  if (raw === undefined)
    throw new ConfigError('peers', 'missing required array (at least one peer)');
  const arr = asArray(raw, 'peers');
  if (arr.length === 0)
    throw new ConfigError('peers', 'must contain at least one peer');
  return arr.map((p, i) => parsePeer(p, i));
}

function parseGate(raw: unknown): GateConfig {
  const o = asObject(raw, 'gate');
  const strategy = asEnum(o.strategy, 'gate.strategy', GATE_STRATEGIES);
  const { strategy: _, ...rest } = o;
  return {
    strategy,
    params: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function parseDeadlines(raw: unknown): DeadlineConfig {
  if (raw === undefined) {
    return { signingMs: DEFAULT_SIGNING_DEADLINE_MS, dkgMs: DEFAULT_DKG_DEADLINE_MS };
  }
  const o = asObject(raw, 'deadlines');
  return {
    signingMs:
      o.signing_ms === undefined
        ? DEFAULT_SIGNING_DEADLINE_MS
        : asInteger(o.signing_ms, 'deadlines.signing_ms', 1),
    dkgMs:
      o.dkg_ms === undefined
        ? DEFAULT_DKG_DEADLINE_MS
        : asInteger(o.dkg_ms, 'deadlines.dkg_ms', 1),
  };
}

function parseTrigger(raw: unknown, i: number): TriggerEntry {
  const path = `triggers[${i}]`;
  const o = asObject(raw, path);
  const kind = asEnum(o.kind, `${path}.kind`, TRIGGER_KINDS);
  const { kind: _, ...rest } = o;
  return {
    kind,
    params: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function parseTriggers(raw: unknown): TriggerEntry[] {
  if (raw === undefined) return [];
  const arr = asArray(raw, 'triggers');
  return arr.map((t, i) => parseTrigger(t, i));
}

// ---------------------------------------------------------------------------
// Coherence checks (cross-field invariants verifiable without share file)
// ---------------------------------------------------------------------------

function validateCoherence(cfg: DaemonConfig): void {
  const seenIds = new Set<string>([cfg.node.id]);
  const seenPids = new Set<number>([cfg.node.partyId]);
  cfg.peers.forEach((p, i) => {
    if (seenIds.has(p.id))
      throw new ConfigError(`peers[${i}].id`, `duplicate id '${p.id}' (collides with node or earlier peer)`);
    if (seenPids.has(p.partyId))
      throw new ConfigError(`peers[${i}].party_id`, `duplicate partyId ${p.partyId} (collides with node or earlier peer)`);
    seenIds.add(p.id);
    seenPids.add(p.partyId);
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Validate a parsed-from-TOML raw value and shape it into a `DaemonConfig`. */
export function parseDaemonConfig(raw: unknown): DaemonConfig {
  const o = asObject(raw, '<root>');
  const cfg: DaemonConfig = {
    share: parseShare(o.share),
    node: parseNode(o.node),
    transport: parseTransport(o.transport),
    peers: parsePeers(o.peers),
    gate: parseGate(o.gate),
    deadlines: parseDeadlines(o.deadlines),
    triggers: parseTriggers(o.triggers),
  };
  validateCoherence(cfg);
  return cfg;
}

/** Parse a TOML text blob straight into a `DaemonConfig`. */
export function parseDaemonConfigToml(text: string): DaemonConfig {
  const raw = parseToml(text);
  return parseDaemonConfig(raw);
}
