# Contracts: src/config/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/config/

### `types.ts`
**Purpose:** Type definitions for the daemon runtime configuration shape.

**Public surface:**
- `TRANSPORT_KINDS`, `GATE_STRATEGIES`, `TRIGGER_KINDS` — const string tuples (readonly arrays)
  - **Post:** Used as discriminators in union types and enum validation.
  - **Note:** `TRIGGER_KINDS = ['http', 'uds', 'cron']`; `'uds'` is the default operator API in deb-installed daemons.

- `NETWORK_NAMES`, `NetworkName` — re-exported from `src/otzi/backend/types.ts`
  - **Post:** `NETWORK_NAMES = ['mainnet', 'testnet4', 'signet']` — exactly Ötzi's network set.

- `NetworkConfig` — `{ name: NetworkName; esploraUrl?: string }`
  - **Pre:** `name` ∈ `NETWORK_NAMES`; `esploraUrl`, when set, is an `http://` or `https://` URL.
  - **Post:** `name` is the vault's network: the share, every `announce-dkg` and every proposal must match it. `esploraUrl` is the Esplora base the CLI uses; when unset the CLI uses Ötzi's per-network default (`chainApiUrl`). The daemon never reads `esploraUrl`.

- `ShareConfig` — `{ path: string; passwordEnv: string }`
  - **Pre:** `path` is an absolute path; `passwordEnv` is a non-empty env var name.
  - **Post:** Locates the Ötzi v4 share file (`.pending` staging file next to it) and its password source.

- `NodeConfig` — `{ id: string; identityKeyFile?: string; pubkeyBookFile?: string }`
  - **Pre:** `id` is a local logging label; `identityKeyFile`, `pubkeyBookFile` required for real transports at construction time.
  - **Post:** `id` is *not* a cross-node identity — the pubkey book is the cross-node identity primitive, and `partyId` is derived from it at startup (`transport-factory.resolveSelfFromBook`). Files are absent in in-memory tests.

- `TransportConfig` — `{ kind: TransportKind; url?: string; advertisedEndpoint?: string }`
  - **Pre:** If `kind === 'relay'`, `url` present. If `kind === 'peer-mesh'`, `advertisedEndpoint` is set (canonical `host:port`); transport-factory hard-errors at startup if absent.
  - **Post:** `advertisedEndpoint` is the address peers dial to reach this daemon.

- `PeerEntry` — `{ endpoint: string }`
  - **Pre:** `endpoint` is canonical `host:port` (post-parse, after `canonicalizeEndpoint`).
  - **Post:** One peer's reachable address. Order does not matter; `[[peers]]` is a typo check against the authoritative book (bidirectional endpoint match in transport-factory). Under `transport.kind = "relay"` the entries are parsed and validated but not used.

- `GateConfig` — `{ strategy: GateStrategy; params?: Record<string, unknown> }`
  - **Post:** Gate activation and raw strategy-specific fields, narrowed by the gate's `parse*Params` (see [gate.md](gate.md)).

- `DeadlineConfig` — `{ signingMs: number; dkgMs: number }`
  - **Pre:** Integers from 1 to 2 147 483 647 (`MAX_DEADLINE_MS`, Node's `setTimeout` maximum, about 24.8 days). The parser rejects a value outside that range at `deadlines.signing_ms` / `deadlines.dkg_ms` with a `ConfigError` that names the limit; a larger value would make every deadline timer fire at once.
  - **Post:** Ceremony deadlines.

- `BootstrapConfig` — `{ role: 'leader' | 'leaf'; bind?: string; leaderUrl?: string; parties?: number }`
  - **Pre:** For `'leader'`, `bind` is `host:port`. For `'leaf'`, `leaderUrl` is a full URL. `parties` is an integer from 2 to 255. Enforced by the parser per role and transport kind.
  - **Post:** Read by `otzi setup` to dispatch to the leader or leaf bootstrap path. Dormant after the pubkey book is written; harmless to leave in config. `parties` is the ring size, this node included; it is set only for `role = 'leader'` under `transport.kind = 'relay'`, where there is no `[[peers]]` list to count. Under peer-mesh the ring size is `[[peers]].length + 1`.

- `TriggerEntry` — `{ kind: TriggerKind; params?: Record<string, unknown> }`
  - **Post:** One trigger source (http, uds, or cron).

- `DaemonConfig` — `{ share; node; network; transport; peers; gate; deadlines; triggers; bootstrap? }`
  - **Post:** Complete daemon startup configuration. The share file is not read here. `peers` has at least one entry under peer-mesh and may be `[]` under relay.

- `DEFAULT_SIGNING_DEADLINE_MS`, `DEFAULT_DKG_DEADLINE_MS` — `300_000` (5 min) and `900_000` (15 min), used when `[deadlines]` is absent.
- `MAX_DEADLINE_MS` — `2_147_483_647`, the largest accepted `signing_ms` / `dkg_ms`.

**Invariants:**
- `DaemonConfig` is separate from Ötzi's `VaultConfig`; the share file stays Ötzi-compatible JSON.
- TOML → TS mapping uses snake_case (TOML) → camelCase (TS).

**Cross-component contracts:**
- Imported by `parse.ts`, `load.ts`, the daemon, the CLI.

**Notes / gotchas:**
- `[[peers]]` carries only `endpoint`; per-peer identifiers live in the pubkey book.
- A relay config needs no `[[peers]]`: the pubkey book alone names the ring. The relay leader's `[bootstrap] parties` stands in for the peer count during setup.

---

### `parse.ts`
**Purpose:** Pure TOML parser. Converts TOML text (snake_case keys) → `DaemonConfig` (camelCase types).

**Public surface:**
- `ConfigError` — class extends Error
  - **Pre:** Constructor takes `path` (TOML key path, e.g. `network.name`) and `message`.
  - **Post:** `.name = 'ConfigError'`; `message = "config <path>: <message>"`; `.path` names the offending key.

- `parseDaemonConfigToml(text: string): DaemonConfig`
  - **Pre:** `text` is TOML; `[deadlines]` / `[[triggers]]` / `[bootstrap]` optional; `[[peers]]` optional under relay.
  - **Post:** Validated `DaemonConfig` with defaults applied.
  - **Throws:** `ConfigError` on missing required fields, type mismatches, enum violations or rejected keys; the TOML library's `Error` on unparseable text.

- `parseDaemonConfig(raw: unknown): DaemonConfig`
  - **Pre:** `raw` is an already-parsed TOML object.
  - **Post / Throws:** Same as `parseDaemonConfigToml`.

- `asObject(v, path)`, `asString(v, path)`, `asInteger(v, path, min)`, `asArray(v, path)`, `asEnum(v, path, choices)` — helpers
  - **Post:** Coerced value, or `ConfigError`. `asInteger` accepts `number` and `bigint` within the safe range.

- Section parsers: `parseShare`, `parseNode`, `parseNetwork`, `parseTransport`, `parsePeer(raw, i)`, `parsePeers(raw, kind)`, `parseGate`, `parseDeadlines`, `parseTrigger(raw, i)`, `parseTriggers`, `parseBootstrap(raw, kind)`
  - **Post:** Typed section objects. `parseTransport` and `parsePeer` apply `canonicalizeEndpoint` to every endpoint; the resulting `DaemonConfig` always stores canonical form.
  - **Order:** `parseDaemonConfig` parses `[transport]` first and passes its `kind` to `parsePeers` and `parseBootstrap`, which both depend on it. A config with several faults therefore reports a `[transport]` fault before any other.

- **`[network]`** (`parseNetwork`)
  ```toml
  [network]
  name = "mainnet"          # mainnet | testnet4 | signet
  # esplora_url = "https://mempool.example/api"   # optional; CLI only
  ```
  - `name` required, one of `NETWORK_NAMES`.
  - `esplora_url` optional; must be an `http://` or `https://` URL.

- **Triggers:**
  - `kind = "http"`: `params.bind` is `host:port` with a loopback host (`127.0.0.1`, `::1`, `localhost`) or an absolute UDS path; any other host is rejected. Optional `auth_token_env`.
  - `kind = "uds"`: `params.path` is an absolute socket path. No `bind`, no `auth_token_env`.
  - `kind = "cron"`: `job_name`, `schedule`, optional `timezone`.

- **`[[peers]]`** (`parsePeers(raw, kind)`):
  - `transport.kind = "peer-mesh"`: required, at least one entry (`peers: missing required array (at least one peer)`, `peers: must contain at least one peer`).
  - `transport.kind = "relay"`: optional. Absent or `peers = []` gives `[]`. Entries present are validated as above (`endpoint` required and canonical, unknown and retired keys rejected) but not used.

- **`[bootstrap]`** (`parseBootstrap(raw, kind)`): `role ∈ {'leader', 'leaf'}`; `bind` required for leader, `leader_url` (`http(s)://…`) required for leaf.
  - `parties`: an integer from 2 to 255 (`ConfigError('bootstrap.parties', 'must be an integer from 2 to 255 (got …)')`).
    - Leader under relay: required (`ConfigError('bootstrap.parties', 'required when transport.kind = "relay" and bootstrap.role = "leader"')`).
    - Leader under peer-mesh: rejected (`ConfigError('bootstrap.parties', 'only used with transport.kind = "relay"; peer-mesh counts [[peers]]')`). Checked before the unknown-key rule, like the retired keys.
    - Leaf, under either transport: an unknown key (`ConfigError('bootstrap.parties', 'unknown key (expected one of role, leader_url)')`).
  - The requirement applies at every parse of the config, `otzi setup` and daemon start alike: `[bootstrap]` is setup-only, but the parser is shared.

- `validateCoherence(cfg)` — hook for cross-field checks after parsing (no mutation). Endpoint matching against the pubkey book happens in transport-factory.

**Rejected keys** — each throws `ConfigError` at the named path with the message shown:

| Key | Message |
|---|---|
| `network.opnet_rpc` | `no longer supported — remove it; the CLI reaches the chain through network.esplora_url` |
| `network.name = "testnet"` | `use testnet4 or signet` |
| `network.name = "regtest"` | `not supported` |
| `node.party_id` | `no longer supported — partyId is derived from the pubkey book at startup` |
| `peers[i].id`, `peers[i].party_id`, `peers[i].wallet_address` | ``no longer supported — peers carry only `endpoint` post-cleanup`` |
| `transport.listen` | `no longer supported — use transport.advertised_endpoint` |
| `gate.max_amount`, `gate.max_btc_per_tx` | `use max_sats_per_tx` (raised by `parsePolicyParams`) |
| `gate.allowed_btc_recipients`, `gate.destination_allowlist` | `use allowed_recipients` (raised by `parsePolicyParams`) |
| `gate.method_allowlist`, `gate.allowed_contracts` | `no longer supported` (raised by `parsePolicyParams`) |
| `bootstrap.parties` (leader, peer-mesh) | `only used with transport.kind = "relay"; peer-mesh counts [[peers]]` |

- **Unknown keys** — every table rejects a key it does not take, with `ConfigError('<dotted key>', 'unknown key (expected one of …)')` (`network.esplora_uri`, `peers[0].port`, `triggers[1].mode`, a stray top-level `logging`). The keys each table takes: root `share, node, network, transport, peers, gate, deadlines, triggers, bootstrap`; `[share]` `path, password_env`; `[node]` `id, identity_key_file, pubkey_book_file`; `[network]` `name, esplora_url`; `[transport]` `kind, url` (relay) or `kind, advertised_endpoint` (peer-mesh); `[[peers]]` `endpoint`; `[deadlines]` `signing_ms, dkg_ms`; `[[triggers]]` `kind` plus `bind, auth_token_env` (http), `path` (uds), `schedule, job_name, timezone` (cron); `[bootstrap]` `role` plus `bind` and, under relay, `parties` (leader) or `leader_url` (leaf). The rejected keys above keep their specific messages (checked first). `[gate]` params are checked by the strategy's parser (`parsePolicyParams`, `parseExecParams`, `parseWebhookParams`, all of which reject unknown keys) when the daemon builds its gate (`parsePolicyParams` also takes `[network].name` and refuses an `allowed_recipients` entry that is no address of that network); under `auto` the config parser refuses every param itself.

**Invariants:**
- All section paths use snake_case (e.g., `share.password_env`); coerced to camelCase in types.
- A misspelt key is an error, never a silently missing setting.
- The `params` of `[gate]` (every key beside `strategy`) and of `[[triggers]]` (every key beside `kind`) stay raw `Record<string, unknown>` here; the gate and trigger builders narrow them. Strategy params are flat keys directly under `[gate]`.
- `strategy = "auto"` takes no params: any other key in `[gate]` is `ConfigError('gate.<key>', 'not used by strategy auto')`, so leftover policy keys never look like rules that are not enforced.
- Deadlines default to 5 min / 15 min if the section is missing.
- `transport.url` required for relay; `transport.advertised_endpoint` optional at parse time for peer-mesh (transport-factory hard-errors if missing).
- Under peer-mesh, `[[peers]]` must have at least one entry; under relay it may be absent or empty. Every entry present has a canonical `endpoint`.
- A relay leader's `[bootstrap]` carries `parties`; no other `[bootstrap]` does.
- **HTTP trigger loopback enforcement** is load-bearing: the CLI is THE operator surface, and a non-loopback HTTP bind would let remote callers forge ceremony triggers.

**Cross-component contracts:**
- Used by `load.ts`; `ConfigError` is also thrown by `src/gate/*` param parsers.

**Notes / gotchas:**
- TOML `[[triggers]]` array is optional (parsed as empty if absent).
- `describe(v)` helper for error messages (null → "null", array → "array", typeof fallback).

---

### `load.ts`
**Purpose:** Thin I/O wrapper. Reads TOML file from disk and delegates parsing.

**Public surface:**
- `loadDaemonConfig(path: string)` — async function
  - **Pre:** `path` is a readable TOML file.
  - **Post:** Returns `DaemonConfig`, fully validated.
  - **Throws:** I/O errors (file not found, permission denied) as thrown by `readFile`; `ConfigError` from parse failures.

**Invariants:**
- No caching; each call re-reads and re-parses.
- Share file decryption and the share/book cross-checks are NOT in this module (`src/daemon/config-merge.ts`, `transport-factory.ts`).

**Cross-component contracts:**
- Imported by the daemon entrypoint, `config-merge.ts` and the CLI (`DaemonClient.fromConfig`, verbs that need the network or the Esplora URL).

**Notes / gotchas:**
- Errors from I/O are bare Node.js errors; callers should distinguish from `ConfigError` for better UX.

---
