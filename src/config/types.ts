/**
 * Daemon runtime configuration.
 *
 * Loaded from TOML at startup. Separate from Ötzi's `VaultConfig` — the v4
 * share file stays Ötzi-compatible and unchanged; daemon-specific settings
 * live here. Strategy-specific sub-fields for gate / triggers are stored raw
 * in `params` and narrowed by the gate and trigger builders.
 */

import type { NetworkName } from '../otzi/backend/types';

export const TRANSPORT_KINDS = ['peer-mesh', 'relay'] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export const GATE_STRATEGIES = ['auto', 'policy', 'exec', 'webhook'] as const;
export type GateStrategy = (typeof GATE_STRATEGIES)[number];

export const TRIGGER_KINDS = ['http', 'uds', 'cron'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const BOOTSTRAP_ROLES = ['leader', 'leaf'] as const;
export type BootstrapRole = (typeof BOOTSTRAP_ROLES)[number];

export interface BootstrapConfig {
  role: BootstrapRole;
  /** Required when role === 'leader'. host:port the bootstrap server binds. */
  bind?: string;
  /** Required when role === 'leaf'. Full URL of the leader's bootstrap endpoint. */
  leaderUrl?: string;
  /**
   * Ring size, this node included: an integer from 2 to 255. Set only when
   * role === 'leader' and the transport is relay, which has no `[[peers]]` list to
   * count; required there, rejected everywhere else.
   */
  parties?: number;
}

export { NETWORK_NAMES } from '../otzi/backend/types';
export type { NetworkName };

export interface NetworkConfig {
  /**
   * The vault's Bitcoin network: the share, every `announce-dkg` and every
   * proposal must match it.
   */
  name: NetworkName;
  /**
   * Esplora base URL (`http://` or `https://`). Used by the CLI only; the
   * daemon never reads it. When unset the CLI uses Ötzi's per-network default
   * (`chainApiUrl`).
   */
  esploraUrl?: string;
}

export interface ShareConfig {
  /** Absolute path to the Ötzi-compatible share JSON file. */
  path: string;
  /** Name of the env var holding the share-file password. Not the password itself. */
  passwordEnv: string;
}

export interface NodeConfig {
  /** Logical node identifier (e.g. "node-a"). Local logging label only. */
  id: string;
  /** Path to the PKCS#8 ECDH identity private key (required for real transports). */
  identityKeyFile?: string;
  /** Path to the JSON pubkey book produced by bootstrap (required for real transports). */
  pubkeyBookFile?: string;
}

export interface TransportConfig {
  kind: TransportKind;
  /** Relay URL when kind === 'relay'. E.g. `ws://relay.example:9000`. */
  url?: string;
  /**
   * Peer-mesh: this node's reachable address (canonical `host:port` form).
   * Required when `kind === 'peer-mesh'`; populated by the parser from the
   * TOML `transport.advertised_endpoint` field.
   */
  advertisedEndpoint?: string;
}

export interface PeerEntry {
  /** Canonical `host:port` form (post-parse). */
  endpoint: string;
}

export interface GateConfig {
  strategy: GateStrategy;
  /** Strategy-specific config (allowlists, webhook URL, exec command, ...). Narrowed in 5b. */
  params?: Record<string, unknown>;
}

export interface DeadlineConfig {
  signingMs: number;
  dkgMs: number;
}

export interface TriggerEntry {
  kind: TriggerKind;
  /** Kind-specific config (bind address, cron schedule, ...). Narrowed in 5d. */
  params?: Record<string, unknown>;
}

export interface DaemonConfig {
  share: ShareConfig;
  node: NodeConfig;
  network: NetworkConfig;
  transport: TransportConfig;
  /** At least one entry under peer-mesh; may be `[]` under relay, which does not use it. */
  peers: PeerEntry[];
  gate: GateConfig;
  deadlines: DeadlineConfig;
  triggers: TriggerEntry[];
  /** Optional. Populated by debconf-rendered daemon.toml; absent in test fixtures. */
  bootstrap?: BootstrapConfig;
}

export const DEFAULT_SIGNING_DEADLINE_MS = 300_000;
export const DEFAULT_DKG_DEADLINE_MS = 900_000;
/** The largest `signing_ms` / `dkg_ms`: Node's `setTimeout` maximum (2^31 − 1 ms, about 24.8 days). */
export const MAX_DEADLINE_MS = 2_147_483_647;
