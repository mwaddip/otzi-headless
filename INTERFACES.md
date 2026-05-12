# INTERFACES.md — otzi-headless contract reference

Authoritative inventory of preconditions, postconditions, and invariants for every component in this repo. Last verified against the codebase: 2026-05-12 (post identity-decoupling Phase G).

## How to use this doc

**Rule of engagement** — every code change must touch this file before code:

1. **Read** the relevant section first. Understand what callers promise, what the component guarantees, what invariants must hold, and which other components depend on the contract you're about to touch.
2. **Re-read after context decay.** If you've been working in this conversation for >10 messages or made 60+ tool calls, re-read before editing — see OVERRIDES.md Rule 7.
3. **Update** the contract HERE before landing the code change. A change that alters behavior at an interface boundary without updating the contract is a contract violation.
4. **Cite affected contracts** in commit messages and PR descriptions whenever behavior crosses an interface.

**Code-vs-contract conflicts:** if a contract doesn't match current behavior, the contract is stale. Investigate, decide which is wrong, fix the divergence, then resume work. Never silently route around a stale contract.

**Reading order:** sections are organized bottom-up by dependency. Read in order to learn the system; jump to a section to make a targeted change.

---

## Global invariants

Cross-cutting truths that hold everywhere; subsystem sections may restate them for emphasis.

### Trust model
- **Federation trust is axiomatic.** Federation members trust each other. The threshold (t-of-n) protects key material; compromising <t peers yields nothing.
- **Worst case for a rogue federation member is DoS, not theft.** Insider lies are out of scope; gates are NOT anti-insider.
- **Per-node gate scope:** anti-API-forgery + operational policy ONLY (rate limits, allowlists). NOT cross-verification of leader-supplied data beyond honest-bug-catching.
- **Operational threshold = n in v0.1 CLI flows.** The DKG produces a t-of-n share and the leader's `signers` array is unconstrained at the protocol layer, but `otzi sign` / `otzi btc send` always pass all n partyIds. An offline peer is a red flag in a headless federation (compromise / partition / sabotage), not a graceful-degradation budget. The t-of-n cryptographic property defends against <t key-share compromise; it is separate from the operational policy of all-n participation.
- **Network-layer pre-filter (peer-mesh only).** The peer-mesh WS server's `verifyClient` drops inbound connections from any source IP not in the resolved peer-endpoint allowlist. Drop is silent (`socket.destroy()` before the WS handshake completes; no 401 or other response on the wire) with a `peer-allowlist:` warn line for log scrapers. Independent from and additive to the cryptographic mutual-auth layer (Noise-KK + ML-DSA pubkey book) — both must pass for a peer to participate. **Asymmetry:** the relay transport has NO L4 filter; the relay multiplexes by `partyId` from the client `hello`, not by source IP. Cryptographic auth alone gates relay'd traffic, which is why the relay is acceptable: it sees only opaque ciphertext and cannot impersonate a peer.
- **Daemon scope is key custody.** Sign what operators POST; no chain watching, autonomous triggers, decision intelligence, or anything non-key-adjacent inside the daemon.
- **Manifest parsing + ABI awareness are operator-side**, never inside the daemon. `/sign` accepts only discriminated raw construction params.

### Byte-compatibility boundary
- **`src/wire/` and `src/node/` are LIFTED VERBATIM from `~/projects/otzi/`.** DO NOT EDIT THEM. Byte-compat for V3 share files, ML-DSA DKG blobs, FROST blobs, and OP_20 calldata is a hard contract. New SIBLING files in those dirs are fine.
- **Don't rewrite relative imports** in `src/wire/` to add `.js` extensions.

### Ceremony shape
- **Pull-based.** Peers store produced blobs; consumers pull missing inputs reactively. NO leader-driven state sync, NO 500ms ticks, NO barriers.
- **Signing is asymmetric:** trigger-assigns a static leader who drives all rounds + runs combine + retries on null with `#N` ceremonyId suffix. Participants are reactive (announce-driven, no r3 pull, no combine).
- **DKG is symmetric:** every peer is equal. The "leader" only fires the trigger.
- **`Transport` authenticates `from`** on every broadcast/pull callback. Test transports MUST preserve this contract even when bypassing E2E encryption.
- **`BlobStore.put` is idempotent on byte-equal; throws on byte-conflict.** Wire codecs MUST be deterministic.
- **`BlobServer` is daemon-scoped (not ceremony-scoped).** A peer that finishes can still serve its blobs to lagging peers.
- **`servePulls` is registered once per daemon at startup**, not per ceremony.

### Verify-before-gate
- Orchestrator narrows on `announce.protocol` BEFORE evaluateGate.
  - **`btc`:** rebuilds tx via `buildBtcTxFromParams`, sighash match → ok; mismatch → silent drop.
  - **`opnet`:** re-extracts sighashes from `unsignedTxHex`, match → ok; mismatch → silent drop. Hints are advisory only.
  - **`opnet-params`:** derives `refundAddress` (theft check), reconstructs capture inputs, re-runs deterministic capture, sighash match → ok. `destination` + `method` are STRUCTURALLY verified.
  - **`keylink`:** unverified by design (DKG-state threading is a future plug-in point).
- Decoded BTC outputs (non-self only) flow into `SigningSpec.outputs` + `amount` + `destination` for verified gate evaluation.

### OPNet construction-params (Phase 8) traps
- **`captureMutex` serializes all OPNet captures process-wide.** Concurrent captures interleave the `BitcoinUtils.rndBytes` monkey-patch counter — corrupts both. DO NOT bypass.
- **`ChallengeSolution.toRaw()` is lossy.** `legacyPublicKey` is post-tweak 32B x-only; SDK needs 33B SEC1 original. Use `serializeChallengeForWire` from `opnet-params-reconstruct.ts`.
- **`refundAddress` MUST be locally derived per peer** via `deriveVaultP2tr(untweakedPubKey, network)`. Bogus refund = theft of change (not just DoS).
- **OPNet capture composition surface.** Provider broadcast and SDK signer are wrapped via composition (`CapturingProvider` Proxy + `CaptureSigner` class) — the upstream provider object is never mutated, and there is no graft on a wallet keypair (no mnemonic plumbing anywhere in the capture path). The lone remaining ambient mutation is `BitcoinUtils.rndBytes`; `rndbytes-canary.test.ts` asserts the symbol shape we depend on so version-pinning slip fails loudly. Long-term fix requires an upstream PR threading `randomBytes` through `CallResult.sendTransaction` → `factory.signInteraction`.

### Phase-4d trap (initEccLib)
- **NEVER call `initEccLib(createNobleBackend())`** in any code path that imports `@btc-vision/transaction`. The package auto-inits at module load. Double-init silently misroutes the FROST legacy-sig monkey-patch.

### BIP340 verify-key
- FROST key-path BIP340 verify uses the **TWEAKED** pubkey. Ötzi's `backend/src/routes/btc.ts` got this wrong (verifies under untweaked); we use `frostTweakedPubKey`.

### Transport encryption
- **Noise-KK** over ECDH P-256. Four DH outputs (ss, es, se, ee) → HKDF-SHA-256 → 72-byte expand → 2× 32B keys + 2× 4B salts. Authentication is IMPLICIT in DH math; **NO transcript signatures**.
- **`RecordSession`** AES-256-GCM with `salt(4B) ‖ counter(8B)` nonce. Counter is strictly monotonic per direction. Concurrent decrypt on a single session is undefined behavior — peer-mesh `connection.ts` serializes via `processingChain`.
- **Don't use `once('message')`** as the sole handshake consumer; use `HandshakeQueue`-style persistent listener.
- **Don't force-close (`closeAllConnections`)** the bootstrap master after completion; graceful `server.close()` lets in-flight responses flush.

### Operator API surface (load-bearing)
- The daemon's operator API binds to a UDS socket by default (`[[triggers]] kind="uds" path="/var/run/otzi/otzi.sock"`). Filesystem permissions (chmod 660 root:otzi) are the auth model.
- An optional `kind="http"` trigger is supported for the future remote-CLI case, but the parser ENFORCES that the bind host is loopback (`127.0.0.1`, `::1`, `localhost`) or a UDS path. External binds are rejected at parse time.
- Group-membership-based access is the precondition for `feedback_cli_is_primary_entrypoint` — the CLI is THE operator surface, and any user in the `otzi` group can run it without sudo.
- **`otzi <subcommand>` is THE operator-facing surface.** Direct `curl` calls to the daemon UDS are not a supported workflow. If a flow exists in production, it should be reachable via `otzi <subcommand>`. New ops added to the daemon HTTP handler should land alongside a CLI verb that wraps them; raw HTTP usage is reserved for tests + debugging.

### Control plane (Phase 9c)
- The daemon's "control plane" is the set of bootstrap-window-only operations — currently just `manifest-push`. All control-plane wire messages are authenticated by HMAC-SHA-256 over the operator-typed shared `bootstrap-secret`.
- The `bootstrap-secret` lives at `/var/lib/otzi/bootstrap-secret` chmod 660 root:otzi (set up by 9a's debconf prompt at install time, distributed out-of-band between operators). It is wiped automatically by `share-persistence.persistCombinedDkgShare` on first successful DKG completion.
- Post-DKG, all control-plane operations are rejected with `ControlPlaneClosed` errors. Manifest changes after DKG are operator-local: each operator runs `otzi install` on their own node.
- The `manifest-push` opcode rides the existing Noise-KK transport. The transport's authenticated `from` field is independent from the HMAC; the HMAC is additive (it proves the sender knows the operator-typed secret, not just any peer in the ring).
- `op:'sync'` distribution semantics are best-effort broadcast: the local daemon installs first (so a local refusal short-circuits the broadcast), then fans out via `transport.broadcast`. There is NO per-peer ack channel — operators verify with `otzi list` on each peer or via daemon logs if they need confirmation.

### `#N` retry suffix (ML-DSA signing)
- Leader appends `#N` to `ceremonyId` on combine retry. `baseCeremonyId` is stable across retries. **`ceremonyId` MUST NOT contain `#`** ; tighten with a check if ceremonyIds ever come from untrusted sources.

### Round-key conventions
| Protocol | Round keys |
|---|---|
| ML-DSA signing | `mldsa-r1` / `mldsa-r2` / `mldsa-r3` |
| FROST signing | `frost-sign-r1` / `frost-sign-r2` |
| FROST DKG | `frost-dkg-r1` / `frost-dkg-r2` |
| ML-DSA DKG | `p1` / `p2pub` / `p2priv` / `p3priv` / `p4` |
| FROST keylink | `frost-keylink-r1` / `frost-keylink-r2` (distinct from regular FROST signing to avoid collision under the same ceremonyId) |

### Network handling
- `[network].name ∈ {mainnet, testnet, regtest}`.
- `regtest` → combined DKG skips the keylink phase (`frostLegacySig` not produced; OPNet contract calls against the resulting share fail at capture — documented carve-out).
- `mainnet`/`testnet` → keylink phase runs; `daemon.ts` wires `network` into `LeaderDeps` + `OrchestratorDeps`.

### ML-DSA-44 only
- Pubkey 1312 bytes; signature 2592 bytes. Threshold sig is opaque to ML-DSA `/sign` (`scheme='mldsa', protocol='raw'`).
- Address (`walletAddress`) = `0x + hex(SHA256(mldsaPubKey))`.
- Identity model: `mldsaPubKey` is for auth; `walletAddress` is the BTC-payment-style identity (`0x...`); `publicKey` / `tweakedPubKey` / `p2tr` is BTC wallet-only — never for auth.

### Identity-decoupling (post-Phase-G)
- **The raw pubkey is the only cross-node identity primitive.** Federation members agree on raw pubkeys (130-char hex) via bootstrap; everything else is derived or local.
- **`partyId` is derived**, not configured. Bootstrap collects every peer's `(publicKey, advertisedEndpoint)` pair, sorts by raw pubkey bytes ascending, and assigns `partyId = index`. Every peer reproduces the same mapping from the same book. The daemon resolves its own `partyId` at startup by matching its loaded identity's pubkey to a book entry.
- **`advertisedEndpoint` is the cross-node routing primitive.** Canonical `host:port` form (lowercase, default port 8800, RFC 5952 IPv6, no wildcards). All endpoints in pubkey-book entries and `[[peers]]` config are stored canonical post-parse; both sides must literally agree for transport-factory's `validatePeersAgainstBook` to pass.
- **`node.id` is local-only.** A logging label for `peersById[selfPartyId]`; no two operators need to agree on what they call peer N. Non-self labels in `peersById` are synthesized as `peer-${partyId}` by transport-factory.
- **Legacy fields strict-rejected.** Parser refuses `node.party_id`, `[[peers]].{id, party_id, wallet_address}`, and `transport.listen` with explicit "no longer supported" errors pointing at the replacement (`otzi setup` for book regeneration, `transport.advertised_endpoint` for transport, the book itself for peer identifiers). Pubkey-book files containing the legacy `nodeId` field are rejected at parse — operators must regenerate via `otzi setup`.

### Authentication of `from`
- The `from` field in every `Transport` callback is cryptographically authenticated. Implementations MUST NOT forge it (InMemoryTransport respects this in tests).
- Once a leader is pinned for a `baseCeremonyId` (first announce wins), all subsequent announces + signoffs MUST come from that peer. Non-leader announces silently drop.

### Don't-list (durable, not exhaustive)
- Don't add a centralized policy engine that duplicates threshold enforcement.
- Don't put manifest parsing or ABI awareness in the daemon (CLI is the operator-side parser).
- Don't add anti-insider verification to the gate.
- Don't try to add or remove peers from a running federation. Ring membership is fixed at bootstrap time (pubkey book + Noise-KK identities are pinned post-bootstrap). Rotation = build a new federation and migrate funds; there is no in-place membership change path by design.
- Don't put decision logic (ML-DSA verify, SSO, wallet auth) in the daemon's gate layer. Thin delegators only (`exec`/`webhook`); opinionated auth ships under `examples/`.
- Don't run combined DKG with `spec.network` unset in production (share persists without `frostLegacySig` → OPNet calls fail at capture).
- Don't bloat the .deb past 2 MB (release workflow's size-regression guard fails).
- Don't accept operator-supplied `refundAddress` on `opnet-params`.
- Don't run two `captureOpnetSighashes` concurrently in the same process — `captureMutex` serializes them.
- Don't send `announce-frost` without `extras` — the wire is strict; parser rejects as null.
- Don't accept `protocol: 'opnet'` requests. The HTTP body parser returns 400; legacy code paths stay in `src/broadcast/` for the `opnet-params` flow's internal use only.

---

## Index

Per-subsystem contracts live in [`facts/`](facts/). Read in dependency order to learn the system; jump to a single file to make a targeted change.

| Subsystem | Description | File |
|---|---|---|
| `src/wire/` | Lifted byte-compat layer from Ötzi: V3 share files, ML-DSA + FROST blob codecs, OP-20 ABI shorthand, manifest types. **DO NOT EDIT — byte-compat with Ötzi is a hard contract.** | [facts/wire.md](facts/wire.md) |
| `src/node/` | Lifted backend lib from Ötzi: `frost-link.computeKeyLinkHash`, `frost-psbt-signer` (capture/replay), `threshold-signer`, `opnet-client`, Node `encryption`. **DO NOT EDIT.** | [facts/node.md](facts/node.md) |
| `src/core/` | Pull-based ceremony plumbing: `Transport` interface, `BlobStore` / `BlobServer` / `BlobPuller`, `CeremonyRunner` (ML-DSA + FROST signing + DKG), session wrappers, ceremony-message wire format. | [facts/core.md](facts/core.md) |
| `src/broadcast/` | Tx pipeline: BTC construction-params (`buildBtcTxFromParams` is deterministic + sighash-verifiable), OPNet capture (with `captureMutex` + `BitcoinUtils.rndBytes` HMAC-DRBG patch) + broadcast, OPNet-params reconstruction (`serializeChallengeForWire` + `deriveVaultP2tr`). | [facts/broadcast.md](facts/broadcast.md) |
| `src/bootstrap/` | One-shot pubkey-book exchange. `runMasterBootstrap` + `runMemberRegister`; `computeFingerprint` = 8-char SHA-256 for cross-channel verification. | [facts/bootstrap.md](facts/bootstrap.md) |
| `src/transport/` | Real network transports. Noise-KK over ECDH P-256 + AES-256-GCM `RecordSession`. Peer-mesh (WebSocket per pair, lower partyId dials) + relay (one WS to relay, N-1 multiplexed Noise sessions). | [facts/transport.md](facts/transport.md) |
| `src/config/` | TOML daemon config: `DaemonConfig` types, `parseDaemonConfigToml`, `ConfigError`. | [facts/config.md](facts/config.md) |
| `src/gate/` | Approval gate: `ApprovalGate` interface (single-method, signaling-only), `AutoGate` / `PolicyGate` / `ExecGate` / `WebhookGate`. Opinionated auth lives under `examples/`. | [facts/gate.md](facts/gate.md) |
| `src/orchestrator/` | Long-lived participant listener. Verify-before-gate (`verifyFrostAnnounce` switch on `protocol`), spec-builder, ceremony dispatch, deadline timeouts. | [facts/orchestrator.md](facts/orchestrator.md) |
| `src/triggers/` | `HttpTrigger` (loopback bind, Bearer auth, 1MB body cap) + `CronTrigger` (`croner` 5/6-field expressions). | [facts/triggers.md](facts/triggers.md) |
| `src/daemon/` | Composition root. `Daemon` wires blob infra + runner + gate + orchestrator + leader + triggers. `LeaderDispatcher` (discriminated `LeaderSignRequest`), `transport-factory` (ringId derivation), `entrypoint` (CLI). | [facts/daemon.md](facts/daemon.md) |

**Reading order (dependency, bottom-up):** `wire` + `node` → `core` → `broadcast` → `bootstrap` + `transport` → `config` + `gate` → `orchestrator` + `triggers` + `daemon`.
