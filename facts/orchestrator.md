# Contracts: src/orchestrator/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/orchestrator/

### `types.ts`
**Purpose:** Participant-side orchestrator dependencies, ceremony outcomes and the logger contract.

**Public surface:**
- `type OutcomeStatus = 'done' | 'aborted' | 'timeout' | 'rejected' | 'invalid-signoff'`

- `interface CeremonyOutcome { ceremonyId: string; kind: 'signing' | 'dkg'; status: OutcomeStatus; signaturesHex?: string[]; address?: string; reason?: string }`
  - **Post:**
    - `done` (signing): `signaturesHex` = the verified signatures from `signoff-done`.
    - `done` (DKG): `address` = the new vault address.
    - `rejected`: this node declined to take part (analysis or gate); `reason` says why.
    - `invalid-signoff`: the leader's `signoff-done` failed verification.
    - `aborted`: a `signoff-aborted` was accepted, or this node's ceremony failed; `reason` says why.
    - `timeout`: the ceremony deadline fired first.
  - **Throws:** Never (pure data).

- `Logger` — `{ debug; info; warn; error }`
  - **Pre:** All methods accept string message + optional metadata object.
  - **Post:** Methods return void; implementation decides whether to emit, buffer, or discard.
  - **Throws:** Never (caller must not depend on handler exceptions).

- `NOOP_LOGGER`
  - **Post:** Every method is a no-op; safe default when no logging is desired.

- `interface OrchestratorDeps`
  ```ts
  io: CeremonyIo; gate: ApprovalGate;
  node: { id: string; partyId: PartyId }; peersById: ReadonlyMap<PartyId, string>;
  network: NetworkName; vault?: DecryptedShare;
  vaultExists: () => Promise<boolean>; createStager: () => ShareStager;
  rng: Rng; ceremonyDeadlines: { signingMs: number; dkgMs: number };
  blobRetentionMs?: { signing: number; dkg: number };   // default BLOB_RETENTION_MS
  addressBook?: () => Promise<AddressBookEntry[]>;
  logger?: Logger;
  ```
  - **Pre:** `io.transport.partyId === node.partyId`; `peersById` holds every ring member, self included (`peersById.size` = ring size); `network` is the configured network; `vault` is the share loaded at startup (undefined on a node without a vault); `vaultExists` reports whether a file exists at the share path; `createStager` returns a fresh stager for the share path; deadlines are positive.
  - **Post:** Fully initializes a participant orchestrator; no lazy fields.

**Cross-component contracts:**
- Depends on: `CeremonyIo`, `ApprovalGate`, `DecryptedShare` (`src/otzi/lib/share-file.ts`), `ShareStager` (`src/core/dkg-ceremony.ts`), `AddressBookEntry`.
- Used by: `Orchestrator`, `LeaderDispatcher` (`Logger`), `Daemon`.

---

### `spec-builder.ts`
**Purpose:** Builds the `CeremonySpec` a gate evaluates, from data this node derived itself.

**Public surface:**
- `resolveLeaderId(from: PartyId, peersById: ReadonlyMap<PartyId, string>): string`
  - **Post:** Returns the label from the map, or the stringified `PartyId` as fallback.
  - **Throws:** Never.

- `buildSigningSpec(analysis: ProposalAnalysis, base: CeremonySpecBase, network: NetworkName, labelFor?: (address: string) => string | undefined): SigningSpec`
  - **Pre:** `analysis` is this node's own `analyzeProposal(proposal, toVaultKey(own publicKeyPackage), network)` result.
  - **Post:** `{ ...base, kind: 'signing', network, txid, inputs, outputs, amount, totalIn, totalOut, fee, vsize, feeRate }` with fields copied from `analysis`. Each output carries `address`, `amount`, `isChange`, and `label` when `labelFor(address)` returns one. `amount` = sum of outputs with `isChange === false`.
  - **Throws:** Never.

- `buildDkgSpec(base: CeremonySpecBase, p: { threshold: number; parties: number; network: NetworkName; peerIds: string[] }): DkgSpec`
  - **Post:** `{ ...base, kind: 'dkg', threshold, parties, network, peerIds }`.
  - **Throws:** Never.

**Invariants:**
- No spec field comes from the leader's announce except `ceremonyId`, the leader identity and the DKG parameters the receiver has already checked against its own configuration.

**Cross-component contracts:**
- Used by: `Orchestrator` (participant), `LeaderDispatcher` (leader).

---

### `orchestrator.ts`
**Purpose:** Long-lived participant-side listener. Parses ceremony messages, applies the participant checks, analyses proposals against this node's own key, gates, runs DKG and signing participation, verifies signoffs, enforces deadlines, and schedules blob cleanup.

**Public surface:**
- `class Orchestrator`
  - **`constructor(deps: OrchestratorDeps)`**
    - **Pre:** `deps.io.transport` is started; `deps.node.partyId === deps.io.transport.partyId`.
    - **Post:** Constructs internal state; does NOT subscribe or emit yet.

  - **`start(): void`**
    - **Post:** Subscribes to `io.transport.onBroadcast`; listener is active for daemon lifetime.
    - **Invariant:** Reentrant (returns early if already started).

  - **`stop(): void`**
    - **Post:** Unsubscribes from transport; aborts every live ceremony; clears all trackers and timers; wakes pending `waitFor` calls.
    - **Invariant:** Reentrant (returns early if not started).

  - **`onCompleted(handler: (o: CeremonyOutcome) => void): Unsubscribe`**
    - **Post:** Registers a listener that fires on every ceremony outcome.
    - **Throws:** Never (handler exceptions are NOT caught by orchestrator; caller must handle them).

  - **`waitFor(ceremonyId: string, timeoutMs?: number): Promise<CeremonyOutcome>`**
    - **Post:** Resolves when the ceremony settles on this node.
    - **Throws:** `Error` on timeout or orchestrator stopped before an outcome.
    - **Concurrency:** Multiple `waitFor` calls for the same ceremony all resolve/reject together.

**Message handling** (messages that fail `parseMessage` are dropped with a log line):

- **`announce-dkg`** — drop (log line with the reason) unless all of these hold:
  - no tracker exists for the `ceremonyId`;
  - `!deps.vault && !(await deps.vaultExists())` — this node holds no vault;
  - `network === deps.network`;
  - `parties === peersById.size` (the parser already guarantees `2 ≤ threshold ≤ parties`);
  - the gate approves `buildDkgSpec(base, { threshold, parties, network, peerIds })` with `role: 'participant'` and `leader = resolveLeaderId(from)`.

  Then: create a tracker (leader pinned = sender), start the `dkgMs` deadline, and run `runDkgCeremony(io, { ceremonyId, sessionId, threshold, parties, network, rng }, createStager(), signal)` with an `AbortController` signal. Success settles `done` with `address` (`vaultPayment(toVaultKey(publicKeyPackage), network).address`); a failure settles `aborted` with the reason; the deadline aborts the controller and settles `timeout`.

- **`announce-sign`** — drop (log line with the reason) unless all of these hold:
  - no tracker exists for the `ceremonyId` — the sender of the first announce is pinned as leader;
  - this node has a vault loaded (`deps.vault`);
  - this node and the sender are in `signers`; `signers` has no duplicates, contains only ring members, and has at least `vault.threshold` entries;
  - the proposal has at most 255 inputs (`MAX_INPUTS`; the parser enforces it on `prevouts`);
  - `analyzeProposal(proposal, toVaultKey(vault.publicKeyPackage), deps.network)` succeeds;
  - the gate approves `buildSigningSpec(analysis, base, network, labelFor)`, with labels from `deps.addressBook` when present (a failed address-book read means no labels).

  Then: keep the analysed sighashes for signoff verification, start the `signingMs` deadline, and run `participateInSigning(io, { ceremonyId, signers, sighashes, keyPackage, publicKeyPackage, rng }, signal)`. A failure settles `aborted` with the reason; success leaves the tracker live until a signoff or the deadline (`timeout`).

- **`signoff-done`** — accepted only from the pinned leader of a live signing tracker. Settles `done` (with `signaturesHex`) when the count equals the kept sighash count and every signature passes `verifySignature(sig, sighash, vault.publicKeyPackage.verifyingKey)`; otherwise logs at error level and settles `invalid-signoff`.

- **`signoff-aborted`** — for signing, accepted only from the pinned leader; for DKG, from any ring member. Aborts the tracker's controller and settles `aborted` with the message's `reason`.

**Settle:** clears the deadline timer, removes the tracker, calls `scheduleClear(io.store, ceremonyId, retention)` with the kind's retention (`blobRetentionMs ?? BLOB_RETENTION_MS`), emits the outcome, logs at info level. A `settled` flag prevents double settlement.

**Rejected participation:** a failed analysis or a gate non-approve (`reject`, `pending`, or a gate that throws) sends nothing to peers and settles the ceremony as `rejected` with the reason. Drops that do not concern a new ceremony — an announce for a `ceremonyId` with a live tracker, a signoff from anyone but the pinned leader (signing), messages for unknown ceremonies — are logged only.

**Invariants:**
- Orchestrator is a long-lived listener, NOT per-ceremony.
- First announce wins: once a tracker is live, its leader cannot change and no second announce for that `ceremonyId` is processed.
- Verify-before-gate: the gate never sees a spec this node did not derive from its own analysis.
- No DKG while a vault exists: the vault check runs on every `announce-dkg`. A `.pending` file does not count as a vault; a committed share file does.
- Silent drops (failed checks, failed analysis, gate non-approve) are indistinguishable from offline to peers.
- Participant never sends a signoff for signing; for DKG, `runDkgCeremony` broadcasts `signoff-aborted` on its own failure.
- Every settle schedules exactly one blob clear.

**Cross-component contracts:**
- Depends on: `Transport.onBroadcast`, `parseMessage`, `runDkgCeremony`, `participateInSigning`, `analyzeProposal` / `toVaultKey` / `vaultPayment` (`src/otzi/lib`), frots `verifySignature`, `ApprovalGate.approve`, `scheduleClear`.
- Used by: `Daemon` (instantiated once; `onCompleted` wired for logging).

**Notes / gotchas:**
- A node that completes a DKG keeps running without the new vault loaded; signing on it starts after a daemon restart. Its `vaultExists()` is true from the commit on, so a second DKG is refused.
- The ceremony deadline is the safety net for a crashed leader or a lost signoff.
- `waitFor` is used by tests; runtime code reacts through `onCompleted`.

---
