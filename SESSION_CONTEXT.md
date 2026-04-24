# otzi-headless — Session Context

Snapshot for hand-off between sessions. `CLAUDE.md` is the spec; `PLAN.md` is the roadmap; this doc captures current state, session-made decisions, and gotchas.

Last updated: 2026-04-24 (Per-node policy primitives landed. `/sign` API flipped from raw-unsigned-tx to **construction params** for BTC: each daemon (leader + participants) builds the tx locally from the same operator-supplied `{ to, amountSat, feeRate, utxos, frostP2tr, frostUntweakedPubKey }`, participants reject silently when their rebuilt sighashes don't match the leader's assertion. OPNet keeps raw-tx + advisory `hints`. `SigningSpec` now carries verified `outputs[]` / `amount` / `destination` / `method` (BTC = structural rebuild; OPNet = operator hints). `PolicyGate` extended with protocol-scoped rules: `max_btc_per_tx`, `allowed_btc_recipients`, `allowed_contracts`, `max_ceremonies_per_hour` (sliding-window, approvals-only). Operator-in-the-loop gates: built-in `exec` + `webhook` strategies (thin delegators); opinionated auth lives OUTSIDE the daemon — `examples/gate-web-opwallet/approver.mjs` is a standalone Node service that consumes the `webhook` interface and enforces OPWallet-signed ML-DSA-44 decisions. Gate-reject-mid-ceremony integration test proves participant silence → leader abort.)

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Extraction + scaffold + plan | ✅ Done. 19 files lifted verbatim from `~/projects/otzi/` into `src/wire/` (12) + `src/node/` (6). `vendor/post-quantum/` vendored. |
| 2 | Ceremony core — pull-based ML-DSA threshold signing end-to-end, asymmetric leader/participant | ✅ Done. |
| 2.5a | FROST signing runner (asymmetric) — `signFrostAsLeader` / `participateInFrostSigning` / `sendFrostSigningDoneSignoff` over `src/wire/frost-sign.ts` | ✅ Done. |
| 2.5b.1 | ML-DSA DKG runner (symmetric) — 4-phase protocol, broadcast + targeted. | ✅ Done. |
| 2.5b.2 | FROST DKG runner (symmetric) — 2-round protocol over `@mwaddip/frots`. | ✅ Done. |
| 2.5b.3 | Combined-ceremony runner — ML-DSA DKG then FROST DKG under one shared `sessionId`. V3 share-file byte-compat. | ✅ Done. |
| 2.5c | Key-link signing — pure composition: `computeKeyLinkHash` → `signFrostAsLeader { tweaked: true }` → signoff. | ✅ Done. |
| 4a | OPNet calldata encoding — pure `encodeCalldata` + `resolveAbi` + `normalizeAbiEntry`. Byte-compat with Ötzi. | ✅ Done. |
| 4b | OPNet contract call pipeline — `captureOpnetSighashes` + `broadcastOpnetTx`. FROST path only. | ✅ Done. |
| 4c | BTC vault pipeline — `prepareBtcTx` + `broadcastBtcTx` + `fetchBtcFees`. Taproot key-path. | ✅ Done. |
| 4d | Testnet e2e (`scripts/testnet-e2e.ts`): 3-peer DKG → seed vault → BHTT.transfer → BTC return. Landed on signet 2026-04-23. Two real bugs found + fixed (see § Phase-4d findings). | ✅ Done. |
| 5a | `DaemonConfig` types + TOML parser. `[share]` / `[node]` / `[transport]` / `[[peers]]` / `[gate]` / `[deadlines]` / `[[triggers]]`. | ✅ Done. |
| 5b | Approval gate — `ApprovalGate` interface + `AutoGate` + `PolicyGate` (strict-by-default). `createGate(config)` factory. | ✅ Done. |
| 5c | Participant orchestrator — `Orchestrator` class. Leader-auth on announce + signoff. Gate decision cached across ML-DSA retries. Ceremony-deadline safety-net timeout. | ✅ Done. |
| 5d | Triggers — `HttpTrigger` on `node:http` (host:port bind, Bearer auth) + `CronTrigger` on `croner`. (Chain watching is out of scope — daemon is a signing backend, not a watcher.) | ✅ Done. |
| 5e | Daemon entrypoint — `Daemon` composition root; `LeaderDispatcher`; default HTTP handler; `config-merge.ts`; CLI `main(argv)` in `entrypoint.ts`. | ✅ Done. |
| 5f | DKG persistence + no-share startup — `share-write.ts` (V3 byte-compat) + `share-persistence.ts` (chmod 600 + mkdir). `validateLoaded` handles `ENOENT` (DKG-only mode). CLI `otzi generate`. | ✅ Done. |
| 5g | FROST `PublicKeyPackage` from persisted share — `frost-reconstruct.ts::buildFrostPublicKeyPackage(kp)` empty-maps PKG; integration test: no-share → DKG → restart → FROST sign + BIP340 verify. | ✅ Done. |
| 5h | Unsigned-tx-on-wire + participant sighash verify — single `POST / { op:'sign', ... }` op; `extractBtcSighashes` pulls per-input BIP-341 sighashes; participant silent-drop on mismatch. **Superseded for BTC by 5i.** | ✅ Done (BTC path now construction-params). |
| **5i** | **BTC construction-params + per-node rebuild + verify** — `/sign { scheme:'frost', protocol:'btc', btc: { to, amountSat, feeRate, utxos, frostP2tr, frostUntweakedPubKey } }` . `buildBtcTxFromParams` is deterministic; leader + participants build identically. Participants rebuild from announce's `btcParams`; sighash mismatch → silent drop. Decoded outputs flow into `SigningSpec.outputs` (non-self only) + `amount` + `destination`. OPNet stays raw-tx + advisory `hints: { contractAddress?, method?, amountTokenAtomic? }`. ML-DSA raw message unchanged (field renamed `messageHex`). | ✅ Done. |
| **5j** | **Operator-in-the-loop gates — `exec` + `webhook` (thin delegators)** — `ExecGate` spawns operator-supplied command, writes spec JSON on stdin, reads `approve`/`reject` from stdout. `WebhookGate` POSTs spec, expects `{ "decision" }`. `serializeSpec` converts bigints → decimal strings. Bundled example `examples/gate-file-approver.sh` (inotifywait file-drop pattern). | ✅ Done. |
| **5k** | **PolicyGate protocol-scoped rules** — `max_btc_per_tx` (sum of non-self outputs), `allowed_btc_recipients` (every non-self output address), `allowed_contracts` (OPNet destination hint), `max_ceremonies_per_hour` (in-memory sliding window; approvals-only). Constructor takes `now?: () => number` for deterministic testing. | ✅ Done. |
| **5l** | **Standalone OPWallet approver** — `examples/gate-web-opwallet/approver.mjs` is an external Node service speaking the daemon's `webhook` contract. POST /webhook holds request open; serves operator UI at GET /; accepts ML-DSA-44-signed decisions on POST /decide; resolves the held webhook with `{ decision }`. Daemon has **NO** ML-DSA verification code for gates — intentionally. Signed payload = `"otzi-headless:gate-decision:v1" ‖ ceremonyId ‖ decision_byte ‖ 32B nonce`. | ✅ Done. |
| 3a | AES-256-GCM record layer (`RecordSession`) — 4B salt ‖ 8B counter nonce. | ✅ Done. |
| 3b | Noise-KK-style handshake — ECDH P-256 static + fresh ephemerals. | ✅ Done. |
| 3c | Bootstrap protocol — master HTTP server + `runMemberRegister`; 8-char SHA-256 fingerprint. | ✅ Done. |
| 3d | `PeerMeshTransport` — WebSocket per peer pair, lower-partyId dials. | ✅ Done. |
| 3e | `RelayServer` + `RelayTransport` — opaque frame routing by ringId + partyId. | ✅ Done. |
| 3f | Transport integration — `transport-factory.ts`; daemon-integration test over each transport. | ✅ Done. |
| 6 | Packaging — Docker, systemd, `.deb` | ⏳ |

**Totals:** 299/299 tests, `tsc --noEmit` clean.

## `src/` inventory

### `src/core/` — ceremony core (phase 2)

| File | Purpose |
|---|---|
| `types.ts` | `PartyId`, `BlobKey`, `Unsubscribe`, `blobKeyToString`. |
| `transport.ts` | `Transport` interface. Authenticated-`from` contract, `broadcast` / `pull` / `servePulls`. |
| `in-memory-transport.ts` | `createInMemoryRing(peers)` — synchronous dispatch test harness. |
| `blob-store.ts` | Keyed store. Idempotent put, throws on byte conflict. |
| `blob-server.ts` | Long-lived bridge from `transport.servePulls` → `BlobStore`. Daemon-scoped. |
| `blob-puller.ts` | Per-key worker pool. Exp backoff + `AbortController` deadline. |
| `ceremony-messages.ts` | Announce / signoff message types. Encode/parse. **announce-frost carries discriminated `AnnounceFrostExtras`: BTC variant with `btcParams` (construction params) OR OPNet variant with `unsignedTxHex` + `inputs` + optional `hints`.** |
| `ceremony-runner.ts` | All leader + participant methods for ML-DSA sign, FROST sign, ML-DSA DKG, FROST DKG, combined DKG. |
| `frost-sign-session.ts` | Session wrapper over `@mwaddip/frots`. N sighashes, mixed key-path/script-path. |
| `dkg-session.ts` | ML-DSA DKG session wrapper. |
| `frost-dkg-session.ts` | FROST DKG session wrapper. |

### `src/broadcast/` — transaction pipeline (phase 4 + 5i)

| File | Purpose |
|---|---|
| `opnet-calldata.ts` | Pure calldata + `messageHash` construction. Byte-compat with Ötzi. |
| `opnet-capture.ts` | Capture sighashes for OPNet contract calls via dummy-sig + monkey-patched `sendRawTransaction`. |
| `opnet-broadcast.ts` | Inject FROST sigs, route through OPNet provider single/package broadcast. |
| `btc-vault.ts` | `prepareBtcTx` (legacy — operator-side helper that queries provider for UTXOs) + `buildBtcTxFromParams` (deterministic: takes UTXOs directly, used by leader AND participant rebuild) + `broadcastBtcTx` (witness inject + BIP340 verify under tweaked) + `extractBtcSighashes` (OPNet raw-tx path verify) + `decodeBtcOutputs` (structural output decoder — fills `SigningSpec.outputs`). |
| `btc-fees.ts` | Mempool.space rates. Throws on non-OK. |

### `src/config/` — daemon config (phase 5a)

| File | Purpose |
|---|---|
| `types.ts` | `DaemonConfig`, `NodeConfig`, `TransportConfig`, `GateConfig`, `TriggerEntry`, enum constants. `GATE_STRATEGIES = ['auto', 'policy', 'exec', 'webhook', 'cli', 'queue']`. |
| `parse.ts` | `parseDaemonConfigToml(text)` + `parseDaemonConfig(raw)`. `ConfigError` with `path` field. |
| `load.ts` | `loadDaemonConfig(path)` — thin I/O wrapper. |

### `src/gate/` — approval gate (phases 5b + 5j + 5k)

| File | Purpose |
|---|---|
| `types.ts` | `ApprovalGate` (single-method: `approve(spec) → Decision`; NO lifecycle hooks — see `feedback_gate_decision_logic_external` memory). `Decision` = `approve` / `reject` / `pending`. `CeremonySpec` = `SigningSpec` ‖ `DkgSpec`. `SigningSpec.outputs` is non-self only (vault change filtered at spec-build). |
| `policy.ts` | `PolicyGate` — strict-by-default deterministic rule engine. Generic (`maxAmount`, `destinationAllowlist`, `methodAllowlist`), BTC-scoped (`maxBtcPerTx`, `allowedBtcRecipients`), OPNet-scoped (`allowedContracts`), rate-limit (`maxCeremoniesPerHour`, sliding window, approvals-only), DKG (`dkgLeaderAllowlist`). Constructor accepts injected `now` for deterministic testing. |
| `exec.ts` | `ExecGate` — spawns operator command, writes `CeremonySpec` JSON on stdin, reads first line of stdout (`approve`/`reject`). `serializeSpec` handles bigint → decimal string. Timeout-bounded. Param keys: `command`, `timeout_sec`, `working_dir`, `env`. |
| `webhook.ts` | `WebhookGate` — POSTs spec JSON to URL, expects `{ "decision" }` response. AbortController-based timeout. Optional `bearer_token_env`. |
| `factory.ts` | `createGate(config)` + `AutoGate`. Wires `auto` / `policy` / `exec` / `webhook`. `cli` / `queue` throw. |

### `src/orchestrator/` — participant dispatcher (phase 5c + 5i)

| File | Purpose |
|---|---|
| `types.ts` | `OrchestratorDeps`, `CeremonyOutcome`, `DkgPersistenceSink`, `Logger` + `NOOP_LOGGER`. |
| `spec-builder.ts` | `buildSpecFromAnnounce(msg, ctx)` → `CeremonySpec`. Takes optional `btcOutputs` + `btcFrostP2tr` from the verify step; populates BTC spec with non-self outputs + amount + destination. OPNet spec populates from announce `hints`. |
| `orchestrator.ts` | Long-lived listener. **Verify-before-gate:** `handleAnnounce` runs `verifyAndDecodeFrostAnnounce` on FROST announces before calling the gate. BTC: rebuilds tx via `buildBtcTxFromParams`, compares sighashes, emits decoded outputs. OPNet: re-extracts sighashes from unsigned-tx. Mismatch → silent drop before gate runs. Decoded outputs threaded through `evaluateGate` → spec-builder → gate. |

### `src/triggers/` — trigger layer (phase 5d)

| File | Purpose |
|---|---|
| `types.ts` | `HttpRequest` / `HttpResponse` / `HttpHandler` + `CronTick` / `CronHandler` + common `TriggerSource`. |
| `http.ts` | `HttpTrigger` on `node:http`. Strict `host:port`, optional Bearer auth, 1MB JSON body cap. |
| `cron.ts` | `CronTrigger` on `croner`. 5/6-field expressions, handler errors caught. |

### `src/daemon/` — composition root (phase 5e + 3f + 5i)

| File | Purpose |
|---|---|
| `config-merge.ts` | `loadAndValidate(configPath)` → `LoadedDaemonState`. Two modes: share present vs. DKG-only. Pure `buildStateFromShare` / `buildStateNoShare`. |
| `share-persistence.ts` | `persistCombinedDkgShare` — encrypted V3 share envelope to disk with chmod 600 + parent mkdir. |
| `leader.ts` | `LeaderDispatcher`. **Discriminated `LeaderSignRequest`:** `LeaderSignBtcRequest { btc: { to, amountSat, feeRate, network, frostP2tr, frostUntweakedPubKey, utxos } }` | `LeaderSignOpnetRequest { unsignedTx, inputs, hints? }` | `LeaderSignMldsaRequest { message }`. BTC: builds via `buildBtcTxFromParams`, populates spec with non-self outputs. OPNet: `extractBtcSighashes` + hint-populated spec. ML-DSA: opaque `message` bytes. `GateRejection` on reject/pending. |
| `daemon.ts` | `Daemon` composition root. Wires blob infra + runner + gate + orchestrator + leader + triggers. `buildDefaultHttpHandler` parses discriminated `op:'sign'` body. Returns 403 on `GateRejection`. |
| `transport-factory.ts` | Loads identity + pubkey book; derives `ringId = SHA-256(sorted raw pubkeys)`; builds peer-mesh or relay transport. |
| `entrypoint.ts` | `main(argv)` CLI. Subcommands: `daemon` / `setup master|member` / `generate`. Does NOT call `initEccLib` (phase-4d trap). |

### `src/bootstrap/` — pubkey exchange (phase 3c)

| File | Purpose |
|---|---|
| `pubkey-book.ts` | `PubkeyBookEntry` / `PubkeyBook`, `buildBook`, `computeFingerprint` = 8-char SHA-256. |
| `master.ts` | `runMasterBootstrap` — one-shot HTTP server with long-poll fanout. Graceful shutdown. |
| `register.ts` | `runMemberRegister` — POSTs identity to master; verifies fingerprint. |

### `src/transport/` — real network transports (phase 3)

| File | Purpose |
|---|---|
| `record.ts` | `RecordSession` — AES-256-GCM per-direction, 4B salt ‖ 8B counter nonce. |
| `identity.ts` | `IdentityKeyPair` = ECDH P-256 + 65-byte raw pub. |
| `handshake.ts` | Noise-KK state machine. Four DH outputs + HKDF. |
| `peer-mesh/*` | `PeerMeshTransport`: one WS per peer pair; lower-partyId dials; persistent `HandshakeQueue`; per-connection async serialization. |
| `relay/*` | `RelayServer` (~150 LOC dumb router) + `RelayTransport` (one WS to relay, N-1 multiplexed Noise-KK sessions). |

## `scripts/`

| File | Purpose |
|---|---|
| `testnet-e2e.ts` | Live signet regression test for phase-4 broadcast pipeline. `source ~/projects/sharedenv/opnet-testnet.env && npx tsx scripts/testnet-e2e.ts`. `SKIP_TX=1` for offline portion. ~200k sats + ~15 min wait per full run. |

## `examples/`

| Path | Purpose |
|---|---|
| `gate-file-approver.sh` | Reference `exec` gate approver — file-drop pattern. Writes `CeremonySpec` to `/var/otzi/pending/<id>.json`, blocks on `inotifywait` for a decision file in `/var/otzi/decisions/`. Simplest pattern to wire a web UI against. |
| `gate-web-opwallet/approver.mjs` | Standalone Node service that speaks the daemon's `webhook` contract and enforces ML-DSA-44 wallet-signed decisions. Daemon has no ML-DSA verification code for gates — it lives here. |
| `gate-web-opwallet/index.html` | Operator UI served by `approver.mjs`. OPWallet's `signMLDSA` signs `salt ‖ ceremonyId ‖ decision_byte ‖ nonce`. |
| `gate-web-opwallet/README.md` | Architecture diagram + run instructions + security properties + customization guide. |

## `docs/`

| File | Purpose |
|---|---|
| `gates.md` | Gate contract, `CeremonySpec` schema, all shipping strategies (`auto` / `policy` / `exec` / `webhook`), deadline table, "build your own" pointer at the OPWallet example. |

## Key decisions

### Approval gate (CLAUDE.md § Security Model)
Per-node, opt-in. Strategies: `auto` / `policy` / `exec` / `webhook` / `cli` / `queue`. Lives in trigger layer (phase 5); ceremony core is unaware. Threshold protects *key material*; gate defends against compromised-machine-as-signing-oracle. Default everywhere is `auto`.

### Leader asymmetry for signing (CLAUDE.md § Core Architecture)
- Signing: trigger-assigns a **static** leader. Leader drives all rounds, runs `combine`, retries on null via `#N` ceremonyId suffix.
- Participants produce r1/r2/r3 reactively per announcement; do NOT combine.
- DKG stays **symmetric**: every peer computes its own unique share.
- Forbidden pattern is *leader-as-synchronization-primitive* (500ms state ticks + barrier sync), not "someone is in charge".

### Transport encryption — classical Noise-KK (2026-04-23)
- No PQ in the transport. ML-DSA already covers identity / quantum-safe auth at the threshold layer.
- **Primitive choice:** Noise-KK pattern over ECDH P-256. Four DH outputs (ss, es, se, ee) mixed into HKDF with transcript-hash salt; 72-byte expand → 2× 32B keys + 2× 4B salts. Authentication IMPLICIT in DH math.
- **No transcript signatures.** Noise KK's "implicit key confirmation" is the authentication.

### Relay — minimal Node, not Ötzi's Go (2026-04-23)
Replaced with a tiny Node relay (~150 LOC) that routes opaque `frame { to, payload }` by `ringId` + `partyId`. ringId = `SHA-256(sorted pubkey book)`. Relay never sees plaintext (Noise KK on top).

### Abort / timeout defaults (CLAUDE.md § Core Architecture)
Per-request retry: exp backoff 1s → 30s cap. Ceremony deadline scales with gate strategy — `auto`/`policy`: 5 min sign / 15 min DKG; `exec`/`webhook`/`cli`/`queue`: unbounded default with operator cap.

### Phase-4d findings (testnet e2e)
1. **`broadcastBtcTx` verify-key inversion.** Ötzi's `backend/src/routes/btc.ts` verifies under the untweaked key, but P2TR key-path signing with `{ tweaked: true }` produces sigs valid under the *tweaked* aggregate. Our port uses `frostTweakedPubKey`.
2. **Double `initEccLib` trap.** `@btc-vision/transaction` auto-inits at module load. A second `initEccLib(createNobleBackend())` leaves `MessageSigner` stale. Daemon entrypoint must NOT init ECC when any broadcast module is in the import graph.

### Extraction philosophy
- `src/wire/` + `src/node/` = verbatim Ötzi byte-compat. Don't edit the lifted files. New *sibling* files are fine.
- `tsconfig.json` uses `moduleResolution: "Bundler"` + `module: "Preserve"`. Don't rewrite imports.

### DKG persistence + no-share startup (2026-04-23)
- Each party encrypts its own share via V3 serializer + AES-256-GCM; writes to `[share].path` at chmod 0600.
- Leader: persistence error → HTTP 500. Participant: error logged; ceremony still settles `done` (best-effort).
- `validateLoaded` handles `ENOENT` (DKG-only mode).

### FROST `PublicKeyPackage` derivation (2026-04-23)
- Persisted V3 share carries only the caller's own `KeyPackage`. Reconstruct with **empty-maps PKG** — matches Ötzi's pattern; participants never touch PKG; aggregation's `verifyingShares` is only used for cheater-ID on verify-failure.

### BTC construction-params + per-node rebuild + verify (2026-04-24)
- `/sign { scheme:'frost', protocol:'btc', btc: {...} }`. Operator sends construction params, not raw bytes. `buildBtcTxFromParams` is deterministic given inputs (greedy largest-first UTXO selection + BIP-341 sighash math).
- Leader builds, runs ceremony, broadcasts. Participant rebuilds from announce's `btcParams`; sighash mismatch = silent drop. If the leader lies about UTXOs, BIP-341 commits to real prevout scripts + values → consensus rejects at broadcast. Worst case: wasted ceremony (DoS) — in-scope for federation trust.
- Decoded outputs populate `SigningSpec.outputs` (non-self only), `amount` (sum), `destination` (first non-self). Gate policy evaluates over **verified** fields.

### OPNet — raw-tx + advisory hints (2026-04-24)
- OPNet's SDK internally fetches UTXOs during tx assembly; making it deterministic requires wrangling the SDK's provider (deferred).
- `/sign { scheme:'frost', protocol:'opnet', unsignedTx, inputs, hints? }` stays on raw-tx. Participants re-extract sighashes from the tx bytes (existing 5h flow).
- `hints: { contractAddress?, method?, amountTokenAtomic? }` carry operator-supplied metadata. Unverified — matches federation-trust posture (insider lies out-of-scope; threshold protects key material, DoS is the worst insider outcome).

### Gate agnostic to decision logic (2026-04-24)
- The daemon's `ApprovalGate` interface is a signaling surface only — `approve(spec) → Decision`.
- Built-in strategies stay **thin**: `auto` (tautological), `policy` (rule engine over structural fields), `exec` (spawn delegator), `webhook` (HTTP delegator). No opinionated auth lives in the daemon.
- Opinionated auth mechanisms (ML-DSA-wallet-signed decisions, SSO, hardware token, CLI, etc.) ship as **external services under `examples/`** that consume the `exec` or `webhook` interface. The OPWallet approver (`examples/gate-web-opwallet/approver.mjs`) is the reference implementation. Swap the auth scheme by editing the approver; the daemon doesn't change.
- Rationale: keeps the daemon small and auditable; operators can upgrade auth mechanisms without daemon releases; every bit of code in `src/gate/` is security-critical.

### Federation trust model (2026-04-23)
- Federation members trust each other axiomatically. Rogue insider's worst case is DoS, not theft.
- Per-node `PolicyGate` is **not anti-insider**. It defends against (a) **API-surface forgery** and (b) **operational policy** (rate limits, allowlists). Both local concerns; no centralized policy engine.
- Don't add cross-verification of leader-supplied data beyond honest-bug-catching.

### Config shape
TOML for daemon runtime config. JSON for share files (Ötzi-compat). `DaemonConfig` separate from Ötzi's `VaultConfig`.

## Open items / gotchas

1. **Mandatory announce-frost wire fields.** `btcParams` (BTC path) + `unsignedTxHex` / `inputs` / `hints` (OPNet path) are currently optional at the wire level so ceremony-mechanics tests can use synthetic sighashes. Strict operator contract lives in `leader.sign()`. Making fields required tightens the protocol and guarantees participant verify always runs; needs updating ~6 test call sites to build real params (or a shared `makeDummyFrostExtras(sighashes)` helper).

2. **OPNet construction-params.** Currently deferred. Needs SDK-level control of UTXO fetching — `captureOpnetSighashes` uses the higher-level `contract.<method>().sendTransaction()` path which internally queries the provider. Making OPNet deterministic requires monkey-patching `utxoManager.getUTXOs` similarly to how we monkey-patch `sendRawTransaction`.

3. **Ring-rotation not implemented.** Once bootstrap is done, the ring is fixed. Adding/removing peers requires re-running bootstrap from scratch. Documented UX limitation; acceptable for stable federations.

4. **Relay reconnect not implemented.** If the relay drops the WebSocket, daemons fail open — operator restart required.

5. **ML-DSA DKG phase-3 expected-senders** — pull from every distinct generator (not just own bitmasks) else `dkgPhase4` throws. Handled in `phase3ExpectedSenders`.

6. **`#N` retry suffix** requires `ceremonyId` to NOT contain `#`. Tighten with a check if ceremonyIds ever come from untrusted sources.

7. **Engine warnings on npm install.** `opnet@1.8.13` + some `@btc-vision/*` want Node 24+; we're on 22.19.

8. **Combine attempt cap.** `signAsLeader`'s `maxCombineAttempts` default is 50 (bumped from 5). Seat-of-pants.

9. **FROST cheater identification disabled.** `buildFrostPublicKeyPackage` passes empty verifying-shares maps; on aggregation failure `signAggregate` returns an empty `culprits` list. Acceptable given transport's authenticated `from`.

10. **ML-DSA only signs raw bytes.** `/sign scheme='mldsa'` requires `protocol='raw'`. No protocol-level decoding for ML-DSA-outer-auth-over-OPNet-tx.

## Things NOT to do

- **Don't call `initEccLib(createNobleBackend())`** in any code path that imports `@btc-vision/transaction`. Phase-4d trap.
- **Don't trust Ötzi's `backend/src/routes/btc.ts`** FROST sig BIP340 verify-key (untweaked); we use `frostTweakedPubKey` for key-path.
- **Don't port Ötzi's React components** (`DKGWizard.tsx`, `ThresholdSign.tsx`, `FrostSign.tsx`, `SigningPage.tsx`). Read for protocol reference only.
- **Don't add a centralized policy engine** that duplicates threshold enforcement.
- **Don't put manifest parsing or ABI awareness in the daemon.** Post-demotion `src/broadcast/` helpers stay as TypeScript exports; public HTTP never takes manifests or ABIs.
- **Don't add anti-insider verification to the gate.** Federation trust is axiomatic; gate is anti-API-forgery + operational policy only.
- **Don't put decision logic (ML-DSA verify, SSO, wallet auth, etc.) in the daemon's gate layer.** Thin delegators only (`exec`/`webhook`). Opinionated auth ships as external services under `examples/`. See `feedback_gate_decision_logic_external` memory.
- **Don't concurrent-decrypt** on a single `RecordSession` — counters are strictly monotonic.
- **Don't use `once('message')` as the sole handshake consumer** — frames arriving during async setup will be lost. Use `HandshakeQueue`-style persistent listener.
- **Don't force-close the bootstrap master** (`closeAllConnections`) after completion — graceful `server.close()` lets in-flight responses flush.
- **Don't rewrite relative imports in `src/wire/`** to add `.js` extensions.
- **Don't register per-ceremony `servePulls` handlers** — `BlobServer` owns it daemon-wide.

## Quick commands

```bash
npm install            # install deps
npx tsc --noEmit       # typecheck
npx vitest run         # run full suite (~30s with real-transport integration tests)
npx vitest             # watch mode

# Integration tests only (real WS + real relay, 3 daemons each):
npx vitest run src/daemon/daemon-integration.test.ts

# Debug-log transport events during an integration run:
OTZI_TEST_LOG=1 npx vitest run src/daemon/daemon-integration.test.ts

# External OPWallet approver (consumes webhook gate):
export APPROVER_PUBKEY_HEX="…"   # 2624 hex chars (ML-DSA-44 pubkey)
node examples/gate-web-opwallet/approver.mjs
```
