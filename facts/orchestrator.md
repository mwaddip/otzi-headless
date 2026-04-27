# Contracts: src/orchestrator/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/orchestrator/

### `types.ts`
**Purpose:** Defines participant-side orchestrator and logger contracts; decouples ceremony outcomes and persistence sinks.

**Public surface:**
- `OrchestratorCeremonyKind`
  - Type: `'signing-mldsa' | 'signing-frost' | 'dkg-mldsa' | 'dkg-frost' | 'dkg-combined'`
  - **Pre:** None (discriminated union tag).
  - **Post:** Uniquely identifies ceremony class for tracker routing and outcome emission.

- `CeremonyOutcome` (discriminated union)
  - **Pre:** `baseCeremonyId` is set; `kind` matches one of the five types; `status` in `'done' | 'aborted' | 'timeout' | 'rejected'`.
  - **Post:** Outcome payload shape matches `kind`: signing outcomes carry signatures (hex) iff `status === 'done'`; DKG outcomes carry key material or empty.
  - **Throws:** Never (outcome is a pure data structure).

- `DkgPersistenceSink` (callback)
  - **Pre:** `result` is non-null `CombinedDkgResult`; `meta.threshold`, `meta.parties`, `meta.level` are positive integers.
  - **Post:** Persists the result to configured path; resolves on success, rejects on file I/O error.
  - **Throws:** `Promise<void>` rejection on mkdir/writeFile/chmod failure.
  - **Concurrency:** One write at a time per node (orchestrator awaits; leader awaits).

- `Logger`
  - **Pre:** All methods accept string message + optional metadata object.
  - **Post:** Methods return void; implementation decides whether to emit, buffer, or discard.
  - **Throws:** Never (caller must not depend on handler exceptions).

- `NOOP_LOGGER`
  - **Pre:** None (singleton).
  - **Post:** Every method is a no-op; safe default when no logging is desired.

- `OrchestratorDeps`
  - **Pre:** `transport.partyId === node.partyId`; `peersById` includes self; `share` and FROST packages either both present or both absent (signing vs DKG-only); `ceremonyDeadlines` are positive integers.
  - **Post:** Fully initializes a participant orchestrator; no lazy fields.
  - **Invariant:** `share` presence gates ML-DSA signing; `frostKeyPackage` + `frostPublicKeyPackage` presence gates FROST signing; both required for combined DKG (`network` set).

**Invariants:**
- `share` and FROST key material must be consistent: if share has `frostKeyPackage`, it MUST also be in `frostKeyPackage` param (or `node/opnet-client` re-derives it).
- `network` is only meaningful when producing `frostLegacySig` (combined DKG on mainnet/testnet); regtest passes `undefined`, key-link skipped.
- `frostLegacySig` is only valid after combined DKG runs; participant-side capture re-extracts it locally.
- Persistence sink errors on participant side do NOT abort the ceremony — DKG memory result is final.

**Cross-component contracts:**
- Depends on: `Transport`, `CeremonyRunner`, `ApprovalGate`, wire types (`DecryptedShare`, `KeyPackage`, etc.).
- Used by: `Orchestrator` (accepts as constructor arg).

**Notes / gotchas:**
- `share` can be undefined (DKG-only mode); all signing requests must check before dispatch.
- `frostLegacySig` must be hex-decoded from share file JSON by caller (not done here).
- Phase 5e: `persistDkgShare` was added; earlier phases had no participant persistence.

---

### `spec-builder.ts`
**Purpose:** Translates parsed announce messages into `CeremonySpec` for gate evaluation, extracting and verifying intent fields.

**Public surface:**
- `SpecBuilderCtx`
  - **Pre:** `fromPartyId` is the announce sender; `peersById` maps all party IDs to node names (includes self); `btcOutputs` populated iff BTC verify succeeded; `btcFrostP2tr` addresses the vault's own change-back address.
  - **Post:** Context carries verified decoding state + peer name resolution.

- `resolveLeaderId(from, peersById)`
  - **Pre:** `from` is a `PartyId`; `peersById` is the peer map.
  - **Post:** Returns node ID string from map, or stringified `PartyId` as fallback.
  - **Throws:** Never (fallback is always safe).

- `buildSpecFromAnnounce(msg, ctx)`
  - **Pre:** `msg` is one of five announce kinds (announce, announce-frost, announce-dkg, announce-frost-dkg, announce-combined-dkg); `ctx.peersById` is non-empty.
  - **Post:** Returns `CeremonySpec` with `kind` (`'signing' | 'dkg'`), `ceremonyId`, `leader`, `role: 'participant'`, and operation/protocol fields populated.
  - **Throws:** Never (all inputs are parsed by `parseCeremonyMessage`).
  - **FROST signing (announce-frost):** Populates `operation` based on `msg.protocol` (btc→btc-transfer, opnet→opnet-call, opnet-params→opnet-call); BTC outputs filtered to exclude self; `amount` + `destination` computed; OPNet raw-tx uses advisory hints; opnet-params carries structurally-verified contractAddress + method.
  - **Invariant:** Non-FROST announces always return `operation: 'generic'` (no intent fields).

**Invariants:**
- BTC outputs are STRUCTURALLY verified by orchestrator before spec-build; filtering self-address is safe.
- OPNet raw-tx hints are ADVISORY (federation-trust posture); only the sighash is trusted.
- OPNet opnet-params destination + method are STRUCTURALLY verified (participant re-ran capture locally); policy rules evaluate trusted data.
- `peersById` must not be empty; at minimum, self is always in it.

**Cross-component contracts:**
- Depends on: `CeremonyMessage` types, `PartyId`.
- Used by: `Orchestrator.evaluateGate()` after FROST verify succeeds.

**Notes / gotchas:**
- FROST verify happens upstream in orchestrator before `buildSpecFromAnnounce` is called — all BTC sighashes are already matched.
- `btcFrostP2tr` filtering is critical: without it, change-back to self would inflate `amount` + pollute `destination`.
- ML-DSA announce (announce) has no intent fields; `operation: 'generic'` is the only spec field besides ceremony metadata.

---

### `orchestrator.ts`
**Purpose:** Long-lived participant-side ceremony listener. Multiplexes announces/signoffs, verifies FROST sighashes, gates specs, dispatches ceremony runners, tracks outcomes.

**Public surface:**
- `Orchestrator` (class)
  - **Constructor(deps: OrchestratorDeps)**
    - **Pre:** `deps.transport` is started and listening for broadcasts; `deps.node.partyId === deps.transport.partyId`.
    - **Post:** Constructs internal state; does NOT call `transport.onBroadcast` or emit any events yet.

  - **start(): void**
    - **Pre:** Called exactly once (or after stop).
    - **Post:** Subscribes to `transport.onBroadcast`; listener is active for daemon lifetime.
    - **Invariant:** Reentrant (returns early if already started).

  - **stop(): void**
    - **Pre:** Called after start (or redundantly).
    - **Post:** Unsubscribes from transport; clears all ceremony trackers and timers; emits 'stopped' event to wake any pending `waitFor` calls.
    - **Invariant:** Reentrant (returns early if not started).

  - **onCompleted(handler): Unsubscribe**
    - **Pre:** Called at any time (before or after start).
    - **Post:** Registers a listener that fires on every ceremony outcome; returns an unsubscribe function.
    - **Throws:** Never (handler exceptions are NOT caught by orchestrator; caller must handle them).

  - **waitFor(baseCeremonyId, timeoutMs): Promise<CeremonyOutcome>**
    - **Pre:** Called before leader broadcasts the announce (or synchronously during onBroadcast).
    - **Post:** Resolves when ceremony settles (outcome emitted) or rejects on timeout / stop.
    - **Throws:** `Error` on timeout or orchestrator stopped before outcome.
    - **Concurrency:** Multiple waitFor calls for the same ceremony all resolve/reject together (single listener, shared promise).

- **Leader authentication**
  - **Pre:** First announce for a `baseCeremonyId` pins the sender as leader; all subsequent announces (including retries + signoff) MUST come from that peer.
  - **Post:** Non-leader announces for that ceremony are silently dropped (logged at warn level).
  - **Invariant:** Once pinned, leader cannot change for that ceremony.

- **Gate evaluation** (happens once per ceremony)
  - **Pre:** FROST verify succeeds (if applicable); spec is built.
  - **Post:** Gate decision is cached in tracker; retries (ML-DSA #N) skip re-evaluation.
  - **Invariant:** Gate errors are treated as reject; ceremony silent-drops.

- **FROST sighash verification** (`verifyFrostAnnounce`)
  - **Pre:** `announce.protocol` is one of `'btc' | 'opnet' | 'opnet-params' | 'keylink'`.
  - **Post:** Returns `{ ok: true, btcOutputs?, btcFrostP2tr? }` on success; `{ ok: false, reason }` on mismatch/error.
  - **btc (btcParams present):** Rebuilds tx via `buildBtcTxFromParams`, compares sighash array length, matches hashes. On mismatch: silent drop, logged at error level.
  - **opnet (unsignedTxHex + inputs):** Re-extracts sighashes via `extractBtcSighashes`, compares count + hashes. On mismatch: silent drop.
  - **opnet-params (opnetParams present):** Rebuilds refund address (theft check), re-runs deterministic capture, compares sighash hashes. On mismatch: silent drop.
  - **keylink:** Unverified (DKG state threading is a future plug-in); returns `ok: true` unconditionally.
  - **Invariant:** Missing key material (share, frost pkg, legacy sig, mnemonic, network) causes opnet-params to silent-drop (logged at error level).

- **Ceremony dispatch**
  - **ML-DSA signing:** Checks `announce.signers` includes self; verifies `deps.share` is present; launches `participateInSigning` task.
  - **FROST signing:** Checks signer set; verifies FROST key material; launches `participateInFrostSigning` task.
  - **ML-DSA DKG:** Derives sessionId; launches `participateInMldsaDkg`; settles on result or error.
  - **FROST DKG:** Launches `participateInFrostDkg`; settles on result or error.
  - **Combined DKG:** Passes `network` to spec if set; launches `participateInCombinedDkg`; calls `persistDkgShare` on success (best-effort, errors logged but don't abort).
  - **Invariant:** All inflight tasks are tracked; settling waits for none (fire-and-forget results in outcome signaling).

- **Signoff handling**
  - **Pre:** Leader broadcasts signoff-done / signoff-frost-done / signoff-aborted.
  - **Post:** Settles ceremony with the signoff outcome (abort → aborted, signoff-done → done with signature/batch).
  - **Invariant:** Signoff from non-leader is silently dropped (logged).

- **Ceremony settlement**
  - **Pre:** Outcome is being recorded.
  - **Post:** Clears deadline timer; removes tracker from ceremonies map; emits 'completed' event; logs at info level.
  - **Invariant:** `settled` flag prevents duplicate settlements.
  - **Deadline:** Fires on ceremony-kind specific timeout (signingMs, dkgMs from config); settles as 'timeout'.

**Invariants:**
- Orchestrator is a long-lived listener, NOT per-ceremony (unlike test helpers `orchestrateParticipant`).
- Gate decision is cached per baseCeremonyId; ML-DSA retries (#N suffixes) skip re-evaluation.
- Signoff always comes from the leader; participant never sends signoff.
- Participant cannot affect ceremony outcome; runner result (or timeout) drives settlement.
- Deadline is enforced per ceremony; timeout-based settlement prevents hung ceremonies from leaking resources.
- Silent drops (sighash mismatch, non-leader announce, gate non-approve) are indistinguishable from offline to peers.

**Cross-component contracts:**
- Depends on: `Transport.onBroadcast`, `CeremonyRunner.participate*`, `ApprovalGate.approve`, verify/rebuild functions.
- Used by: `Daemon` (instantiated once; orchestrator.onCompleted wired for logging).

**Notes / gotchas:**
- No ceremony execution happens if gate is non-approve; peer is silent.
- Ceremony timeout is the safety-net; crashed leaders cause participant-side timeout + settlement as 'timeout'.
- Phase 4d / 5c: key-link unverified in announce; DKG state threading needed for full verification.
- `buildOpnetParamsKeyMat()` returns undefined if any required field (share, frost pkg, legacy sig, mnemonic, network) is missing; opnet-params announce then silent-drops.
- FROST legacy sig is extracted from share during DKG and reused for all opnet-params verification; regeneration is not an option.

---

