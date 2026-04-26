# Contracts: src/config/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/config/

### `types.ts`
**Purpose:** Type definitions for daemon runtime configuration shape.

**Public surface:**
- `TRANSPORT_KINDS`, `GATE_STRATEGIES`, `TRIGGER_KINDS`, `NETWORK_NAMES` — const string tuples (readonly arrays)
  - **Post:** Used as discriminators in union types and enum validation. Exported for re-export in other modules.
  - **Note:** `TRIGGER_KINDS = ['http', 'uds', 'cron']` as of phase 9a; `'uds'` is the default for operator API in deb-installed daemons.

- `NetworkConfig` — interface
  - **Pre:** `name` ∈ `NETWORK_NAMES`; `opnetRpc` is a non-empty string (not validated here).
  - **Post:** Holds network identity (`mainnet|testnet|regtest`) and RPC URL for operator broadcast.

- `ShareConfig` — interface
  - **Pre:** `path` is absolute path; `passwordEnv` is a non-empty env var name.
  - **Post:** Locates Ötzi-compatible share file and its decryption password source.

- `NodeConfig` — interface
  - **Pre:** `id` is logical identifier; `partyId` ∈ [0, n-1]; `identityKeyFile`, `pubkeyBookFile` optional (but required for real transports at construction time).
  - **Post:** Identifies this node and its cryptographic keys. Files are absent in in-memory tests.

- `TransportConfig` — interface
  - **Pre:** `kind` ∈ `TRANSPORT_KINDS`. If `kind === 'relay'`, `url` present; if `kind === 'peer-mesh'`, `listen` optional at parse time (error deferred to transport factory).
  - **Post:** Specifies peer communication channel.

- `PeerEntry` — interface
  - **Pre:** `id` unique (validated later); `partyId` ∈ [0, n-1], unique; `walletAddress` optional, `endpoint` optional (required by phase 3).
  - **Post:** Records one federation peer for announce/commit coordination.

- `GateConfig` — interface
  - **Pre:** `strategy` ∈ `GATE_STRATEGIES`; `params` opaque at this stage.
  - **Post:** Gate activation and raw strategy-specific fields.

- `DeadlineConfig` — interface
  - **Pre:** `signingMs`, `dkgMs` positive integers (validated in parser).
  - **Post:** Ceremony timeout overrides.

- `TriggerEntry` — interface
  - **Pre:** `kind` ∈ `TRIGGER_KINDS`; `params` opaque.
  - **Post:** One trigger for ceremony activation (http or cron).

- `DaemonConfig` — interface
  - **Pre:** All sub-interfaces must satisfy their constraints. Coherence checks run post-parse (no self-collisions, etc.).
  - **Post:** Complete daemon startup configuration. Share file is NOT decrypted yet; cross-validation deferred to phase 5e.

- `DEFAULT_SIGNING_DEADLINE_MS`, `DEFAULT_DKG_DEADLINE_MS` — const numbers
  - **Post:** 300_000 ms (5 min) and 900_000 ms (15 min), fallback when `[deadlines]` section absent.

**Invariants:**
- `DaemonConfig` is Ötzi-agnostic; share file stays Ötzi-compatible JSON.
- TOML → TS mapping uses snake_case (TOML) → camelCase (TS).
- `GateConfig.params` and `TriggerEntry.params` are narrowed by phase 5b and 5d respectively; raw `params` here.

**Cross-component contracts:**
- Imported by `parse.ts`, `load.ts`; re-exported for type-safe construction in daemon entrypoint.

**Notes / gotchas:**
- `identityKeyFile`, `pubkeyBookFile` optional in types but required at transport factory time if not in-memory relay.
- `walletAddress` in `PeerEntry` optional until phase 3.

---

### `parse.ts`
**Purpose:** Pure TOML parser. Converts TOML text (snake_case keys) → `DaemonConfig` (camelCase types).

**Public surface:**
- `ConfigError` — class extends Error
  - **Pre:** Constructor takes `path` (TOML key path, e.g. "gate.max_amount") and `message`.
  - **Post:** Thrown when validation fails. `.name = 'ConfigError'`; `message = "config <path>: <message>"`.
  - **Invariant:** `.path` field points to the offending TOML key; used for precise error attribution in logs.

- `parseDaemonConfigToml(text: string)` — function
  - **Pre:** `text` is valid TOML syntax; may lack `[deadlines]` / `[[triggers]]` (optional).
  - **Post:** Returns validated `DaemonConfig` with all cross-field checks run. Defaults applied for missing optional sections.
  - **Throws:** `ConfigError` on invalid TOML, missing required fields, type mismatches, enum violations, or coherence violations. Standard `Error` if TOML syntax is unparseable (from `smol-toml`).

- `parseDaemonConfig(raw: unknown)` — function
  - **Pre:** `raw` is already parsed from TOML (parsed object, not string).
  - **Post:** Same guarantees as `parseDaemonConfigToml`.
  - **Throws:** `ConfigError` for all validation failure modes.

- `asObject(v, path)`, `asString(v, path)`, `asInteger(v, path, min)`, `asArray(v, path)`, `asEnum(v, path, choices)` — helper functions
  - **Pre:** `v` is unknown; `path` for error reporting; `min` optional lower bound.
  - **Post:** Coerced to target type, or throws.
  - **Throws:** `ConfigError` when type mismatch, out-of-range, not in enum, etc.
  - **Notes:** `asInteger` accepts both `number` and `bigint` (TOML can emit large numbers as bigint); coerces to safe Number range.

- `parseShare`, `parseNode`, `parseNetwork`, `parseTransport`, `parsePeer(raw, i)`, `parsePeers`, `parseGate`, `parseDeadlines`, `parseTrigger(raw, i)`, `parseTriggers` — section-level parsers
  - **Pre:** Each receives raw section from TOML parse tree.
  - **Post:** Typed section object (e.g., `ShareConfig`).
  - **Throws:** `ConfigError` with key paths like "share.path", "node.party_id", "gate.strategy", etc.
  - **UDS trigger params:** `params.path` is the absolute UDS socket path. No `bind`, no `auth_token_env`. Validated at parse time as a non-empty string starting with `/`.

- `validateCoherence(cfg)` — function
  - **Pre:** Fully parsed `DaemonConfig`.
  - **Post:** None (checks only; no mutation).
  - **Throws:** `ConfigError` if node id collides with peer id, or partyId collides, etc.

**Invariants:**
- All section paths use snake_case (e.g., `share.password_env`); coerced to camelCase in types.
- `gate.params` and `triggers[i].params` remain raw `Record<string, unknown>` here; narrowed in phases 5b/5d.
- Deadlines default to 5min / 15min if section missing.
- Transport.url required for relay; Transport.listen optional for peer-mesh (error deferred).
- Peers must have at least one entry.

**Cross-component contracts:**
- Used by `load.ts` to wrap file I/O.
- Used by gate/trigger factory phases (5b, 5d) to parse strategy-specific params.

**Notes / gotchas:**
- TOML `[[triggers]]` array is optional (parsed as empty if absent).
- `partyId` coerced to safe integer, minimum 0.
- Bigint in TOML (e.g., large numbers) handled in `asInteger`; compared to `Number.MAX_SAFE_INTEGER`.
- `describe(v)` helper for error messages (null → "null", array → "array", typeof fallback).

---

### `load.ts`
**Purpose:** Thin I/O wrapper. Reads TOML file from disk and delegates parsing.

**Public surface:**
- `loadDaemonConfig(path: string)` — async function
  - **Pre:** `path` is absolute file path to a readable TOML file.
  - **Post:** Returns `DaemonConfig`, fully validated and coherence-checked.
  - **Throws:** I/O errors (file not found, permission denied) as thrown by `readFile`; `ConfigError` from parse failures.

**Invariants:**
- No caching; each call re-reads and re-parses.
- Share file decryption and cross-validation (phase 5e) are NOT in this module.

**Cross-component contracts:**
- Imported by daemon entrypoint (phase 5a bootstrap).

**Notes / gotchas:**
- Errors from I/O are bare Node.js errors; callers should distinguish from `ConfigError` for better UX.

---

