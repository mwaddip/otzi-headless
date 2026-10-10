# Approval Gates

Per-node filter that each daemon applies before joining a ceremony. The threshold
protects key material: compromising fewer than `t` shares yields nothing. It does
not protect against a compromised *machine* being used as a signing oracle — an
attacker who owns one daemon and can forge triggers into the other auto-signing
daemons reaches the same capability as stealing the key, without stealing any
share. Gates close that gap and enforce **operational policy** (amount caps,
recipient allowlists, fee caps, business-hours review).

A gate decides for its own node only. It cannot stop a spend that every node's
gate approves, so configure gates on every node that should refuse a class of
spends. The ring is the trust boundary; the gate lets each node refuse spends it
should not make.

See `CLAUDE.md` § Security Model for the full trust-model context.

## Gate contract

Every gate implements:

```ts
interface ApprovalGate {
  approve(spec: CeremonySpec): Promise<Decision>
}
type Decision = 'approve' | 'reject' | 'pending'
```

- A gate only **restricts** what its node will sign; it never widens it.
- Rejection is **silent to peers**. A rejecting node contributes no blobs and is
  indistinguishable from an offline node.
- Signing completes only if every node in the signer set approves (all n nodes by
  default). DKG aborts on any reject. A rejecting node therefore stops the
  ceremony; the leader's `sign` call fails.
- A gate that throws, times out or returns anything but `approve` counts as a
  reject. At the leader that is a `403`; at a participant it is a silent drop.
- On the leader the gate runs once per `sign` request, before anything is
  announced. On a participant it runs when the announce arrives.

## The `CeremonySpec`

**Every node builds the spec from its own analysis.** Before the gate runs, the
leader and every participant analyse the proposal against their own key package
and their own network (every input must spend this vault's script, change is any
output paying this vault's script, the proposal network must equal this node's
network). The spec carries the result of that analysis. Nothing in it comes from
the leader's claims, so a compromised leader cannot hide an output behind a fake
change address or misreport the fee.

### Signing spec

```jsonc
{
  "kind": "signing",
  "ceremonyId": "withdrawal-0042",
  "leader": "peer-0",                 // label of the leader; see § Labels
  "role": "participant",              // or "leader" on the initiating node
  "network": "testnet4",
  "txid": "4d2a…",
  "inputs": [
    { "txid": "9f1c…e2", "vout": 0, "amount": 100000 }
  ],
  "outputs": [
    { "address": "tb1p…recipient", "amount": 50000, "isChange": false, "label": "treasury" },
    { "address": "tb1p…vault",     "amount": 49230, "isChange": true }
  ],
  "amount": 50000,                    // sum of non-change outputs, sats
  "totalIn": 100000,
  "totalOut": 99230,
  "fee": 770,
  "vsize": 154,                       // assumes one 64-byte key-path signature per input
  "feeRate": 5                        // sat/vB, may be fractional
}
```

| Field | Notes |
|---|---|
| `outputs[].address` | Exactly the string the analysis encodes (lowercase bech32/bech32m for segwit and taproot). Allowlists compare by exact string. |
| `outputs[].isChange` | True iff the output pays this node's own vault script. |
| `outputs[].label` | Present when the address is in **this node's own address book**. |
| `amount` | Sum of the non-change outputs. Change back to the vault never counts. |
| `fee`, `feeRate` | `totalIn − totalOut` and `fee / vsize`. |

All sat amounts are safe integers and appear as JSON numbers.

### DKG spec

```jsonc
{
  "kind": "dkg",
  "ceremonyId": "setup-2026-10-10",
  "leader": "peer-1",
  "role": "participant",
  "threshold": 3,
  "parties": 3,
  "network": "testnet4",
  "peerIds": ["node-a", "peer-1", "peer-2"]
}
```

`parties` is the ring size and `network` is this node's own network: a node
drops a DKG announce whose values differ before its gate is asked.

### Labels

`leader` and `peerIds` use local labels: `peer-<partyId>` for another node and
this node's `[node].id` for itself. They are the values `dkg_leader_allowlist`
matches against.

## Built-in strategies

Configured under `[gate]` in daemon TOML. Strategy params sit directly in the
`[gate]` table next to `strategy`.

### `auto` — default, always approves

```toml
[gate]
strategy = "auto"
```

Pure headless — every ceremony is approved without checks. Use for fully
automated nodes behind a trusted trigger source. With `auto` on every node, any
ring member that can fire a trigger can spend the vault.

### `policy` — deterministic rule check

```toml
[gate]
strategy                = "policy"
max_sats_per_tx         = 5000000
max_sats_per_24h        = "20000000"
allowed_recipients      = "address-book"
max_fee_sats            = 50000
max_fee_rate            = 50
max_ceremonies_per_hour = 10
```

| Key | Rule |
|---|---|
| `max_sats_per_tx` | `spec.amount` ≤ cap. |
| `max_sats_per_24h` | Sum of `amount` over this node's approvals in the last 24 h, plus this spec, ≤ cap. Recorded at approval; held in memory. |
| `allowed_recipients` | An array of addresses, or the string `"address-book"`. Every non-change output address must be in the set. With `"address-book"`, the book is read at each evaluation; a missing or invalid book rejects. |
| `max_fee_sats` | `spec.fee` ≤ cap. Stops a fee-burn proposal that passes the amount and recipient rules. |
| `max_fee_rate` | `spec.feeRate` ≤ cap (sat/vB). |
| `max_ceremonies_per_hour` | Signing approvals by this node in the last hour < cap. |
| `dkg_leader_allowlist` | DKG only: `spec.leader` must be in the list (see § Labels). |

Caps are non-negative safe integers (TOML integer or decimal string);
`max_fee_rate` may be fractional. Unknown keys are rejected.

**Rejected keys.** Each raises a `ConfigError` at startup:

| Key | Use instead |
|---|---|
| `max_amount`, `max_btc_per_tx` | `max_sats_per_tx` |
| `destination_allowlist`, `allowed_btc_recipients` | `allowed_recipients` |
| `method_allowlist`, `allowed_contracts` | none — a Bitcoin vault signs plain transfers only |

**Strict-by-default.** If a rule is set and its input is missing, the gate
**rejects**. With `allowed_recipients = "address-book"`, a missing book file, an
invalid book file or any other failed read rejects every signing spec, even one
whose outputs are all change. This prevents a missing-input-means-bypass
loophole.

**Rule scoping.** Signing rules apply to signing specs only;
`dkg_leader_allowlist` applies to DKG specs only. A policy gate with no
`dkg_leader_allowlist` approves every DKG.

**Window semantics.** Every rule is evaluated first. Only when the final decision
is approve is the approval recorded in the hourly and 24 h windows, so rejected
specs never consume a cap. The windows count every approval this node gives —
as leader or participant — whether or not the ceremony then completes. They
live in memory and reset on daemon restart.

**Address book.** `"address-book"` reads this node's
`/etc/otzi/address-book.otzi.json` (Ötzi's address-book file format). Edits take
effect without a restart. The book widens the allowlist, so the file is
root-owned and writing it needs root; keep it identical across nodes if you want
every node to enforce the same recipients (`otzi book export` / `otzi book import`).

### `exec` — spawn a command per ceremony

```toml
[gate]
strategy    = "exec"
command     = ["/etc/otzi/gate-file-approver.sh"]   # argv; command[0] is executable
timeout_sec = 86400                                  # hard cap on child lifetime (24h)
working_dir = "/var/otzi"                            # optional cwd
env         = { FOO = "bar" }                        # optional env merged into process.env
```

The daemon writes the spec JSON as one line on the command's stdin. The command
must exit 0 with the first line of stdout being either `approve` or `reject`.
Any other output, non-zero exit or timeout rejects the ceremony (a participant
drops it silently; the leader returns `403`).

The promise only resolves when the command exits — ideal for human-in-the-loop
setups where the operator's script blocks (e.g. `inotifywait` on a decision file,
polling a queue) until the operator responds.

**Worked example:** `examples/gate-file-approver.sh` implements the file-drop
pattern. The script writes the spec to `/var/otzi/pending/<ceremonyId>.json` and
blocks until the operator drops a decision file at
`/var/otzi/decisions/<ceremonyId>` with content `approve` or `reject`. A web UI
is just a directory listing over `/var/otzi/pending/` with buttons that write to
`/var/otzi/decisions/`.

### `webhook` — POST spec to an HTTP endpoint

```toml
[gate]
strategy         = "webhook"
url              = "https://approver.internal/otzi"
timeout_sec      = 86400
bearer_token_env = "APPROVER_TOKEN"    # optional: env var carrying bearer token
```

The daemon POSTs the spec JSON to `url`. The approver endpoint must respond with
`200 OK` and a JSON body `{"decision": "approve" | "reject"}`. The request holds
the connection open for up to `timeout_sec`; long-polling is fine. Non-200
responses or missing/unexpected decision fields are treated as errors (→ reject).

## Operator-in-the-loop timeouts

The ceremony-wide deadlines come from `[deadlines]` and default to the
machine-only values regardless of strategy:

| Strategy | Signing deadline | DKG deadline | Guidance |
|---|---|---|---|
| `auto`, `policy` | 5 min (default) | 15 min (default) | Machine-only — don't let phantom ceremonies linger. |
| `exec`, `webhook` | set to the review window, e.g. 24 h | set likewise | A human approves. Raise `signing_ms` / `dkg_ms` in `[deadlines]` to cover the slowest approver. |

Every ceremony's pulls run until the ceremony deadline. With `exec` and `webhook`
gates, **every signer's decision must therefore arrive within the ceremony
deadline**: the leader waits for each participant's blobs only that long, and a
participant that approves after the deadline has missed the ceremony. Operators
using human approvals should raise `signing_ms` (and `dkg_ms`) on every node to
cover the slowest approver, and keep each gate's `timeout_sec` within it.

## Building your own hook

Any script, service or SDK wiring that speaks the spec contract can serve as a
gate. Two integration surfaces:

1. **`exec` strategy** — simplest: stdin/stdout. Node, Python, Go, shell —
   whatever your approver stack is. See `examples/gate-file-approver.sh` for the
   file-drop pattern.
2. **`webhook` strategy** — for HTTP-native approvers (central queue, Slack bot,
   SaaS approver). Your endpoint implements `POST /…` with a JSON body → respond
   `{"decision": "approve" | "reject"}`. The daemon holds the connection open up to
   `timeout_sec`, so long-poll is fine.

**Reference `webhook` implementation.** `examples/gate-web-btc-message/` ships a
standalone Node.js approver (run with `npx tsx examples/gate-web-btc-message/approver.ts`)
that enforces **Bitcoin message signatures** as its auth policy. `APPROVER_ADDRESS`
pins the one operator address whose signatures count. The page lists pending
ceremonies with outputs, labels, change, fee and fee rate; the operator signs
`otzi-gate:<approve|reject>:<ceremonyId>:<nonce>` in any wallet that signs
messages (BIP-322 simple for P2WPKH and P2TR addresses; legacy / BIP-137 for older
types). The message binds the decision to one ceremony and one approver-issued
nonce, so a signature cannot be replayed for another ceremony or the opposite
decision. The daemon sees only `{ "decision": "approve" }` come back on the held
webhook response; **the daemon has no message-signature code for gates**. Swap the
auth scheme (SSO, hardware token, CLI) by editing the approver; the daemon doesn't
change.

Checklist:

- **Decide on the spec you were given.** It is derived from this node's own
  analysis, so `outputs`, `amount`, `fee` and `feeRate` are what this node would
  sign. Show the operator the output addresses and labels, not just the total.
- **Timeouts are yours to own.** Until you respond, the daemon waits (up to
  `timeout_sec`). A crashed approver → the ceremony deadline eventually fires.
- **Stay silent on reject.** The daemon already drops silently for you; just
  return `reject`.
- **Default to reject on error.** Your hook's fail-closed path is the right one —
  a misconfigured approver should block signing, not default-approve.
- **Log everything.** Each invocation is an audit event. Keep the spec JSON and
  the decision in a durable log so you can reconstruct who approved what.
