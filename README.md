# otzi-headless

Headless daemon variant of [Ötzi](https://github.com/mwaddip/otzi) — automated
ML-DSA + FROST threshold signing over OPNet Bitcoin L1.

Where Ötzi is a browser app for humans running ad-hoc ceremonies, `otzi-headless`
is a long-running daemon for servers running unattended ones: bridge reserves,
liquidity pools, multi-party server vaults, automated triggers.

## Status

| Area | Status |
|---|---|
| Ceremony core (ML-DSA threshold signing, FROST signing, 3 DKG flavors) | ✅ |
| Broadcast pipeline (OPNet calldata + capture + broadcast, BTC vault + fees) | ✅ |
| Testnet end-to-end (signet — BHTT.transfer + BTC return landed 2026-04-23) | ✅ |
| Daemon entrypoint (HTTP / cron triggers, approval gate, orchestrator) | ✅ |
| Transport (Noise-KK peer-mesh + minimal Node relay) | ✅ |
| Bootstrap (identity exchange + fingerprint verification) | ✅ |
| FROST `PublicKeyPackage` reconstruction from V3 share | ⏳ |
| DKG result persistence (encrypted share file) | ⏳ |
| Packaging (Docker, `.deb`, systemd unit) | ⏳ |

**264/264 tests green**, `tsc --noEmit` clean.

## Why a headless variant

Ötzi's React UI coordinates ceremonies via 500 ms state-broadcasts with
barrier synchronization — necessary machinery when participants are browser
tabs that can close, reload, or drift in time. Servers don't have that
fragility. The headless daemon drops the coordination primitive entirely and
replaces it with **pull-based** blob exchange:

- Each peer produces its ceremony blobs locally and stores them.
- For each round, each peer requests the blobs it needs from its producers.
- No heartbeats, no barrier sync, no 500 ms tick — just explicit pulls.

Same wire format and crypto as Ötzi (byte-compat), but a much simpler state
machine. See `CLAUDE.md` for the full design rationale.

## Relation to Ötzi

| | Ötzi | `otzi-headless` |
|---|---|---|
| Interface | React SPA | CLI + HTTP API |
| Coordination | Leader-broadcasts-state, 500 ms ticks, barrier sync | Pull-based |
| Transport | Centralized Go relay | Peer-mesh WebSocket OR minimal Node relay |
| Identity | Per-session Web Crypto ECDH | Per-node long-term ECDH P-256 (bootstrapped once) |
| DKG / signing primitives | Same `@btc-vision/post-quantum` ML-DSA + [`@mwaddip/frots`](https://github.com/mwaddip/frots) FROST |
| OPNet / BTC broadcast | `backend/src/routes/tx.ts`, `btc.ts` | `src/broadcast/*.ts` (ported; verify-key bug fixed) |
| Share files | V3 JSON (encrypted) | Same format |

Ötzi: <https://github.com/mwaddip/otzi>.

## Architecture snapshot

```
┌─────────────┐       ┌──────────────┐       ┌──────────────┐
│   Trigger   │──────▶│  LeaderDisp  │──────▶│  Transport   │
│ (HTTP/cron) │       │ (gate check) │       │ (peer-mesh / │
└─────────────┘       │  ceremony    │       │   relay)     │
                      │  dispatch)   │       └──────┬───────┘
                      └──────────────┘              │
                                                    ▼
                       ┌──────────────┐      ┌──────────────┐
                       │ Orchestrator │◀─────│  incoming    │
                       │   + Gate     │      │  announce    │
                       │  (particip.) │      └──────────────┘
                       └──────┬───────┘
                              ▼
                      ┌──────────────────┐
                      │ CeremonyRunner   │ ML-DSA / FROST / DKG
                      │  + BlobStore     │
                      │  + BlobServer    │
                      │  + BlobPuller    │
                      └──────────────────┘
```

- **Security boundary (CLAUDE.md § Security Model)**: ring of trust + threshold.
  Compromising <t peers yields nothing. Peer allowlist drops traffic from
  unknown sources at the transport layer. Optional per-node **approval gate**
  gives defence-in-depth against a single compromised machine being used as a
  signing oracle — `auto` / `policy` / `webhook` / `cli` / `queue` strategies,
  opt-in, strict-by-default.

- **Transport**: classical Noise-KK over ECDH P-256 + AES-256-GCM. No
  post-quantum in the transport layer (2026-04-23 decision — ML-DSA already
  covers quantum-safe identity at the threshold layer). Authentication is
  implicit in the DH math; no transcript signatures. See
  `SESSION_CONTEXT.md § Transport encryption` for the threat-model note.

## Requirements

- Node.js ≥ 22 (some `@btc-vision/*` deps prefer 24; warnings only on 22).
- Network connectivity between peers for `peer-mesh`, or a reachable relay
  server for `relay`.
- For FROST signing end-to-end: currently blocked on V3 share-file
  `PublicKeyPackage` reconstruction (DKG works fine without it).

## Install

```bash
git clone https://github.com/mwaddip/otzi-headless.git
cd otzi-headless
npm install
```

The daemon runs as TypeScript via [`tsx`](https://github.com/privatenumber/tsx)
— no separate build step is needed. The `bin/otzi` shim dispatches subcommands:

```bash
./bin/otzi                                                    # prints usage
./bin/otzi daemon config.toml                                 # run daemon
./bin/otzi setup leader config.toml --bind 0.0.0.0:7090       # bootstrap leader
./bin/otzi setup leaf config.toml --leader http://<leader>:7090  # bootstrap leaf
```

Or from inside the repo: `npm run daemon -- config.toml`, `npm run setup:leader -- config.toml --bind …`, etc.

## Setting up a federation

### 1. Write the config

Each node needs its own `daemon.toml`. Example for a 3-node 2-of-3 ring
(`node-a` is partyId 0, `node-b` is 1, `node-c` is 2). Each node's file
differs only in the `[node]` section.

```toml
# daemon.toml — on node-a

[share]
path = "/etc/otzi/share.json"           # Ötzi-compatible V3 share file
password_env = "OTZI_SHARE_PASSWORD"    # env var name (not the password)

[node]
id = "node-a"
party_id = 0
identity_key_file = "/var/lib/otzi/identity.json"
pubkey_book_file = "/var/lib/otzi/pubkeys.json"

[transport]
kind = "peer-mesh"                      # or "relay"
listen = "0.0.0.0:8800"                 # omit for relay

[[peers]]
id = "node-b"
party_id = 1
endpoint = "ws://node-b.example:8800"

[[peers]]
id = "node-c"
party_id = 2
endpoint = "ws://node-c.example:8800"

[gate]
strategy = "auto"                       # auto | policy | exec | webhook

[deadlines]
signing_ms = 300000
dkg_ms = 900000

[[triggers]]
kind = "http"
bind = "127.0.0.1:8080"
auth_token_env = "OTZI_TRIGGER_TOKEN"   # optional; if set, Bearer auth required
```

For `kind = "relay"`, drop `transport.listen` and add `transport.url = "ws://relay-host:9000"`.

### 2. Bootstrap identity + pubkey book

The bootstrap exchanges each daemon's long-term ECDH public key. Designate
one node as the **leader** for setup; others `register` against it.
Run the daemons **sequentially** — leader first, then each leaf.

**On the leader (`node-a`):**

```bash
./bin/otzi setup leader /etc/otzi/daemon.toml --bind 0.0.0.0:7090
```

Leader generates an identity keypair (if one doesn't already exist), starts
a one-shot HTTP server, and waits for every expected peer to register. On
completion, it writes `pubkey_book_file` and prints the fingerprint.

**On each leaf (`node-b`, `node-c`):**

```bash
./bin/otzi setup leaf /etc/otzi/daemon.toml --leader http://node-a.example:7090
```

Each leaf generates its own identity, POSTs it to leader, and long-polls
until leader returns the full pubkey book. It writes the same book locally
and prints the fingerprint.

### 3. Verify fingerprints

Each node prints:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  otzi: setup complete — node-a (partyId 0)
  fingerprint: a7c9b3e1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Manually eyeball-compare fingerprints across every node.** If any node
shows a different value, someone tampered with the bootstrap exchange:
delete all pubkey books and start over.

### 4. Run the daemons

On each node:

```bash
export OTZI_SHARE_PASSWORD='<share password>'
export OTZI_TRIGGER_TOKEN='<random token>'   # if configured
./bin/otzi daemon /etc/otzi/daemon.toml
```

Daemons connect over the configured transport and idle until a trigger fires.

### 5. Run a DKG ceremony

Once all daemons are running, POST to any node's HTTP trigger:

```bash
curl -X POST http://node-a.example:8080/ \
  -H 'Authorization: Bearer <OTZI_TRIGGER_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"op":"dkg-combined","ceremonyId":"initial-dkg","threshold":2,"parties":3,"level":44}'
```

Response (HTTP 200):

```json
{
  "ceremonyId": "initial-dkg",
  "status": "done",
  "mldsaPublicKeyHex": "...",
  "frostVerifyingKeyHex": "04..."
}
```

**Known gap**: the daemon does not yet persist DKG results to a share file
(`encryptShareFile` helper not yet ported). For now, DKG output is returned
in the HTTP response — you'd capture it and write the share manually. This
closes when the V3 share-file write path lands.

### Other HTTP operations

| op | Body fields | Notes |
|---|---|---|
| `dkg-combined` | `threshold`, `parties`, `level` | ML-DSA + FROST under one sessionId |
| `dkg-mldsa` | `threshold`, `parties`, `level` | ML-DSA only |
| `dkg-frost` | `threshold`, `parties` | FROST only (secp256k1) |
| `sign-mldsa` | `messageHex`, `signers[]` | Generic ML-DSA signing |
| `sign-frost` | `sighashes[{hashHex,tweaked}]`, `signers[]` | Generic FROST signing |

BTC- / OPNet-specific endpoints (encoded calldata, prepare-and-sign, broadcast)
compose on top of these but are not yet exposed at the HTTP layer — driven
programmatically via `scripts/testnet-e2e.ts` today.

## Packaging

### npm tarball

```bash
npm pack
```

Produces `otzi-headless-<version>.tgz` containing the files listed in
`package.json#files` (`src/`, `bin/`, `vendor/`, etc.). Install with:

```bash
tar xzf otzi-headless-*.tgz
cd package
npm install --omit=dev        # installs runtime deps (including tsx)
./bin/otzi daemon daemon.toml
```

Or globally: `npm install -g ./otzi-headless-*.tgz` — then `otzi` is on PATH.

### `.deb`

Not yet shipped. Planned for phase 6 alongside the systemd unit:

```
/usr/bin/otzi                             # the bin/otzi shim
/usr/lib/otzi-headless/                   # src/, vendor/, node_modules/
/etc/otzi/daemon.toml                     # sample config (operator-edited)
/lib/systemd/system/otzi.service          # service unit
/var/lib/otzi/                            # identity + pubkey book files
```

Route to packaging is either [`fpm`](https://fpm.readthedocs.io/) (simplest,
one-shot from the `npm pack` tree) or a full Debian `debian/` directory. TBD
when operator deployment concretely needs it.

## Development

```bash
npm test                    # full vitest suite (~30s; includes real-WS + relay integration)
npm run typecheck           # tsc --noEmit
npx vitest                  # watch mode
npx vitest run <path>       # single file / directory

# Enable verbose per-peer logging inside integration tests:
OTZI_TEST_LOG=1 npx vitest run src/daemon/daemon-integration.test.ts

# Testnet end-to-end (costs ~200k sats + ~15 min wait; requires opnet-testnet.env):
source ~/projects/sharedenv/opnet-testnet.env && npx tsx scripts/testnet-e2e.ts
```

Source layout under `src/`:

- `core/` — ceremony runner, session wrappers, in-memory transport.
- `wire/` — Ötzi byte-compat codecs. **Do not edit.**
- `node/` — Ötzi backend crypto adapters. **Do not edit.**
- `broadcast/` — OPNet + BTC pipeline functions (pure).
- `config/` — TOML parser + `DaemonConfig` types.
- `gate/` — approval gate interface + auto/policy implementations.
- `orchestrator/` — participant-side ceremony dispatcher.
- `triggers/` — HTTP + cron trigger sources.
- `daemon/` — composition root, leader dispatcher, CLI entrypoint.
- `bootstrap/` — pubkey-book + master/member bootstrap helpers.
- `transport/` — Noise KK handshake, AES-GCM record layer.
  - `peer-mesh/` — direct-WebSocket transport.
  - `relay/` — minimal Node relay + client transport.

See `SESSION_CONTEXT.md` for the per-file inventory and the lessons learned
during phases 4d, 5, and 3f — especially the double-`initEccLib` trap and
the handshake-message-loss race.

## Related projects

- **Ötzi** — browser app, full UI. <https://github.com/mwaddip/otzi>
- **`@mwaddip/frots`** — pure-TypeScript FROST (secp256k1) used by both.
  <https://github.com/mwaddip/frots>
- **`@btc-vision/post-quantum`** — ML-DSA + threshold-ML-DSA (vendored under `vendor/post-quantum/`).
- **OPNet** — smart-contract protocol on Bitcoin L1. <https://opnet.org>
  / <https://github.com/btc-vision/opnet>

## License

TBD.
