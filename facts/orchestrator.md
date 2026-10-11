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
  - **Pre:** `io.transport.partyId === node.partyId`; `peersById` holds every ring member, self included (`peersById.size` = ring size); `network` is the configured network; `vault` is the share loaded at startup (undefined on a node without a vault); `vaultExists` reports whether a file exists at the share path; `createStager` returns a fresh stager for the share path; `io.pullOpts` supplies the pull backoff (`initialDelayMs`, `maxDelayMs`) — participant ceremonies replace its `deadlineMs` and `maxAttempts` (see *Participant pulls*); `addressBook` returns this node's address-book entries; deadlines are positive.
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
**Purpose:** Long-lived participant-side listener. Parses ceremony messages, applies the participant checks, analyses proposals against this node's own key, gates, runs DKG and signing participation, verifies signoffs, enforces deadlines, schedules blob cleanup, holds this node's single DKG slot, and reserves the ids of ceremonies this node leads.

**Public surface:**
- `class Orchestrator`
  - **`constructor(deps: OrchestratorDeps)`**
    - **Pre:** `deps.io.transport` is started; `deps.node.partyId === deps.io.transport.partyId`.
    - **Post:** Constructs internal state; does NOT subscribe or emit yet.

  - **`start(): void`**
    - **Post:** Subscribes to `io.transport.onBroadcast`; listener is active for daemon lifetime.
    - **Invariant:** Reentrant (returns early if already started).

  - **`stop(): void`**
    - **Post:** Unsubscribes from transport; aborts every live ceremony, the local DKG slot included, and schedules the blob clear (`scheduleClear`, the kind's retention) of every live tracker's ceremony, so DKG secret shares never stay in memory past the retention period; clears all trackers, records (settled outcomes and ended local slots), local signing reservations and timers; wakes pending `waitFor` calls. Ceremonies cut short by `stop` emit no outcome. A joined DKG still unwinding keeps the DKG slot until its ceremony promise settles.
    - **Invariant:** Reentrant (returns early if not started).

  - **`onCompleted(handler: (o: CeremonyOutcome) => void): Unsubscribe`**
    - **Post:** Registers a listener that fires on every ceremony outcome.
    - **Throws:** Never. A handler that throws is logged at error level; the exception never reaches the transport, a timer or a promise chain, and the other handlers still run.

  - **`waitFor(ceremonyId: string, timeoutMs?: number): Promise<CeremonyOutcome>`**
    - **Post:** Resolves when the ceremony settles on this node; resolves at once with the recorded outcome when it settled within its retention period. `timeoutMs` defaults to 60 000.
    - **Throws:** `Error` on timeout or orchestrator stopped before an outcome.
    - **Concurrency:** Multiple `waitFor` calls for the same ceremony all resolve/reject together.

  - **`beginLocalDkg(ceremonyId: string): { signal: AbortSignal; end(): void } | null`**
    - **Post:** Returns `null` when any DKG is live on this node (see *At most one live DKG per node*) or when `ceremonyId` is taken (see *Ids this node leads*). Otherwise registers `ceremonyId` as this node's local DKG and returns its slot: `signal` aborts when a ring member's DKG `signoff-aborted` for `ceremonyId` arrives or `stop()` runs; `end()` releases the slot and records `ceremonyId` as ended for the DKG retention period (`blobRetentionMs ?? BLOB_RETENTION_MS`), the same record and expiry settled ceremonies get. `end()` is idempotent (it never releases a later slot and records only once).
    - **Throws:** Never.
    - **Used by:** `LeaderDispatcher.runDkg` (409 `a DKG is already running on this node` on `null` once `ceremonyIdInUse` was false; combines `signal` with its ceremony deadline for `runDkgCeremony`; calls `end()` in `finally`).

  - **`beginLocalSigning(ceremonyId: string): { end(): void } | null`**
    - **Post:** Returns `null` when `ceremonyId` is taken (see *Ids this node leads*). Otherwise reserves `ceremonyId` as a signing ceremony this node leads and returns its slot; `end()` releases it and records `ceremonyId` as ended for the signing retention period, like `beginLocalDkg`. `end()` is idempotent (it never releases a later reservation of the same id and records only once). Any number of local signing ceremonies with distinct ids can be live.
    - **Throws:** Never.
    - **Used by:** `LeaderDispatcher.sign` (409 `ceremony id <id> is already in use on this node` on `null`; calls `end()` in `finally`).

  - **`ceremonyIdInUse(ceremonyId: string): boolean`**
    - **Post:** `true` iff `ceremonyId` is taken (see *Ids this node leads*). Read-only.
    - **Throws:** Never.
    - **Used by:** `LeaderDispatcher.runDkg`, to answer a reused id with `ceremony id <id> is already in use on this node` rather than the live-DKG 409; `LeaderDispatcher.sign`, to answer a reused id with that 409 before the analysis and the gate, so no approval is consumed for a request refused anyway.

**At most one live DKG per node.** Two concurrent DKGs would share one `.pending` path and could commit a share that never passed the all-N confirmation. A DKG is live while a local DKG slot is held, while a DKG tracker exists, and while a joined DKG's `runDkgCeremony` has not settled — its `stage`, `commit` or `discard` can outlast the tracker (an abort or deadline settles the tracker at once), so the slot is held until the ceremony promise settles, also after `stop()`. `beginLocalDkg` returns `null` and `announce-dkg` is dropped while a DKG is live.

**Ids this node leads.** A `ceremonyId` is taken while it has a live tracker, an outcome recorded within its retention period, a local DKG slot, a local signing slot, or a local slot that ended within its retention period (`end()` records it). `beginLocalDkg` and `beginLocalSigning` refuse a taken id, and an announce whose id is held by a local slot, live or ended, is dropped (see the duplicate checks), so a ceremony this node leads never shares its id — its blobs and its scheduled clear — with another ceremony on this node, led or joined, until its blobs are cleared. Reusing a led id within retention is therefore a 409 on the leader before anything is announced.

**Message handling.** A message that fails `parseMessage` is dropped with a warn line. Every drop logs exactly one line naming the ceremony, the sender and the reason: warn for suspicious input (a parse failure, an announce or signoff from anyone but the pinned leader, a check below that fails on the leader's data), info or debug for benign cases (a duplicate announce, a ceremony that already ended here, this node not in `signers`, a signoff for a ceremony unknown here).

Every announce first passes the duplicate checks: no tracker exists for the `ceremonyId` (an announce for a live tracker is dropped: warn when the sender is not the pinned leader or the kind differs, info for a duplicate from the leader); the `ceremonyId` is not held by a local DKG or signing slot, live or ended within its retention period (warn); and no ceremony with that `ceremonyId` settled on this node within its retention period (info) — reusing an id within retention would collide with its stored blobs and its scheduled clear.

- **`announce-dkg`** — drop unless all of these hold, in this order:
  1. the sender is a ring member (`peersById.has(from)`; the transport already authenticates ring members — defence in depth);
  2. the duplicate checks;
  3. no DKG is live on this node (local slot, participant tracker, or a joined DKG still unwinding);
  4. `network === deps.network`;
  5. `parties === peersById.size` (the parser already guarantees `2 ≤ threshold ≤ parties`);
  6. no share is loaded (`!deps.vault`);
  7. `await deps.vaultExists()` is `false` (a throw is a drop) — a `.pending` file does not count;
  8. the gate approves `buildDkgSpec({ ceremonyId, leader: resolveLeaderId(from), role: 'participant' }, { threshold, parties, network, peerIds })`, with `peerIds` = every `peersById` label in party order.

  Before step 7 the orchestrator creates the tracker (leader pinned = sender, which also takes the DKG slot) and starts the `dkgMs` deadline; a drop at step 7 removes the tracker without an outcome. Then: run `runDkgCeremony(io, { ceremonyId, sessionId, threshold, parties, network, rng }, createStager(), signal)` with the tracker's `AbortController` signal. Success settles `done` with `address` (`vaultPayment(toVaultKey(publicKeyPackage), network).address`); a failure settles `aborted` with the reason. A `DkgShareKeptError` (the ceremony failed after this node published its `dkg-verified`, so its staged share was kept) settles `aborted` at error level; when the tracker had already settled (a ring member's `signoff-aborted`, the deadline, `stop()`), it is logged at error level on its own line. Either way the line carries the kept path and the recovery. `createStager` is called only here.

- **`announce-sign`** — drop unless all of these hold, in this order:
  1. the duplicate checks — the sender of the first announce is pinned as leader;
  2. this node has a vault loaded (`deps.vault`);
  3. this node is in `signers` (info when not); the sender is in `signers`; `signers` has no duplicates, contains only ring members, and has at least `vault.threshold` entries;
  4. the proposal has at most 255 inputs (`MAX_INPUTS`; the parser enforces it on `prevouts`);
  5. `analyzeProposal(proposal, toVaultKey(vault.publicKeyPackage), deps.network)` succeeds;
  6. the gate approves `buildSigningSpec(analysis, { ceremonyId, leader: resolveLeaderId(from), role: 'participant' }, network, labelFor)`. With `deps.addressBook`, `labelFor(address)` is otzi `labelFor(entries, address)`; a rejected `addressBook()` means no labels and one warn line, never a failed ceremony.

  Before step 5 the orchestrator creates the tracker (leader pinned = sender) and starts the `signingMs` deadline. Then: keep the analysed sighashes for signoff verification and run `participateInSigning(io, { ceremonyId, signers, sighashes, keyPackage, publicKeyPackage, rng }, signal)`. A failure settles `aborted` with the reason; success leaves the tracker live until a signoff or the deadline (`timeout`).

- **`signoff-done`** — accepted only from the pinned leader of a live signing tracker. Settles `done` (with `signaturesHex`) when the count equals the kept sighash count and every signature passes `verifySignature(sig, sighash, vault.publicKeyPackage.verifyingKey)`; otherwise settles `invalid-signoff`, logged at error level.

- **`signoff-aborted`** — for signing, accepted only from the pinned leader; for DKG, from any ring member. Aborts the tracker's controller and settles `aborted` with the message's `reason` (or `aborted by party <from>` without one). A DKG `signoff-aborted` from any ring member for the `ceremonyId` of the local DKG slot aborts the slot's `signal`.

**Rejected participation vs. structural drops.** A failed analysis (step 5 of `announce-sign`) or a gate non-approve (`reject`, `pending`, or a gate that throws; either kind) sends nothing to peers and settles the ceremony as `rejected` with the reason, so `waitFor` resolves and `onCompleted` fires. Every earlier check is a structural drop: a parse failure, a non-leader or duplicate announce, a ceremony that already ended, a live DKG, a wrong network or party count, a vault present for a DKG, a signer-list failure, or no vault for signing. A structural drop is logged only — no tracker survives it and no outcome is emitted.

**Gate:** evaluated once per ceremony (signing has no retries; a second announce for the `ceremonyId` is a duplicate). A gate that throws counts as `reject`.

**Deadline:** starts when the tracker is created, so it covers the gate decision; an `exec` or `webhook` decision must arrive within the ceremony deadline. When it fires it aborts the tracker's controller and settles `timeout`.

**Participant pulls:** each ceremony runs on `{ ...io, pullOpts: { ...io.pullOpts, deadlineMs, maxAttempts: Number.MAX_SAFE_INTEGER } }` with `deadlineMs` = `signingMs` or `dkgMs`, so pulls are bounded by the ceremony deadline, not by an attempt count — a peer waiting on a slow gate is not given up on early.

**Settle:** sets the `settled` flag (no double settlement), clears the deadline timer, aborts the tracker's controller, removes the tracker, calls `scheduleClear(io.store, ceremonyId, retention)` with the kind's retention (`blobRetentionMs ?? BLOB_RETENTION_MS`), records the outcome for the same retention period, logs one line (info for `done` and a gate `rejected`; warn for `aborted`, `timeout` and an analysis or gate-error `rejected`; error for `invalid-signoff`) and emits the outcome.

**Invariants:**
- Orchestrator is a long-lived listener, NOT per-ceremony.
- First announce wins: once a tracker is live, its leader cannot change and no second announce for that `ceremonyId` is processed.
- Verify-before-gate: the gate never sees a spec this node did not derive from its own analysis.
- No DKG while a vault exists: the vault check runs on every `announce-dkg`. A `.pending` file does not count as a vault; a committed share file does.
- At most one live DKG per node, whichever node leads it.
- Silent drops (failed checks, failed analysis, gate non-approve) are indistinguishable from offline to peers.
- Participant never sends a signoff for signing; for DKG, `runDkgCeremony` broadcasts `signoff-aborted` on its own failure (not when aborted by signal).
- Every settle schedules exactly one blob clear, and so does `stop()` for every live tracker.
- No promise the orchestrator starts rejects unhandled: every ceremony chain ends in a `catch` that logs at error level, and `onCompleted` handlers run isolated.

**Cross-component contracts:**
- Depends on: `Transport.onBroadcast`, `parseMessage`, `runDkgCeremony`, `participateInSigning`, `analyzeProposal` / `toVaultKey` / `vaultPayment` / `labelFor` (`src/otzi/lib`), frots `verifySignature`, `ApprovalGate.approve`, `scheduleClear`.
- Used by: `Daemon` (instantiated once; `onCompleted` forwarded by `Daemon.onCompleted`; passed to the leader as its `LocalCeremonySlots`), `LeaderDispatcher` (`beginLocalDkg`, `beginLocalSigning`, `ceremonyIdInUse`).

**Notes / gotchas:**
- A node that completes a DKG keeps running without the new vault loaded; signing on it starts after a daemon restart. Its `vaultExists()` is true from the commit on, so a second DKG is refused.
- A DKG that commits after its tracker settled (an abort raced the commit) logs a warn line: the share is on disk although the outcome is not `done`. A node that has verified all N−1 confirmations commits even when its tracker was aborted meanwhile (core.md, `runDkgCeremony`).
- The ceremony deadline is the safety net for a crashed leader or a lost signoff.
- `waitFor` is used by tests; runtime code reacts through `onCompleted`.

---
