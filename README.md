# otzi-headless

[![Release](https://img.shields.io/github/v/tag/mwaddip/otzi-headless?label=release)](https://github.com/mwaddip/otzi-headless/releases)

A federated threshold-signing **daemon** for Bitcoin vaults. N daemons hold
[FROST](https://www.rfc-editor.org/rfc/rfc9591) key shares of one key-path-only
Taproot key (`bc1p…` / `tb1p…`) and jointly sign spends that every node has
checked against its own key and its own approval gate — bridge reserves,
liquidity pools, multi-party server vaults. Headless variant of
[Ötzi](https://github.com/mwaddip/otzi): share files and address books move
between the two in both directions.

`otzi-headless` is a **signing backend**, not a wallet, chain watcher, or
decision engine. The daemon's only job is custody of threshold-shared keys and
execution of signing ceremonies; it has no chain access. The `otzi` CLI builds a
transaction proposal from Esplora data, asks the daemon to sign it, and
broadcasts the result. Chain monitoring, autonomous triggers, and business logic
live in the operator's own infrastructure.

> **Status:** release 0.3.0. Share files are Ötzi v4. v3 share files are not
> supported and there is no migration path: set up a new vault with
> `otzi generate`.

## Table of contents

- [Threat model](#threat-model)
- [Architecture](#architecture)
- [Setup walkthrough — 3-of-3 federation](#setup-walkthrough--3-of-3-federation)
- [CLI](#cli)
- [Address book](#address-book)
- [Gates: writing your own approver](#gates-writing-your-own-approver)
- [Backup & restore](#backup--restore)
- [fail2ban](#fail2ban)
- [Repo layout](#repo-layout)
- [License](#license)

---

## Threat model

The security boundary is a **ring of trust** fixed at bootstrap, plus a
per-node check of every spend.

- **Ring membership is fixed.** The pubkey book pins every member's P-256
  identity. Rotation means building a new federation and moving the funds;
  there is no in-place membership change.
- **Threshold cryptography.** Compromising fewer than `t` of the `n` key
  shares yields nothing — the threshold-secured key cannot be reconstructed or
  used to forge.
- **Operational policy: n-of-n.** `otzi generate` creates a vault with
  `threshold = parties`, and signing uses all `n` nodes by default. An offline
  peer in a headless federation is a red flag (compromise / partition /
  sabotage), not a graceful-degradation budget. The cryptographic threshold is
  defense-in-depth against key-share compromise. The consequence: **every share
  is required to sign, so back up every node** (see
  [Backup & restore](#backup--restore)).
- **Every node signs only what it derived itself.** The leader and every
  participant analyse each proposal against their own key and network: every
  input must spend this vault's script, change is only an output paying that
  script, the proposal network must equal the node's network. Sighashes are
  never sent; each node computes them. Nothing the leader asserts about keys,
  addresses, change, fee or network is trusted, and false prevout data yields
  signatures that are invalid on chain.
- **Per-node approval gate (optional).** Defense-in-depth against a single
  compromised *machine* (vs. compromised key share) being used as a signing
  oracle. Each node optionally vets each ceremony locally before participating:
  `auto` / `policy` / `exec` / `webhook`, on a spec built from the node's own
  analysis. See [Gates](#gates-writing-your-own-approver) below.
- **Setup trust assumption, run-once DKG.** One administrator sets up the
  federation, or a trusted group does it live. The DKG's checks make a faulty or
  inconsistent setup fail loudly, and once a vault exists no DKG can touch it:
  nodes that hold a vault drop the announce.
- **Network pre-filter.** The peer-mesh transport drops inbound TCP
  connections from any source IP not in the resolved peer-endpoint
  allowlist before the WebSocket handshake completes (silent
  `socket.destroy()`, no 401 response on the wire). Independent from and
  additive to the cryptographic Noise-KK mutual auth against the pubkey book.
- **Out of scope.** Chain watching, autonomous triggers, decision intelligence,
  script-path spends, fee bumping, and mixed ceremonies between daemons and web
  Ötzi browser parties. All of those belong in the operator's own
  infrastructure or in Ötzi.

Full invariants live in [`INTERFACES.md`](INTERFACES.md) and
[`CLAUDE.md`](CLAUDE.md).

---

## Architecture

Four properties shape everything else:

1. **Pull-based blob exchange.** Each peer produces ceremony blobs locally
   and stores them. For each round, peers pull missing inputs from
   producers reactively. No 500 ms state ticks, no barriers, no heartbeats.
2. **Signing is leader-driven, DKG is symmetric.** A signing trigger
   (UDS / HTTP / cron) fires on exactly one node; that node analyses the
   proposal, evaluates its gate, announces once, drives both rounds, aggregates
   and finalizes the signed transaction. DKG, by contrast, is symmetric — every
   party computes its own unique key share.
3. **Proposal in, signed transaction out.** Callers send Ötzi's `SendProposal`
   (`network`, `tx`, `prevouts`); the daemon returns the signed transaction and
   never touches the chain. The CLI reads UTXOs and broadcasts through Esplora.
4. **CLI is the operator-facing surface.** The daemon's UDS / HTTP API is an
   internal implementation detail. Every operator workflow goes through
   `otzi <subcommand>`; the daemon socket binds to loopback or UDS only
   (parser-enforced).

```
┌──────────┐    ┌────────────┐    ┌─────────────┐    ┌─────────────┐
│ operator │ ─▶ │  otzi CLI  │ ─▶ │   daemon    │ ◀─▶ │   peers     │
│  shell   │    │ (UDS)      │    │ leader/orch │    │ (mesh/relay)│
└──────────┘    └─────┬──────┘    └─────────────┘    └─────────────┘
                      │                  │
                      ▼                  ▼
               ┌─────────────┐    ┌─────────────┐
               │   Esplora   │    │ approval    │ ── exec / webhook
               │ UTXOs · fee │    │ gate        │      → external
               │ · broadcast │    │ (per-node)  │        approver
               └─────────────┘    └─────────────┘
```

The ceremony protocols are documented step by step in
[`docs/signing-flows.md`](docs/signing-flows.md).

---

## Setup walkthrough — 3-of-3 federation

Three nodes, all online, signing all together. Replace `node-a / node-b /
node-c` with your real hostnames. Steps run **on every node** unless marked
otherwise.

The walkthrough uses **testnet4** so you can complete it with disposable
funds. For mainnet, swap `testnet4` → `mainnet` in the debconf prompt;
everything else — ceremony, CLI flow, file layout — is identical. The vault
address printed by `otzi generate` uses the network's address prefix (`tb1p…` on
testnet4 and signet, `bc1p…` on mainnet).

### 1. Install the .deb

Download `otzi-headless_0.3.0_amd64.deb` from
[releases](https://github.com/mwaddip/otzi-headless/releases) onto each
host. Then:

```bash
sudo apt install ./otzi-headless_0.3.0_amd64.deb
```

`apt` resolves the `nodejs ≥ 22` dependency automatically. (Plain `dpkg
-i` will fail on unmet deps — follow up with `sudo apt -f install`.)

debconf will prompt — answer the same way on each node:

| Prompt | `node-a` | `node-b` | `node-c` |
|---|---|---|---|
| Restore from backup? | No | No | No |
| Bootstrap role | `leader` | `leaf` | `leaf` |
| Operator usernames (space-separated) | your shell user | your shell user | your shell user |
| Bitcoin network (`mainnet` / `testnet4` / `signet`) | `testnet4` | `testnet4` | `testnet4` |
| Esplora URL (optional) | *blank* | *blank* | *blank* |
| Transport kind | `peer-mesh` | `peer-mesh` | `peer-mesh` |
| This node's reachable address | `node-a.example:8800` | `node-b.example:8800` | `node-c.example:8800` |
| Other peers (comma-separated `host[:port]`) | `node-b.example,node-c.example` | `node-c.example` | `node-b.example` |
| Bootstrap bind / leader URL | bind `0.0.0.0:7090` | leader `http://node-a.example:7090` | leader `http://node-a.example:7090` |
| Node identifier | `node-a` | `node-b` | `node-c` |

Notes on the prompts:

- **"This node's reachable address"** is the address peers will dial to
  reach this daemon. Wildcard binds (`0.0.0.0`, `::`) are rejected at
  parse — use the host's routable IP or DNS name. Port defaults to 8800
  if omitted.
- **"Other peers"** is a comma-separated list of every OTHER node in the
  ring. On a leaf, you do NOT need to retype the leader here — postinst
  derives the leader-as-peer entry automatically from the Bootstrap
  leader URL above. So leaves only list peers other than the leader.
- **"Esplora URL"** is the chain API the `otzi btc *` verbs use. Blank selects
  the mempool.space default for the network. The daemon never reads it.

postinst auto-adds every operator listed at the debconf prompt to the
`otzi` group (so they can connect to the UDS at
`/var/run/otzi/otzi.sock`). Linux supplementary-group changes don't
affect already-running shells, so each listed operator must log out and
back in once — or run `exec newgrp otzi` in their existing session —
before the next step.

### 2. Bootstrap pubkey exchange

The leader hosts a one-shot HTTP server on `:7090`; leaves register against
it. Run leader first.

**On `node-a` (leader):**

```bash
otzi setup /etc/otzi/daemon.toml
```

**On `node-b` and `node-c`:**

```bash
otzi setup /etc/otzi/daemon.toml
```

Each node prints the 96-bit SHA-256 fingerprint of the resulting pubkey book,
formatted `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`. **Compare the fingerprint across all
three nodes out of band** (voice call, signed message). If any node shows a
different value, someone tampered with the exchange — delete
`/var/lib/otzi/pubkeys.json` everywhere and start over.

The pubkey book records each peer's partyId (assigned deterministically by
sorted-pubkey-bytes order, identical on every node) and reachable address.
No manual editing of `daemon.toml` is required — `[[peers]]` was populated
from your debconf "Other peers" answer at install time.

### 3. Start the daemons

The daemon reads the share password from the env var named by
`[share].password_env` (default `OTZI_SHARE_PASSWORD`) and refuses to start
without it. The systemd unit loads it from `/etc/otzi/otzi.env`: create that file
(owner `root:root`, mode `0600`) and put the single line
`OTZI_SHARE_PASSWORD=<a strong password>` in it:

```bash
sudo install -m 600 -o root -g root /dev/null /etc/otzi/otzi.env
sudoedit /etc/otzi/otzi.env      # OTZI_SHARE_PASSWORD=<a strong password>
```

systemd reads this file itself and interprets quotes and backslashes in it
(and strips spaces around the value), so pick a password without `"`, `'`, `\`
or leading/trailing spaces — `openssl rand -base64 32` gives one — or write it
in double quotes with `\"` and `\\` escaped.

Then, **on every node**:

```bash
sudo systemctl enable --now otzi
```

A node without a vault starts in setup mode: it takes part in the DKG, but
signing is refused until the vault exists and the daemon has restarted.

### 4. Generate the vault

**On one node** (here `node-a`), run the DKG. Every daemon must be running and
hold no vault:

```bash
otzi generate
```

The command derives `parties = 3` from the pubkey book and runs a 3-of-3 FROST
DKG. All three nodes sign a verification message over their own view of the
result, stage their share, and complete only after every other node has
confirmed. Each node ends with its encrypted share at `/var/lib/otzi/share.json`
(Ötzi v4, mode 0600) and the public vault metadata at
`/var/lib/otzi/vault-pubkey.json`. The CLI prints the vault address, the
network, the share path, and the reminder to restart every daemon.

### 5. Restart every daemon

A running daemon does not load a share created after it started. On every node:

```bash
sudo systemctl restart otzi
```

Until then `sign` returns `409`.

### 6. Check the vault

On every node:

```bash
otzi vault
```

The address, network and `3-of-3` must be identical on all three nodes.

### 7. Fund the vault

Send testnet4 coins to the printed `tb1p…` address. Verify on a block explorer;
the daemon does not watch chains.

```bash
otzi btc balance              # poll until you see your funding confirmed
```

`otzi btc send` spends **confirmed** UTXOs only.

### 8. Send from the vault

```bash
otzi btc send tb1p…dest 50000 --fee-rate 5
```

The CLI fetches confirmed UTXOs from Esplora, builds the proposal, and calls the
local daemon, which becomes the leader. Every node analyses the proposal against
its own key and runs its own gate; the nodes run the two FROST rounds; the leader
returns the signed transaction; the CLI broadcasts it and prints the txid and the
explorer URL. If the broadcast fails after signing, the CLI prints the signed
hex so you can broadcast it by other means.

Label recipients in the node's [address book](#address-book) to send by name:

```bash
sudo otzi book add treasury tb1p…dest --note "cold storage"
otzi btc send treasury 0.001btc
```

For the deeper dive (every prompt, every file, every uninstall path),
see [`docs/install.md`](docs/install.md).

---

## CLI

The CLI is the only operator-facing surface. Direct `curl` calls to the
daemon UDS are reserved for tests + debugging.

| Verb | Purpose |
|---|---|
| `otzi daemon <config>` | Run the daemon (long-lived; usually started by systemd). |
| `otzi setup <config>` | Bootstrap pubkey exchange. Reads `[bootstrap].role`. Prints the 96-bit fingerprint. |
| `otzi generate` | Run the run-once DKG through the local daemon; prints the vault address. |
| `otzi vault [--json]` | Print the vault address, network and threshold/parties (keys with `--json`). |
| `otzi btc balance [--unit ...]` | Confirmed and unconfirmed vault balance from Esplora (units: `sats` `btc` `mbtc` `ubtc`). |
| `otzi btc send <label\|address> <amount[unit]\|max> [--fee-rate N]` | Build, sign and broadcast a send. |
| `otzi btc sign <proposal.json> [--broadcast]` | Sign a caller-built `SendProposal`; prints the analysis, txid and signed hex. |
| `otzi book list\|add\|remove\|import\|export` | Manage this node's address book. |
| `otzi backup` | Produce a password-protected archive of full node state. |
| `otzi restore [--password-stdin] <archive>` | Recover from a backup (refuses if config exists or daemon running). |

Full reference with flags + examples: [`docs/cli.md`](docs/cli.md).
Daemon API reference: [`docs/api.md`](docs/api.md).
`daemon.toml` reference: [`docs/config.md`](docs/config.md).

---

## Address book

Each node has its own address book at `/etc/otzi/address-book.otzi.json`, in
Ötzi's address-book file format. It labels recipients in gate specs and CLI
output, resolves `otzi btc send <label>`, and can serve as the policy recipient
allowlist (`allowed_recipients = "address-book"`). Reading needs `otzi` group
membership; writing needs root, because the book can widen a policy allowlist.
Nodes do not share or sync books: copy the file with `otzi book export` and
`otzi book import` to keep several nodes identical.

---

## Gates: writing your own approver

The `ApprovalGate` is a per-node *signaling surface*, not a decision
engine. It answers `approve(spec) → approve | reject | pending` for each
ceremony, on a spec the node built from its own analysis of the proposal. The
daemon ships with four built-in strategies — kept thin deliberately, so
opinionated auth schemes live outside the daemon's audit surface:

| Strategy | What it is |
|---|---|
| `auto` | Tautological — always approves. The default. |
| `policy` | Deterministic rules over the signing spec (`max_sats_per_tx`, `max_sats_per_24h`, `allowed_recipients`, `max_fee_sats`, `max_fee_rate`, `max_ceremonies_per_hour`, …). Strict-by-default. |
| `exec` | Spawns an operator-supplied process; writes the spec on stdin, reads `approve` / `reject` from stdout. |
| `webhook` | POSTs the spec to an operator-supplied URL; expects `{"decision": "approve" \| "reject"}`. |

To plug in custom decision logic — Bitcoin-message-signed approvals, SSO,
hardware tokens, Slack approvals — you build an **external service** that
consumes either the `exec` or `webhook` interface. The daemon doesn't change.

The bundled reference example is `examples/gate-web-btc-message/`: a standalone
Node.js service that holds the daemon's webhook request open while a
browser-based operator UI collects a decision signed with a Bitcoin message
signature, in any wallet that signs messages. Run it with
`npx tsx examples/gate-web-btc-message/approver.ts`; `APPROVER_ADDRESS` pins the
one operator address whose signatures count.

For the file-drop pattern (no HTTP), see `examples/gate-file-approver.sh`
— a single-file `inotifywait`-based exec gate that watches a directory.

Full gate contract + spec schema: [`docs/gates.md`](docs/gates.md).

---

## Backup & restore

`otzi-headless` ships with first-class backup. Run after every config
change, after `otzi generate`, and after address-book changes:

```bash
sudo otzi backup
# → ~/otzi-backup-<ISO-timestamp>.otzi-backup (mode 0600; root reads the share)
# Password (32 chars, ~190 bits entropy) printed once to stdout — write it down.
```

The archive is AES-256-GCM with PBKDF2-SHA256 (600k iterations) and
contains every file needed to fully restore a node's slot in the
federation: `daemon.toml`, encrypted share, identity keypair, pubkey book,
vault metadata, and the address book.

**Back up every node.** The vault is n-of-n, so every share is required to sign;
a lost share without a backup makes the funds unspendable.

Recovery has two paths:

- **Fresh install via debconf** — answer *Yes* to "Restore from a
  backup?" during `apt install`. The rest of the install prompts (role,
  network, peers, etc.) are skipped; config comes from the archive.
- **Manual** via `otzi restore <archive>` (or `--password-stdin` for
  scripted runs). Refuses to overwrite an existing config or run while
  the daemon is up — loud failure beats silent overwrite.

What the archive does **not** contain: other federation members' shares,
on-chain vault funds, the .deb itself.

Full operations + recovery details: [`docs/install.md`](docs/install.md)
§ Backup + recovery.

---

## fail2ban

The peer-mesh transport drops non-peer source IPs at the WebSocket
upgrade layer (`socket.destroy()` before any HTTP response is written),
with a `peer-allowlist:` warn line emitted to journald. To escalate
repeat offenders to an iptables ban, install the bundled fail2ban plugin:

```bash
sudo cp examples/fail2ban/otzi.conf  /etc/fail2ban/filter.d/
sudo cp examples/fail2ban/otzi.local /etc/fail2ban/jail.d/
sudo systemctl reload fail2ban
fail2ban-client status otzi
```

Tunable parameters (`maxretry` / `findtime` / `bantime`) live in
`otzi.local`. For stable production federations, tighten `bantime` to
permanent — legitimate peers never trip the allowlist in steady state.

See `examples/fail2ban/README.md` for the journald regex dry-run, port
adjustment, and tuning notes.

---

## Repo layout

```
src/
├── otzi/         lifted verbatim from Ötzi at src/otzi/OTZI_COMMIT — DO NOT EDIT
│   ├── lib/        share file v4, blob codecs, proposal analysis, address-book file
│   └── backend/    transaction building, Esplora client, message-signature verifier
├── core/         blob store + server + puller + retention, ceremony messages,
│                 FROST DKG and signing sessions, DKG and signing ceremonies
├── bootstrap/    one-shot pubkey-book exchange, 96-bit fingerprint
├── transport/    Noise-KK over P-256, peer-mesh + relay
├── config/       TOML parser + DaemonConfig types
├── gate/         ApprovalGate + auto / policy / exec / webhook
├── address-book/ per-node address book store
├── orchestrator/ participant-side dispatcher (analyse, gate, then take part)
├── triggers/     HTTP / UDS / cron sources
├── cli/          per-command modules (generate, vault, btc, book, backup, restore)
├── daemon/       composition root, API parsing, leader dispatcher, share + vault metadata, entrypoint
├── testing/      test-only helpers (in-memory ring, proposals, mock Esplora)
└── util/         endpoint canonicalization and other small helpers

examples/
├── gate-file-approver.sh        reference exec gate (file-drop)
├── gate-web-btc-message/        reference webhook gate (Bitcoin message signatures)
└── fail2ban/                    filter + jail for peer-allowlist drops

scripts/
├── check-otzi-drift.sh          diff the lifted files against an Ötzi checkout
├── build-deb.sh                 build the .deb
└── test-deb-container.sh        install the .deb end-to-end in a container

docs/
├── install.md                   operator install walkthrough
├── cli.md                       CLI reference
├── api.md                       daemon API reference
├── config.md                    daemon.toml reference
├── gates.md                     ApprovalGate contract + strategies
└── signing-flows.md             DKG and signing ceremony flows

facts/                        per-subsystem contracts (read in dependency order)
INTERFACES.md                 global invariants + contract index
CLAUDE.md                     project-wide design rationale
```

---

## License

TBD.
