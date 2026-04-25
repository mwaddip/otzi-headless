# Contracts: src/core/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/core/

### `types.ts`

**Purpose:** Shared type definitions for ceremony blobs and transport layer.

**Public surface:**
- `type PartyId = number`
  - **Pre:** 0-indexed integer; valid range is ceremony-specific (0 ≤ partyId < parties).
  - **Post:** Canonical party identifier within the ring.
  - **Concurrency:** Immutable type; no concurrency concerns.

- `const BROADCAST = undefined`
  - **Pre:** Singleton marker.
  - **Post:** Indicates broadcast blob (to field absent on BlobKey).

- `interface BlobKey`
  - **Pre:** `ceremonyId` must be non-empty string (no constraint on `#` suffix enforced here; upper layers handle retry numbering); `round` is semantic round name; `from` is valid PartyId in active ceremony; `to` is undefined for broadcast or valid target PartyId.
  - **Post:** Uniquely identifies a ceremony blob; invariant (ceremonyId, round, from, to) is unique per BlobStore.
  - **Concurrency:** Immutable data structure; safe for concurrent reads.

- `type Unsubscribe = () => void`
  - **Pre:** Returned from `onBroadcast` or `servePulls`; calling twice is explicitly idempotent.
  - **Post:** Handler is unregistered; subsequent calls are no-ops.

- `function blobKeyToString(key: BlobKey) → string`
  - **Pre:** Valid BlobKey.
  - **Post:** Stable string form suitable for Map keys or logging; `to` rendered as `'*'` when undefined.
  - **Concurrency:** Pure function; safe.

**Invariants:**
- PartyId is 0-indexed within the ring; conversion to FROST's 1-indexed bigint happens in wire layer.
- BlobKey tuples are globally unique per ceremony (no collisions across rounds or retries).

**Cross-component contracts:**
- Used by: Transport, BlobStore, BlobPuller, CeremonyRunner (exclusively).

---

### `transport.ts`

**Purpose:** Interface for pull-based peer communication; specifies authenticated peer-to-peer and broadcast channels.

**Public surface:**
- `interface Transport`
  - `readonly partyId: PartyId`
    - **Pre:** This daemon's 0-indexed identity, stable across daemon lifetime.
    - **Post:** Same value as provided at Transport creation.

  - `readonly peers: readonly PartyId[]`
    - **Pre:** Complete list of all ring members (including self), sorted (implied by callers).
    - **Post:** Immutable; stable across daemon lifetime; length is fixed N for all ceremonies on this daemon.

  - `broadcast(msg: Uint8Array) → Promise<void>`
    - **Pre:** `msg` is non-empty; caller treats as broadcast to all other peers (sender is implicit).
    - **Post:** Message is delivered to all other `partyId` on all peers' `onBroadcast` handlers with `from: this.partyId`.
    - **Throws:** On network failure or internal error; caller should treat as retryable or fatal depending on phase.
    - **Concurrency:** Safe to call concurrently; broadcast order is NOT guaranteed.
    - **Cross-component:** The sender's `from` is cryptographically authenticated; implementations MUST NOT forge `from` even in test harnesses (InMemoryTransport respects this).

  - `onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void) → Unsubscribe`
    - **Pre:** Handler is a new function; at most one handler per Transport (enforced by InMemoryTransport).
    - **Post:** Handler fires synchronously on each `broadcast` from any peer; unsubscribe is idempotent.
    - **Throws:** InMemoryTransport throws if a handler is already registered.

  - `pull(key: BlobKey) → Promise<Uint8Array | null>`
    - **Pre:** `key.from` is a valid peer in the ring; key identifies a blob expected to be produced by that peer.
    - **Post:** Returns blob bytes if peer has produced it; returns `null` if peer hasn't produced it yet (caller retries with backoff); throws if `key.from` is not in peers array.
    - **Throws:** On peer-not-found, network error, or other transport failure (retryable by caller).
    - **Concurrency:** Safe to call concurrently; null returns are interpreted as "not yet ready" (BlobPuller retries).

  - `servePulls(handler: (from: PartyId, key: BlobKey) → Uint8Array | null) → Unsubscribe`
    - **Pre:** Handler is a new function; at most one handler per Transport (enforced).
    - **Post:** Handler fires on each incoming `pull` request from a peer, returning the blob if this node has produced it (or `null` if not). Unsubscribe returns `null` for all subsequent pulls.
    - **Throws:** InMemoryTransport throws if a handler is already registered.
    - **Concurrency:** Handler may fire concurrently from multiple peer pull requests; should be thread-safe or use a lock.

**Invariants:**
- `from` in every broadcast/pull callback is authenticated (the peer genuinely sent the message).
- Test transports (InMemoryTransport) may bypass E2E encryption but MUST preserve authenticated-`from` semantics.
- Peers list is fixed for the daemon's lifetime; ceremonies do not add or remove peers mid-run.

**Cross-component contracts:**
- Used by: CeremonyRunner (broadcasts announcements, pulls blobs), BlobPuller (pulls blobs), BlobServer (serves stored blobs).
- Implemented by: InMemoryTransport (test harness), real transports in daemon (not in scope).

**Notes / gotchas:**
- `pull(key)` returning `null` does NOT indicate an error; it means the producer has not yet generated the blob. BlobPuller interprets null as "retry later with backoff."
- `servePulls` is registered once per daemon at startup; its lifetime is the daemon's, not a ceremony's. This allows a peer to serve blobs from completed ceremonies to lagging peers.

---

### `in-memory-transport.ts`

**Purpose:** Test-only Transport implementation; simulates an N-peer ring in a single process with synchronous dispatch.

**Public surface:**
- `function createInMemoryRing(peers: readonly PartyId[]) → Map<PartyId, Transport>`
  - **Pre:** `peers` is a sorted array of valid PartyIds (0-indexed, no gaps, e.g., [0,1,2] for 3-party ring).
  - **Post:** Returns a Map from partyId to an InMemoryTransport instance; each transport's broadcast and pull target the others in the ring synchronously.
  - **Throws:** On invalid partyId ranges or duplicates (no validation shown; callers must provide valid input).
  - **Concurrency:** Shared references in the ring; no mutex; NOT intended for multi-threaded test harnesses.

- `class InMemoryTransport implements Transport`
  - **Pre:** Constructed via `createInMemoryRing`; partyId and peers provided at construction.
  - **Post:** Transport methods dispatch synchronously to peer instances in the shared ring Map.
  - **Memory:** Each transport holds references to the entire ring; no cleanup needed per ceremony.
  - **Invariants:**
    - At most one `pullHandler` per transport.
    - Broadcasts route to all other peers (partyId check prevents self-delivery).
    - Pull requests go directly to the target peer's `servePull` method (no async wrapping, no null-then-wait).

**Cross-component contracts:**
- Used by: tests that exercise ceremony mechanics without real networking.
- Depends on: InMemoryTransport shared ring Map (circular reference; OK for test harness).

**Notes / gotchas:**
- Synchronous dispatch means tests can deadlock if a handler calls transport methods during event processing.
- No simulated latency or loss; test assertions must not rely on timing or retries.

---

### `blob-store.ts`

**Purpose:** In-memory immutable blob storage; enforces idempotent-on-equal / conflict-on-differ semantics.

**Public surface:**
- `class BlobStore`
  - **Pre:** Created fresh per daemon (not per ceremony); lives as long as the daemon.
  - **Post:** Owns a Map of (BlobKey.string → {key, blob}) entries; fires observers on put.

  - `put(key: BlobKey, blob: Uint8Array) → void`
    - **Pre:** BlobKey and Uint8Array are fresh; if key already exists, blob MUST be byte-identical (idempotent) or it's a protocol violation.
    - **Post:** Blob is stored; if byte-equal to existing entry, fires no observer (idempotent no-op); if byte-differ, throws immediately.
    - **Throws:** `Error("Conflicting blob for ${keyStr}")` if re-putting different bytes under the same key. Caller (CeremonyRunner or BlobPuller) should treat as ceremony-fatal and abort.
    - **Concurrency:** NOT thread-safe; assumes single-threaded ceremony runner or external serialization.
    - **Idempotency:** Putting identical bytes is a no-op (no observer fire, no exception).

  - `get(key: BlobKey) → Uint8Array | undefined`
    - **Pre:** BlobKey is well-formed.
    - **Post:** Returns stored blob or undefined if absent; returned Uint8Array is a reference (caller MUST treat as immutable).
    - **Throws:** Never.
    - **Concurrency:** Safe for concurrent reads.

  - `has(key: BlobKey) → boolean`
    - **Pre:** BlobKey is well-formed.
    - **Post:** Returns true if blob is in store.
    - **Concurrency:** Safe for concurrent reads.

  - `list(ceremonyId: string, round?: string) → Array<{key: BlobKey; blob: Uint8Array}>`
    - **Pre:** ceremonyId is non-empty; optional round filters results.
    - **Post:** Returns all blobs for the ceremony (optionally filtered to one round); returns copies of the blob references (callers MUST not mutate).
    - **Concurrency:** Safe for concurrent reads.

  - `onPut(handler: (key: BlobKey) => void) → Unsubscribe`
    - **Pre:** Handler is a new function.
    - **Post:** Handler fires after each successful put that is NOT an idempotent no-op (byte-equal existing entry). Unsubscribe is idempotent.
    - **Concurrency:** Handlers fire synchronously during put; do not call store methods from handlers.

  - `clear(ceremonyId: string) → void`
    - **Pre:** ceremonyId identifies an in-flight or completed ceremony.
    - **Post:** Deletes all blobs for that ceremony; does NOT fire observers (cleanup-only).
    - **Concurrency:** Safe if called once per ceremony at end-of-life.

**Invariants:**
- Each (ceremonyId, round, from, to) key is unique; re-putting triggers conflict check.
- Idempotency on byte-equality ensures eventual consistency (same blob pulled twice is a no-op).
- Byte references are not copied; callers MUST treat get() results as read-only.

**Cross-component contracts:**
- Depends on: BlobKey type (from types.ts).
- Used by: CeremonyRunner (stores produced blobs, pulls and stores received blobs), BlobPuller (stores pulled blobs), BlobServer (queries get for serving).
- Wire format: blobs are JSON-encoded round results (wire/threshold.ts, wire/dkg.ts formatters).

**Notes / gotchas:**
- NOT thread-safe; ceremony runner must serialize blob operations or use external locks.
- Conflict detection is exact byte comparison; different encodings of the same data are treated as conflicts (by design — wire codecs MUST be deterministic).
- `onPut` observers fire synchronously during put; blocking or reentering is unsafe.

---

### `blob-server.ts`

**Purpose:** Long-lived bridge from Transport.servePulls to BlobStore; decouples blob availability from ceremony lifetime.

**Public surface:**
- `class BlobServer`
  - **Pre:** Constructed at daemon startup with a Transport and BlobStore (both long-lived).
  - **Post:** Registers a pull handler that serves any blob in the store; lifetime is the daemon's, not a ceremony's.
  - **Memory:** Holds a reference to the pull-handler unsubscriber (stored as `off`).

  - `constructor(transport: Transport, store: BlobStore)`
    - **Pre:** transport and store are both live; at most one BlobServer per daemon (enforced by Transport.servePulls).
    - **Post:** Registers the pull handler; handler looks up keys in the store and returns the blob or null.
    - **Throws:** If transport already has a pull handler registered (InMemoryTransport throws).

  - `close() → void`
    - **Pre:** BlobServer is live (not already closed).
    - **Post:** Unregisters the pull handler; subsequent pulls return null.
    - **Concurrency:** Safe to call once at daemon shutdown.

**Invariants:**
- The pull handler serves blobs from store.get(key) with fallback to null (key not in store).
- BlobServer lifetime decouples blob availability from ceremony completion: a peer that finishes can still serve its blobs to lagging peers (important for federation fault tolerance).

**Cross-component contracts:**
- Depends on: Transport.servePulls, BlobStore.get.
- Used by: daemon lifecycle (created at startup, closed at shutdown).

**Notes / gotchas:**
- BlobServer is a passive bridge; it does NOT actively push blobs or clean up old ceremonies. The daemon must manually call store.clear(ceremonyId) for memory management.
- The pull handler is registered once per daemon; it serves all ceremonies that have run on that daemon.

---

### `blob-puller.ts`

**Purpose:** Fetches expected blobs from their producers into BlobStore with exponential backoff retry.

**Public surface:**
- `interface PullOpts`
  - **Fields:**
    - `maxAttempts: number` — max pull tries per key before giving up.
    - `initialDelayMs: number` — initial backoff after null-return (doubled each retry up to maxDelayMs).
    - `maxDelayMs: number` — cap on backoff delay.
    - `deadlineMs: number` — wall-clock deadline from `pullAll` start.
  - **Pre:** All fields must be positive; typically maxAttempts ≥ 10, initialDelayMs = 100, maxDelayMs = 5000, deadlineMs = 30000.
  - **Post:** Passed to `pullAll`; controls retry behavior and timeout.

- `class BlobPuller`
  - **Pre:** Constructed with Transport and BlobStore (long-lived).
  - **Post:** Provides `pullAll` method for parallel blob fetches.

  - `async pullAll(expected: readonly BlobKey[], opts: PullOpts) → Promise<void>`
    - **Pre:** `expected` is a non-empty array of BlobKeys (each with a valid producer in transport.peers); opts are well-formed.
    - **Post:** Resolves when all blobs are in store. Each blob is fetched by a parallel worker (Promise.all).
    - **Throws:**
      - `Error("Failed to fetch ${keyStr} after ${maxAttempts} attempts")` if a key is not found after maxAttempts retries.
      - `Error("Deadline exceeded while pulling ${keyStr}")` if wall-clock deadline fires before all blobs are fetched.
    - **Concurrency:** Parallel per-key workers; safe.
    - **Abort semantics:** Uses AbortController to cancel all workers when wall-clock deadline fires.

  - `private async pullOne(key: BlobKey, opts: PullOpts, signal: AbortSignal) → Promise<void>`
    - **Pre:** key is valid; signal is from AbortController.
    - **Post:** Pulls key from transport.pull(key) with exponential backoff; stores blob if not already in store (double-check avoids race).
    - **Throws:** On exhausted attempts or deadline.
    - **Backoff:** delay starts at opts.initialDelayMs, doubles on each null-return (capped at opts.maxDelayMs), does NOT backoff after successful pull or conflict.
    - **Idempotency check:** If blob lands in store by another path (parallel worker or local production), pullOne short-circuits (store.has check).

**Invariants:**
- Per-key workers retry independently; a deadline fires for all.
- Wall-clock deadline is enforced via AbortController; once fired, all pending pulls reject.
- Blobs stored via pullAll.put are idempotent (store.put checks byte-equality); a conflict is a protocol violation that propagates.

**Cross-component contracts:**
- Depends on: Transport.pull, BlobStore.get/put/has.
- Used by: CeremonyRunner (pulls round results between phases).
- Error propagation: transport.pull throws are immediately fatal; BlobStore.put conflicts are ceremony-fatal.

**Notes / gotchas:**
- `maxAttempts` is per-key, not total; if a key takes 10 attempts and deadline fires after attempt 5, the deadline takes precedence.
- Deadline is wall-clock; sleep delays are interruptible via AbortSignal race.
- Initial delay should be tuned per deployment (100ms for local tests, 500ms+ for real networks).

---

### `ceremony-messages.ts`

**Purpose:** Wire protocol for ceremony control messages (broadcasts, not blobs); defines message shapes, encoding/parsing, helpers.

**Public surface:**
- `type CeremonyMessage = { v: 1; kind: 'announce' | 'announce-frost' | ... }`
  - **Pre:** Exhaustive union of all ceremony control message types.
  - **Post:** Marshals to JSON; `v: 1` is version marker.
  - **Kinds:**
    - `announce` — ML-DSA signing attempt with optional `#N` retry suffix.
    - `announce-frost` — FROST signing with construction data (btc/opnet/opnet-params/keylink protocol).
    - `announce-dkg`, `announce-frost-dkg`, `announce-combined-dkg` — symmetric DKG initiations.
    - `signoff-done`, `signoff-frost-done` — leader success signoffs.
    - `signoff-aborted` — leader abort.

- `function encodeCeremonyMessage(msg: CeremonyMessage) → Uint8Array`
  - **Pre:** Message is well-formed CeremonyMessage.
  - **Post:** JSON-stringified + UTF-8 encoded.
  - **Concurrency:** Pure function; safe.

- `function parseCeremonyMessage(bytes: Uint8Array) → CeremonyMessage | null`
  - **Pre:** bytes are UTF-8 JSON (may be truncated or malformed).
  - **Post:** Parses and validates shape; returns null on any parse or validation error (soft error, not thrown — matches federation-trust posture: ignore bad announces).
  - **Throws:** Never; invalid messages are silently dropped.
  - **Validation:** v=1, discriminant kind, all required fields present and well-typed.

- **Announce variants:**

  - `announce` (ML-DSA signing)
    - **Pre:** `messageHex` is even-length hex string (message bytes); `signers` is non-empty array of valid PartyIds.
    - **Post:** Wire shape with `ceremonyId` (may include `#N` retry suffix), `baseCeremonyId` (stable across retries), `messageHex`, `signers`.
    - **Factory:** `announceMessage(ceremonyId, baseCeremonyId, message: Uint8Array, signers) → CeremonyMessage`

  - `announce-frost` (FROST signing with protocol)
    - **Pre:** `sighashes` is array of {hashHex (32B hex), tweaked (bool)}; `signers` is active signer set; `extras: AnnounceFrostExtras` specifies protocol (btc/opnet/opnet-params/keylink).
    - **Post:** Base message + protocol-specific construction data.
    - **Protocols:**
      - `btc` — `btcParams` with to/amount/feeRate/network/frostP2tr/utxos. Participants rebuild tx and verify sighashes.
      - `opnet` — `unsignedTxHex` + `inputs[]` + optional `hints`. Participants re-extract sighashes from tx bytes.
      - `opnet-params` — `opnetParams: AnnounceOpnetParams` (full UTXO/challenge/random-seed payload for deterministic `captureOpnetSighashes` rebuild).
      - `keylink` — `network` (mainnet/testnet). Participants sign the OPNet SDK key-link hash.
    - **Factory:** `announceFrostMessage(ceremonyId, baseCeremonyId, sighashes[], signers, extras) → CeremonyMessage`
    - **Dummy for testing:** `makeDummyFrostKeylinkExtras(network) → AnnounceFrostKeylinkExtras`

  - `announce-dkg`, `announce-frost-dkg`, `announce-combined-dkg` (DKG)
    - **Pre:** `sessionIdHex` is 64-char hex (32 bytes); `threshold ≤ parties`; `level` is ML-DSA security level (44/65/87 for combined-dkg).
    - **Post:** Initiator broadcasts sessionId; participants extract it and run DKG with matching params.
    - **Factories:** `announceDkgMessage`, `announceFrostDkgMessage`, `announceCombinedDkgMessage`
    - **Extractors:** `sessionIdFromAnnounceDkg`, etc., decode sessionIdHex back to Uint8Array.

  - `signoff-done` (ML-DSA success)
    - **Pre:** `signatureHex` is even-length hex (FIPS 204 signature).
    - **Post:** Leader broadcasts after combine succeeds; participants release state on receipt.
    - **Factory:** `signoffDoneMessage(baseCeremonyId, signature: Uint8Array) → CeremonyMessage`

  - `signoff-frost-done` (FROST success)
    - **Pre:** `signaturesHex[]` is array of hex-encoded 64-byte BIP340 sigs (one per sighash, ceremony order).
    - **Post:** Leader broadcasts after aggregate; carries all N signatures for audit.
    - **Factory:** `signoffFrostDoneMessage(baseCeremonyId, signatures: Uint8Array[])`

  - `signoff-aborted` (any failure)
    - **Pre:** `baseCeremonyId` identifies the ceremony; optional `reason` is human-readable cause.
    - **Post:** Leader broadcasts on exhausted retries or unrecoverable error; participants release state.
    - **Factory:** `signoffAbortedMessage(baseCeremonyId, reason?)`

- **OPNet params (AnnounceOpnetParams):**
  - **Fields:**
    - `contractAddress`, `method` — target contract + 4-byte selector (STRUCTURALLY-verified on SigningSpec, so policy rules can gate).
    - `params[]` — pre-conversion constructor args (JSON-safe types).
    - `refundAddress`, `feeRate`, `priorityFeeSat`, `maxSatToSpendSat` — OPNet tx params.
    - `randomBytesSeedHex` — 32-byte random seed for deterministic `BitcoinUtils.rndBytes()` during sighash capture.
    - `utxos[]` — `AnnounceOpnetUtxoRaw` (transactionId, outputIndex, value, scriptPubKey) in raw IUTXO form.
    - `challenge` — `ChallengeSolution.toRaw()` pass-through object.
    - `mldsaThresholdSignatureHex` — ML-DSA sig over `sha256(calldata)` (outer OPNet tx auth; operator pre-computes via `/sign scheme='mldsa'` ceremony, leader asserts, participants consume during capture).
    - `hints?` — advisory contractAddress/method/amountTokenAtomic (unlike opnet-params, these are not STRUCTURALLY-verified; legacy compatibility).
  - **Validation:** Structural validation only (field types); `challenge` is checked at reconstruction time (soft error).
  - **Parse / encode:** `parseOpnetParams`, `encodeOpnetParams` (internal helpers).

**Invariants:**
- Wire messages are JSON-safe (no binary encoding); byte-stability relies on canonical JSON encoding.
- `ceremonyId` may carry `#N` suffix (leader-driven retries); `baseCeremonyId` is stable across retries (used for aggregate-level bookkeeping).
- `from` (sender) is implicit in transport callback; message contains only content, not sender.
- Parse errors silently drop messages (federation-trust posture: assume honest peers, ignore garbage).
- OPNet params `challenge` is pass-through; malformed challenge is caught at `new ChallengeSolution(raw)` during rebuild (soft drop).

**Cross-component contracts:**
- Depends on: types.ts (PartyId), wire/hex.ts (toHex/fromHex).
- Used by: CeremonyRunner (constructs announcements + signoffs), ceremony trigger layer (parses announcements to decide participation).
- Wire format: JSON over UTF-8; no compression, no encryption (transport layer handles E2E encryption).

**Notes / gotchas:**
- `ceremonyId` field in announce carries the `#N` suffix for a retry; `baseCeremonyId` is the stable root (participants should listen on base, switch to #N only when announce fires).
- FROST keylink uses round names `frost-keylink-r1`/`r2` to avoid collision with regular FROST signing rounds (same ceremony can't run both).
- `opnet-params` protocol is for deterministic rebuild; `opnet` is advisory (legacy); policy rules MUST gate on contractAddress/method from opnet-params, NOT from opnet hints.
- `mldsaThresholdSignatureHex` in opnet-params is asserted but not verified by orchestrator (operator pre-computed, doS-safe by federation trust).

---

### `ceremony-runner.ts`

**Purpose:** Drives all ceremony protocols (ML-DSA signing, FROST signing, DKG variants) end-to-end; implements leader/participant asymmetry for signing, symmetric protocols for DKG.

**Public surface:**

- **Specs (input types):**

  - `interface SigningSpec`
    - **Fields:**
      - `ceremonyId: string` — stable ID (may include `#N` for retries in runner state; base ID used for signoff).
      - `message: Uint8Array` — bytes to sign (e.g., SHA256(data)).
      - `signers: PartyId[]` — active signer set (size = threshold); MUST include this daemon's partyId.
      - `share: DecryptedShare` — this daemon's ML-DSA key share (from DKG or dealer).
    - **Pre:** `signers` is non-empty, sorted, all valid; partyId is in signers.
    - **Post:** Passed to signAsLeader or participateInSigning.

  - `interface FrostSigningSpec`
    - **Fields:**
      - `ceremonyId: string` — unique ceremony ID (no retries; FROST combine is deterministic).
      - `sighashes: readonly FrostSighash[]` — array of {hash (32B), tweaked (bool)}; canonical input order.
      - `signers: PartyId[]` — active signer set (size = minSigners); MUST include partyId.
      - `keyPackage: KeyPackage` — this daemon's FROST signing key (from DKG).
      - `publicKeyPackage: PublicKeyPackage` — shared group material (identical across all signers).
      - `rng: Rng` — CSPRNG for nonce generation.
    - **Pre:** `sighashes` non-empty; `keyPackage` and `publicKeyPackage` DKG-derived and consistent.
    - **Post:** Passed to signFrostAsLeader or participateInFrostSigning.

  - `interface MldsaDkgSpec`
    - **Fields:** `ceremonyId`, `threshold`, `parties`, `level` (ML-DSA security level).
    - **Pre:** `0 < threshold ≤ parties`; `level ∈ {44, 65, 87}`; partyId < parties.
    - **Post:** Passed to runMldsaDkg or participateInMldsaDkg.

  - `interface FrostDkgSpec`
    - **Fields:** `ceremonyId`, `threshold`, `parties`, `rng`.
    - **Pre:** `0 < threshold ≤ parties`; partyId < parties.
    - **Post:** Passed to runFrostDkg or participateInFrostDkg.

  - `interface CombinedDkgSpec`
    - **Fields:** `ceremonyId`, `threshold`, `parties`, `level`, `rng`, `network?` (for optional key-link signing).
    - **Pre:** `0 < threshold ≤ parties`; `level` valid.
    - **Post:** Runs ML-DSA DKG then FROST DKG under one sessionId; optionally runs n-of-n FROST key-link sign if network is set.

  - `interface CombinedDkgResult`
    - **Fields:** `mldsa: DKGResult`, `frost: {keyPackage, publicKeyPackage}`, `frostLegacySig?: Uint8Array`.
    - **Post:** Returned by runCombinedDkg / participateInCombinedDkg; contains both key materials + optional key-link sig.

- **ML-DSA Signing (asymmetric):**

  - `async signAsLeader(spec: SigningSpec, opts: PullOpts, maxCombineAttempts = 50) → Promise<Uint8Array>`
    - **Pre:** `spec.partyId` (implicit, from transport) is in spec.signers; spec.message non-empty; opts well-formed.
    - **Post:** Returns FIPS 204 signature on success; broadcasts announce per attempt (base ID + `#N` suffix on retry), drives 3 rounds (R1/R2/R3), runs combine, retries on null (up to maxCombineAttempts), broadcasts signoff-done on success.
    - **Throws:** `Error("Signing aborted: <reason>")` on exhausted retries or unrecoverable error; broadcasts signoff-aborted before throwing.
    - **Concurrency:** Single-threaded; leader must not be called concurrently.
    - **Retry behavior:** After each combine attempt, if result is null (rejection-sampling), ceremony ID gets `#N` suffix (e.g., `base#2`); participants watch `baseCeremonyId` and switch to new announce.
    - **Blob production:** Leader produces R1/R2/R3 locally via round1/round2/round3; pulls R1 and R2 from active signers; runs combine on R3.
    - **Signoff:** After combine succeeds, caller broadcasts the tx upstream, then calls `sendSigningDoneSignoff` to release participant state (TTL is safety net).

  - `async participateInSigning(spec: SigningSpec, opts: PullOpts) → Promise<void>`
    - **Pre:** `spec.partyId` in spec.signers; spec non-empty.
    - **Post:** Produces R1/R2/R3 blobs locally, pulls R1 and R2 from other active signers, adds them to session, destroys session on return.
    - **Throws:** On pull timeout or blob rejection.
    - **Concurrency:** Single-threaded per daemon; participants run reactively (one per announcement).
    - **Non-operations:** Participant does NOT pull R3 from others, does NOT run combine (leader-only).

  - `async sendSigningDoneSignoff(baseCeremonyId: string, signature: Uint8Array) → Promise<void>`
    - **Pre:** Called after signAsLeader succeeds and tx is broadcast.
    - **Post:** Broadcasts signoff-done message with signature; releases participant state immediately.
    - **Concurrency:** Safe to call from leader context.

- **FROST Signing (asymmetric, no retry):**

  - `async signFrostAsLeader(spec: FrostSigningSpec, opts: PullOpts, announceExtras: AnnounceFrostExtras) → Promise<Uint8Array[]>`
    - **Pre:** `spec.partyId` in spec.signers; `announceExtras` is valid construction data (btc/opnet/opnet-params/keylink).
    - **Post:** Broadcasts announce (no retries), drives R1+R2, aggregates N BIP340 sigs (one per sighash), returns sigs array (ceremony order).
    - **Throws:** `Error("FROST signing aborted: <reason>")` on any failure; broadcasts signoff-aborted.
    - **Concurrency:** Single-threaded.
    - **Determinism:** FROST combine always succeeds (no rejection sampling); single attempt guaranteed.

  - `async participateInFrostSigning(spec: FrostSigningSpec, opts: PullOpts) → Promise<void>`
    - **Pre:** `spec.partyId` in spec.signers.
    - **Post:** Produces R1+R2, pulls R1+R2 from other signers, does NOT aggregate (leader-only).
    - **Throws:** On pull timeout or blob rejection.

  - `async sendFrostSigningDoneSignoff(baseCeremonyId: string, signatures: ReadonlyArray<Uint8Array>) → Promise<void>`
    - **Pre:** Called after signFrostAsLeader succeeds.
    - **Post:** Broadcasts signoff-frost-done with all sigs; releases participant state.

- **ML-DSA DKG (symmetric, no leader):**

  - `async runMldsaDkg(spec: MldsaDkgSpec, opts: PullOpts) → Promise<DKGResult>`
    - **Pre:** `spec.partyId` < spec.parties; threshold/parties valid.
    - **Post:** Generates sessionId, broadcasts announce-dkg, runs 5-phase protocol (P1/P2-pub/P2-priv/P3/P4), returns own DKGResult (share + pubkey).
    - **Throws:** `Error("MLDSA DKG aborted: <reason>")` on failure.
    - **Concurrency:** Single-threaded.
    - **Initiator role:** The peer whose trigger fired generates sessionId; others discover it via announce and call participateInMldsaDkg. No mid-ceremony coordinator.

  - `async participateInMldsaDkg(spec: MldsaDkgSpec, sessionId: Uint8Array, opts: PullOpts) → Promise<DKGResult>`
    - **Pre:** `sessionId` extracted from received announce-dkg message (must be 32 bytes).
    - **Post:** Runs the same 5-phase protocol with the asserted sessionId; returns own DKGResult.
    - **Throws:** Same abort semantics.

- **FROST DKG (symmetric, no leader):**

  - `async runFrostDkg(spec: FrostDkgSpec, opts: PullOpts) → Promise<{keyPackage, publicKeyPackage}>`
    - **Pre:** spec valid; partyId < parties.
    - **Post:** Generates sessionId, broadcasts announce-frost-dkg, runs 3-round protocol (R1/R2/finalize), returns local key material.
    - **Throws:** `Error("FROST DKG aborted: <reason>")`

  - `async participateInFrostDkg(spec: FrostDkgSpec, sessionId: Uint8Array, opts: PullOpts) → Promise<{keyPackage, publicKeyPackage}>`
    - **Pre:** sessionId from announce-frost-dkg (32 bytes).
    - **Post:** Runs protocol with asserted sessionId.
    - **Throws:** Same abort semantics.

- **Combined DKG (symmetric, single sessionId, optional key-link signing):**

  - `async runCombinedDkg(spec: CombinedDkgSpec, opts: PullOpts) → Promise<CombinedDkgResult>`
    - **Pre:** spec valid; partyId < parties; if spec.network is set, OPNet SDK is available (for key-link hash computation).
    - **Post:** Generates sessionId, broadcasts announce-combined-dkg, runs ML-DSA DKG then FROST DKG under one sessionId. If spec.network is set, also runs n-of-n FROST sign over `computeKeyLinkHash(...)` and includes `frostLegacySig` in result.
    - **Throws:** `Error("Combined DKG aborted: <reason>")`
    - **Key-link signing (phase 2.5c):** All peers participate in n-of-n sign (signers = [0..N-1]); deterministic aggregate produces the same sig everywhere. Sig is what OPNet SDK replays via `withFrostLegacySig` during V3-vault contract calls.

  - `async participateInCombinedDkg(spec: CombinedDkgSpec, sessionId: Uint8Array, opts: PullOpts) → Promise<CombinedDkgResult>`
    - **Pre:** sessionId from announce-combined-dkg.
    - **Post:** Runs combined protocol; includes key-link sig if spec.network was set.

**Invariants:**

- **Asymmetry contract (signing):** Leader drives all 3 rounds and runs combine (sole producer of final sig); participants produce R1/R2/R3 but do NOT pull R3 from others or combine.
- **Symmetry contract (DKG):** All peers run the same phases end-to-end; initiator only names the peer whose trigger fired; no coordinator.
- **Idempotency:** Blobs stored via store.put are idempotent (store checks byte-equality); pulling the same blob twice is a no-op.
- **Retry naming:** ML-DSA signing uses `#{N}` suffix on ceremonyId (base ID `foo` becomes `foo#2` on second attempt); participants watch baseCeremonyId and switch rounds on new announce.
- **Blob round names:** ML-DSA: `mldsa-r1/r2/r3`; FROST: `frost-sign-r1/r2`; FROST DKG: `frost-dkg-r1/r2`; Key-link FROST: `frost-keylink-r1/r2` (distinct from regular FROST to avoid collision).
- **Session destruction:** Every session (ML-DSA, FROST, DKG) is destroyed in finally block; destruction clears all state and marks destroyed=true to prevent re-entry.

**Cross-component contracts:**

- Depends on: Transport (broadcast, pull), BlobStore (put, get, has), BlobPuller (pullAll with backoff), ceremony-messages (encode/parse/factories), wire codecs (threshold, dkg, frost-dkg, frost-sign), DKG session modules (dkg-session, frost-dkg-session, frost-sign-session).
- Used by: daemon trigger layer (listens for announcements, invokes run*/participate* methods), human operators (via CLI).
- Memory: Sessions are short-lived (per ceremony attempt); store and transport are long-lived (daemon lifetime).

**Notes / gotchas:**

- **Retry loop (ML-DSA signing):** Leader retries up to maxCombineAttempts; each attempt gets a new `#N` suffix (ceremony ID becomes foo#1, foo#2, etc., but baseCeremonyId stays foo). Participants watch baseId and react to new announces; they must pull and process each retry independently.
- **Keylink phase:** After combined DKG finishes, all peers run n-of-n FROST sign with all N parties as signers (not just threshold). Output is deterministic; all parties get the same sig. This sig is what the OPNet SDK replays.
- **Pull blocking:** Pulling is reactive; participants block on pullAll until deadline. Leader must poll for R1/R2/R3 as participants produce them.
- **Blob conflicts:** If a blob re-put with different bytes, store.put throws; runner catches and converts to ceremony abort.
- **Unrecoverable errors:** Transport throws, blob rejection, or decode errors are caught as strings and broadcast in signoff-aborted before throwing.

---

### `dkg-session.ts`

**Purpose:** ML-DSA DKG session wrapper; implements 5-phase symmetric protocol (P1/P2/P2-finalize/P3/P4).

**Public surface:**

- `interface MldsaDkgSession`
  - **Read-only fields:** `partyId`, `sessionId` (32B), `threshold`, `parties`, `level`, `instance` (ThresholdMLDSA), `setup` (DKGSetupResult).
  - **Mutable fields:** phase state (phase1State, myPhase1Broadcast, collectedPhase1, ..., collectedPhase4, result, destroyed).
  - **Invariants:** Only one peer produces each broadcast/private blob per phase; destroyed flag blocks re-entry.

- `function createSession(input: CreateMldsaDkgSessionInput) → MldsaDkgSession`
  - **Pre:** `partyId ∈ [0, parties)`; `0 < threshold ≤ parties`; `sessionId.length === 32`; `level ∈ {44, 65, 87}`.
  - **Post:** Session object initialized; all state maps empty, result/destroyed false.
  - **Throws:** On invalid range or sessionId length.

- **Phase 1 (commitment broadcast):**

  - `function phase1(session) → string`
    - **Pre:** Session live (not destroyed); phase1 not already run.
    - **Post:** Calls `instance.dkgPhase1`, stores state and broadcast, adds own broadcast to collected, returns encoded broadcast string.
    - **Throws:** On destroyed or re-entry.

- **Phase 2 (public reveal broadcast + private reveals to holder-mates):**

  - `function phase2(session) → string`
    - **Pre:** phase1 run; all N phase1 broadcasts collected.
    - **Post:** Calls `instance.dkgPhase2` with sorted P1 list, stores broadcast and per-recipient private map, returns encoded broadcast.
    - **Throws:** If phase1 not run or missing any phase1 broadcasts.

  - `function phase2PrivateForTarget(session, toPartyId) → string | null`
    - **Pre:** phase2 run.
    - **Post:** Returns encoded private reveal for toPartyId (holder-mate) or null if none.

  - `function phase2Recipients(session) → PartyId[]`
    - **Pre:** phase2 run.
    - **Post:** Returns parties (excluding self) who should receive phase2 private blobs, sorted.

  - `function phase2ExpectedSenders(session) → PartyId[]`
    - **Pre:** Session created (setup available).
    - **Post:** Returns parties (excluding self) from whom phase2 private reveals are expected (symmetric: j sends me iff j and I share ≥1 bitmask). No pulling needed; computable from setup.holdersOf.

  - `function phase2Finalize(session) → void`
    - **Pre:** phase1 run; all N phase2-pub broadcasts collected; all expected phase2 privates collected.
    - **Post:** Calls `instance.dkgPhase2Finalize` locally; stores result (used to produce P3 blobs).

- **Phase 3 (targeted masks to every other generator):**

  - `function phase3PrivateForTarget(session, toPartyId) → string | null`
    - **Pre:** phase2Finalize run.
    - **Post:** Returns encoded phase3 private for toPartyId (generator assignment) or null if none.

  - `function phase3Recipients(session) → PartyId[]`
    - **Pre:** phase2Finalize run.
    - **Post:** Returns parties (excluding self) to send P3 privates to, sorted.

  - `function phase3ExpectedSenders(session) → PartyId[]`
    - **Pre:** phase2Finalize run.
    - **Post:** Returns distinct generators (excluding self) from whom P3 privates are expected. May be < N if some generators are repeated.

- **Phase 4 (aggregate broadcast):**

  - `function phase4(session) → string`
    - **Pre:** All N phase1 broadcasts, all phase2-pub broadcasts, all expected phase3 privates collected; phase2Finalize run.
    - **Post:** Calls `instance.dkgPhase4` with all inputs, stores broadcast, returns encoded broadcast.
    - **Throws:** On missing phase3 privates.

- **Finalize (derive own share + public key):**

  - `function finalize(session) → DKGResult`
    - **Pre:** All N phase4 broadcasts collected; phase2Finalize run.
    - **Post:** Calls `instance.dkgFinalize`, caches result, returns DKGResult (own ThresholdKeyShare + aggregate pubkey).
    - **Throws:** On missing phase4 broadcasts or phase2Finalize not run.
    - **Idempotency:** If called multiple times, returns cached result.

- **Blob ingestion (adds received blobs to state):**

  - `function addBlob(session, blob: string, round: DkgRound) → {ok: boolean; error?: string}`
    - **Pre:** blob is properly encoded/formatted; round ∈ {p1, p2-pub, p2-priv, p3, p4}.
    - **Post:** Decodes blob, validates sender partyId, checks for duplicates, stores in appropriate map, returns {ok: true} or {ok: false; error: reason}.
    - **Soft errors:** Returns {ok: false} on bad format or duplicate (NOT thrown); caller decides whether to abort.
    - **Validation per round:**
      - p1: sender ≠ self, partyId in range [0, parties).
      - p2-pub: sender ≠ self, partyId in range.
      - p2-priv: sender ≠ self, from/to partyIds in range.
      - p3: sender (generator) ≠ self, generatorId in range.
      - p4: sender ≠ self, partyId in range.

- `function destroySession(session) → void`
  - **Pre:** Session is live.
  - **Post:** Sets destroyed=true, nullifies all state, clears all maps.
  - **Concurrency:** Safe to call once per session (idempotent after first call due to destroyed check in all phase functions).

**Invariants:**

- Session is single-threaded; only one peer calls phase*() on any given session instance.
- Destroyed flag prevents re-entry after finalize or error.
- All broadcast blobs are sorted by partyId (0..N-1) before passing to ThresholdMLDSA lib functions.
- Private reveals are indexed by sender partyId (p2-priv) or by sender generator ID (p3), not recipient.
- Phase 2 and 3 have optional holders/generators; phase4 is N-of-N broadcast.

**Cross-component contracts:**

- Depends on: @btc-vision/post-quantum (ThresholdMLDSA, DKG lib), wire/dkg.ts (encode/decode functions), PartyId type.
- Used by: CeremonyRunner.runMldsaDkgProtocol / participateInMldsaDkg.
- Blob wire format: JSON strings from wire/dkg.ts (encodePhase*Broadcast, encodePhase*Private).

**Notes / gotchas:**

- Phase 2 private reveals are sent only to "holder-mates" (parties sharing ≥1 bitmask from setup); other parties get null from phase2PrivateForTarget.
- Phase 3 private masks are sent to every other party but must be indexed by generator ID; if two parties share the same generator role, only one set of masks is collected.
- Phase 2 finalize is local (no network); phase2Finalize must be called before phase3 work can start.
- All broadcast phases require collection of N blobs before next phase; targeted phases require only the subset of expected senders.

---

### `frost-dkg-session.ts`

**Purpose:** FROST (secp256k1) DKG session wrapper; implements 3-round symmetric protocol (R1/R2/finalize).

**Public surface:**

- `interface FrostDkgSession`
  - **Read-only fields:** `partyId`, `sessionId`, `threshold`, `parties`, `rng`.
  - **Mutable fields:** r1Secret, myR1Package, collectedR1, r2Secret, myR2PackagesByRecipient, collectedR2, result, destroyed.
  - **Invariants:** FROST uses 1-indexed bigint IDs internally; partyId-to-frostId conversion happens in wire codec (partyIdToFrostId / frostIdToPartyId).

- `function createSession(input: CreateFrostDkgSessionInput) → FrostDkgSession`
  - **Pre:** `partyId ∈ [0, parties)`; `0 < threshold ≤ parties`; `sessionId.length === 32`; `rng` is CSPRNG.
  - **Post:** Session initialized; all state null/empty, destroyed=false.
  - **Throws:** On invalid range or sessionId length.

- **Round 1 (commitment + proof of knowledge broadcast):**

  - `function round1(session) → string`
    - **Pre:** Session live; round1 not yet run.
    - **Post:** Calls `libDkgRound1` (converted to FROST's 1-indexed ID), stores secret and package, adds own to collected, returns encoded R1 string.
    - **Throws:** On destroyed or re-entry.

- **Round 2 (targeted signing shares):**

  - `function round2(session) → void`
    - **Pre:** round1 run; all N R1 packages collected.
    - **Post:** Calls `libDkgRound2` with r1Secret and received R1 packages (excluding self), stores r2Secret and per-recipient packages (converted back to partyId).
    - **Throws:** On missing R1 packages or round1 not run.
    - **No return:** void; output is via round2ForTarget.

  - `function round2ForTarget(session, toPartyId) → string | null`
    - **Pre:** round2 run.
    - **Post:** Returns encoded R2 share for toPartyId or null if lib produced none (e.g., invalid recipient).

  - `function round2Recipients(session) → PartyId[]`
    - **Pre:** round2 run.
    - **Post:** Returns all recipient partyIds (N-1 parties, excluding self), sorted.

- **Finalize (VSS-verify received shares, derive key material):**

  - `function finalize(session) → {keyPackage, publicKeyPackage}`
    - **Pre:** round2 run; all N-1 R2 packages addressed to self collected.
    - **Post:** Calls `libDkgFinalize` with r2Secret and all received R1+R2 packages, caches result, returns {keyPackage, publicKeyPackage} with BIP341 tap-tweak applied.
    - **Throws:** On missing R2 packages or round2 not run.
    - **Idempotency:** Returns cached result if called multiple times.

- **Blob ingestion:**

  - `function addBlob(session, blob: string, round: FrostDkgRound) → {ok: boolean; error?: string}`
    - **Pre:** blob properly encoded; round ∈ {r1, r2}.
    - **Post:** Decodes blob, converts FROST ID to partyId, validates sender and recipient (r2 only), stores in appropriate map, returns {ok} or {ok: false; error}.
    - **Soft errors:** Bad format, out-of-range ID, duplicate, or wrong recipient returns {ok: false} (NOT thrown).
    - **Validation per round:**
      - r1: sender ≠ self, partyId in [0, parties).
      - r2: sender ≠ self, recipient = self, both partyIds in range.

- `function destroySession(session) → void`
  - **Pre:** Session live.
  - **Post:** Sets destroyed=true, nullifies all state, clears maps.

**Invariants:**

- Single-threaded per session instance.
- Destroyed flag prevents re-entry.
- FROST library uses 1-indexed bigint; wire codec converts to/from partyId (0-indexed).
- Round 2 shares are targeted (N-1 per party); each party gets shares from every other party (N-1 incoming).
- Finalize requires all N-1 R2 shares and all N R1 packages (own + N-1 others).
- PublicKeyPackage includes BIP341 post-DKG tap-tweak (applied by libDkgFinalize).

**Cross-component contracts:**

- Depends on: @mwaddip/frots (FROST DKG lib), wire/dkg.ts (encode/decode + partyId ↔ frostId conversion).
- Used by: CeremonyRunner.runFrostDkgProtocol / participateInFrostDkg.
- Blob wire format: JSON strings from wire/dkg.ts.

**Notes / gotchas:**

- FROST DKG is N-to-N (every party sends shares to every other); mirrors ML-DSA's phase 3 (targeted reveals) but not phase 2 (no public broadcast before targeted).
- partyId-to-frostId conversion is 1-based; frostId = BigInt(partyId + 1). Conversion lives in wire codec, not here.
- Round 2 shares are keyed by sender partyId in collectedR2; during finalize, they're looked up by FROST bigint via frostIdToPartyId.

---

### `frost-sign-session.ts`

**Purpose:** FROST (secp256k1) signing session wrapper; implements 2-round symmetric protocol (R1/R2) + leader-only aggregate.

**Public surface:**

- `interface FrostSighash`
  - **Fields:** `hash: Uint8Array` (32B), `tweaked: boolean` (key-path vs script-path BIP341 tweak).
  - **Pre:** hash is SHA256 output (32 bytes); tweaked indicates BIP341 tap-tweak applied.
  - **Post:** One sighash to sign in the ceremony.

- `interface FrostSigningSession`
  - **Read-only fields:** `partyId`, `keyPackage`, `publicKeyPackage`, `sighashes`, `activeSigners`, `rng`, `sessionId` (32B, derived from ceremonyId via SHA256).
  - **Mutable fields:** myNonces, myCommitments, collectedR1, myShares, collectedR2, signatures, destroyed.
  - **Invariants:** N sighashes signed in parallel (one blob per round packs all N items).

- `function createSession(input: CreateFrostSessionInput) → FrostSigningSession`
  - **Pre:** `sighashes.length > 0`; `partyId ∈ activeSigners`; `keyPackage` and `publicKeyPackage` from DKG or dealer.
  - **Post:** Session initialized; sessionId derived as SHA256(ceremonyId); all state null/empty.
  - **Throws:** On empty sighashes or partyId not in activeSigners.
  - **sessionId determinism:** All peers derive same sessionId from same ceremonyId, enabling wire-envelope session tag without random state.

- **Round 1 (nonce + commitment generation, broadcast commitments):**

  - `function round1(session) → string`
    - **Pre:** Session live; round1 not run.
    - **Post:** Generates N (nonces, commitments) pairs (one per sighash) via libSignRound1, stores nonces and commitments, adds own commitments to collectedR1, returns encoded R1 blob.
    - **Throws:** On destroyed or re-entry.

- **Round 2 (signature shares, broadcast shares):**

  - `function round2(session) → string`
    - **Pre:** round1 run; all activeSigners' R1 commitments collected (via addBlob or manual collection).
    - **Post:** For each sighash, gathers commitments from all signers (sorted by partyId) and calls libSignRound2 to produce signature share. Stores shares, adds own to collectedR2, returns encoded R2 blob.
    - **Throws:** On missing R1 commitments or round1 not run.
    - **Determinism:** Sorted signer order ensures all parties produce identical share arrays.

- **Aggregate (leader-only, produce final signatures):**

  - `function aggregate(session) → Uint8Array[]`
    - **Pre:** round2 run; all activeSigners' R2 shares collected.
    - **Post:** For each sighash, gathers shares and commitments from all signers (sorted), calls libSignAggregate, returns array of N BIP340 Schnorr sigs (ceremony order, one per sighash).
    - **Throws:** On missing R2 shares or R1 commitments.
    - **Idempotency:** If called multiple times, returns cached signatures.
    - **Leader-only:** Participants do NOT call this; only leader aggregates.

- **Blob ingestion:**

  - `function addBlob(session, blob: string, expectedRound: FrostSignRound) → {ok: boolean; error?: string}`
    - **Pre:** blob properly encoded; expectedRound ∈ {1, 2}; session not destroyed.
    - **Post:** Decodes blob, validates sender partyId, checks sighash count and non-duplicate, stores commitments/shares, returns {ok} or {ok: false; error}.
    - **Soft errors:** Bad format, out-of-range partyId, not in activeSigners, wrong sighash count, or duplicate returns {ok: false} (NOT thrown).
    - **Validation per round:**
      - r1: sender ≠ self, in activeSigners, commitments.length = N sighashes.
      - r2: sender ≠ self, in activeSigners, shares.length = N sighashes.

- `function destroySession(session) → void`
  - **Pre:** Session live.
  - **Post:** Sets destroyed=true, nullifies all state, clears maps.

**Invariants:**

- Single-threaded per session instance.
- Destroyed flag prevents re-entry.
- All N sighashes are signed in lockstep (same R1 nonce per sighash across all parties, same R2 share computation, same aggregate).
- Signature order matches sighash order (canonical input order preserved).
- activeSigners are sorted by partyId before passing to aggregate (determinism).
- BIP340 signature is 64 bytes (32B r + 32B s); tweaked flag is metadata (tells aggregate to apply BIP341 context hash).

**Cross-component contracts:**

- Depends on: @mwaddip/frots (FROST sign lib), wire/frost-sign.ts (encode/decode).
- Used by: CeremonyRunner.signFrostAsLeader / participateInFrostSigning / runKeylinkSignProtocol.
- Blob wire format: JSON from wire/frost-sign.ts.
- sessionId derivation: SHA256(ceremonyId) — deterministic across peers, enables sync without pre-shared session secrets.

**Notes / gotchas:**

- sessionId is NOT a secret; it's derived deterministically so peers can embed it in wire envelopes as a non-secret session tag.
- All N sighashes are signed with the same nonce generation params (partyId + keyPackage); results are N independent BIP340 sigs in ceremony order.
- Leader aggregate is deterministic (no randomness); all peers who run aggregate locally get the same N sigs (used for key-link protocol where all peers aggregate independently).
- `tweaked` flag is metadata; it tells the FROST library whether to apply BIP341 context hash during r2 and aggregate (true = key-path, false = script-path).

---

## Cross-Module Summary

**Data flow:**
1. Transport broadcasts ceremony announcements; peers listen via onBroadcast.
2. CeremonyRunner reacts to announcements, drives protocol phases.
3. Each phase produces a blob (stored locally or received); CeremonyRunner stores own blobs in BlobStore, pulls others' blobs via BlobPuller.
4. BlobPuller uses Transport.pull with exponential backoff + wall-clock deadline.
5. BlobServer serves stored blobs to peers pulling via Transport.pull.
6. Session modules (DkgSession, FrostDkgSession, FrostSignSession) hold transient protocol state; blobs are ingested via addBlob.

**Lifetime:**
- Transport + BlobStore + BlobServer: daemon lifetime (long-lived).
- BlobPuller: created per daemon, reused across ceremonies.
- Sessions: per-ceremony-attempt (destroyed after finalize or error).
- Blobs: live in store until ceremony.clear(ceremonyId).

**Concurrency:**
- All modules assume single-threaded ceremony runner (no internal locks).
- Transport.pull may fire from peer transports (sync in InMemoryTransport, async in real transports).
- BlobStore.onPut observers fire synchronously during put; should not reenter.
- BlobPuller parallelizes per-key workers (Promise.all); abort via wall-clock deadline.

**Error handling:**
- Transport errors: retryable (BlobPuller retries with backoff).
- BlobStore conflicts (re-put different bytes): protocol violation, ceremony-fatal.
- Blob rejection (addBlob returns {ok: false}): soft error, runner logs and continues or aborts depending on phase.
- Unrecoverable errors: leader broadcasts signoff-aborted before throwing.

**Contracts (formal):**

| Contract | Pre | Post | Throws |
|----------|-----|------|--------|
| BlobStore.put(key, blob) | key unique or blob byte-equal; not destroyed | Blob stored or conflict error | `Error("Conflicting blob...")` |
| BlobPuller.pullAll(keys, opts) | keys non-empty; opts valid; deadline > now | All blobs in store | `Error("Failed to fetch...")` or `Error("Deadline exceeded...")` |
| Transport.pull(key) | key.from ∈ peers | blob bytes or null or transport error | Varies (peer-dependent) |
| Transport.broadcast(msg) | msg non-empty | msg delivered to all other peers with from=partyId | Varies (peer-dependent) |
| Transport.servePulls(handler) | handler new; at most one per transport | handler fires on incoming pulls | InMemoryTransport throws if duplicate |
| CeremonyRunner.signAsLeader(spec, opts, maxAttempts) | spec valid, partyId ∈ signers, maxAttempts > 0 | signature returned or aborted with signoff | `Error("Signing aborted...")` |
| CeremonyRunner.participateInSigning(spec, opts) | spec valid, partyId ∈ signers | R1/R2/R3 produced, others' pulled | `Error("Missing ... blob...")` or pull timeout |
| MldsaDkgSession.addBlob(session, blob, round) | blob encoded; round valid; session not destroyed | blob decoded and stored (soft error if invalid) | Never (returns {ok: bool; error?}) |
| FrostDkgSession.finalize(session) | round2 run; all R2 collected | (keyPackage, publicKeyPackage) returned | `Error("round2 not run...")` or `Error("Missing R2...")` |
| FrostSignSession.aggregate(session) | round2 run; all R2 collected; all R1 collected | N BIP340 sigs returned (ceremony order) | `Error("Missing R2...")` or `Error("Missing R1...")` |

---

## Key Gotchas

1. **ceremonyId retry suffix:** ML-DSA signing's `#N` suffix (e.g., `base#2`) is part of ceremonyId in runner state but NOT advertised separately; participants watch `baseCeremonyId` (stable across retries) and react to new announces dynamically.

2. **FROST keylink round naming:** Uses `frost-keylink-r1` and `frost-keylink-r2` (NOT `frost-sign-r1/r2`) to avoid collision with regular FROST signing (same ceremony can emit both if missequenced).

3. **BlobStore idempotency:** Re-putting IDENTICAL bytes is a silent no-op (no observer fire); re-putting DIFFERENT bytes is a protocol violation (immediate conflict throw). Callers MUST ensure wire codecs are deterministic.

4. **Transport authenticated-from:** The `from` field in every broadcast/pull callback is cryptographically authenticated. Test transports (InMemoryTransport) MUST preserve this contract even when bypassing E2E encryption.

5. **DKG sessionId:** Shared across ML-DSA + FROST phases in combined DKG (same 32B value used for both); enables deterministic key binding without out-of-band coordination.

6. **FROST aggregate is deterministic:** All peers with the same R1+R2 collections get the same N signatures (no randomness in aggregate). Key-link protocol exploits this: all peers run aggregate independently and get the same sig.

7. **partyId vs frostId:** ML-DSA and CeremonyRunner use 0-indexed partyId; FROST lib uses 1-indexed bigint frostId. Conversion happens in wire/dkg.ts (partyIdToFrostId / frostIdToPartyId); callers do NOT do the conversion.

8. **Wall-clock deadline:** BlobPuller deadline is absolute (wall-clock time since pullAll call), NOT relative per key. If maxAttempts = 10 and deadline fires after 5 attempts, deadline wins.

9. **BlobServer lifetime:** NOT ceremony-scoped; lives as long as daemon. Allows peers to serve completed ceremonies' blobs to lagging peers (federation fault tolerance).

10. **Lead-participant asymmetry (signing):** Participants produce R1/R2/R3 but do NOT pull R3 or combine. If they try to combine, they get null (no R3 from themselves or leader). Leader is sole producer of final sig.
