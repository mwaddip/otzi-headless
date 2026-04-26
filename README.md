# otzi-headless

[![Release](https://img.shields.io/github/v/tag/mwaddip/otzi-headless?label=release)](https://github.com/mwaddip/otzi-headless/releases)

A federated threshold-signing **daemon** for OPNet Bitcoin L1 vaults. ML-DSA
post-quantum auth + FROST Schnorr signing, run unattended across a small
ring of trusted operator nodes — bridge reserves, liquidity pools,
multi-party server vaults. Headless variant of [Ötzi](https://github.com/mwaddip/otzi).

`otzi-headless` is a **signing backend**, not a wallet, chain watcher, or
decision engine. Operators POST construction parameters via the CLI; the
daemon's only job is custody of threshold-shared keys and execution of
signing ceremonies. Chain monitoring, autonomous triggers, and business
logic live in the operator's own infrastructure.

> **Status:** v0.1.0 — first pre-release. No deployed users yet; the wire
> format and config schema may still change before v1.

## Table of contents

- [Threat model](#threat-model)
- [Architecture](#architecture)
- [Setup walkthrough — 3-of-3 federation](#setup-walkthrough--3-of-3-federation)
- [CLI](#cli)
- [Gates: writing your own approver](#gates-writing-your-own-approver)
- [Manifest builder](#manifest-builder)
- [Backup & restore](#backup--restore)
- [fail2ban](#fail2ban)
- [Repo layout](#repo-layout)
- [License](#license)

---

## Threat model

The security boundary is a **ring of trust** established at DKG time.

- **Threshold cryptography.** Compromising fewer than `t` of the `n`
  key shares yields nothing — the threshold-secured key cannot be
  reconstructed or used to forge.
- **Federation trust is axiomatic.** Members trust each other by virtue of
  being on the ring. The worst a rogue insider can do is DoS the federation
  (refuse to sign); they cannot extract key material.
- **Operational policy: n-of-n in v0.1.** The cryptographic protocol
  supports `t-of-n`, but the v0.1 CLI signs with all `n` peers. An offline
  peer in a headless federation is a red flag (compromise / partition /
  sabotage), not a graceful-degradation budget. The `t < n` setting is
  defense-in-depth against key-share compromise — it is *not* an
  operational budget for absent signers.
- **Per-node approval gate (optional).** Defense-in-depth against a single
  compromised *machine* (vs. compromised key share) being used as a
  signing oracle. Each node optionally vets each ceremony locally before
  participating: `auto` / `policy` / `exec` / `webhook`. See
  [Gates](#gates-writing-your-own-approver) below.
- **Network pre-filter.** The peer-mesh transport drops inbound TCP
  connections from any source IP not in the resolved peer-endpoint
  allowlist before the WebSocket handshake completes (silent
  `socket.destroy()`, no 401 response on the wire). Independent from and
  additive to the cryptographic Noise-KK + ML-DSA mutual auth.
- **Out of scope.** Anti-insider verification, chain watching, autonomous
  triggers, decision intelligence, manifest parsing or ABI awareness inside
  the daemon. All of those belong in the operator's own infrastructure.

Full invariants live in [`INTERFACES.md`](INTERFACES.md) and
[`CLAUDE.md`](CLAUDE.md).

---

## Architecture

Three properties shape everything else:

1. **Pull-based blob exchange.** Each peer produces ceremony blobs locally
   and stores them. For each round, peers pull missing inputs from
   producers reactively. No 500 ms state ticks, no barriers, no heartbeats.
2. **Signing is leader-asymmetric, DKG is symmetric.** A signing trigger
   (HTTP / cron / UDS) fires on exactly one node; that node drives all
   rounds, runs `combine`, and broadcasts the result. DKG, by contrast, is
   leaderless — every party computes its own unique key share.
3. **CLI is the operator-facing surface.** The daemon's UDS / HTTP API is
   an internal implementation detail. Every operator workflow goes through
   `otzi <subcommand>`; the daemon socket binds to loopback or UDS only
   (parser-enforced).

```
┌──────────┐    ┌────────────┐    ┌─────────────┐    ┌─────────────┐
│ operator │ ─▶ │  otzi CLI  │ ─▶ │   daemon    │ ◀─▶ │   peers     │
│  shell   │    │ (UDS / SSH)│    │ leader/orch │    │ (mesh/relay)│
└──────────┘    └────────────┘    └─────────────┘    └─────────────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │ approval    │ ── exec / webhook
                                  │ gate        │      → external
                                  │ (per-node)  │        approver
                                  └─────────────┘
```

---

## Setup walkthrough — 3-of-3 federation

Three nodes, all online, signing all together. Replace `node-a / node-b /
node-c` with your real hostnames. Steps run **on every node** unless marked
otherwise.

The walkthrough uses **testnet** so you can complete it with disposable
funds. For mainnet, swap `testnet` → `mainnet` in the debconf prompt
(default OPNet RPC becomes `https://api.opnet.org`); everything else —
ceremony, CLI flow, file layout — is identical. The vault addresses
printed by `otzi generate` will use the network's address prefix
(`tb1p…` on testnet, `bc1p…` on mainnet). `regtest` also works but
skips the OPNet keylink phase, so OPNet contract calls against the
resulting share will fail at capture (BTC vault transfers still work).

### 1. Install the .deb

Download `otzi-headless_0.1.0_amd64.deb` from
[releases](https://github.com/mwaddip/otzi-headless/releases) onto each
host. Then:

```bash
sudo apt install ./otzi-headless_0.1.0_amd64.deb
```

`apt` resolves the `nodejs ≥ 22` dependency automatically. (Plain `dpkg
-i` will fail on unmet deps — follow up with `sudo apt -f install`.)

debconf will prompt — answer the same way on each node:

| Prompt | `node-a` | `node-b` | `node-c` |
|---|---|---|---|
| Restore from backup? | No | No | No |
| Bootstrap role | `leader` | `leaf` | `leaf` |
| Operator usernames (space-separated) | your shell user | your shell user | your shell user |
| Bootstrap secret (shared passphrase) | *agreed out-of-band* | *same* | *same* |
| Bitcoin network | `testnet` | `testnet` | `testnet` |
| OPNet RPC URL | `https://testnet.opnet.org` | *same* | *same* |
| Transport kind | `peer-mesh` | `peer-mesh` | `peer-mesh` |
| Listen address | `0.0.0.0:8800` | `0.0.0.0:8800` | `0.0.0.0:8800` |
| Bootstrap bind / leader URL | bind `0.0.0.0:7090` | leader `http://node-a:7090` | leader `http://node-a:7090` |
| Peer hostnames | `node-b node-c` | `node-a node-c` | `node-a node-b` |
| Node identifier | `node-a` | `node-b` | `node-c` |

The bootstrap secret is short-lived: it lives at
`/var/lib/otzi/bootstrap-secret` (mode 660 root:otzi) and is automatically
wiped the moment DKG completes successfully.

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

Each node prints its own 8-character SHA-256 fingerprint of the resulting
pubkey book. **Eyeball-compare the fingerprint across all three nodes.**
If any node shows a different value, someone tampered with the exchange —
delete `/var/lib/otzi/pubkeys.json` everywhere and start over.

### 3. Complete the peer entries

After `otzi setup` finishes, each node has a `pubkeys.json` but
`/etc/otzi/daemon.toml`'s `[[peers]]` blocks are stubs. Edit them in,
copying `wallet_address` from the freshly written `pubkeys.json`:

```toml
[[peers]]
id = "node-b"
party_id = 1
wallet_address = "0xabc..."
endpoint = "ws://node-b.example:8800"

[[peers]]
id = "node-c"
party_id = 2
wallet_address = "0xdef..."
endpoint = "ws://node-c.example:8800"
```

Same on every node, with each node's own block omitted. `party_id` values
are assigned during bootstrap and recorded in `pubkeys.json`.

### 4. Run DKG

**On the leader only** (the daemon must already be reachable via systemd
— start it now):

```bash
sudo systemctl enable --now otzi    # on every node
otzi generate /etc/otzi/daemon.toml # on the leader only
```

The leader derives `parties = 3` from its configured peer set and runs a
3-of-3 combined DKG (ML-DSA + FROST + key-link). Each node persists its
own encrypted share to `/var/lib/otzi/share.json`. The bootstrap secret is
wiped automatically. The CLI prints:

```
otzi generate: DKG complete (status=done)
  ceremonyId:        dkg-2026-04-26T12-34-56-789Z
  vault BTC:         tb1p…   (fund here for BTC)
  vault OPNet:       0x…     (send OP20 / contract calls here)
  ML-DSA pubkey:     …
  FROST verifying:   …
  share path:        /var/lib/otzi/share.json
```

### 5. Fund the vault

Send testnet BTC (or OP20 tokens for an OPNet flow) to the printed vault
addresses. Verify on a block explorer; the daemon does not watch chains.

```bash
otzi btc balance              # poll until you see your funding
otzi op20 balance BHTT        # if your manifest defines OP20 tokens
```

### 6. Install a manifest

A manifest (`.otzi.json`) is a per-project file enumerating contract
addresses, ABI shorthand (OP20 / OP20S / OP721 / Custom), and per-token
decimals. The CLI consumes it for `otzi sign` / `otzi op20 balance`. Hand
it to every node:

```bash
otzi install ./my-project.otzi.json
otzi list                    # confirm operations
```

(You can author manifests via the [manifest builder](#manifest-builder)
or write them by hand against
[`docs/headless-manifest-schema.json`](docs/headless-manifest-schema.json).)

For multi-node distribution during the bootstrap window, see `otzi sync`
in [`docs/cli.md`](docs/cli.md) — HMAC-authenticated push to all peers
in one call. After DKG, manifest distribution is operator-local
(`otzi install` on each node).

### 7. Sign your first transaction

OPNet contract call:

```bash
otzi sign BHTT transfer tb1p…dest 1000000
```

Or a plain BTC vault transfer:

```bash
otzi btc send tb1p…dest 50000sats --fee-rate 10
```

The CLI runs the full ceremony — ML-DSA pre-sign over `sha256(calldata)`,
then FROST `opnet-params` for OPNet (or `btc` construction-params for the
plain vault transfer) — and prints the resulting transaction ID. The
daemon broadcasts internally for OPNet; for BTC the CLI returns the tx ID
once mempool.space confirms acceptance.

For the deeper deep-dive (every prompt, every file, every uninstall path),
see [`docs/install.md`](docs/install.md).

---

## CLI

The CLI is the only operator-facing surface. Direct `curl` calls to the
daemon UDS are reserved for tests + debugging.

| Verb | Purpose |
|---|---|
| `otzi daemon <config>` | Run the daemon (long-lived; usually started by systemd). |
| `otzi setup <config>` | Bootstrap pubkey exchange. Reads `[bootstrap].role`. |
| `otzi generate <config>` | Trigger combined DKG against the local daemon (leader only). |
| `otzi install <manifest>` | Install a `.otzi.json` manifest at `/etc/otzi/manifest.otzi.json`. |
| `otzi list` | List operations from the installed manifest. |
| `otzi uninstall` | Remove the installed manifest. |
| `otzi sync <manifest>` | Distribute a manifest to all peers (bootstrap-window only). |
| `otzi sign <contract> <method> <args...>` | Run a threshold-signed OPNet contract call. |
| `otzi btc send <addr> <amount>[unit]` | BTC vault transfer (units: `sats` `btc` `mbtc` `ubtc`). |
| `otzi btc balance [--unit ...]` | Read vault BTC balance (chain-direct, no daemon round-trip). |
| `otzi op20 balance <ticker\|ID>` | Read vault OP20 balance using manifest decimals. |
| `otzi vault [--json]` | Print vault addresses + pubkeys. |
| `otzi backup` | Produce a password-protected archive of full daemon state. |
| `otzi restore [--password-stdin] <archive>` | Recover from a backup (refuses if config exists or daemon running). |

Full reference with flags + examples: [`docs/cli.md`](docs/cli.md).
HTTP/UDS endpoint reference: [`docs/api.md`](docs/api.md).

---

## Gates: writing your own approver

The `ApprovalGate` is a per-node *signaling surface*, not a decision
engine. It answers `approve(spec) → approve | reject | pending` for each
ceremony. The daemon ships with four built-in strategies — kept thin
deliberately, so opinionated auth schemes live outside the daemon's audit
surface:

| Strategy | What it is |
|---|---|
| `auto` | Tautological — always approves. The default. |
| `policy` | Generic rule engine over structural spec fields (`max_btc_per_tx`, `allowed_btc_recipients`, `allowed_contracts`, `max_ceremonies_per_hour`, …). Strict-by-default. |
| `exec` | Spawns an operator-supplied process; writes the spec on stdin, reads `approve` / `reject` from stdout. |
| `webhook` | POSTs the spec to an operator-supplied URL; expects `{"decision": "approve" | "reject" | "pending"}`. |

To plug in a custom decision logic — ML-DSA wallet-signed approvals,
SSO, hardware tokens, Slack approvals — you build an **external service**
that consumes either the `exec` or `webhook` interface. The daemon
doesn't change.

The bundled reference example is `examples/gate-web-opwallet/`: a
standalone Node.js service that holds the daemon's webhook request open
while a browser-based operator UI signs the decision via OPWallet's
`signMLDSA`. See its `README.md` for the architecture diagram, the
signed-payload byte layout, and customization guidance.

For the file-drop pattern (no HTTP), see `examples/gate-file-approver.sh`
— a single-file `inotifywait`-based exec gate that watches a directory.

Full gate contract + spec schema: [`docs/gates.md`](docs/gates.md).

---

## Manifest builder

A manifest (`.otzi.json`) is per-project UI/ABI configuration: contract
names, addresses, ABI shorthand (`OP20`, `OP20S`, `OP721`, or inline
`Custom` ABI), per-token decimals. One installed manifest per daemon.

Authoring options:

1. **Visual builder** (recommended). `examples/manifest-builder/` is a
   static Preact UI vendored with offline JS bundles. Run:
   ```bash
   cd examples/manifest-builder
   bash serve.sh             # Python's stdlib HTTP server on :8765
   ```
   Open <http://localhost:8765/index.html>, fill in contracts, hit
   *Export*. The output is schema-validated against the same validator
   the daemon uses.

2. **By hand** against
   [`docs/headless-manifest-schema.json`](docs/headless-manifest-schema.json).

Distribute the resulting `.otzi.json` to every operator node. During the
bootstrap window (pre-DKG), `otzi sync <path>` HMAC-pushes it to all
peers in one call. After DKG, distribution is per-node
(`otzi install <path>` on each).

Builder design notes: [`docs/manifest-builder-spec.md`](docs/manifest-builder-spec.md).

---

## Backup & restore

`otzi-headless` ships with first-class backup. Run after every config
change, every peer change, and after initial DKG:

```bash
otzi backup
# → ~/otzi-backup-<ISO-timestamp>.otzi-backup (mode 0600)
# Password (32 chars, ~190 bits entropy) printed once to stdout — write it down.
```

The archive is AES-256-GCM with PBKDF2-SHA256 (600k iterations) and
contains every file needed to fully restore a node's slot in the
federation: `daemon.toml`, encrypted share, identity keypair, pubkey book,
installed manifest, vault-pubkey cache, and (pre-DKG only) the bootstrap
secret.

Recovery has two paths:

- **Fresh install via debconf** — answer *Yes* to "Restore from a
  backup?" during `apt install`. The rest of the install prompts (role,
  peers, bootstrap secret, etc.) are skipped; config comes from the
  archive.
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
├── core/         ceremony runner, blob store + server + puller, wire codecs
├── wire/         lifted byte-compat from Ötzi — DO NOT EDIT
├── node/         lifted backend lib from Ötzi — DO NOT EDIT
├── broadcast/    OPNet calldata + capture + broadcast, BTC vault
├── bootstrap/    one-shot pubkey-book exchange
├── transport/    Noise-KK over P-256, peer-mesh + relay
├── config/       TOML parser + DaemonConfig types
├── gate/         ApprovalGate + auto / policy / exec / webhook
├── orchestrator/ participant-side dispatcher (verify-before-gate)
├── triggers/     HTTP / UDS / cron sources
├── cli/          per-command modules (install, sign, btc, op20, vault, ...)
└── daemon/       composition root, leader dispatcher, console logger, entrypoint

examples/
├── gate-file-approver.sh      reference exec gate (file-drop)
├── gate-web-opwallet/         reference webhook gate (OPWallet UI)
├── manifest-builder/          static Preact UI for authoring .otzi.json
└── fail2ban/                  filter + jail for peer-allowlist drops

docs/
├── install.md                 operator install walkthrough
├── cli.md                     CLI reference
├── api.md                     HTTP / UDS endpoint reference
├── config.md                  daemon.toml reference
├── gates.md                   ApprovalGate contract + strategies
├── manifest-builder-spec.md   builder UI design notes
└── headless-manifest-schema.json   manifest JSON Schema

facts/                        per-subsystem contracts (read in dependency order)
INTERFACES.md                 global invariants + contract index
CLAUDE.md                     project-wide design rationale
```

---

## License

TBD.
