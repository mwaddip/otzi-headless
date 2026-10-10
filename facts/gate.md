# Contracts: src/gate/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/gate/

### `types.ts`
**Purpose:** Approval gate interface and ceremony spec shapes.

**Public surface:**
- `Decision` — `'approve' | 'reject' | 'pending'`.
- `CeremonyRole` — `'leader' | 'participant'`.

- `interface CeremonySpecBase { ceremonyId: string; leader: string; role: CeremonyRole }`
  - **Pre:** `ceremonyId` matches `CEREMONY_ID_RE`; `leader` is the leader's label from `peersById` (`resolveLeaderId`); `role` is this node's role.
  - **Post:** Common fields for all ceremony specs.

- `interface SpecOutput { address: string; amount: number; isChange: boolean; label?: string }`
  - **Post:** One transaction output from this node's `analyzeProposal`: `address` as the analysis encodes it, `amount` in sats (safe integer), `isChange` ⇔ the output pays this node's own vault script, `label` from this node's own address book when the address is in it.

- `interface SigningSpec extends CeremonySpecBase`
  ```ts
  kind: 'signing'; network: NetworkName; txid: string;
  inputs: Array<{ txid: string; vout: number; amount: number }>; outputs: SpecOutput[];
  amount: number; totalIn: number; totalOut: number; fee: number; vsize: number; feeRate: number;
  ```
  - **Pre:** Built by `buildSigningSpec` from this node's own `ProposalAnalysis` — never from leader-supplied fields.
  - **Post:** `outputs` lists every output, change included, in transaction order. `amount` = sum of outputs with `isChange === false`. `fee = totalIn − totalOut`. `vsize` assumes one 64-byte key-path signature per input. `feeRate = fee / vsize` (sat/vB, may be fractional). All sat amounts are safe integers.

- `interface DkgSpec extends CeremonySpecBase { kind: 'dkg'; threshold: number; parties: number; network: NetworkName; peerIds: string[] }`
  - **Pre:** `2 ≤ threshold ≤ parties`; `parties` = ring size; `network` = the announced network (equal to this node's); `peerIds` = labels of every ring member, self included.
  - **Post:** DKG ceremony identity and participant list.

- `type CeremonySpec = SigningSpec | DkgSpec` (discriminated union on `.kind`).

- `interface ApprovalGate`
  - **Post:** Single async method `approve(spec: CeremonySpec): Promise<Decision>`.
  - **Contract:** A gate can only FURTHER RESTRICT; never widen. A rejecting node stays silent to peers. DKG aborts on any reject (every ring member takes part). Signing completes only if every node in `signers` approves (`signers` defaults to all n).
  - **Lifecycle:** Gate lives in the trigger layer; ceremony core / transport are unaware.

**Invariants:**
- Every spec field is derived by this node: the leader and each participant analyse the proposal against their own key and network before building the spec (verify-before-gate).
- `isChange` is decided by script equality with this node's own vault script; a leader cannot mark a foreign output as change.
- `Decision` semantics: `'approve'` → proceed; `'reject'` → drop (participant silent, leader surfaces 403); `'pending'` → re-check on external signal.

**Cross-component contracts:**
- `CeremonySpec` built at trigger time (leader, `src/daemon/leader.ts`) or announce-receipt time (participant, `src/orchestrator/orchestrator.ts`) via `src/orchestrator/spec-builder.ts`.
- Daemon promises NOT to mutate spec after passing to gate.
- Exec and webhook approvers receive the spec as JSON.

**Notes / gotchas:**
- Output addresses are exactly the strings `analyzeProposal` produces (lowercase bech32/bech32m for segwit and taproot). Allowlists compare by exact string.

---

### `policy.ts`
**Purpose:** Deterministic, strict-by-default policy rules on Bitcoin ceremony specs.

**Public surface:**
- `interface PolicyConfig`
  ```ts
  maxSatsPerTx?: number; maxSatsPer24h?: number;
  allowedRecipients?: string[] | 'address-book';
  maxFeeSats?: number; maxFeeRate?: number;
  maxCeremoniesPerHour?: number; dkgLeaderAllowlist?: string[];
  ```
  - **Post:** Parsed policy state; a rule is active iff its field is set.

- `interface PolicyGateOptions { now?: () => number; loadAddressBook?: () => Promise<string[]>; logger?: Logger }`
  - `now` defaults to `Date.now` (injectable for window tests).
  - `loadAddressBook` returns the addresses in this node's address book; required for `allowedRecipients === 'address-book'`. It rejects (throws) when the book cannot be loaded, including when the book file does not exist.
  - `logger` (`Logger` / `NOOP_LOGGER` from `src/orchestrator/types.ts`, default `NOOP_LOGGER`) receives the warning the `"address-book"` rule logs when it rejects for a missing dependency or a failed load.

- `class PolicyGate implements ApprovalGate`
  - **Constructor:** `new PolicyGate(config: PolicyConfig, opts?: PolicyGateOptions)`. Never throws.

- `PolicyGate.approve(spec)` — async
  - **Pre:** `spec` built by `spec-builder.ts`.
  - **Post:** `'approve'` iff every active rule passes; `'reject'` otherwise. Never `'pending'`. Never throws.
  - **Signing rules:**

    | Key (`[gate]`) | Field | Rule |
    |---|---|---|
    | `max_sats_per_tx` | `maxSatsPerTx` | `spec.amount` ≤ cap. |
    | `max_sats_per_24h` | `maxSatsPer24h` | Sum of `amount` over this node's approvals in the last 24 h, plus `spec.amount`, ≤ cap. |
    | `allowed_recipients` | `allowedRecipients` | Every output with `isChange === false` has its `address` in the set. With `"address-book"`, the set is `loadAddressBook()` read at each evaluation; a missing or invalid book rejects. |
    | `max_fee_sats` | `maxFeeSats` | `spec.fee` ≤ cap. |
    | `max_fee_rate` | `maxFeeRate` | `spec.feeRate` ≤ cap (sat/vB). |
    | `max_ceremonies_per_hour` | `maxCeremoniesPerHour` | Signing approvals by this node in the last hour < cap. |

  - **DKG rule:** `dkg_leader_allowlist` (`dkgLeaderAllowlist`) — `spec.leader` must be in the list. Signing rules never apply to a `DkgSpec`; the DKG rule never applies to a `SigningSpec`.
  - **Strict by default:** a configured rule whose input is missing rejects. With `"address-book"`, a missing book file, an invalid book file, any other failed load, or no `loadAddressBook` dependency rejects every signing spec — even one whose outputs are all change — and `PolicyGate` logs a warning through its `logger` naming the cause (`no address book loader`, or the load error's message).
  - **Windows:** every rule is evaluated first; only when the final decision is approve is the approval recorded in the hourly window (timestamp) and the 24 h window (`{ at: now(), amount }`). Entries older than 3 600 000 ms / 86 400 000 ms are pruned. The checks and the records happen in one synchronous section (after any address-book load), so concurrent evaluations cannot both pass a cap.

- `parsePolicyParams(params: Record<string, unknown>): PolicyConfig`
  - **Pre:** The `params` of `GateConfig`: every key of the `[gate]` table except `strategy`.
  - **Post:** Validated `PolicyConfig`.
  - **Validation:**
    - `max_sats_per_tx`, `max_sats_per_24h`, `max_fee_sats`: non-negative safe integers, given as a TOML integer or a decimal string.
    - `max_fee_rate`: non-negative number (may be fractional) or decimal string.
    - `allowed_recipients`: an array of non-empty address strings, or the string `"address-book"`; any other string is a `ConfigError`.
    - `max_ceremonies_per_hour`: positive integer.
    - `dkg_leader_allowlist`: array of strings.
    - Unknown keys are rejected.
  - **Rejected keys** (each a `ConfigError` at `gate.<key>`):

    | Key | Message |
    |---|---|
    | `max_amount`, `max_btc_per_tx` | `use max_sats_per_tx` |
    | `allowed_btc_recipients`, `destination_allowlist` | `use allowed_recipients` |
    | `method_allowlist`, `allowed_contracts` | `no longer supported` |

  - **Throws:** `ConfigError` (from `../config/parse`) with a path like `gate.max_fee_rate` or `gate.allowed_recipients[2]`.

**Invariants:**
- Strict-by-default: if a rule is configured and the spec lacks its input, the gate rejects.
- Windows are in memory (reset on daemon restart) and count approvals only — every approval this node gives, leader or participant, whether or not the ceremony then completes.
- `amount` counts only non-change outputs, so change back to the vault never consumes a cap.

**Cross-component contracts:**
- Created by `factory.createGate()` when `gate.strategy === 'policy'`.
- `loadAddressBook` is wired by the daemon: it reads the node's address book (`addressBookPath`, default `DEFAULT_ADDRESS_BOOK_PATH`) with `readAddressBook(addressBookPath, network, { missing: 'error' })`, so a missing file (ENOENT) is a failure where the default reading returns `[]` (see [address-book.md](address-book.md)).
- Expected by daemon to be deterministic and side-effect-free apart from the window memory.

**Notes / gotchas:**
- Rejects are not recorded, so they don't count toward the windows.
- With `"address-book"`, editing `/etc/otzi/address-book.otzi.json` widens the allowlist; the file is root-owned 0640 for that reason.

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
  - **Note:** Thrown errors are caught by the orchestrator and treated as `reject` at a participant (silent), or as `GateRejection` at the leader.
  - **Timeout:** Hard cap via `setTimeout` → `SIGTERM`. Timer cleared on success.

- `serializeSpec(spec)` — function
  - **Pre:** `spec` is `CeremonySpec` (SigningSpec or DkgSpec).
  - **Post:** JSON string; any bigint is rendered as a decimal string. Bitcoin specs carry only safe-integer and finite numbers, so amounts, fee and fee rate appear as JSON numbers.

- `parseExecParams(params)` — function
  - **Pre:** The `params` of `GateConfig`: every key of the `[gate]` table except `strategy`.
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
- Spec includes all fields; delegate is responsible for validation if needed. `examples/gate-file-approver.sh` reads the signing spec fields.

**Notes / gotchas:**
- Command is spawned every time `approve()` is called (no caching; idempotency is delegate's responsibility).
- Working directory defaults to daemon's cwd if omitted.
- Environment is merged (not replaced); delegate sees `process.env` + the `[gate]` table's `env`.
- Timeout is hard wall (SIGTERM); no grace period for cleanup.
- stderr truncated to 500 chars in error message for readability.

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
    1. Build headers: `{'content-type': 'application/json'}` + optional `Authorization: Bearer <token>` (from env; throws before any request when the variable is empty or unset).
    2. POST `serializeSpec(spec)` to `url` with `node:http` / `node:https` `request` (a fresh connection per call; redirects are not followed). The deadline timer starts here.
    3. Collect the response body, at most 64 KiB (65 536 bytes).
    4. A status outside 2xx throws with the status line and the first 500 characters of the body.
    5. Expect JSON `{"decision": "approve" | "reject"}`; return the decision.
  - **Returns:** `'approve'` or `'reject'` from response.decision.
  - **Throws:** Error on HTTP failure, timeout, a connection closed before the body ended, a 2xx body over 64 KiB, non-JSON response, missing/invalid decision field, or non-2xx HTTP status.
  - **Timeout:** `timeoutSec` is ONE deadline covering connect, response headers and the whole body read. On expiry the request is destroyed and the call throws `WebhookGate: timed out after <timeoutSec>s`. Early headers, trickled bytes or a stalled body do not extend it. Values above 2 147 483 647 ms (the longest timer Node can set) are capped to it.

- `parseWebhookParams(params)` — function
  - **Pre:** The `params` of `GateConfig`: every key of the `[gate]` table except `strategy`.
  - **Post:** Validated `WebhookGateConfig`.
  - **Throws:** `ConfigError` for invalid url, missing timeout_sec, bad bearer_token_env, etc.

**Invariants:**
- POST body is the JSON-serialized spec (`serializeSpec`, as with `ExecGate`).
- Response is expected to be JSON with `{"decision": "approve" | "reject"}`.
- Bearer token is read from env at request time (not at config time); throws if env var is missing/empty when set.
- Non-OK HTTP status (not 2xx) throws before parsing response body.
- The transport is `node:http` / `node:https`, not `fetch`: the global fetch client abandons a response that is silent for 5 minutes (headers and body timeouts), whatever `timeoutSec` says.
- The response body is capped at 64 KiB, so a hostile approver cannot exhaust the daemon's memory.

**Cross-component contracts:**
- Created by `factory.createGate()` when `gate.strategy === 'webhook'`.
- Daemon expects synchronous-looking approval via HTTP (long-polling supported; endpoint holds connection open for up to `timeoutSec`, with or without sending headers early).
- Spec includes all fields; delegate is responsible for validation if needed. `examples/gate-web-btc-message/` is a webhook approver whose operator signs each decision with a Bitcoin message signature.

**Notes / gotchas:**
- Bearer token is read from `process.env[bearerTokenEnv]` on each request (allows rotation without daemon restart).
- If env var is set but empty, throws immediately.
- The timeout covers the connection, the response headers and the whole body read; the JSON parse that follows is synchronous.
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
  - **Use:** Default gate strategy (no policy).

- `AutoGate.approve(spec)` — async method
  - **Pre:** Any spec.
  - **Post:** Returns `Promise<'approve'>`.
  - **Throws:** Never.

- `createGate(config: GateConfig, deps?: { loadAddressBook?: () => Promise<string[]>; logger?: Logger }): ApprovalGate`
  - **Pre:** `config` is validated `GateConfig` with strategy ∈ `GATE_STRATEGIES`.
  - **Post:** Returns `ApprovalGate` (one of AutoGate, PolicyGate, ExecGate, WebhookGate).
  - **Dispatch table:**
    - `'auto'` → `new AutoGate()`.
    - `'policy'` → `new PolicyGate(parsePolicyParams(config.params ?? {}), { loadAddressBook: deps?.loadAddressBook, logger: deps?.logger })`.
    - `'exec'` → `new ExecGate(parseExecParams(config.params ?? {}))`.
    - `'webhook'` → `new WebhookGate(parseWebhookParams(config.params ?? {}))`.
    - Fallback → Throw "unreachable" (exhaustive check via TypeScript `never`).
  - **Throws:** ConfigError from parse* helpers if params are invalid.

**Invariants:**
- Exactly one gate is constructed per daemon (singleton at startup, used for every ceremony, leader and participant).
- Each strategy's `parseFooParams()` is called here; errors abort daemon startup.

**Cross-component contracts:**
- Called by `Daemon` at construction, with `loadAddressBook` reading this node's address book (a missing file is a failure) and the daemon's `logger`.
- Gate instance persists for daemon lifetime (stateful for rate windows).

**Notes / gotchas:**
- `config.params` defaults to empty object (`{}`) if undefined; ensures parse* helpers don't crash on null/undefined.
- TypeScript exhaustive check (`const _exhaustive: never = ...`) ensures new strategies require explicit dispatch.

---

## examples/ (approver examples, not part of the daemon)

### `examples/gate-web-btc-message/`
**Purpose:** Webhook approver whose operator signs every decision with a Bitcoin message signature in any wallet that signs messages. Run with `npx tsx examples/gate-web-btc-message/approver.ts`; `APPROVER_ADDRESS` pins the one operator address whose signatures count. The page lists pending specs with outputs, labels, change, fee and fee rate.

**Public surface (`decision.ts`):**
- `decisionMessage(decision: 'approve' | 'reject', ceremonyId: string, nonce: string): string`
  - **Post:** `` `otzi-gate:${decision}:${ceremonyId}:${nonce}` ``.
- `verifyDecision(p: { address: string; decision: 'approve' | 'reject'; ceremonyId: string; nonce: string; signature: string }): boolean`
  - **Post:** `verifyBitcoinMessage(p.address, decisionMessage(p.decision, p.ceremonyId, p.nonce), p.signature)` — BIP-322 simple for P2WPKH / P2TR, legacy / BIP-137 for older types. Never throws.

**Approver (`approver.ts`):**
- Environment: `APPROVER_ADDRESS` (required; must satisfy `isValidSignInAddress`, otherwise the approver exits 1), `APPROVER_LISTEN` (`host:port`, default `127.0.0.1:8181`), `APPROVER_TOKEN` (optional; when set, `POST /webhook` requires `Authorization: Bearer <token>`).
- `POST /webhook` is the daemon's webhook gate. The body is the spec JSON; `ceremonyId` must match `^[A-Za-z0-9._:-]{1,128}$` and `kind` must be `signing` or `dkg`, else `400`. The request is held, with no response bytes sent, under a fresh random 16-byte hex nonce until `/decide` answers it with `200 {"decision": …}`, the daemon disconnects (its `timeout_sec` passed or it restarted; the entry is dropped), or shutdown answers `503`.
- `GET /pending` returns `{ address, pending: [{ nonce, ceremonyId, receivedAt, spec, messages: { approve, reject } }] }`, where `messages` holds the `decisionMessage` text for each decision.
- `POST /decide` takes `{ nonce, decision, signature }`. It resolves the held request only when `verifyDecision` holds for the pinned address, that request's ceremony id and the nonce. A signature that does not verify answers `403` and leaves the request pending; an unknown or used nonce answers `404`.

**Invariants:**
- The signed message binds the decision to one ceremony and one approver-issued nonce, so a signature cannot be replayed for another ceremony or the other decision.
- A nonce is deleted when its decision lands, so it works once. Requests are keyed by nonce, so two nodes holding the same `ceremonyId` do not collide.
- The approver imports the lifted `src/otzi/backend/btc-message.ts`; the daemon never does. The daemon sees only `{"decision": …}` from the webhook.

### `examples/gate-file-approver.sh`
**Purpose:** File-drop `exec` approver. Reads the spec JSON from stdin, writes it to `<pending dir>/<ceremonyId>.json` for the operator, waits for a decision file `<decisions dir>/<ceremonyId>` containing `approve` or `reject`, and prints that decision. Every spec field it reads is a field of the Bitcoin `SigningSpec` / `DkgSpec` above.
