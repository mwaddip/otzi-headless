# Contracts: src/gate/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/gate/

### `types.ts`
**Purpose:** Approval gate interface and ceremony spec shapes.

**Public surface:**
- `Decision` — `'approve' | 'reject' | 'pending'`.
- `CeremonyRole` — `'leader' | 'participant'`.

- `CeremonySpecBase` — interface
  - **Pre:** `ceremonyId` unique; `leader` matches a peer id in config; `role` in `{'leader', 'participant'}`.
  - **Post:** Common fields for all ceremony specs.

- `SigningSpec` — interface
  - **Pre:**
    - `kind === 'signing'`.
    - `operation` ∈ `{'btc-transfer', 'opnet-call', 'key-link', 'generic'}`.
    - `amount` bigint (smallest units: sats for BTC, atomic for OPNet) or undefined (e.g., raw-message signing).
    - `destination` address string or undefined (primary output for BTC, contract for OPNet).
    - `method` string (OPNet method or BTC sighash tag) or undefined.
    - `outputs` populated ONLY for `operation === 'btc-transfer'`; every non-self output address decoded (verified by participant rebuild).
    - Vault's own change output is EXCLUDED from outputs (policy rules like `allowed_btc_recipients` don't require self-address in allowlist).
  - **Post:** High-level operation intent, amount, destination, external outputs.

- `DkgSpec` — interface
  - **Pre:**
    - `kind === 'dkg'`.
    - `protocol` ∈ `{'mldsa', 'frost', 'combined'}`.
    - `threshold` ≥ 1.
    - `parties` ≥ threshold.
    - `peerIds` array of expected peer ids (including self).
  - **Post:** DKG ceremony identity and participant list.

- `CeremonySpec` — `SigningSpec | DkgSpec` (discriminated union on `.kind`).

- `ApprovalGate` — interface
  - **Post:** Single async method `approve(spec: CeremonySpec): Promise<Decision>`.
  - **Contract:** Gate can only FURTHER RESTRICT; never widen decisions. Rejecting node stays silent to peers. DKG aborts on any reject (threshold = n). Signing proceeds iff ≥ t peers approve.
  - **Lifecycle:** Gate lives in trigger layer; ceremony core / transport are unaware.

**Invariants:**
- `outputs` is readonly (immutable view). Non-self outputs only; change filtered at spec-build.
- `SigningSpec.details` extra fields for audit/logging; gate behavior ignores unless rule-relevant.
- `Decision` semantics: `'approve'` → proceed; `'reject'` → drop (participant silent, leader surfaces); `'pending'` → re-check on external signal.

**Cross-component contracts:**
- `CeremonySpec` built at trigger time (leader) or announce-receipt (participant).
- Specs wired through announce payload (phase 5c/5d).
- Daemon promises NOT to mutate spec after passing to gate.

**Notes / gotchas:**
- BTC outputs exclude change (detected & filtered during spec build). Policy rule `allowed_btc_recipients` applies only to external outputs.
- `amount` is sum of non-self outputs for BTC; hints-supplied for OPNet (treated as opaque by gate, verification is upstream).

---

### `policy.ts`
**Purpose:** Deterministic, strict-by-default policy rule engine on ceremony specs.

**Public surface:**
- `PolicyConfig` — interface
  - **Pre:** All fields optional; combination determines which rules are active.
  - **Post:** Parsed policy state (allowlists, caps, rate limit).
  - **Rules:**
    - `maxAmount` (u64 or decimal string) — cap on `spec.amount`. Spec rejected if amount missing OR > cap.
    - `destinationAllowlist` (string array) — destination must be in list if set. Rejected if destination missing.
    - `methodAllowlist` (string array) — method must be in list if set. Rejected if method missing.
    - `maxBtcPerTx` (BTC-only, smallest units) — cap on sum of non-self outputs. Active only when `operation === 'btc-transfer'`. Rejected if outputs missing.
    - `allowedBtcRecipients` (BTC-only) — every non-self output address must be in list. Rejected if outputs missing or any address is null (OP_RETURN, etc.).
    - `allowedContracts` (OPNet-only) — `spec.destination` must be in list. Active only when `operation === 'opnet-call'`. Rejected if destination missing.
    - `maxCeremoniesPerHour` (sliding window, approvals-only) — max signing ceremonies approved per rolling hour. Rejected when exceeded.
    - `dkgLeaderAllowlist` (DKG-only) — leader must be in list if set.

- `PolicyGate` — class implements `ApprovalGate`
  - **Pre:** Constructor takes `PolicyConfig` and optional `now: () => number` (for deterministic testing of rate limit).
  - **Post:** Instance ready to approve specs.
  - **Throws:** Never in constructor.
  - **Invariant:** `signingApprovals` array holds timestamps (ms) of approved signing ceremonies; pruned by sliding-window cutoff.

- `PolicyGate.approve(spec)` — async method
  - **Pre:** `spec` is fully populated (spec-builder responsibility).
  - **Post:** Returns `Promise<Decision>`.
  - **Returns:**
    - `'approve'` if all active rules pass.
    - `'reject'` if any rule fails (no partial information leaked; fail-stop).
    - Never `'pending'`.
  - **Throws:** Never (async, returns Decision).
  - **Semantics of strict-by-default:**
    - If operator sets allowlist/cap AND spec lacks the corresponding field → reject.
    - Rationale: operator explicitly opted in; field-missing should not bypass.
  - **Rate limit:** Check + record atomically (no async gap). Sliding window: cutoff = now() - 1hr, prune old entries, check count, append timestamp.

- `parsePolicyParams(params)` — function
  - **Pre:** Raw TOML `[gate.params]` table (string keys, unknown values).
  - **Post:** Validated `PolicyConfig`.
  - **Throws:** `ConfigError` with path like `gate.max_amount`, `gate.allowed_btc_recipients[i]`, etc.
  - **Validation:**
    - `max_amount` coerced to bigint via `coerceAmount` (accepts number, bigint, or decimal string "12345").
    - Allowlists coerced to string array via `coerceStringArray`.
    - `max_ceremonies_per_hour` coerced to positive integer via `coercePositiveInt`.
    - Unknown keys rejected.

- `coerceAmount(v, path)`, `coercePositiveInt(v, path)`, `coerceStringArray(v, path)` — helpers
  - **Pre:** `v` is unknown; `path` for error reporting.
  - **Post:** Coerced type or throws.
  - **Throws:** `ConfigError` when invalid.
  - **Notes:** `coerceAmount` accepts `number`, `bigint`, or non-negative decimal string.

**Invariants:**
- Strict-by-default: if a rule is configured and spec lacks the field, gate rejects.
- Rate limit window is in-memory (resets on daemon restart); entries are per-approval (not per-ceremony, not per-leader).
- BTC rules (maxBtcPerTx, allowedBtcRecipients) only active when `operation === 'btc-transfer'`.
- OPNet rule (allowedContracts) only active when `operation === 'opnet-call'`.
- DKG rule (dkgLeaderAllowlist) only active when `kind === 'dkg'`.

**Cross-component contracts:**
- Created by `factory.createGate()` when `gate.strategy === 'policy'`.
- Expected by daemon to be deterministic and side-effect-free (except rate-limit memory).
- Needs injectable `now()` for testing.

**Notes / gotchas:**
- Rate limit is in-memory and approvals-only (rejects are not recorded, so they don't count toward the window).
- Change output filtering happens at spec-build time, not in the policy gate.
- Null addresses in BTC outputs (OP_RETURN) are explicitly rejected if `allowedBtcRecipients` is set.
- Amount validation is generic (any operation with amount); BTC + OPNet can both use it.

---

### `exec.ts`
**Purpose:** Operator-in-the-loop approval via spawned subprocess.

**Public surface:**
- `ExecGateConfig` — interface
  - **Pre:**
    - `command` non-empty array of strings; `command[0]` is executable.
    - `timeoutSec` positive number.
    - `workingDir` optional absolute path.
    - `env` optional key-value table (merged into `process.env`).
  - **Post:** Configuration for subprocess spawning.

- `ExecGate` — class implements `ApprovalGate`
  - **Pre:** Constructor takes `ExecGateConfig`.
  - **Post:** Instance ready to approve specs by spawning a child process.
  - **Throws:** Never in constructor.

- `ExecGate.approve(spec)` — async method
  - **Pre:** `spec` is fully populated.
  - **Post:** Returns `Promise<Decision>`.
  - **Process:**
    1. Spawn `command[0]` with args `command[1..]`.
    2. Write `serializeSpec(spec) + '\n'` to stdin.
    3. Capture stdout/stderr.
    4. Wait for exit with `timeoutSec` hard cap (SIGTERM on timeout).
    5. Parse first line of stdout: `'approve'` or `'reject'` (case-insensitive).
    6. Non-zero exit → throw. Unexpected output → throw.
  - **Returns:**
    - `'approve'` if exit code 0 and first stdout line is "approve".
    - `'reject'` if exit code 0 and first stdout line is "reject".
  - **Throws:** Error when exit code ≠ 0, timeout, spawn failure, or unexpected output.
  - **Note:** Thrown errors are caught by orchestrator and converted to `reject` at participant (silent), or `GateRejection` at leader.
  - **Timeout:** Hard cap via `setTimeout` → `SIGTERM`. Timer cleared on success.

- `serializeSpec(spec)` — function
  - **Pre:** `spec` is `CeremonySpec` (SigningSpec or DkgSpec).
  - **Post:** JSON string with bigints → decimal strings.
  - **Contract:** Bigint serialization is load-bearing. Exec delegate must parse decimal strings back to bigint if needed for arithmetic.
  - **Example:** `{amount: 50000n}` → `{"amount":"50000"}`.

- `parseExecParams(params)` — function
  - **Pre:** Raw TOML `[gate.params]` table.
  - **Post:** Validated `ExecGateConfig`.
  - **Throws:** `ConfigError` for invalid command, missing timeout_sec, bad env, etc.
  - **Validation:**
    - `command` must be non-empty string array.
    - `timeout_sec` must be positive number.
    - `working_dir` optional string.
    - `env` optional key-value table (all values must be strings).

**Invariants:**
- Spec is JSON-serialized on stdin (one line, newline-terminated).
- stdout first line determines decision (case-insensitive, trimmed).
- stderr is captured but not parsed (logged for debugging).
- If command returns multiple lines, only first is used.
- Throwing from `approve()` is caught by orchestrator and handled as gate rejection.

**Cross-component contracts:**
- Created by `factory.createGate()` when `gate.strategy === 'exec'`.
- Daemon expects synchronous-looking approval via stdin/stdout protocol.
- Spec includes all fields; delegate is responsible for validation if needed.

**Notes / gotchas:**
- Command is spawned every time `approve()` is called (no caching; idempotency is delegate's responsibility).
- Working directory defaults to daemon's cwd if omitted.
- Environment is merged (not replaced); delegate sees `process.env` + `[gate.params].env`.
- Timeout is hard wall (SIGTERM); no grace period for cleanup.
- stderr truncated to 500 chars in error message for readability.
- Bigint in spec is serialized as decimal string (e.g., "50000", not 50000); delegate must parse back if needed.

---

### `webhook.ts`
**Purpose:** Operator-in-the-loop approval via HTTP POST.

**Public surface:**
- `WebhookGateConfig` — interface
  - **Pre:**
    - `url` non-empty string (HTTP endpoint).
    - `timeoutSec` positive number.
    - `bearerTokenEnv` optional env var name (for `Authorization: Bearer` header).
  - **Post:** Configuration for HTTP approval request.

- `WebhookGate` — class implements `ApprovalGate`
  - **Pre:** Constructor takes `WebhookGateConfig`.
  - **Post:** Instance ready to approve specs by HTTP POST.
  - **Throws:** Never in constructor.

- `WebhookGate.approve(spec)` — async method
  - **Pre:** `spec` is fully populated.
  - **Post:** Returns `Promise<Decision>`.
  - **Process:**
    1. Set up AbortController, timeout = `timeoutSec * 1000` ms.
    2. Build headers: `{'content-type': 'application/json'}` + optional `Authorization: Bearer <token>` (from env).
    3. POST `serializeSpec(spec)` to `url`.
    4. Expect JSON response `{"decision": "approve" | "reject"}`.
    5. Return decision.
  - **Returns:** `'approve'` or `'reject'` from response.decision.
  - **Throws:** Error on HTTP failure, timeout, non-JSON response, missing/invalid decision field, or non-OK HTTP status.
  - **Timeout:** AbortController signal aborted after `timeoutSec * 1000` ms; fetch rejects with AbortError.

- `parseWebhookParams(params)` — function
  - **Pre:** Raw TOML `[gate.params]` table.
  - **Post:** Validated `WebhookGateConfig`.
  - **Throws:** `ConfigError` for invalid url, missing timeout_sec, bad bearer_token_env, etc.

**Invariants:**
- POST body is JSON-serialized spec (bigints as decimal strings, as with `ExecGate`).
- Response is expected to be JSON with `{"decision": "approve" | "reject"}`.
- Bearer token is read from env at request time (not at config time); throws if env var is missing/empty when set.
- Non-OK HTTP status (not 2xx) throws before parsing response body.

**Cross-component contracts:**
- Created by `factory.createGate()` when `gate.strategy === 'webhook'`.
- Daemon expects synchronous-looking approval via HTTP (long-polling supported; endpoint holds connection open).
- Spec includes all fields; delegate is responsible for validation if needed.

**Notes / gotchas:**
- Bearer token is read from `process.env[bearerTokenEnv]` on each request (allows rotation without daemon restart).
- If env var is set but empty, throws immediately.
- Timeout applies to entire HTTP request lifecycle (connection + response read + body parse).
- Response body truncated to 500 chars in error message.
- HTTP errors (connection refused, DNS failure, timeout) result in thrown Error (not Decision).
- If response JSON is missing `decision` field, throws (no default).

---

### `factory.ts`
**Purpose:** Gate construction dispatcher. Routes config.strategy → `ApprovalGate` implementation.

**Public surface:**
- `AutoGate` — class implements `ApprovalGate`
  - **Pre:** None.
  - **Post:** Instance that always returns `'approve'`.
  - **Throws:** Never.
  - **Use:** Default gate strategy (tautological, no policy).

- `AutoGate.approve(spec)` — async method
  - **Pre:** Any spec.
  - **Post:** Returns `Promise<'approve'>`.
  - **Throws:** Never.

- `createGate(config)` — function
  - **Pre:** `config` is validated `GateConfig` with strategy ∈ `GATE_STRATEGIES`.
  - **Post:** Returns `ApprovalGate` (one of AutoGate, PolicyGate, ExecGate, WebhookGate).
  - **Dispatch table:**
    - `'auto'` → `new AutoGate()`.
    - `'policy'` → `new PolicyGate(parsePolicyParams(config.params ?? {}))`.
    - `'exec'` → `new ExecGate(parseExecParams(config.params ?? {}))`.
    - `'webhook'` → `new WebhookGate(parseWebhookParams(config.params ?? {}))`.
    - Fallback → Throw "unreachable" (exhaustive check via TypeScript `never`).
  - **Throws:** ConfigError from parse* helpers if params are invalid.
  - **Note:** Passing `config.params ?? {}` ensures parse* helpers receive an object (even if params is undefined).

**Invariants:**
- Exactly one gate is constructed per daemon (singleton at startup, used for every ceremony).
- Each strategy's `parseFooParams()` is called here; errors abort daemon startup.

**Cross-component contracts:**
- Called by daemon entrypoint (phase 5b gate narrowing).
- Returned gate is passed to trigger layer for each ceremony.
- Gate instance persists for daemon lifetime (stateful for rate limit, etc.).

**Notes / gotchas:**
- `config.params` defaults to empty object (`{}`) if undefined; ensures parse* helpers don't crash on null/undefined.
- TypeScript exhaustive check (`const _exhaustive: never = ...`) ensures new strategies require explicit dispatch.

---

