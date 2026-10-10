# Contracts: src/core/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/core/

### `types.ts`

**Purpose:** Shared type definitions for ceremony blobs and transport layer.

**Public surface:**
- `type PartyId = number`
  - **Pre:** 0-indexed integer; valid range is `0 ≤ partyId < parties` (ring size).
  - **Post:** Canonical party identifier within the ring. FROST identifier = `partyId + 1`.
  - **Concurrency:** Immutable type; no concurrency concerns.

- `const BROADCAST = undefined`
  - **Pre:** Singleton marker.
  - **Post:** Indicates broadcast blob (`to` field absent on BlobKey).

- `interface BlobKey`
  - **Pre:** `ceremonyId` is a non-empty string (ceremony IDs that enter from the API or the wire match `CEREMONY_ID_RE`, see `messages.ts`); `round` is a round key (see § Round keys in INTERFACES.md); `from` is the producing PartyId; `to` is undefined for a broadcast blob or the recipient PartyId for an addressed blob.
  - **Post:** Uniquely identifies a ceremony blob; the tuple (ceremonyId, round, from, to) is unique per BlobStore.
  - **Concurrency:** Immutable data structure; safe for concurrent reads.

- `type Unsubscribe = () => void`
  - **Pre:** Returned from `onBroadcast` or `servePulls`; calling twice is explicitly idempotent.
  - **Post:** Handler is unregistered; subsequent calls are no-ops.

- `function blobKeyToString(key: BlobKey) → string`
  - **Pre:** Valid BlobKey.
  - **Post:** Stable string form suitable for Map keys or logging; `to` rendered as `'*'` when undefined.
  - **Concurrency:** Pure function; safe.

**Invariants:**
- PartyId is 0-indexed within the ring; conversion to FROST's 1-indexed bigint uses `partyIdToFrostId` / `frostIdToPartyId` from `src/otzi/lib/dkg.ts`.
- BlobKey tuples are unique per ceremony (no collisions across rounds).

**Cross-component contracts:**
- Used by: Transport, BlobStore, BlobServer, BlobPuller, sessions, ceremonies.

---

### `transport.ts`

**Purpose:** Interface for pull-based peer communication; specifies authenticated peer-to-peer and broadcast channels.

**Public surface:**
- `interface Transport`
  - `readonly partyId: PartyId`
    - **Pre:** This daemon's 0-indexed identity, stable across daemon lifetime.
    - **Post:** Same value as provided at Transport creation.

  - `readonly peers: readonly PartyId[]`
    - **Pre:** Complete list of all ring members (including self), sorted.
    - **Post:** Immutable; stable across daemon lifetime; length is the ring size N for all ceremonies on this daemon.

  - `broadcast(msg: Uint8Array) → Promise<void>`
    - **Pre:** `msg` is non-empty; caller treats as broadcast to all other peers (sender is implicit).
    - **Post:** Message is delivered to all other peers' `onBroadcast` handlers with `from: this.partyId`. Never delivered to self.
    - **Throws:** On network failure or internal error; caller should treat as retryable or fatal depending on phase.
    - **Concurrency:** Safe to call concurrently; broadcast order is NOT guaranteed.
    - **Cross-component:** The sender's `from` is cryptographically authenticated; implementations MUST NOT forge `from` even in test harnesses (InMemoryTransport respects this).

  - `onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void) → Unsubscribe`
    - **Pre:** Handler is a new function; at most one handler per Transport (enforced by InMemoryTransport).
    - **Post:** Handler fires on each `broadcast` from any peer; unsubscribe is idempotent.
    - **Throws:** InMemoryTransport throws if a handler is already registered.

  - `pull(key: BlobKey) → Promise<Uint8Array | null>`
    - **Pre:** `key.from` is a valid peer in the ring; key identifies a blob expected to be produced by that peer.
    - **Post:** Returns blob bytes if the peer serves it; returns `null` if the peer hasn't produced it yet, or will not serve it to this node (caller retries with backoff); throws if `key.from` is not in peers array.
    - **Throws:** On peer-not-found, network error, or other transport failure (retryable by caller).
    - **Concurrency:** Safe to call concurrently; null returns are interpreted as "not yet ready" (BlobPuller retries).

  - `servePulls(handler: (from: PartyId, key: BlobKey) → Uint8Array | null) → Unsubscribe`
    - **Pre:** Handler is a new function; at most one handler per Transport (enforced).
    - **Post:** Handler fires on each incoming `pull` request from a peer with the requester's authenticated `from`, returning the blob or `null`. Unsubscribe returns `null` for all subsequent pulls.
    - **Throws:** InMemoryTransport throws if a handler is already registered.
    - **Concurrency:** Handler may fire concurrently from multiple peer pull requests; should be thread-safe or use a lock.

**Invariants:**
- `from` in every broadcast/pull callback is authenticated (the peer genuinely sent the message).
- Test transports (InMemoryTransport) may bypass E2E encryption but MUST preserve authenticated-`from` semantics.
- Peers list is fixed for the daemon's lifetime; ceremonies do not add or remove peers mid-run.

**Cross-component contracts:**
- Used by: ceremonies (broadcast messages), BlobPuller (pulls blobs), BlobServer (serves stored blobs), orchestrator (`onBroadcast`).
- Implemented by: InMemoryTransport (test harness), `PeerMeshTransport` and `RelayTransport` (see [transport.md](transport.md)).

**Notes / gotchas:**
- `pull(key)` returning `null` does NOT indicate an error; it means the producer has not yet generated the blob (or refuses to serve it). BlobPuller interprets null as "retry later with backoff."
- `servePulls` is registered once per daemon at startup; its lifetime is the daemon's, not a ceremony's. This allows a peer to serve blobs from completed ceremonies to lagging peers until retention clears them.

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
  - **Post:** Transport methods dispatch synchronously to peer instances in the shared ring Map. `servePulls` handlers receive the puller's real partyId as `from`.
  - **Memory:** Each transport holds references to the entire ring; no cleanup needed per ceremony.
  - **Invariants:**
    - At most one `pullHandler` per transport.
    - Broadcasts route to all other peers (partyId check prevents self-delivery).
    - Pull requests go directly to the target peer's `servePull` method (no async wrapping, no null-then-wait).

**Cross-component contracts:**
- Used by: tests that exercise ceremony mechanics without real networking (`src/testing/ring.ts`).
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
    - **Pre:** If key already exists, blob MUST be byte-identical (idempotent) or it's a protocol violation.
    - **Post:** Blob is stored; if byte-equal to existing entry, fires no observer (idempotent no-op); if byte-differ, throws immediately.
    - **Throws:** `Error("Conflicting blob for ${keyStr}")` if re-putting different bytes under the same key. Callers treat this as ceremony-fatal.
    - **Concurrency:** NOT thread-safe; assumes single-threaded ceremony code or external serialization.
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
    - **Post:** Returns all blobs for the ceremony (optionally filtered to one round); callers MUST not mutate the blobs.
    - **Concurrency:** Safe for concurrent reads.

  - `onPut(handler: (key: BlobKey) => void) → Unsubscribe`
    - **Pre:** Handler is a new function.
    - **Post:** Handler fires after each successful put that is NOT an idempotent no-op (byte-equal existing entry). Unsubscribe is idempotent.
    - **Concurrency:** Handlers fire synchronously during put; do not call store methods from handlers.

  - `clear(ceremonyId: string) → void`
    - **Pre:** ceremonyId identifies an in-flight or completed ceremony.
    - **Post:** Deletes all blobs for that ceremony; does NOT fire observers (cleanup-only).
    - **Concurrency:** Called by `blob-retention.ts` once per ceremony end.

**Invariants:**
- Each (ceremonyId, round, from, to) key is unique; re-putting triggers conflict check.
- Idempotency on byte-equality ensures eventual consistency (same blob pulled twice is a no-op).
- Byte references are not copied; callers MUST treat get() results as read-only.

**Cross-component contracts:**
- Depends on: BlobKey type (from types.ts).
- Used by: sessions' callers in `dkg-ceremony.ts` / `sign-ceremony.ts` (store produced blobs), BlobPuller (stores pulled blobs), BlobServer (serves), `blob-retention.ts` (clears).
- Blob format: FROST blobs are the UTF-8 bytes of an Ötzi envelope string (`src/otzi/lib/dkg.ts`, `frost-sign.ts`); `dkg-verified` is the raw 64-byte signature.

**Notes / gotchas:**
- NOT thread-safe; ceremony code must serialize blob operations or use external locks.
- Conflict detection is exact byte comparison; different encodings of the same data are treated as conflicts (by design — codecs MUST be deterministic). A conflicting own `sign-r1` is what stops a reused `ceremonyId` from producing a second set of commitments while the first is still stored.
- `onPut` observers fire synchronously during put; blocking or reentering is unsafe.

---

### `blob-server.ts`

**Purpose:** Long-lived bridge from `Transport.servePulls` to `BlobStore`, with addressed-blob access control. Decouples blob availability from ceremony lifetime.

**Public surface:**
- `class BlobServer`
  - **Pre:** Constructed at daemon startup with a Transport and BlobStore (both long-lived).
  - **Post:** Registers a pull handler; lifetime is the daemon's, not a ceremony's.
  - **Memory:** Holds the pull-handler unsubscriber.

  - `constructor(transport: Transport, store: BlobStore)`
    - **Pre:** transport and store are both live; at most one BlobServer per daemon (enforced by `Transport.servePulls`).
    - **Post:** Registers the pull handler `(from, key)`:
      - `key.to !== undefined` and `from !== key.to` → `null`, whether or not the blob exists;
      - otherwise `store.get(key) ?? null`.
    - **Throws:** If transport already has a pull handler registered (InMemoryTransport throws).

  - `close() → void`
    - **Pre:** BlobServer is live (not already closed).
    - **Post:** Unregisters the pull handler; subsequent pulls return null.
    - **Concurrency:** Safe to call once at daemon shutdown.

**Invariants:**
- **Addressed-blob access:** a blob whose key has a `to` is served only to the authenticated requester equal to `to`. Blobs without `to` are served to any ring member (the transport delivers pulls only from ring members). DKG round-2 secret shares (`dkg-r2`) are the addressed blobs, so with `threshold < parties` no peer can collect another party's shares.
- A refused pull is indistinguishable from "not produced yet" (`null`).
- BlobServer lifetime decouples blob availability from ceremony completion: a peer that finishes keeps serving its blobs to lagging peers until retention clears them.

**Cross-component contracts:**
- Depends on: Transport.servePulls (authenticated `from`), BlobStore.get.
- Used by: daemon lifecycle (created at startup, closed at shutdown); `src/testing/ring.ts`.

**Notes / gotchas:**
- BlobServer is a passive bridge; it does NOT push blobs or clean up. Cleanup is `blob-retention.ts`.

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
  - **Pre:** All fields positive.
  - **Post:** Passed to `pullAll`; controls retry behavior and timeout.
  - **Ceremonies:** the daemon's `CeremonyIo.pullOpts` supplies the backoff (`initialDelayMs`, `maxDelayMs`). Every ceremony — leader (`LeaderDispatcher`) and participant (`Orchestrator`) — runs with `deadlineMs` = the ceremony deadline (`[deadlines].signing_ms` or `dkg_ms`) and `maxAttempts = Number.MAX_SAFE_INTEGER`, so pulls retry with backoff until the ceremony deadline: they are bounded by the deadline, not by an attempt count.

- `class BlobPuller`
  - **Pre:** Constructed with Transport and BlobStore (long-lived).
  - **Post:** Provides `pullAll` for parallel blob fetches.

  - `async pullAll(expected: readonly BlobKey[], opts: PullOpts, signal?: AbortSignal) → Promise<void>`
    - **Pre:** Each key in `expected` names a producer in `transport.peers`; opts are well-formed.
    - **Post:** Resolves when every expected key is in the store. Each key is fetched by a parallel worker (`Promise.all`); a pulled blob is stored under the key it was requested with, so `key.from` is the authenticated producer.
    - **Throws:**
      - `Error("Failed to fetch ${keyStr} after ${maxAttempts} attempts")` if a key is not served after maxAttempts retries.
      - `Error("Deadline exceeded while pulling ${keyStr}")` if the wall-clock deadline fires first.
      - `Error('aborted')` when `signal` aborts (or is already aborted); every worker stops pulling.
      - A `BlobStore` conflict or transport throw propagates.
    - **Concurrency:** Parallel per-key workers; safe.

**Invariants:**
- Per-key workers retry independently; the deadline and the signal stop all of them.
- When a `pullAll` call settles (every key present, a key failed, the deadline, or the signal), its remaining workers stop retrying and put nothing further.
- A worker short-circuits if its key lands in the store by another path (local production, parallel puller).
- Blobs stored via `pullAll` go through `store.put` (idempotent on equal bytes; a conflict is a protocol violation that propagates).

**Cross-component contracts:**
- Depends on: Transport.pull, BlobStore.get/put/has.
- Used by: `dkg-ceremony.ts`, `sign-ceremony.ts` (through `CeremonyIo`).

**Notes / gotchas:**
- `maxAttempts` is per-key; the deadline is wall-clock for the whole call and wins when it fires first.
- Sleep delays are interruptible by the deadline and by the signal.
- Initial delay should be tuned per deployment (a few ms in tests, 100 ms+ on real networks).

---

### `blob-retention.ts`

**Purpose:** Delayed cleanup of a ceremony's blobs after it ends on this node.

**Public surface:**
- `const BLOB_RETENTION_MS = { signing: 300_000, dkg: 900_000 } as const`
  - **Post:** Retention after a ceremony ends: 5 minutes for signing, 15 minutes for DKG — the default ceremony deadlines, so a peer that is behind can still pull until then.

- `function scheduleClear(store: BlobStore, ceremonyId: string, delayMs: number): void`
  - **Pre:** The ceremony has ended on this node (either role, any outcome).
  - **Post:** Starts an unref'd timer (it never keeps the process alive) that calls `store.clear(ceremonyId)` after `delayMs`.
  - **Throws:** Never.

**Invariants:**
- Every ceremony end on a node (leader success, leader failure, every participant settle) schedules exactly one clear for its `ceremonyId`.
- DKG round-2 secret shares and signing blobs do not outlive the retention window.

**Cross-component contracts:**
- Used by: `Orchestrator` (every settle), `LeaderDispatcher` (settle and failure).

**Notes / gotchas:**
- Reusing a `ceremonyId` within the retention window fails: the stored blobs conflict, and the scheduled clear removes the new ceremony's blobs.

---

### `ceremony-io.ts`

**Purpose:** The I/O bundle every ceremony runs on.

**Public surface:**
- `interface CeremonyIo { transport: Transport; store: BlobStore; puller: BlobPuller; pullOpts: PullOpts }`
  - **Pre:** `store` is the store the daemon's `BlobServer` serves; `puller` wraps the same `transport` and `store`.
  - **Post:** Passed to `runDkgCeremony`, `leadSigning`, `participateInSigning`. Self is `transport.partyId`; the ring is `transport.peers`.

**Cross-component contracts:**
- Built by: `Daemon` (one per daemon), `src/testing/ring.ts` (one per test node).

---

### `messages.ts`

**Purpose:** Ceremony control messages (broadcasts, not blobs): shapes, strict parser, encoder.

**Public surface:**
```ts
export const CEREMONY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_INPUTS = 255;
export interface AnnounceDkg { v: 2; kind: 'announce-dkg'; ceremonyId: string; sessionIdHex: string; threshold: number; parties: number; network: NetworkName }
export interface AnnounceSign { v: 2; kind: 'announce-sign'; ceremonyId: string; signers: PartyId[]; proposal: SendProposal }
export interface SignoffDone { v: 2; kind: 'signoff-done'; ceremonyId: string; signaturesHex: string[] }
export interface SignoffAborted { v: 2; kind: 'signoff-aborted'; ceremonyId: string; reason?: string }
export type CeremonyMessage = AnnounceDkg | AnnounceSign | SignoffDone | SignoffAborted;
```

- `isCeremonyId(s: unknown): s is string`
  - **Post:** `true` iff `s` is a string matching `CEREMONY_ID_RE`.

- `isProposalShape(p: unknown): p is SendProposal`
  - **Post:** `true` iff `p` has exactly the keys `{network, tx, prevouts}`; `network` is one of the three networks; `tx` is non-empty, even-length, lowercase hex; `prevouts` is an array of 1–255 entries, each with exactly the keys `{txid, vout, amount, script}`: `txid` 64 lowercase hex, `vout` a safe integer ≥ 0, `amount` a safe integer ≥ 0, `script` non-empty even-length lowercase hex.
  - **Notes:** Shape only. Everything else (input/prevout match, vault script, network, fee) is `analyzeProposal`'s job.

- `encodeMessage(msg: CeremonyMessage): Uint8Array`
  - **Pre:** `msg` satisfies the parser rules.
  - **Post:** UTF-8 JSON. `parseMessage(encodeMessage(m))` deep-equals `m`.

- `parseMessage(bytes: Uint8Array): CeremonyMessage | null`
  - **Post:** Returns the message when every rule below holds; `null` otherwise.
  - **Throws:** Never.
  - **Rules:**
    - UTF-8 JSON object with `v === 2` and `kind` one of the four kinds.
    - Each kind has an exact key set (`reason` optional for `signoff-aborted`); extra keys mean `null`.
    - `ceremonyId`: `isCeremonyId`.
    - `sessionIdHex`: 64 lowercase hex characters.
    - `threshold` and `parties`: integers from 2 to 255, with `threshold ≤ parties`.
    - `network`: one of `mainnet`, `testnet4`, `signet`.
    - `signers`: 1–255 integers in `0..254`.
    - `proposal`: `isProposalShape`.
    - `signaturesHex`: 1–255 strings of 128 lowercase hex characters.
    - `reason`: a string of at most 1024 characters.

**Invariants:**
- `from` (sender) is the transport's authenticated `from`; messages carry no sender field.
- A parse failure is a silent drop at the receiver (logged).
- Sighashes never appear in a message; every signer derives them from `proposal`.

**Cross-component contracts:**
- Depends on: `NetworkName`, `SendProposal` (`src/otzi/`), `PartyId`.
- Used by: `dkg-ceremony.ts` (`signoff-aborted`), `sign-ceremony.ts` (`announce-sign`), `Orchestrator` (parse), `LeaderDispatcher` (`announce-dkg`, signoffs), `src/daemon/api.ts` (`isCeremonyId`, `isProposalShape`, `MAX_INPUTS`).

---

### `frost-dkg-session.ts`

**Purpose:** FROST (secp256k1) DKG session wrapper around `@mwaddip/frots`; 3-step symmetric protocol (R1 / R2 / finalize) with Ötzi codecs.

**Public surface:**

- `interface FrostDkgSession`
  - **Read-only fields:** `partyId`, `sessionId` (32 B), `threshold`, `parties`, `rng`.
  - **Mutable fields:** `r1Secret`, `myR1Package`, `collectedR1`, `r2Secret`, `myR2PackagesByRecipient`, `collectedR2`, `result`, `destroyed`.

- `function createSession(input: CreateFrostDkgSessionInput) → FrostDkgSession`
  - **Pre:** `partyId ∈ [0, parties)`; `0 < threshold ≤ parties`; `sessionId.length === 32`; `rng` is a CSPRNG.
  - **Post:** Session initialized; all state null/empty, `destroyed = false`.
  - **Throws:** On invalid range or sessionId length.

- `function round1(session) → string`
  - **Pre:** Session live; round 1 not yet run.
  - **Post:** Calls frots `dkgRound1(partyIdToFrostId(partyId), parties, threshold, rng)`, stores secret and package, adds own package to `collectedR1`, returns the `encodeFrostRound1` blob (Ötzi `frost-r1`).
  - **Throws:** On destroyed or re-entry.

- `function round2(session) → void`
  - **Pre:** Round 1 run; all N round-1 packages collected.
  - **Post:** Calls frots `dkgRound2` (verifies every proof of knowledge), stores the round-2 secret and one package per recipient.
  - **Throws:** On missing round-1 packages, round 1 not run, or a frots verification failure (names the offending identifier).

- `function round2ForTarget(session, toPartyId) → string | null`
  - **Pre:** Round 2 run.
  - **Post:** `encodeFrostRound2` blob (Ötzi `frost-r2`, envelope `to` = recipient) for `toPartyId`, or null for self.

- `function round2Recipients(session) → PartyId[]`
  - **Pre:** Round 2 run.
  - **Post:** Every other partyId, sorted ascending.

- `function finalize(session) → { keyPackage, publicKeyPackage }`
  - **Pre:** Round 2 run; all N−1 round-2 packages addressed to self collected.
  - **Post:** Calls frots `dkgFinalize` (verifies every received share), caches and returns the key material with the BIP341 key-path tweak applied.
  - **Throws:** On missing packages or a frots verification failure.
  - **Idempotency:** Returns the cached result on repeated calls.

- `function addBlob(session, blob: string, round: 'r1' | 'r2', from: PartyId) → { ok: true } | { ok: false; error: string }`
  - **Pre:** `from` is the authenticated producer the blob was pulled from; session not destroyed.
  - **Post:** On `ok: true` the decoded package is stored under `from`.
  - **Rejects (`ok: false`, error names `from`):**
    - `from === partyId` or `from ∉ [0, parties)`;
    - the blob does not decode (`decodeFrostRound1` / `decodeFrostRound2` → null);
    - **sender binding:** the partyId inside the blob ≠ `from` (round 1: `frostIdToPartyId(identifier)`; round 2: `sender`);
    - **commitment count:** a round-1 package without exactly `threshold` commitments;
    - round 2: the recipient inside the blob ≠ this node;
    - a second package from the same `from` for the round.
  - **Throws:** Never.

- `function destroySession(session) → void`
  - **Post:** Sets `destroyed = true`, nulls all secrets, clears all maps.

**Invariants:**
- Single-threaded per session instance; destroyed flag prevents re-entry.
- Round-2 shares are targeted (N−1 per party); every party receives one share from every other party.
- Finalize requires all N round-1 packages (own included) and all N−1 round-2 packages.
- The public key package carries the BIP341 key-path tweak (`verifyingKey` = output key, `untweakedVerifyingKey` = internal key).

**Cross-component contracts:**
- Depends on: `@mwaddip/frots`; codecs and id conversion from `src/otzi/lib/dkg.ts`.
- Used by: `dkg-ceremony.ts`.

**Notes / gotchas:**
- `encodeFrostRound2`'s envelope `to` matches the blob key's `to`, which is what `BlobServer` uses to refuse other requesters.

---

### `frost-sign-session.ts`

**Purpose:** FROST (secp256k1) signing session wrapper around `@mwaddip/frots`; 2-round protocol (R1 / R2) plus leader-only aggregate, with Ötzi codecs, sender binding and the nonce rules.

**Public surface:**

- `interface FrostSighash`
  - **Fields:** `hash: Uint8Array` (32 B), `tweaked: boolean`.
  - **Post:** One sighash to sign. Every caller in this repo passes `tweaked: true` (BIP341 key-path).

- `type FrostSignRound = 1 | 2`

- `interface FrostSigningSession`
  - **Read-only fields:** `partyId`, `keyPackage`, `publicKeyPackage`, `sighashes`, `activeSigners`, `rng`, `sessionId`.
  - **Mutable fields:** `myNonces`, `myCommitments`, `collectedR1`, `myShares`, `collectedR2`, `signatures`, `round2Started: boolean`, `destroyed`.

- `interface CreateFrostSessionInput { partyId; keyPackage; publicKeyPackage; sighashes; activeSigners; rng; sessionId: Uint8Array }`
  - `sessionId` is 32 bytes: the first sighash for proposal signing, the DKG session ID for DKG verification. The Ötzi envelope `sid` (first 16 hex characters) is taken from it.

- `function createSession(input: CreateFrostSessionInput) → FrostSigningSession`
  - **Pre:** `1 ≤ sighashes.length ≤ 255`; `partyId ∈ activeSigners`; `activeSigners` has no duplicates; `keyPackage` and `publicKeyPackage` are from the same vault.
  - **Post:** Session initialized; `round2Started = false`; all state null/empty.
  - **Throws:** On empty sighashes, `partyId` not in `activeSigners`, or `sessionId` not 32 bytes.

- `function round1(session) → string`
  - **Pre:** Session live; round 1 not run.
  - **Post:** One frots `signRound1(keyPackage, rng)` per sighash (fresh nonces), stores nonces and commitments, adds own commitments to `collectedR1`, returns the `encodeFrostSignR1` blob (Ötzi `frost-sign-r1`).
  - **Throws:** On destroyed or re-entry.

- `function round2(session) → string`
  - **Pre:** Round 1 run; `round2Started === false`; one commitment set collected for every signer in `activeSigners`.
  - **Post:** Sets `round2Started = true` before any work; takes exactly one commitment set per active signer, frozen at that moment; for each sighash calls frots `signRound2(keyPackage, nonces, hash, commitments sorted by identifier, { tweaked })`; sets `myNonces = null`; adds own shares to `collectedR2`; returns the `encodeFrostSignR2` blob (Ötzi `frost-sign-r2`).
  - **Throws:** If round 2 already started (checked first), round 1 not run, or a commitment set is missing. Past those first two checks `myNonces` is `null` once `round2` exits, by return or by throw; a throw there leaves the session unable to run round 2 again.

- `function aggregate(session) → Uint8Array[]`
  - **Pre:** Round 2 run; one share set collected for every active signer. Leader only (and every node in DKG verification).
  - **Post:** For each sighash, frots `signAggregate(shares, hash, commitments, publicKeyPackage, { tweaked })` with the full `publicKeyPackage`; returns one 64-byte BIP340 signature per sighash, in sighash order. Cached on repeated calls.
  - **Throws:** On missing shares, or a frots verification failure naming the cheating identifier (needs the full `verifyingShares`).

- `function addBlob(session, blob: string, expectedRound: FrostSignRound, from: PartyId) → { ok: true } | { ok: false; error: string }`
  - **Pre:** `from` is the authenticated producer the blob was pulled from; session not destroyed.
  - **Post:** On `ok: true` the decoded set is stored under `from`.
  - **Rejects (`ok: false`, error names `from`):**
    - `from === partyId` or `from ∉ activeSigners`;
    - the blob does not decode (`decodeFrostSignR1` / `decodeFrostSignR2` → null, or the decoder throws on a truncated payload);
    - **sender binding:** the partyId inside the blob ≠ `from`, or any entry's FROST identifier ≠ `from + 1`;
    - entry count ≠ `sighashes.length`;
    - round 1: any `hiding` or `binding` that is not a 33-byte compressed secp256k1 point on the curve (a truncated or off-curve point is rejected naming `from`, not left to fail later inside `round2`);
    - a second set from the same `from` for the round;
    - round 1 after round 2 has started.
  - **Throws:** Never.

- `function destroySession(session) → void`
  - **Post:** Sets `destroyed = true`, nulls nonces, shares and signatures, clears maps.

**Invariants (nonce rules):**
- Round 2 runs at most once per session; the `round2Started` guard is set before any work.
- Round 2 uses exactly one commitment set per active signer, frozen when it starts; later blobs cannot change it.
- Nonces are fresh per session (`signRound1`) and dropped right after `signRound2`.
- Signature order matches sighash order (input order).

**Cross-component contracts:**
- Depends on: `@mwaddip/frots`; codecs from `src/otzi/lib/frost-sign.ts`.
- Used by: `sign-ceremony.ts` (proposal signing), `dkg-ceremony.ts` (verification signature).

**Notes / gotchas:**
- The Ötzi sign decoders do not check payload length, the inner partyId, the identifiers or the points; `addBlob` is where those checks live: payload partyId, entry count, identifiers, and in round 1 point validity. A truncated round-2 payload makes the decoder throw, which `addBlob` turns into a rejection.
- `sessionId` is not a secret; it only tags envelopes.

---

### `dkg-ceremony.ts`

**Purpose:** The symmetric DKG protocol with verification signature and all-N confirmation (spec §5.3 steps 2–7).

**Public surface:**
```ts
export const DKG_ROUNDS = { r1: 'dkg-r1', r2: 'dkg-r2', verifyR1: 'dkg-verify-r1', verifyR2: 'dkg-verify-r2', verified: 'dkg-verified' } as const;
export interface DkgCeremonyResult { keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage }
export interface ShareStager { stage(r: DkgCeremonyResult): Promise<void>; commit(): Promise<void>; discard(): Promise<void> }
export interface DkgCeremonySpec { ceremonyId: string; sessionId: Uint8Array; threshold: number; parties: number; network: NetworkName; rng: Rng }
```

- `async runDkgCeremony(io: CeremonyIo, spec: DkgCeremonySpec, stager: ShareStager, signal?: AbortSignal) → Promise<DkgCeremonyResult>`
  - **Pre:** `announce-dkg` for this ceremony was broadcast (leader) or accepted (participant) — announcing is the caller's job; this node holds no vault; `spec.parties === io.transport.peers.length`; `2 ≤ threshold ≤ parties`; `sessionId` is 32 bytes; `ceremonyId` satisfies `isCeremonyId`.
  - **Post (success):** Every step below completed in order; returns this node's key material. `stager.commit()` has resolved (the daemon's stager renames `.pending` to the share path and writes `vault-pubkey.json`).
    1. **Round 1.** `round1`; put `{ceremonyId, round: 'dkg-r1', from: self}`; pull `dkg-r1` from the other N−1 nodes; `addBlob(..., 'r1', from)` each.
    2. **Round 2.** `round2`; put one `{round: 'dkg-r2', from: self, to: peer}` per peer; pull the N−1 `{round: 'dkg-r2', from: peer, to: self}`; `addBlob(..., 'r2', from)`; `finalize`.
    3. **Verify.** `M = dkgVerifyMessage(sessionId, network, publicKeyPackage)` from this node's own result. Signing session with `sighashes = [{ hash: M, tweaked: true }]`, `activeSigners` = all parties, `sessionId = spec.sessionId`. Put `dkg-verify-r1`, pull from all others, `addBlob(..., 1, from)`; `round2` (nonces dropped), put `dkg-verify-r2`, pull from all others, `addBlob(..., 2, from)`; `aggregate` with the full `publicKeyPackage`; check `verifySignature(sig, M, publicKeyPackage.verifyingKey)`.
    4. **Stage.** `stager.stage({ keyPackage, publicKeyPackage })`.
    5. **Confirm.** Put `dkg-verified` = the raw 64-byte aggregate signature. Pull `dkg-verified` from all N−1 others; each must be 64 bytes and pass `verifySignature(theirs, M, publicKeyPackage.verifyingKey)`.
    6. **Complete.** `stager.commit()`.
  - **Post (failure, any step):**
    1. `await stager.discard()`;
    2. unless `signal?.aborted`, broadcast `signoff-aborted {ceremonyId, reason}`;
    3. throw `Error('DKG aborted: <reason>')`.
  - **Abort:** `signal` aborting stops every pull (`Error('aborted')`) and takes the failure path without broadcasting.

**Invariants:**
- **Guarantee:** a node completes only when every node has produced a signature under the same vault key over the same transcript and has staged its share to disk.
- An equivocating node (different `dkg-r1` per puller) makes the verification signature or a confirmation fail; no node completes.
- Sessions are destroyed on every exit path.

**Cross-component contracts:**
- Depends on: `frost-dkg-session.ts`, `frost-sign-session.ts`, `messages.ts` (`encodeMessage`), `dkgVerifyMessage` (`src/otzi/lib/dkg.ts`), frots `verifySignature`, `CeremonyIo`.
- Used by: `LeaderDispatcher.runDkg`, `Orchestrator` (`announce-dkg`).
- `ShareStager` implemented by: `createShareStager` (`src/daemon/vault-share.ts`).

---

### `sign-ceremony.ts`

**Purpose:** The proposal signing protocol (spec §5.4), leader and participant halves.

**Public surface:**
```ts
export const SIGN_ROUNDS = { r1: 'sign-r1', r2: 'sign-r2' } as const;
export interface SignCeremonySpec { ceremonyId: string; signers: readonly PartyId[]; sighashes: readonly Uint8Array[]; keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage; rng: Rng }
```
- `SignCeremonySpec.sighashes` are the sighashes this node computed with `analyzeProposal` (input order, 1–255 entries). `keyPackage` / `publicKeyPackage` come from this node's own share.

- `async leadSigning(io: CeremonyIo, spec: SignCeremonySpec, proposal: SendProposal, signal?: AbortSignal) → Promise<Uint8Array[]>`
  - **Pre:** The caller analysed `proposal` against this node's own key and network and its gate approved; `spec.signers` contains this node, has no duplicates, contains only ring members, and has at least `publicKeyPackage.minSigners` entries.
  - **Post:** Broadcasts `announce-sign {ceremonyId, signers, proposal}`; signing session with `sessionId = sighashes[0]` and `tweaked: true` for every sighash; puts `sign-r1`, pulls `sign-r1` from every other signer, `addBlob(..., 1, from)`; `round2`, puts `sign-r2`, pulls `sign-r2` from every other signer, `addBlob(..., 2, from)`; `aggregate` with the full `publicKeyPackage`; checks `verifySignature(sig, sighash, publicKeyPackage.verifyingKey)` for every input. Returns one 64-byte signature per input, in input order.
  - **Throws:** Before announcing or storing anything, on a spec that breaks the checks listed under *Spec validation* below. Later, on any pull failure, rejected blob (`Rejected <round> blob from party <from>: <reason>` names the sender), aggregation failure (frots names the cheating signer), failed verification (`signature for input <i> does not verify`), or `signal` abort (`Error('aborted')`).
  - **Abort:** `signal` is checked before the announce (an already-aborted signal announces and stores nothing), before round 2 and before aggregating, and it stops every pull (`Error('aborted')`). `LeaderDispatcher` passes its ceremony-deadline signal.
  - **Notes:** Does not broadcast a signoff; `LeaderDispatcher` broadcasts `signoff-done` / `signoff-aborted`.

- `async participateInSigning(io: CeremonyIo, spec: SignCeremonySpec, signal?: AbortSignal) → Promise<void>`
  - **Pre:** The `announce-sign` passed the participant checks, `analyzeProposal` against this node's own key, and the gate (see [orchestrator.md](orchestrator.md)).
  - **Post:** Signing session as above; puts `sign-r1`, pulls `sign-r1` from every other signer, `addBlob(..., 1, from)`; `round2` (nonces dropped), puts `sign-r2`; resolves. Does not pull `sign-r2` and does not aggregate.
  - **Throws:** Before producing anything, on a spec that breaks the checks listed under *Spec validation* below. Later, on any pull failure, rejected blob (`Rejected <round> blob from party <from>: <reason>`), or `signal` abort (`Error('aborted')`).

- **Spec validation** (both functions, first thing, in this order; the error texts are exact, and nothing is announced, stored or created when one throws). For `leadSigning` this node is the leader, so "this node is not in `signers`" is the leader-missing case.
  - `sighashes.length` not in 1..255 → `sighashes must have 1 to 255 entries, got <n>`
  - a sighash not 32 bytes → `sighash <i> is <len> bytes, expected 32`
  - `signers` empty → `signers must not be empty`
  - duplicate signer → `signers must be unique`
  - this node (`transport.partyId`) not in `signers` → `party <id> is not in signers`
  - a signer not in `transport.peers` → `signer <id> is not in the ring`
  - fewer signers than `publicKeyPackage.minSigners` → `signers needs at least <minSigners> entries, got <n>`

**Invariants:**
- Sighashes never leave the node; each signer derives them from the proposal.
- The nonce rules of `frost-sign-session.ts` hold on both roles; the session is destroyed on every exit path.
- A conflicting own `sign-r1` (reused `ceremonyId` within retention) throws from `BlobStore.put` before any share is computed.

**Cross-component contracts:**
- Depends on: `frost-sign-session.ts`, `messages.ts`, frots `verifySignature`, `CeremonyIo`.
- Used by: `LeaderDispatcher.sign` (`leadSigning`), `Orchestrator` (`participateInSigning`).

---

## src/testing/ (test only)

Test helpers; never imported by runtime code.

### `ring.ts`
- `interface RingNode { partyId: PartyId; io: CeremonyIo; server: BlobServer }`
- `makeRing(n: number, pullOpts?: Partial<PullOpts>): RingNode[]`
  - **Post:** An in-memory ring (`createInMemoryRing`) of `n` nodes, each with its own `BlobStore`, `BlobServer` and `BlobPuller`. Pull defaults: `maxAttempts 50`, `initialDelayMs 5`, `maxDelayMs 20`, `deadlineMs 3000`.

### `proposal.ts`
- `testVault(t: number, n: number): { keyPackages: KeyPackage[]; publicKeyPackage: PublicKeyPackage; vaultKey: VaultKey }`
  - **Post:** A real FROST DKG result (via Ötzi `runDkg`); `keyPackages[i]` belongs to partyId `i`; `vaultKey = toVaultKey(publicKeyPackage)`.
- `makeProposal(vaultKey: VaultKey, network: NetworkName, opts?: { inputs?: Array<{ amount: number; script?: string }>; outputs?: Array<{ address: string; amount: number }>; change?: number }): SendProposal`
  - **Post:** An unsigned transaction with random prevout txids, every input sequence `0xfffffffd`, lockTime 0. Defaults: one input of 100 000 sats paying the vault script; one external output of 50 000 sats; change of 49 000 sats back to the vault. `inputs[i].script` overrides the prevout script (for foreign-input tests). With defaults, `analyzeProposal(makeProposal(v, net), v, net)` succeeds.

---

## Cross-Module Summary

**Data flow:**
1. A trigger reaches `LeaderDispatcher` (leader) or a broadcast reaches `Orchestrator` (participant); both parse with `messages.ts`.
2. The ceremony (`runDkgCeremony`, `leadSigning`, `participateInSigning`) drives sessions, puts own blobs in `BlobStore`, pulls peers' blobs with `BlobPuller`.
3. `BlobServer` serves stored blobs to pulling peers, refusing addressed blobs to anyone but the recipient.
4. Sessions ingest pulled blobs through `addBlob(..., from)`, which applies sender binding.
5. When the ceremony ends on a node, `scheduleClear` clears its blobs after the retention period.

**Lifetime:**
- Transport + BlobStore + BlobServer + BlobPuller: daemon lifetime.
- Sessions: per ceremony (destroyed on every exit path).
- Blobs: until `scheduleClear` fires (5 min signing, 15 min DKG after the ceremony ends on this node).

**Error handling:**
- Transport null: retryable (BlobPuller backoff).
- BlobStore conflict: protocol violation, ceremony-fatal.
- `addBlob` → `{ ok: false }`: ceremony-fatal; the abort reason names the sender.
- DKG failure: `signoff-aborted` from the failing node (unless aborted by signal), `.pending` discarded.
- Signing failure after announce: the leader dispatcher broadcasts `signoff-aborted`.

**Contracts (formal):**

| Contract | Pre | Post | Throws |
|----------|-----|------|--------|
| BlobStore.put(key, blob) | key unique or blob byte-equal | Blob stored or conflict error | `Error("Conflicting blob...")` |
| BlobServer pull handler(from, key) | `from` authenticated | blob, or `null` (absent, or `key.to` set and ≠ `from`) | Never |
| BlobPuller.pullAll(keys, opts, signal?) | producers in ring; opts valid | All blobs in store | `Failed to fetch…`, `Deadline exceeded…`, `aborted` |
| Transport.pull(key) | key.from ∈ peers | blob bytes or null or transport error | Varies (peer-dependent) |
| Transport.broadcast(msg) | msg non-empty | msg delivered to all other peers with from=partyId | Varies (peer-dependent) |
| parseMessage(bytes) | — | valid `CeremonyMessage` or `null` | Never |
| FrostDkgSession.addBlob(s, blob, round, from) | `from` authenticated | stored, or `{ok:false}` naming `from` | Never |
| FrostSignSession.addBlob(s, blob, round, from) | `from` authenticated | stored, or `{ok:false}` naming `from` | Never |
| FrostSignSession.round2(s) | all commitments collected; not started | shares blob; `myNonces === null` | already started / missing commitments |
| runDkgCeremony(io, spec, stager, signal?) | announced; no vault | share committed, result returned | `DKG aborted: <reason>` |
| leadSigning(io, spec, proposal, signal?) | analysed + gated by caller | verified signatures, input order | on any failure / `aborted` |
| participateInSigning(io, spec, signal?) | participant checks passed | `sign-r1`, `sign-r2` produced | on any failure / `aborted` |

---

## Key Gotchas

1. **Addressed blobs:** `BlobServer` checks `key.to` against the requester. Never add a second serving path that skips this check.

2. **Sender binding lives in `addBlob`:** the Ötzi decoders do not bind blobs to senders (and the sign decoders do not check lengths). Always pass the authenticated `from`.

3. **BlobStore idempotency:** Re-putting IDENTICAL bytes is a silent no-op (no observer fire); re-putting DIFFERENT bytes is a protocol violation (immediate conflict throw). Codecs MUST be deterministic.

4. **Transport authenticated-from:** The `from` field in every broadcast/pull callback is cryptographically authenticated. Test transports (InMemoryTransport) MUST preserve this contract even when bypassing E2E encryption.

5. **Nonces:** `round2` sets `round2Started` before computing and leaves `myNonces === null`. Never cache or log nonce objects.

6. **FROST aggregate is deterministic:** All nodes with the same commitment and share sets get the same signatures; DKG verification relies on every node aggregating independently.

7. **partyId vs frostId:** 0-indexed partyId everywhere in headless; FROST uses 1-indexed bigint (`partyIdToFrostId` / `frostIdToPartyId` from `src/otzi/lib/dkg.ts`). Sign blobs carry the 16-bit identifier, which must equal `from + 1`.

8. **Wall-clock deadline:** BlobPuller deadline is absolute (since the `pullAll` call), NOT relative per key.

9. **BlobServer lifetime:** NOT ceremony-scoped; lives as long as the daemon. Retention, not the server, bounds how long blobs exist.

10. **Leader-participant asymmetry (signing):** Participants produce `sign-r1` and `sign-r2` and stop; only the leader pulls `sign-r2` and aggregates.
