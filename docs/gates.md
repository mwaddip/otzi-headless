# Approval Gates

Per-node policy filter that each daemon applies before joining a ceremony. Gates defend against **API-surface forgery** (external attacker breaches one daemon's HTTP, tries to fan out triggers to t-1 other daemons) and enforce **operational policy** (amount caps, recipient allowlists, business-hours review). Gates do *not* defend against federation insiders — federation members trust each other axiomatically; a rogue insider's worst case is DoS, not theft (the threshold guarantees no `<t` peers yield key material).

See `CLAUDE.md` § Security Model for the full trust-model context.

## Gate contract

Every gate implements:

```ts
interface ApprovalGate {
  approve(spec: CeremonySpec): Promise<Decision>
}
type Decision = 'approve' | 'reject' | 'pending'
```

Rejection is **silent to peers** — a rejecting node contributes no blobs and is indistinguishable from being offline. If fewer than `t` peers approve, signing aborts naturally.

## The `CeremonySpec`

The gate sees a discriminated-union describing the ceremony. BTC signing specs carry `outputs`, `amount`, `destination` **verified** via local rebuild from operator-supplied construction parameters. OPNet signing specs carry operator-supplied **advisory hints** (not verified — daemon stays ABI-agnostic). DKG specs carry threshold/parties/leader.

```jsonc
// BTC signing (after participant rebuilt the tx locally from btcParams)
{
  "kind": "signing",
  "ceremonyId": "btc-ceremony-1",
  "leader": "node-a",
  "role": "participant",              // or "leader" on the initiator
  "operation": "btc-transfer",
  "amount": "50000",                   // bigint → decimal string over the wire
  "destination": "bc1p…",              // first non-self output
  "outputs": [
    { "address": "bc1p…",     "amountSat": "50000" },
    { "address": "bc1pself…", "amountSat": "49000" }   // change output
  ]
}

// OPNet signing (populated from operator-supplied hints)
{
  "kind": "signing",
  "ceremonyId": "opnet-ceremony-1",
  "leader": "node-a",
  "role": "participant",
  "operation": "opnet-call",
  "amount": "1000000",
  "destination": "0x…contract",
  "method": "transfer"
}

// DKG
{
  "kind": "dkg",
  "ceremonyId": "dkg-1",
  "leader": "node-a",
  "role": "leader",
  "protocol": "combined",              // "mldsa" | "frost" | "combined"
  "threshold": 2,
  "parties": 3,
  "peerIds": ["node-a", "node-b", "node-c"]
}
```

**bigints serialize as decimal strings.** Human-in-the-loop hooks should parse `amount`, `outputs[].amountSat` as u64 to avoid JavaScript number-precision loss.

## Built-in strategies

Configured under `[gate]` in daemon TOML.

### `auto` — default, always approves

```toml
[gate]
strategy = "auto"
```

Pure headless — every ceremony is approved without checks. Use for fully automated nodes behind a trusted trigger source.

### `policy` — deterministic rule check

```toml
[gate]
strategy = "policy"
[gate.params]
# Generic signing rules — apply to any signing spec (BTC or OPNet):
max_amount           = 100000              # cap on spec.amount (u64 or decimal string)
destination_allowlist = ["bc1p…", "0x…"]   # spec.destination must be in list
method_allowlist     = ["transfer"]        # spec.method must be in list (OPNet hint)

# BTC-scoped (active iff operation='btc-transfer'):
max_btc_per_tx         = 100000000         # 1 BTC cap on sum of non-self outputs
allowed_btc_recipients = ["bc1p…"]          # every non-self output address must be in list

# OPNet-scoped (active iff operation='opnet-call'):
allowed_contracts      = ["0xcontract…"]    # spec.destination (contract hint) must be in list

# Signing rate limit — sliding 1h window, in-memory, resets on daemon restart:
max_ceremonies_per_hour = 10

# DKG-scoped:
dkg_leader_allowlist    = ["node-a"]
```

**Strict-by-default.** If a rule is set and the spec lacks the corresponding field, the gate **rejects**. Prevents a missing-field-means-bypass loophole.

**Rule scoping.** Generic rules fire on every signing spec. Protocol-scoped rules (`max_btc_per_tx`, `allowed_btc_recipients`, `allowed_contracts`) only fire when the spec's `operation` matches — an `allowed_contracts` rule never rejects a BTC-transfer, and an `allowed_btc_recipients` rule never rejects an OPNet call.

**Self-filtering.** BTC `spec.outputs` is the **non-self** output set only — the vault's own change-back is filtered out in the spec builder. `allowed_btc_recipients` doesn't require every operator to list their own vault P2TR; only external recipients.

**Rate-limit semantics.** `max_ceremonies_per_hour` applies to signing only. Slots are consumed by **approvals**, not rejections — a burst of 100 wrong-destination attempts doesn't lock out a subsequent valid call. Counts are in-memory; a daemon restart resets.

### `exec` — spawn a command per ceremony

```toml
[gate]
strategy = "exec"
[gate.params]
command = ["/etc/otzi/gate-file-approver.sh"]   # argv; command[0] is executable
timeout_sec = 86400                             # hard cap on child lifetime (24h)
working_dir = "/var/otzi"                        # optional cwd
env = { FOO = "bar" }                           # optional env merged into process.env
```

Daemon writes the `CeremonySpec` JSON (bigint → decimal string) on the command's stdin. The command must exit 0 with the first line of stdout being either `approve` or `reject`. Any other output, non-zero exit, or timeout treats the ceremony as rejected (the orchestrator silent-drops; the leader surfaces `GateRejection`).

The Promise only resolves when the command exits — ideal for human-in-the-loop setups where the operator's script blocks (e.g. `inotifywait` on a decision file, polling a queue) until the operator responds.

**Worked example:** `examples/gate-file-approver.sh` implements the file-drop pattern. The script writes the spec to `/var/otzi/pending/<ceremonyId>.json` and blocks until the operator drops a decision file at `/var/otzi/decisions/<ceremonyId>` with content `approve` or `reject`. A web UI is just a directory listing over `/var/otzi/pending/` with buttons that write to `/var/otzi/decisions/`.

### `webhook` — POST spec to an HTTP endpoint

```toml
[gate]
strategy = "webhook"
[gate.params]
url = "https://approver.internal/otzi"
timeout_sec = 86400
bearer_token_env = "APPROVER_TOKEN"    # optional: env var carrying bearer token
```

Daemon POSTs the `CeremonySpec` JSON to `url`. The approver endpoint must respond with `200 OK` and a JSON body `{"decision": "approve" | "reject"}`. The request holds the connection open for up to `timeout_sec`; long-polling is fine. Non-200 responses or missing/unexpected decision fields are treated as errors (→ reject).

### `cli` / `queue` — not yet implemented

Spec'd but not shipping in this release. `cli` is for interactive operator sessions; `queue` is for a daemon-held in-memory pending queue polled by a separate CLI tool. File an issue if you need one.

## Operator-in-the-loop timeouts

Ceremony-wide deadline auto-scales with strategy:

| Strategy            | Signing deadline | DKG deadline | Rationale |
|---------------------|------------------|--------------|-----------|
| `auto`, `policy`    | 5 min            | 15 min       | Machine-only — don't let phantom ceremonies linger. |
| `exec`, `webhook`   | 24 h (default)   | 24 h         | Human-in-the-loop; operator cap configurable. |

Overridable in the daemon's `[deadlines]` block.

## Building your own hook

Any script, service, or SDK wiring that speaks the `CeremonySpec` contract can serve as a gate. Two integration surfaces:

1. **`exec` strategy** — simplest: stdin/stdout. Node, Python, Go, shell — whatever your approver stack is. See `examples/gate-file-approver.sh` for the file-drop pattern.
2. **`webhook` strategy** — for HTTP-native approvers (central queue, Slack bot, SaaS approver). Your endpoint implements: `POST /…` with JSON body → respond `{"decision": "approve" | "reject"}`. The daemon holds the connection open up to `timeout_sec`, so long-poll is fine.

**Reference `webhook` implementation.** `examples/gate-web-opwallet/` ships a standalone Node.js approver service that speaks the webhook interface and enforces **OPWallet-signed ML-DSA-44 decisions** as its auth policy — a complete end-to-end demo of "operator reviews in a browser, wallet signs the decision, daemon sees only `{ "decision": "approve" }` come back on the held webhook response." The daemon itself has no ML-DSA verification code for gates; that's deliberate — the `ApprovalGate` surface is intentionally agnostic to decision logic. Swap the auth scheme (SSO, hardware token, CLI) by editing the approver; the daemon doesn't change.

Checklist:

- **Parse bigints as strings.** `amount`, `outputs[].amountSat` come as decimal strings to preserve u64 precision.
- **Timeouts are yours to own.** Until you respond, the daemon waits (up to `timeout_sec`). A crashed approver → ceremony deadline eventually fires.
- **Stay silent on reject.** The daemon already does silent-drop for you; just return `reject`.
- **Default to reject on error.** Your hook's fail-closed path is the right one — a misconfigured approver should block signing, not default-approve.
- **Log everything.** Each invocation is an audit event. Keep the spec JSON + decision in a durable log so you can reconstruct who approved what.
