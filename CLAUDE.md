@~/projects/OVERRIDES.md

# CLAUDE.md — otzi-headless

## Project Overview

Headless daemon variant of Ötzi: a FROST-only Bitcoin vault for automated and federated custody — bridge reserves, liquidity pools, multi-party server vaults. N daemons hold FROST key shares of one key-path-only Taproot key (`bc1p…` / `tb1p…`) and jointly sign spends that every node has checked against its own key and its own approval gate. Ceremonies are machine-triggered. Headless by default; optional per-node approval gate for critical deployments (see § Security Model).

Reference implementation: `~/projects/otzi/` (React + Express + Go relay, interactive operators). This repo is a **separate-repo sibling**, not a workspace member. The surface it shares with Ötzi is lifted verbatim into `src/otzi/` from one recorded Ötzi commit and checked by a drift script (see § Code Shared With Ötzi). A share file written by otzi-headless opens in web Ötzi, and the reverse.

## Interface Contracts

`INTERFACES.md` (entry point) + `facts/<subsystem>.md` (per-subsystem) hold the authoritative preconditions, postconditions, and invariants for every component in this repo.

**Before any code change:**
1. Read the relevant `facts/<subsystem>.md` first. The `INTERFACES.md` index maps subsystems to files.
2. If the change crosses a contract boundary, update the contract there before writing code.
3. Cite affected contracts in commit messages and PR descriptions.

If a contract doesn't match current behavior, the contract is stale — investigate, fix the divergence, then resume work. Never silently route around a stale contract.

## Core Architecture: Pull-Based Blob Exchange

Ötzi's React UI uses leader-driven state-sync: 500ms STATE broadcasts, barrier synchronization, COMPLETE-gated transitions. **DO NOT PORT THIS.** That complexity is browser tax (tabs close, timers drift, users refresh); it's a coordination primitive forced by fragile endpoints, not a protocol property.

The daemon runs pull-based instead:
- Each peer holds produced blobs in memory during a ceremony and clears them a fixed retention period after the ceremony ends on that node (5 min signing, 15 min DKG), so lagging peers can still pull until then.
- For round N, each peer requests missing inputs from their producers.
- When a peer has all inputs, it computes and stores the output.
- No 500ms state ticks, no barrier synchronization, no heartbeat.

### Role asymmetry — signing vs DKG

**Signing is leader-driven.** The trigger (API call / cron) fires on exactly one node — the initiator. That node is the leader for this ceremony:
- Analyses the caller's `SendProposal` against its own key and network, and evaluates its own gate, before anything is announced.
- Broadcasts `announce-sign` once, carrying the proposal. Sighashes are never sent; every signer computes them from the proposal.
- Drives both rounds, pulling co-signers' `sign-r1` / `sign-r2` blobs into its session.
- Aggregates locally with the full public key package (frots names a cheating signer), checks every signature against the vault output key, and finalizes the signed transaction. The daemon returns it to the caller; the caller broadcasts it.
- Runs a single attempt: FROST aggregation is deterministic, so there are no retries.
- Broadcasts `signoff-done` (carrying the signatures) after finalizing — participants verify the signatures and release state immediately.
- Broadcasts `signoff-aborted` on any failure after the announce.

**Participants** (non-leader signers) run their own analysis and gate on the announce, produce `sign-r1`, pull `sign-r1` from co-signers, produce `sign-r2`, and stop — they do NOT aggregate. A participant settles on signoff receipt (common case) or on the ceremony deadline (safety net for a crashed leader / dropped signoff).

This leader is trigger-assigned — a static role for the ceremony, not an elected coordination primitive. No leader election, no heartbeat, no barrier. The forbidden shape is the Ötzi UI's *leader-as-synchronization-primitive*, not "someone is in charge".

**DKG is symmetric.** The node whose trigger fires generates the 32-byte session ID and announces; it has no other role. Every party computes its own key share; no party ever holds another party's share. All N nodes then FROST-sign a verification message computed from their own view of the result, each aggregates and verifies that signature, stages its share file, and completes only after every other node has confirmed its own verification.

**Abort/timeout.** Blob pulls retry with exponential backoff until the ceremony deadline (leader and participants alike). Ceremony-wide deadline scales with approval strategy: `auto` / `policy` → 5 min signing, 15 min DKG (machine-only — don't let phantom ceremonies linger); `exec` / `webhook` → unbounded by default, operator cap (e.g. 24h). All values config-driven. DKG and signing both abort if any peer drops or rejects — by design the `dkg` op creates an n-of-n vault (`threshold = parties`) and signing uses all n signers by default. An offline peer in a headless federation is a red flag (compromise, partition, sabotage), not a graceful-degradation budget. The threshold `t` is defense-in-depth against key-share compromise (any <t shares are useless to an attacker), separate from the operational requirement that all n peers participate.

## Security Model: Ring of Trust

Ring of trust established at bootstrap. The security boundary is:
1. **Threshold ceremony** — any signature requires t-of-n peers to collectively agree. Compromising <t peers yields nothing.
2. **Peer allowlist** — transport drops traffic from any source not on the peer list (IP pinning on peer-mesh + mutual Noise-KK authentication against the P-256 pubkey book).
3. **Per-node analysis of every proposal** — each node, leader and participant alike, runs `analyzeProposal(proposal, toVaultKey(ownPublicKeyPackage), ownNetwork)` and signs only sighashes it computed itself. Every input must spend this node's own vault script, change is only an output paying that script, and the proposal network must equal this node's network. Nothing the leader asserts about keys, addresses, change or network is trusted. The gate decides on a spec built from this node's own analysis, and participants verify the leader's `signoff-done` signatures against their own sighashes and output key.

**Setup trust assumption and run-once DKG.** The DKG is a run-once setup step for unconfigured nodes. Setup runs under a trust assumption: one administrator sets up the federation, or a trusted group does it live. The DKG's checks — exact commitment count, sender binding, a verification signature by all N nodes, all-N confirmation before any node completes — make a faulty or inconsistent setup fail loudly. Once a vault exists (a share loaded, or a file at the share path), no DKG can touch it: participants drop the announce and the `dkg` op returns 409. Replacing a vault is an operator action: move the share file away and restart the daemon.

**No centralized policy engine.** A separate layer that re-checks ceremony rules the whole ring must pass (per-transaction amount/destination allowlists at the protocol level, approval quorums that duplicate the threshold) adds nothing the threshold doesn't already enforce. Skip it.

**Per-node approval gate — opt-in, additive.** The threshold protects *key material*: compromising <t keys yields nothing. It does not protect against a compromised *machine* being used as a signing oracle — an attacker who owns one daemon and can forge triggers into t-1 auto-signing peers reaches mnemonic-equivalent capability without ever stealing a key. For critical deployments, each daemon optionally gates its own participation in each ceremony:

- Config-selectable strategy per node: `auto` (pure headless, the default), `policy` (deterministic rule check — amount, fee and fee-rate caps, every recipient ∈ allowlist or the node's own address book, rate limits), `exec` (spawn operator command, read approve/reject from stdout), `webhook` (POST spec to external approver over https — or http on loopback only — and await its decision).
- Interface: `approve(ceremonySpec) → approve | reject | pending`. Pending re-checks on external signal.
- Semantics: a gate can only *further restrict* what its node will sign, never widen. A rejecting node stays silent; to peers it is indistinguishable from offline. DKG and signing both abort on any reject — operationally every node signs (see § Core Architecture).
- Lives in the trigger layer. Ceremony core and transport do not know the gate exists — they just see a slower or absent peer.

Default is `auto` everywhere. The gate is opt-in per node, not required infrastructure.

## Transport

Config-selectable:
1. **Peer mesh** — direct WebSocket connections between daemons. Fits permanent federations with stable identities.
2. **Relay** — the headless relay server (`src/transport/relay/server.ts`), a dumb router of opaque encrypted frames. Simpler, but requires a coordinator online. otzi-headless never joins an Ötzi relay session.

Both share the same E2E encrypted wire format (Noise-KK over ECDH P-256, AES-256-GCM records).

## Triggers

Ceremonies are initiated by machine inputs from operator infrastructure:
- API call (UDS by default, loopback HTTP optional) from an authorized operator backend or the `otzi` CLI.
- Scheduled/cron.

The daemon does NOT watch chains, queues, or external state, and it has no chain access — it is a signing backend, not an autonomous actor. The caller builds a `SendProposal` (e.g. `otzi btc send` from Esplora UTXOs), the daemon's `sign` op returns the signed transaction, and the caller broadcasts it. If a ceremony should fire on a chain event, the operator's own watcher subscribes to the event and calls the `sign` op. Keeping the daemon's surface narrow keeps the audit footprint small.

Config-driven. Any interactive approval is layered on top via the per-node gate (see § Security Model), not at the trigger itself.

## Code Shared With Ötzi

otzi-headless speaks its own transport and ceremony messages. The code it shares with Ötzi is lifted verbatim from one recorded Ötzi commit:

- `src/otzi/lib/` ← Ötzi `src/lib/`: `dkg.ts`, `dkg.fixture.ts`, `dkg.test.ts`, `frost-sign.ts`, `frost-sign.test.ts`, `share-file.ts`, `share-file.test.ts`, `bitcoin.ts`, `bitcoin.test.ts`, `crypto.ts`, `hex.ts`, `vault-types.ts`, `address-book.ts`, `address-book.test.ts`.
- `src/otzi/backend/` ← Ötzi `backend/src/lib/`: `bitcoin.ts`, `bitcoin.test.ts`, `test-vault.fixture.ts`, `esplora.ts`, `btc-message.ts`, `btc-message.test.ts`, `types.ts`.

Rules:
- **DO NOT EDIT `src/otzi/`.** Every file is byte-identical to the Ötzi commit recorded in `src/otzi/OTZI_COMMIT`. Headless code that needs more goes in its own modules outside `src/otzi/`. The directory mirrors Ötzi's layout, so lifted files never collide with headless modules.
- `scripts/check-otzi-drift.sh <otzi-checkout>` diffs every lifted file against an Ötzi checkout and exits non-zero on any difference. CI clones Ötzi at the recorded commit and runs it.
- Moving to a newer Ötzi commit: copy the files, update `OTZI_COMMIT`, update `facts/otzi.md`, then run the drift check and both test suites.
- Browser-only helpers (`downloadShareFile`, `downloadAddressBook`) are present but never called; `tsconfig` keeps the `DOM` lib so they typecheck.

The shared surface: share file v4, vault address derivation (`p2tr(xOnly(untweakedVerifyingKey))`, key-path only), the `frost-r1` / `frost-r2` / `frost-sign-r1` / `frost-sign-r2` blob codecs, the DKG verification message `taggedHash("Otzi/dkg-verify", …)`, `SendProposal` + `analyzeProposal`, the Esplora client and its per-network defaults, and the address-book file. Not shared: Ötzi's relay protocol, its relay text messages (`BARRIER:`, `FROST-STATE:`, `PROPOSAL-REQ:`, …) and its REST API. Mixed ceremonies (daemons and browser parties in one session) are out of scope.

## What to Rewrite (Not Port)

Ötzi's React components carry browser-specific tangles. Read them for protocol reference; **do not lift their state machines**:
- `src/components/DKGWizard.tsx` (relay barriers, 3 s re-send loop, React state).
- `src/components/FrostSign.tsx` (500 ms `FROST-STATE:` round sync, relay-sender binding).
- `src/components/SendSession.tsx` (proposal relay messages, `PROPOSAL-REQ:` polling).

Write the daemon state machines from scratch using the pull-based model above.

## Reference Files in Ötzi

Useful when working on the shared surface:
- `facts/INTERFACES.md` — Ötzi's contracts; §3–§8, §11 and §15 cover what otzi-headless shares.
- `src/components/DKGWizard.tsx` — DKG ceremony flow, including the verification signature (protocol reference only).
- `src/components/FrostSign.tsx` — signing rounds, nonce handling, participant binding (protocol reference only).
- `src/components/SendSession.tsx`, `src/components/ProposalReview.tsx` — proposal exchange and approval.
- `docs/signing-flows.md` — documented ceremony flows.
- `docs/otzi-address-book-schema.json` — address-book file schema.

## Identity Model

Keep the transport identity and the vault key apart:

| Field | What it is | Used for |
|-------|-----------|----------|
| `publicKeyHex` (pubkey book entry) | Raw 65-byte uncompressed P-256 public key (130 hex chars) | Transport identity: Noise-KK authentication, `partyId` derivation, ring ID, bootstrap fingerprint |
| `partyId` | Index of the entry in the pubkey book (sorted by raw pubkey bytes) | Ring position; FROST identifier = `partyId + 1` |
| `node.id` | Local label from `daemon.toml` | Logging only |
| `internalKey` / `outputKey` / `address` (`VaultKey`, `publicKeyPackage`) | FROST group key and its key-path-only P2TR | Building and signing transactions ONLY — never for transport auth |

## Stack

- Pure Node.js + TypeScript. No React, no Vite, no browser.
- **Config format:** TOML for daemon runtime config (network, peers, triggers, gate strategy, deadlines — operator-edited); JSON for share files (Ötzi v4, byte-compatible) and the address book (Ötzi address-book file).
- **Runtime config type:** `DaemonConfig` is separate from Ötzi's `VaultConfig`. The share file stays Ötzi-compatible; daemon-specific settings live in `DaemonConfig`. Startup reads the share, decrypts it (`decryptShareFile`), checks it against `[network].name` (`assertShareMatchesVault`), and checks `partyId` and `parties` against the pubkey book.
- UDS / loopback-HTTP API for triggering ceremonies; the `otzi` CLI is the operator surface.
- Deployment targets: Docker container, systemd service, .deb package.

## Bitcoin Stack

- `@mwaddip/frots` (`github:mwaddip/frots`, or `npm link` from `~/projects/frots` during development) — FROST (RFC 9591, secp256k1-SHA256-TR): DKG, signing, aggregation with cheater identification.
- `@scure/btc-signer@2.4.1`, `@scure/base@2.4.0` — transactions, addresses, BIP341 sighashes. Exact pins: the versions in Ötzi's lockfile at the lifted commit.
- `@noble/curves`, `@noble/hashes` — secp256k1 / BIP340, SHA-256 and tagged hashes.
- Chain data: an Esplora REST API (`src/otzi/backend/esplora.ts`), used by the CLI only. Default: mempool.space per network; `[network].esplora_url` overrides.
- Networks: `mainnet`, `testnet4`, `signet` — exactly Ötzi's set.

## Git Workflow

- Work on `master`.
- Tag releases as `vX.Y.Z`.
- Conventional commits (feat/fix/docs).
- Commit from project root.

## Background Design Context

Carved off after a design session in Ötzi on 2026-04-22. Key decisions reached in that session:

1. **Extraction is too expensive.** Lifting ceremony state machines from Ötzi's React components was estimated at 2-3 weeks of refactoring due to DKGWizard's 35+ useEffect hooks, setInterval-driven progress, and useState/useRef tangles. Not worth it.
2. **Pull-based daemon state machine is simpler.** Daemons with stable presence don't need the leader-driven state-sync that exists to paper over browser flakiness.
3. **Shared surface is narrow enough for separate repo.** Share file, blob codecs, proposal analysis, Esplora client and address-book file are lifted verbatim and drift-checked, so drift collapses to "a lifted file differs from the recorded Ötzi commit" — a mechanically checked invariant.
4. **Security boundary = ring of trust + threshold, with optional per-node approval gate on top.** No *centralized* policy engine (duplicates what the ceremony enforces); but a per-node participation filter is additive defense-in-depth against compromised-machine threat, opt-in, and invisible to the ceremony core.
5. **Abort/timeout semantics resolved.** Per-request retry + strategy-scaled ceremony deadline; concrete defaults in § Core Architecture.

A second design session on 2026-10-10 fixed the vault shape (spec: `docs/superpowers/specs/2026-10-10-btc-only-pivot-design.md`):

6. **FROST-only Bitcoin vault.** The daemon holds FROST shares of one key-path-only Taproot key and nothing else. Share files are Ötzi v4.
7. **Proposal in, signed transaction out.** Callers send Ötzi's `SendProposal`; every node analyses it against its own key; the daemon returns the signed transaction and never touches the chain.
8. **Per-node address book.** Ötzi's address-book file format, one file per node; it supplies labels to gate specs and can serve as the policy recipient allowlist.
