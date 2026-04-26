@~/projects/OVERRIDES.md

# CLAUDE.md — otzi-headless

## Project Overview

Headless daemon variant of Ötzi, for automated and federated threshold-signing systems: bridge reserves, liquidity pools, multi-party server vaults. Machine-triggered ML-DSA + FROST ceremonies over OPNet Bitcoin L1. Headless by default; optional per-node approval gate for critical deployments (see § Security Model).

Reference implementation: `~/projects/otzi/` (React + Express + Go relay, interactive operators). This repo is a **separate-repo sibling**, not a workspace member — drift risk is minimal because the protocol is solidified (DKG + FROST + ML-DSA, standards-based); any changes are bug fixes, not new features.

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
- Each peer holds produced blobs in memory during ceremony.
- For round N, each peer requests missing inputs from their producers.
- When a peer has all inputs, it computes and stores the output.
- No 500ms state ticks, no barrier synchronization, no heartbeat.

### Role asymmetry — signing vs DKG

**Signing is leader-driven.** The trigger (HTTP call / cron) fires on exactly one node — the initiator. That node is the leader for this ceremony:
- Drives all rounds, pulling co-signers' blobs into its session.
- Runs `combine` locally (only the leader needs the signature — to broadcast the transaction).
- Retries from round 1 with a `#N` ceremonyId suffix on rejection-sampling failure.
- Broadcasts `announce` before each attempt so participants produce fresh blobs.
- Broadcasts `signoff-done` (carrying the signature for audit) after the transaction is on-chain — releases participant state immediately.
- Broadcasts `signoff-aborted` on exhausted retries or upstream failure.

**Participants** (non-leader active signers) produce their own blobs per announcement, pull r1 / r2 inputs from co-signers, but do NOT pull r3 and do NOT run `combine`. Session destroyed on signoff receipt (common case) or ceremony-deadline TTL (safety net for crashed leader / dropped signoff).

This leader is trigger-assigned — a static role for the ceremony, not an elected coordination primitive. No leader election, no heartbeat, no barrier. The forbidden shape is the Ötzi UI's *leader-as-synchronization-primitive*, not "someone is in charge".

**DKG remains leaderless and symmetric.** Every party computes its own unique key share; there is no single public aggregation step. All peers run the full protocol and self-determine completion from their own outputs.

**Abort/timeout.** Per-request retry: exponential backoff 1s → 30s cap, max 5 attempts. Ceremony-wide deadline scales with approval strategy: `auto` / `policy` → 5 min signing, 15 min DKG (machine-only — don't let phantom ceremonies linger); `exec` / `webhook` → unbounded by default, operator cap (e.g. 24h). All values config-driven. DKG aborts if any peer drops or rejects (threshold = n); signing degrades gracefully iff ≥ t peers remain responsive.

## Security Model: Ring of Trust

Ring of trust established at DKG time. The security boundary is:
1. **Threshold ceremony** — any signature requires t-of-n peers to collectively agree. Compromising <t peers yields nothing.
2. **Peer allowlist** — transport drops traffic from any source not on the peer list (IP pinning + mutual ML-DSA auth).

**No centralized policy engine.** A separate layer that re-checks ceremony rules the whole ring must pass (per-transaction amount/destination allowlists at the protocol level, approval quorums that duplicate the threshold) adds nothing the threshold doesn't already enforce. Skip it.

**Per-node approval gate — opt-in, additive.** The threshold protects *key material*: compromising <t keys yields nothing. It does not protect against a compromised *machine* being used as a signing oracle — an attacker who owns one daemon and can forge triggers into t-1 auto-signing peers reaches mnemonic-equivalent capability without ever stealing a key. For critical deployments, each daemon optionally gates its own participation in each ceremony:

- Config-selectable strategy per node: `auto` (pure headless, the default), `policy` (deterministic rule check — amount ≤ X, destination ∈ allowlist, method ∈ allowlist), `exec` (spawn operator command, read approve/reject from stdout), `webhook` (POST spec to external approver, await signed response).
- Interface: `approve(ceremonySpec) → approve | reject | pending`. Pending re-checks on external signal.
- Semantics: a gate can only *further restrict* what its node will sign, never widen. A rejecting node stays silent; to peers it is indistinguishable from offline. DKG aborts on any reject (threshold = n); signing proceeds iff ≥ t peers approve.
- Lives in the trigger layer. Ceremony core and transport do not know the gate exists — they just see a slower or absent peer.

Default is `auto` everywhere. The gate is opt-in per node, not required infrastructure.

## Transport

Config-selectable:
1. **Peer mesh** — direct WebSocket connections between daemons. Fits permanent federations with stable identities.
2. **Relay** — reuses Ötzi's existing Go relay (`~/projects/otzi/relay/`). Simpler, but requires a coordinator online.

Both share the same E2E encrypted wire format.

## Triggers

Ceremonies are initiated by machine inputs from operator infrastructure:
- HTTP/IPC API call from an authorized operator backend.
- Scheduled/cron.

The daemon does NOT watch chains, queues, or external state — it is a signing backend, not an autonomous actor. If a ceremony should fire on a chain event, the operator's own watcher subscribes to the event and POSTs `/sign`. Keeping the daemon's surface narrow keeps the audit footprint small.

Config-driven. Any interactive approval is layered on top via the per-node gate (see § Security Model), not at the trigger itself.

## What to Share With Ötzi

Byte-for-byte compatible surface (port carefully, verify against Ötzi):
- **Wire format** — DKG and signing-round blob encoding. See `~/projects/otzi/src/lib/dkg.ts` (Phase 3+4 checksums live here) and the ceremony components.
- **Crypto primitives** — `@mwaddip/frots` (pure TS FROST, at `~/projects/frots`), `@btc-vision/post-quantum` (ML-DSA; Ötzi vendors it at `vendor/post-quantum/`).
- **Relay client** — `~/projects/otzi/src/lib/relay.ts` is clean, class-based, event-emitter-style. Largely reusable as-is.
- **Broadcast adapters** — `backend/src/routes/btc.ts` (BTC vault) and `tx.ts` (OPNet contract sighash/broadcast) are already non-UI. `backend/src/lib/frost-psbt-signer.ts` and `backend/src/lib/threshold-signer.ts` are already headless.

## What to Rewrite (Not Port)

Ötzi's React components carry browser-specific tangles. Read them for protocol reference; **do not lift their state machines**:
- `src/components/DKGWizard.tsx` (~1844 lines, 35+ useEffect hooks, setInterval-driven progress).
- `src/components/ThresholdSign.tsx` (~687 lines, inline relay dispatch, useState phase mgmt).
- `src/components/FrostSign.tsx` (useRef+useState-counter hybrid for round-sync).
- `src/components/SigningPage.tsx` (orchestrator, contract + BTC vault flows).

Write the daemon state machines from scratch using the pull-based model above.

## Reference Files in Ötzi

Useful during the port:
- `src/lib/relay.ts` — relay client (lift).
- `src/lib/dkg.ts` — DKG blob encoding with checksums (match byte-for-byte).
- `backend/src/lib/frost-psbt-signer.ts` — FROST PSBT capture/replay (lift).
- `backend/src/lib/threshold-signer.ts` — ML-DSA threshold signing (lift).
- `backend/src/routes/btc.ts` — BTC prepare/broadcast (adapt).
- `backend/src/routes/tx.ts` — OPNet contract sighash/broadcast + ABI resolution (adapt).
- `docs/signing-flows.md` — documented ceremony flows.

## Identity Model

Same as Ötzi — avoid pubkey confusion:

| Field | What it is | Used for |
|-------|-----------|----------|
| `mldsaPubKey` | Raw ML-DSA public key (1312/1952/2592 bytes) | Auth signature verification |
| `walletAddress` | `0x + hex(SHA256(mldsaPubKey))` | Peer identity |
| `publicKey` / `tweakedPubKey` / `p2tr` | Bitcoin key | Wallet/transaction ONLY — never for auth |

## Stack

- Pure Node.js + TypeScript. No React, no Vite, no browser.
- **Config format:** TOML for daemon runtime config (peers, triggers, gate strategy, deadlines — operator-edited); JSON for share files (Ötzi-compat, byte-stable).
- **Runtime config type:** `DaemonConfig` is separate from Ötzi's `VaultConfig`. Share file stays Ötzi-compatible; daemon-specific settings live in `DaemonConfig`. Startup loads share → extracts crypto → merges with `DaemonConfig`.
- HTTP/IPC API for triggering ceremonies.
- Deployment targets: Docker container, systemd service, .deb package.

## OPNet Dependencies

- `opnet@1.8.6` — contract interactions, OP_20_ABI.
- `@btc-vision/transaction@1.8.2` — Address, BinaryWriter.
- `@btc-vision/bitcoin@7.0.0` — network types.
- `@btc-vision/post-quantum` — ML-DSA (vendor as Ötzi does, or pull from upstream if packaging has improved).
- `@mwaddip/frots` (`github:mwaddip/frots`, or `npm link` from `~/projects/frots` during development) — FROST.
- ML-DSA-44 only (level 44 for OPNet).

## Git Workflow

- Work on `master`.
- Tag releases as `vX.Y.Z`.
- Conventional commits (feat/fix/docs).
- Commit from project root.

## Background Design Context

Carved off after a design session in Ötzi on 2026-04-22. Key decisions reached in that session:

1. **Extraction is too expensive.** Lifting ceremony state machines from Ötzi's React components was estimated at 2-3 weeks of refactoring due to DKGWizard's 35+ useEffect hooks, setInterval-driven progress, and useState/useRef tangles. Not worth it.
2. **Pull-based daemon state machine is simpler.** Daemons with stable presence don't need the leader-driven state-sync that exists to paper over browser flakiness.
3. **Shared surface is narrow enough for separate repo.** Wire format + crypto + relay + manifest + broadcast. Drift risk collapses to "wire format diverges" — well-specified invariant.
4. **Security boundary = ring of trust + threshold, with optional per-node approval gate on top.** No *centralized* policy engine (duplicates what the ceremony enforces); but a per-node participation filter is additive defense-in-depth against compromised-machine threat, opt-in, and invisible to the ceremony core.
5. **Abort/timeout semantics resolved.** Per-request retry + strategy-scaled ceremony deadline; concrete defaults in § Core Architecture.
