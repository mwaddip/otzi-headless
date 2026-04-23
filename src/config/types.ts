/**
 * Daemon runtime configuration.
 *
 * Loaded from TOML at startup. Separate from Ötzi's `VaultConfig` — share
 * file stays Ötzi-compatible and unchanged; daemon-specific settings live
 * here. Phase 5a defines the top-level shape; strategy-specific sub-fields
 * for gate / triggers are stored raw in `params` and narrowed by later
 * sub-phases (5b for gate strategies, 5d for trigger kinds).
 */

export const TRANSPORT_KINDS = ['peer-mesh', 'relay'] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export const GATE_STRATEGIES = ['auto', 'policy', 'webhook', 'cli', 'queue'] as const;
export type GateStrategy = (typeof GATE_STRATEGIES)[number];

export const TRIGGER_KINDS = ['http', 'cron', 'chain-watcher'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export interface ShareConfig {
  /** Absolute path to the Ötzi-compatible share JSON file. */
  path: string;
  /** Name of the env var holding the share-file password. Not the password itself. */
  passwordEnv: string;
}

export interface NodeConfig {
  /** Logical node identifier (e.g. "node-a"). */
  id: string;
  /** 0..n-1; must match the decrypted share's `partyId` at load time. */
  partyId: number;
  /** Path to the PKCS#8 ECDH identity private key (required for real transports). */
  identityKeyFile?: string;
  /** Path to the JSON pubkey book produced by bootstrap (required for real transports). */
  pubkeyBookFile?: string;
}

export interface TransportConfig {
  kind: TransportKind;
  /** Relay URL when kind === 'relay'. E.g. `ws://relay.example:9000`. */
  url?: string;
  /** Listen address when kind === 'peer-mesh'. E.g. `127.0.0.1:8800`. */
  listen?: string;
}

export interface PeerEntry {
  /** Logical peer id matching the peer's own `node.id`. */
  id: string;
  partyId: number;
  /** `0x` + hex(SHA256(mldsaPubKey)). Optional in 5a; required by phase 3. */
  walletAddress?: string;
  /** WebSocket endpoint for peer-mesh. Optional; absent means relay-only. */
  endpoint?: string;
}

export interface GateConfig {
  strategy: GateStrategy;
  /** Strategy-specific config (allowlists, webhook URL, queue path, ...). Narrowed in 5b. */
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
  transport: TransportConfig;
  peers: PeerEntry[];
  gate: GateConfig;
  deadlines: DeadlineConfig;
  triggers: TriggerEntry[];
}

export const DEFAULT_SIGNING_DEADLINE_MS = 300_000;
export const DEFAULT_DKG_DEADLINE_MS = 900_000;
