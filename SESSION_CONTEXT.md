# otzi-headless — Session Context

Snapshot for hand-off between sessions. `CLAUDE.md` is the spec; `PLAN.md` is the roadmap; this doc captures current state, session-made decisions, and gotchas.

Last updated: 2026-04-23 (DKG persistence + no-share startup landed — daemon now boots without a share file, runs DKG in DKG-only mode, persists encrypted V3 share files to disk via leader + each participant, and reloads on restart. New `otzi generate` CLI triggers the DKG against a local DKG-only daemon. Together these close the "fresh-install" workflow gap.).

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Extraction + scaffold + plan | ✅ Done. 19 files lifted verbatim from `~/projects/otzi/` into `src/wire/` (12) + `src/node/` (6). `vendor/post-quantum/` vendored. |
| 2 | Ceremony core — pull-based ML-DSA threshold signing end-to-end, asymmetric leader/participant | ✅ Done. |
| 2.5a | FROST signing runner (asymmetric) — `signFrostAsLeader` / `participateInFrostSigning` / `sendFrostSigningDoneSignoff` over `src/wire/frost-sign.ts` | ✅ Done. |
| 2.5b.1 | ML-DSA DKG runner (symmetric) — `runMldsaDkg` / `participateInMldsaDkg`. 4-phase protocol, P1/P2-pub/P4 broadcast, P2-priv/P3 targeted. End-to-end verified via `ThresholdMLDSA.sign`. | ✅ Done. |
| 2.5b.2 | FROST DKG runner (symmetric) — `runFrostDkg` / `participateInFrostDkg`. 2-round protocol (R1 broadcast, R2 targeted) over `@mwaddip/frots`. End-to-end: DKG → FROST signing → BIP340 `verifySignature`. | ✅ Done. |
| 2.5b.3 | Combined-ceremony runner — `runCombinedDkg` / `participateInCombinedDkg`. Single initiator broadcasts `announce-combined-dkg`; runs ML-DSA DKG then FROST DKG under one shared `sessionId`. Matches Ötzi's `DKGWizard.tsx` flow and V3 share-file byte-compat. | ✅ Done. |
| 2.5c | Key-link signing — pure composition: `computeKeyLinkHash(...)` → `signFrostAsLeader { tweaked: true }` → `sendFrostSigningDoneSignoff` → every peer captures the sig. BIP340 verifies under tweaked key. | ✅ Done. |
| 4a | OPNet calldata encoding — pure `encodeCalldata(method, params, paramTypes)` + `resolveAbi(abi)` + `normalizeAbiEntry`. Byte-compat with Ötzi. | ✅ Done. |
| 4b | OPNet contract call pipeline — `captureOpnetSighashes` + `broadcastOpnetTx`. FROST path only; Express wrapper stripped. | ✅ Done. |
| 4c | BTC vault pipeline — `prepareBtcTx` + `broadcastBtcTx` + `fetchBtcFees`. Taproot key-path. In-module TTL caches dropped (phase-5 owns workflow state). | ✅ Done. |
| 4d | Testnet e2e (`scripts/testnet-e2e.ts`): 3-peer DKG → seed vault → BHTT.transfer → BTC return. Both txs landed on signet 2026-04-23. Two real bugs found + fixed (see Decisions § Phase-4d findings). | ✅ Done. |
| 5a | `DaemonConfig` types + TOML parser (`smol-toml`). `[share]` / `[node]` / `[transport]` / `[[peers]]` / `[gate]` / `[deadlines]` / `[[triggers]]`. Strategy-specific sub-fields captured raw in `params`, narrowed by 5b/5d. | ✅ Done. |
| 5b | Approval gate — `ApprovalGate` interface + `AutoGate` + `PolicyGate` (strict-by-default: operator-set constraint + spec-missing-field = reject). `createGate(config)` factory. `webhook`/`cli`/`queue` throw not-implemented. | ✅ Done. |
| 5c | Participant orchestrator — `Orchestrator` class lifted from test helpers. Leader-auth on announce + signoff. Gate decision cached across ML-DSA retries. Ceremony-deadline safety-net timeout. All 5 ceremony kinds (ML-DSA sign, FROST sign, 3 DKG flavors). | ✅ Done. |
| 5d | Triggers — `HttpTrigger` on `node:http` (host:port bind, Bearer auth, 1MB JSON bodies) + `CronTrigger` on `croner` (5/6-field expressions, handler-error isolation). Chain-watcher deferred. | ✅ Done. |
| 5e | Daemon entrypoint — `Daemon` composition root (blob store/server/puller + runner + gate + orchestrator + triggers); `LeaderDispatcher` (gate-checked `runCombinedDkg` / `runMldsaDkg` / `runFrostDkg` / `signMldsa` / `signFrost`); default HTTP handler routes `op=dkg-combined|sign-mldsa|…`; `config-merge.ts` loads + cross-validates share against config; CLI `main(argv)` in `entrypoint.ts`. | ✅ Done. |
| 5f | DKG persistence + no-share startup — `src/wire/share-write.ts` (encrypt + V3 serialize, byte-compat with Ötzi's `encryptShareV3`); `src/daemon/share-persistence.ts` (write to disk with chmod 600 + parent mkdir); `LoadedDaemonState.persistDkgShare` closure pre-bound by `validateLoaded` (captures path + password). Leader persists synchronously inside `runCombinedDkg`; participants persist before settling outcome (best-effort: errors logged). `validateLoaded` handles `ENOENT` — daemon comes up with `state.share = undefined`, signing rejected with clear error, DKG works. New CLI `otzi generate <config>` POSTs `dkg-combined` to local daemon. Integration test exercises the full no-share → DKG → restart → sign loop. | ✅ Done. |
| 3a | AES-256-GCM record layer (`RecordSession`) — nonce = 4B salt ‖ 8B BE counter (TLS 1.3 convention), 2^48 soft-rekey / 2^64 hard limit, auth-failure doesn't advance recv counter. | ✅ Done. |
| 3b | Noise-KK-style handshake — pre-shared static ECDH P-256 identity keys + fresh ephemeral per handshake; four DH outputs (ss, es, se, ee) mixed into HKDF with transcript-hash salt; implicit key confirmation via first record frame. | ✅ Done. |
| 3c | Bootstrap protocol — master HTTP server + `runMemberRegister` CLI, long-poll until pubkey book complete; `computeFingerprint` = 8-char SHA-256 for operator eyeball. | ✅ Done. |
| 3d | `PeerMeshTransport` — WebSocket per peer pair, lower-partyId dials, exponential reconnect, pull timeout = transient null. | ✅ Done. |
| 3e | `RelayServer` (minimal Node relay, ~150 LOC) + `RelayTransport` — one WS per daemon to relay, N-1 multiplexed Noise-KK sessions inside, roster push via `peer-joined` / `peer-left`. | ✅ Done. |
| 3f | Transport integration — `transport-factory.ts` loads identity PKCS#8 + pubkey book, derives `ringId = SHA-256(sorted pubkeys)`, constructs peer-mesh or relay; daemon-integration test runs a full HTTP-driven combined DKG over each. | ✅ Done. |
| 6 | Packaging — Docker, systemd, `.deb` | ⏳ |

**Totals:** 265/265 tests, `tsc --noEmit` clean.

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
| `ceremony-messages.ts` | Announce / signoff message types. Encode/parse. |
| `ceremony-runner.ts` | All leader + participant methods for ML-DSA sign, FROST sign, ML-DSA DKG, FROST DKG, combined DKG. |
| `frost-sign-session.ts` | Session wrapper over `@mwaddip/frots`. N sighashes, mixed key-path/script-path. |
| `dkg-session.ts` | ML-DSA DKG session wrapper. `phase2ExpectedSenders` / `phase3ExpectedSenders` (distinct generators). |
| `frost-dkg-session.ts` | FROST DKG session wrapper. `round1` broadcast, `round2ForTarget` targeted. |

### `src/broadcast/` — transaction pipeline (phase 4)

| File | Purpose |
|---|---|
| `opnet-calldata.ts` | Pure calldata + `messageHash` construction. Byte-compat with Ötzi. |
| `opnet-capture.ts` | Capture sighashes for OPNet contract calls via dummy-sig + monkey-patched `sendRawTransaction`. |
| `opnet-broadcast.ts` | Inject FROST sigs, route through OPNet provider single / package broadcast. |
| `btc-vault.ts` | `prepareBtcTx` (UTXO + coin select + Taproot sighashes) + `broadcastBtcTx` (BIP340 verify under `frostTweakedPubKey` + witness inject). |
| `btc-fees.ts` | Mempool.space rates. Throws on non-OK; no silent fallback. |

### `src/config/` — daemon config (phase 5a)

| File | Purpose |
|---|---|
| `types.ts` | `DaemonConfig`, `NodeConfig` (incl. `identityKeyFile`, `pubkeyBookFile`), `TransportConfig` (kind + optional `url` / `listen`), `GateConfig`, `TriggerEntry`, enum constants. |
| `parse.ts` | `parseDaemonConfigToml(text)` + `parseDaemonConfig(raw)`. `ConfigError` with `path` field. Snake_case → camelCase. Coherence checks (unique ids, unique partyIds, node partyId ≥ 0). |
| `load.ts` | `loadDaemonConfig(path)` — thin I/O wrapper. |

### `src/gate/` — approval gate (phase 5b)

| File | Purpose |
|---|---|
| `types.ts` | `ApprovalGate`, `Decision`, `CeremonySpec` discriminated union (`SigningSpec` + `DkgSpec`). |
| `policy.ts` | `PolicyGate` (maxAmount, destinationAllowlist, methodAllowlist, dkgLeaderAllowlist) — strict-by-default. `parsePolicyParams` accepts number or decimal string for amounts (u256 safe). |
| `factory.ts` | `createGate(config)` + `AutoGate`. |

### `src/orchestrator/` — participant dispatcher (phase 5c)

| File | Purpose |
|---|---|
| `types.ts` | `OrchestratorDeps` (incl. optional `share` + optional `persistDkgShare` sink), `CeremonyOutcome` (discriminated by kind), `DkgPersistenceSink` type (shared with leader + config-merge), minimal `Logger` interface + `NOOP_LOGGER`. |
| `spec-builder.ts` | `buildSpecFromAnnounce` → `CeremonySpec`. Signing announces currently produce `operation: 'generic'` — future wire extension (HANDOFF.md item #2) puts the unsigned tx itself on the wire so participants can decode + verify. |
| `orchestrator.ts` | Long-lived listener. Leader-auth pins `from` of first announce. Gate decision cached per baseCeremonyId. Signing settles via signoff; DKG settles via participate-promise (calls `persistDkgShare` before settle on combined-DKG; persist errors logged but don't block settle — best-effort on participant side). `dispatchMldsaSigning` no-ops with an error log when `share` is missing (DKG-only daemon). `waitFor` / `onCompleted` / `stop`. |

### `src/triggers/` — trigger layer (phase 5d)

| File | Purpose |
|---|---|
| `types.ts` | `HttpRequest` / `HttpResponse` / `HttpHandler` + `CronTick` / `CronHandler` + common `TriggerSource`. |
| `http.ts` | `HttpTrigger` on `node:http`. Strict `host:port`, optional Bearer auth (token from env var), 1MB JSON body cap. |
| `cron.ts` | `CronTrigger` on `croner`. 5/6-field expressions, handler errors caught. |

### `src/daemon/` — composition root (phase 5e + 3f)

| File | Purpose |
|---|---|
| `config-merge.ts` | `loadAndValidate(configPath)` → `LoadedDaemonState` (config + optional decrypted share + `peersById` + pre-bound `persistDkgShare` sink). Two startup modes: share present → full alignment validation; share missing (`ENOENT`) → DKG-only mode. Pure `buildStateFromShare` / `buildStateNoShare` variants for tests. |
| `share-persistence.ts` | `persistCombinedDkgShare` — writes the encrypted V3 share envelope (via `src/wire/share-write::encryptShareV3`) to the configured path. Forces chmod 600 explicitly, mkdirs the parent (so `/etc/otzi/` Just Works on a fresh box). |
| `leader.ts` | `LeaderDispatcher` — gate-checked `runCombinedDkg` / `runMldsaDkg` / `runFrostDkg` / `signMldsa` / `signFrost`. `share` is optional — `signMldsa` throws clearly if missing (DKG-only daemon). `runCombinedDkg` calls `persistDkgShare` after success and propagates persist errors to the caller (HTTP 500). `GateRejection` thrown on reject/pending — no announce broadcasts. |
| `daemon.ts` | `Daemon` composition root. Wires blob infra + runner + gate + orchestrator + leader + triggers (and threads `state.persistDkgShare` to both leader + orchestrator). `buildDefaultHttpHandler` routes JSON `{op, …}` to leader primitives; returns 403 on `GateRejection`. |
| `transport-factory.ts` | Loads identity (PKCS#8 privkey + raw pub) + pubkey book from disk; derives `ringId = SHA-256(sorted raw pubkeys)`; builds peer-mesh or relay transport accordingly. `buildTransportFromMemory` for tests. |
| `entrypoint.ts` | `main(argv)` CLI shim. Subcommands: `daemon` / `setup master|member` / `generate`. `daemon` loads config/share/identity/book → starts transport → starts Daemon (announces signing+DKG vs DKG-only mode at startup). `generate` POSTs `dkg-combined` to the local daemon's HTTP trigger. SIGINT/SIGTERM graceful shutdown. Does NOT call `initEccLib` (phase-4d trap). |

### `src/bootstrap/` — pubkey exchange (phase 3c)

| File | Purpose |
|---|---|
| `pubkey-book.ts` | `PubkeyBookEntry` / `PubkeyBook`, sort-by-partyId `buildBook`, validation (130-char hex, 0x04 prefix, unique ids/partyIds), `computeFingerprint` = 8-char SHA-256. |
| `master.ts` | `runMasterBootstrap` — one-shot HTTP server. Long-poll `CompletionGate` fans out book when all peers register. Graceful shutdown (no `closeAllConnections`; `Connection: close` header). |
| `register.ts` | `runMemberRegister` — POSTs identity to master; self-check against returned book; verify local vs advertised fingerprint. |

### `src/transport/` — real network transports (phase 3)

| File | Purpose |
|---|---|
| `record.ts` | `RecordSession` — AES-256-GCM per-direction with 4B salt ‖ 8B counter nonce. Synchronous counter increment before async crypto call. `shouldRekey(threshold)`. |
| `identity.ts` | `IdentityKeyPair` = ECDH P-256 privkey + 65-byte raw pub. `generateIdentity`, `importPeerPubKey`, `importIdentity` (PKCS#8 + raw pub), `exportPrivateKeyPkcs8`. |
| `handshake.ts` | Noise-KK-style state machine. `initiatorBegin` → `responderRespond` → `initiatorFinish`. Four DH outputs + HKDF with transcript-hash salt → 72-byte expand (2×32B keys + 2×4B salts). Role-oriented. |
| `peer-mesh/wire.ts` | JSON codec: handshake (cleartext) + `AppMessage` (broadcast, pull-req, pull-resp) wrapped in AES-GCM post-handshake. Base64 for binary in JSON. |
| `peer-mesh/connection.ts` | `PeerConnection` — one WS per peer pair. `HandshakeQueue` persistently listens from handshake start, buffers frames arriving during setup, replays into constructor. Per-connection async-chain serializes decryption. |
| `peer-mesh/peer-mesh.ts` | `PeerMeshTransport` implements `Transport`. Lower-partyId dials. Exponential reconnect 1s → 10s cap (initiator only). Pull timeout = transient `null`. |
| `relay/wire.ts` | JSON wire protocol: `hello` / `frame` (C→S); `ack` / `peer-joined` / `peer-left` / `incoming` / `error` (S→C). |
| `relay/server.ts` | `RelayServer` — dumb router. Per-ringId connection maps, roster events, frame routing by `to`. FCFS partyId slot; deploy behind network restriction. |
| `relay/relay-transport.ts` | `RelayTransport` implements `Transport`. One WS to relay, N-1 Noise-KK sessions multiplexed inside. Per-peer serial processing via `pending[]` + `processing` flag (prevents mid-handshake re-entry races). |

## `scripts/`

| File | Purpose |
|---|---|
| `testnet-e2e.ts` | Live signet regression test for phase-4 broadcast pipeline. `source ~/projects/sharedenv/opnet-testnet.env && npx tsx scripts/testnet-e2e.ts`. `SKIP_TX=1` for offline portion. ~200k sats + ~15 min wait per full run. |

## Key decisions

### Approval gate (CLAUDE.md § Security Model)
Per-node, opt-in. Strategies: `auto` / `policy` / `webhook` / `cli` / `queue`. Lives in trigger layer (phase 5); ceremony core is unaware. Threshold protects *key material*; gate defends against compromised-machine-as-signing-oracle. Default everywhere is `auto`.

### Leader asymmetry for signing (CLAUDE.md § Core Architecture)
- Signing: trigger-assigns a **static** leader. Leader drives all rounds, runs `combine`, retries on null via `#N` ceremonyId suffix. Broadcasts `announce` per attempt, `signoff-done` (with sig) after successful tx broadcast, `signoff-aborted` on any failure path.
- Participants produce r1/r2/r3 reactively per announcement; pull r1/r2 inputs from co-signers; do NOT pull r3, do NOT combine.
- DKG stays **symmetric**: every peer computes its own unique share.
- Forbidden pattern is *leader-as-synchronization-primitive* (500ms state ticks + barrier sync), not "someone is in charge".

### Transport encryption — classical Noise-KK (2026-04-23)
- No PQ in the transport. ML-DSA already covers identity / quantum-safe auth at the threshold layer. Transport uses classical ECDH for session confidentiality only.
- **Primitive choice:** Noise-KK pattern over ECDH P-256. Each daemon has a long-term ECDH P-256 identity keypair. Pubkeys pre-shared via bootstrap (phase 3c), pinned in every peer's pubkey book. Handshake exchanges fresh ephemerals; four DH outputs (ss, es, se, ee) concatenated as HKDF IKM; transcript hash as salt; 72-byte expand → 2× 32B keys + 2× 4B salts. Authentication is IMPLICIT in the DH math (wrong static key → wrong derived secrets → AES-GCM auth fails on first record frame).
- **No transcript signatures.** Noise KK's "implicit key confirmation" is the authentication. No Ed25519 / ML-DSA on handshake transcripts — the DH math is the proof.
- **Threat-model note:** harvest-now-decrypt-later against ECDH would eventually expose DKG phase-2 private shares + FROST round blobs if captured streams are broken in the quantum future. Signatures and tx bytes are public on-chain anyway; only DKG-era blobs carry forward-secrecy risk. DKG rotation cadence bounds residual exposure.

### Bootstrap protocol (phase 3c)
- Operator designates one node as setup master; all others `register` against it over plain HTTP.
- Master runs a one-shot HTTP server, collects `{nodeId, partyId, publicKeyHex}` registrations, long-polls each open connection until all expected peers have registered, then fans out the complete pubkey book as each peer's HTTP response.
- 8-char SHA-256 **fingerprint** displayed at completion; operator manually eyeball-compares across nodes to defeat silent MitM of the setup flow.
- Implementation note: master must NOT forcibly close connections with `closeAllConnections()` at shutdown — gracefully let in-flight responses flush first, else the last-registering peer loses its book. `Connection: close` header on responses helps idle-socket cleanup without cutting in-flight.

### Relay — minimal Node, not Ötzi's Go (2026-04-23)
CLAUDE.md originally said "reuses Ötzi's Go relay". Revisited during phase 3e: Ötzi's relay assigns server-side session codes (client can't propose), uses its own ECDH + AES key-distribution flow we'd have to work around, and adds a Go binary to the deploy story. Replaced with a tiny Node relay (~150 LOC) that routes opaque `frame { to, payload }` by `ringId` + `partyId`. No session-creation dance — ringId is a shared grouping key derived from `SHA-256(sorted pubkey book)`. Roster pushed as `peer-joined` / `peer-left` events. Relay never sees plaintext (Noise KK on top).

### Pull semantics in real transports (phase 3f)
`transport.pull(key)` must return `null` on timeout, not throw. `BlobPuller` retries on null + deadline-aborts on the ceremony's own clock. Throwing would abort a ceremony on one unlucky pull response.

### Per-connection message serialization (phase 3f)
Both peer-mesh and relay serialize per-peer message processing. In peer-mesh, `PeerConnection` uses an async chain (`processingChain = processingChain.then(...)`) so concurrent frames can't race the AES-GCM counter. In relay, `PeerState.pending[]` + `processing` flag dispatches frames sequentially so mid-handshake awaits can't receive a second frame as "stale handshake bytes".

### Handshake message queue (phase 3f)
`PeerConnection.dial` / `acceptInbound` attach a persistent `ws.on('message')` listener from handshake start via `HandshakeQueue`. Without this, the original `once('message')`-based implementation lost any frame that arrived between the once-listener firing and the PeerConnection constructor attaching its `on('message')` — resulting in record-counter desync and immediate AES-GCM auth failure on the next frame.

### Abort / timeout defaults (CLAUDE.md § Core Architecture)
Per-request retry: exp backoff 1s → 30s cap. Ceremony deadline scales with gate strategy — `auto`/`policy`: 5 min sign / 15 min DKG; `webhook`/`cli`/`queue`: unbounded default with operator cap.

### Pull-handler lifecycle (debug fix during 2.4)
`BlobServer` decouples `servePulls` lifetime from the ceremony. Fix for a two-generals race where the first peer to finish would unregister mid-ceremony. Server owns the handler for the daemon's lifetime.

### Config shape
TOML for daemon runtime config. JSON for share files (Ötzi-compat). `DaemonConfig` separate from Ötzi's `VaultConfig`.

### Phase-4d findings (testnet e2e)

1. **`broadcastBtcTx` verify-key inversion.** Ötzi's `backend/src/routes/btc.ts` verifies under the untweaked key, but P2TR key-path signing with `{ tweaked: true }` produces sigs valid under the *tweaked* aggregate. Our port takes `frostTweakedPubKey` and verifies under it. Phase C of `scripts/testnet-e2e.ts` proves the convention.

2. **Double `initEccLib` trap.** `@btc-vision/transaction` auto-inits at module load; `MessageSigner` is bound to that instance via `import { backend }`. A second `initEccLib(createNobleBackend())` leaves `MessageSigner` stale and `withFrostLegacySig`'s patch lands on the wrong backend. Daemon entrypoint must NOT init ECC when any broadcast module is in the import graph.

### Extraction philosophy
- `src/wire/` + `src/node/` = verbatim Ötzi byte-compat. No edits.
- `tsconfig.json` uses `moduleResolution: "Bundler"` + `module: "Preserve"`. Don't rewrite imports.

### DKG persistence + no-share startup (2026-04-23)
- After `runCombinedDkg` (leader) or `participateInCombinedDkg` (participant) settles, each party encrypts its own share via `serializeCombinedV3` + AES-256-GCM and writes the result as a V3 `ShareFile` JSON to the configured `[share].path`. File mode forced to `0o600`; parent directory created if missing.
- Leader: persistence error propagates to the HTTP caller (HTTP 500) — operator sees the failure. Participant: persistence error logged at error level; ceremony still settles `done` (DKG succeeded in memory; persistence is best-effort on participants since they have no caller to report to).
- `validateLoaded` handles missing share (`ENOENT`) gracefully: daemon enters DKG-only mode (`state.share = undefined`, `persistDkgShare` still pre-bound). Signing rejected with clear errors; DKG works fine. Operator restarts after DKG to enter signing-capable mode.
- Implementation: `src/wire/share-write.ts` (encrypt + V3 serialize wrapper, byte-compat with Ötzi's `encryptShareV3`) + `src/daemon/share-persistence.ts` (filesystem-side write). `src/wire/` byte-compat files are not edited — `share-write.ts` is a new sibling.

### Daemon = signing service, not transaction builder (2026-04-23)
- The daemon's HTTP API takes raw unsigned transaction bytes — no manifests, no ABIs, no contract knowledge. Construction (manifest → calldata → unsigned tx) lives in operator-side tooling.
- The phase-4 `src/broadcast/` modules will eventually be **demoted from daemon-internal to operator-side helpers** as part of HANDOFF item #2 (unsigned-tx on wire) — they stay in the repo as TypeScript exports for operators that want them, but not behind the public HTTP API.
- Daemon stays protocol-aware (BTC PSBT sighashes, OPNet interaction sighashes) but ABI-agnostic. Sighash computation = bytes-in, hash-out; never decode meaning.

### Federation trust model (2026-04-23)
- Federation members trust each other axiomatically. The system's value is *no key extraction is possible*; rogue insider's worst case is DoS, not theft. Compromising <t peers yields nothing.
- Per-node `PolicyGate` is **not anti-insider**. It defends against (a) **API-surface forgery** — external attacker breaches one daemon's HTTP, fans out triggers to t-1 auto-signing peers — and (b) **operational policy** (rate limits, business hours, allowlists). Both are local concerns; no centralized policy engine.
- Don't add cross-verification of leader-supplied data beyond what's needed for catching honest leader bugs. Ötzi co-signers also see only leader-supplied advisory metadata; headless matches that posture.

## Open items / gotchas

1. **FROST `PublicKeyPackage` reconstruction from V3 share file.** Persisted V3 share carries `frostKeyPackage` (full per-party `KeyPackage`); full `PublicKeyPackage` additionally needs the per-party `verifyingShares` map. Daemon currently accepts a pre-built `PublicKeyPackage` via `DaemonDeps.frostPublicKeyPackage` — meaning **no FROST signing works in a real deployment** without external injection. HANDOFF item #1: either derive the missing fields from `KeyPackage` (cheap, byte-compat preserved) or extend the share format to V4 (breaks Ötzi byte-compat; bump everywhere).

2. **Chain-watcher trigger (phase 5d deferral).** `kind: "chain-watcher"` isn't implemented; `Daemon` constructor throws if config contains one. Needs OPNet subscription plumbing — unclear design space until there's a concrete use case.

3. **Participant-side intent unavailable on the wire.** Announce payloads carry sighashes only — no representation of *what* is being signed. Participant-side `PolicyGate` with any rule set → strict-by-default rejects. **HANDOFF item #2 puts the full unsigned tx on the wire** (reframed from the earlier "intent metadata fields" approach), so participants decode + recompute the sighash + (in a follow-up) evaluate gate primitives against the decoded operation.

4. **Ring-rotation not implemented.** Once bootstrap is done, the ring is fixed. Adding/removing peers requires re-running bootstrap from scratch (`rm pubkeys.json identity.key; otzi setup …`). Documented UX limitation; acceptable for stable federations.

5. **Relay reconnect not implemented.** If the relay itself drops the WebSocket, daemons fail open — all connected peers marked disconnected, no reconnection attempt. Operator restart required. Simple exponential backoff could land as a future hardening.

6. **ML-DSA DKG phase-3 expected-senders** — pull from every distinct generator (not just generators of our own bitmasks), else `dkgPhase4` throws "Missing mask pieces from generator N". Handled in `src/core/dkg-session.ts::phase3ExpectedSenders`.

7. **`#N` retry suffix** requires `ceremonyId` to NOT contain `#`. Tighten with a check if ceremonyIds ever come from untrusted sources.

8. **Engine warnings on npm install.** `opnet@1.8.13` + some `@btc-vision/*` want Node 24+; we're on 22.19. Warnings only.

9. **Combine attempt cap.** `signAsLeader`'s `maxCombineAttempts` default is 50 (bumped from 5 after rejection-sampling exhaustion in tests). Seat-of-pants; TODO: empirical measurement at representative (t, n).

## Things NOT to do

- **Don't call `initEccLib(createNobleBackend())`** in any code path that imports `@btc-vision/transaction`. Phase-4d trap — burned ~2 testnet runs diagnosing. Entrypoint honors this.
- **Don't trust Ötzi's `backend/src/routes/btc.ts`** — its FROST sig BIP340 verify uses the untweaked key; we use `frostTweakedPubKey` for key-path.
- **Don't port Ötzi's React components** (`DKGWizard.tsx`, `ThresholdSign.tsx`, `FrostSign.tsx`, `SigningPage.tsx`). Read for protocol reference only.
- **Don't add a centralized policy engine** that duplicates threshold enforcement.
- **Don't put manifest parsing or ABI awareness in the daemon** — daemon = signing service, takes raw unsigned tx bytes only. Manifest/ABI logic lives in operator-side tooling (post-demotion `src/broadcast/`).
- **Don't add anti-insider verification to the gate** — federation trust is axiomatic. Gate is anti-API-forgery + operational policy only; cross-checking leader-supplied data beyond honest-bug-catching is out of scope.
- **Don't concurrent-decrypt** on a single `RecordSession` — the send and recv counters are strictly monotonic. Both transports serialize per-connection; preserve if touching.
- **Don't use `once('message')` as the sole handshake message consumer** — any frame arriving during the subsequent async setup will be lost. Use a `HandshakeQueue`-style persistent listener.
- **Don't force-close the bootstrap master** (`closeAllConnections`) after completion — graceful `server.close()` lets in-flight responses flush.
- **Don't rewrite relative imports in `src/wire/`** to add `.js` extensions — preserve Ötzi source-level byte-compat.
- **Don't register per-ceremony `servePulls` handlers** — `BlobServer` owns it daemon-wide.

## Quick commands

```bash
npm install            # install deps
npx tsc --noEmit       # typecheck
npx vitest run         # run full suite (takes ~30s with real-transport integration tests)
npx vitest             # watch mode

# Integration tests only (real WS + real relay, 3 daemons each):
npx vitest run src/daemon/daemon-integration.test.ts

# Debug-log transport events during an integration run:
OTZI_TEST_LOG=1 npx vitest run src/daemon/daemon-integration.test.ts
```
