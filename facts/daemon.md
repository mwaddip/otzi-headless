# Contracts: src/daemon/, src/cli/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/daemon/

### `config-merge.ts`
**Purpose:** Loads the daemon TOML config, the share password and the v4 share (if present) into `LoadedDaemonState`.

**Public surface:**
- `interface LoadedDaemonState { config: DaemonConfig; share?: DecryptedShare; password: string }`
  - **Post:** `share` is the decrypted v4 share, checked against `config.network.name`; `undefined` on a node without a vault (no file at `[share].path`). `password` is kept in memory so a DKG on this node can encrypt its new share with it.
  - **Invariant:** `share` presence gates signing; a node without a share can run the run-once DKG.

- `async loadAndValidate(configPath: string, options?: { env?: Readonly<Record<string, string | undefined>>; vaultPubkeyPath?: string; logger?: Logger }): Promise<LoadedDaemonState>`
  - **Options (defaults):** `env` — `process.env`; `vaultPubkeyPath` — `DEFAULT_VAULT_PUBKEY_PATH` (tests and alternate installs pass their own path so nothing is written to `/var/lib/otzi`); `logger` — `NOOP_LOGGER`.
  - **Pre:** `configPath` is a readable `daemon.toml`. The share password is in the env var named by `[share].password_env` (in `options.env`).
  - **Post:** Config parsed (`parseDaemonConfigToml`); `share = await loadVaultShare(config.share.path, password, config.network.name)`; when a share was loaded, `removeCommittedStaging(config.share.path, logger)` first removes a `.pending` that is the share's own file (info line, no warning); otherwise `warnOnPendingShare(config.share.path, logger)` reports a `.pending` file next to the share path, which is never loaded. Whenever a share is loaded, `vault-pubkey.json` is rewritten from it (`writeVaultPubkeyFile(vaultPubkeyFromPackage(share.publicKeyPackage, network), vaultPubkeyPath)`), in addition to the write on DKG commit. The rewrite is best-effort: a write failure is logged at warn level through `logger` and does not stop startup.
  - **Ownership:** the startup `vault-pubkey.json` rewrite and the `.pending` warning both happen here and nowhere else at startup; `runDaemonCommand` passes its logger and does not warn a second time.
  - **Throws:** `ConfigError` / TOML errors; `Error` naming the env var when the password is missing or empty; every `loadVaultShare` error (wrong password, network mismatch, corrupted file).

**Invariants:**
- The password env var MUST be set even without a share (the DKG encrypts the new share with it).
- No partial state: a share that fails any check refuses startup; it is never treated as "no vault".
- A node with a loaded share always has a current `vault-pubkey.json` after startup (barring a logged write failure), including a node whose share came from web Ötzi or a restore.

**Cross-component contracts:**
- Depends on: `loadDaemonConfig` / `parseDaemonConfigToml`, `vault-share.ts`, `vault-pubkey.ts`.
- Used by: `entrypoint.ts` (`runDaemonCommand`), tests.

---

### `vault-share.ts`
**Purpose:** Load, stage, commit and discard v4 share files.

**Public surface:**
- `pendingPath(path: string): string`
  - **Post:** `` `${path}.pending` ``.

- `async vaultFileExists(path: string): Promise<boolean>`
  - **Post:** `true` iff a file system entry exists at `path`; `false` on ENOENT.
  - **Throws:** Any other `stat` error.

- `async loadVaultShare(path: string, password: string, network: NetworkName): Promise<DecryptedShare | undefined>`
  - **Post:** Reads the JSON at `path`, `decryptShareFile(raw, password)`, checks `share.network === network`, then `assertShareMatchesVault(share, network)`; returns the share. Returns `undefined` when `path` does not exist (ENOENT).
  - **Throws:**
    - invalid JSON → `Error('share file <path> is not valid JSON', { cause })`;
    - any `decryptShareFile` failure other than otzi's own messages (`Unsupported share file version`, `Share file is corrupted`, `This share file belongs to a different vault`), i.e. a wrong password or ciphertext that does not decode → `Error('cannot decrypt share file <path>: wrong password or corrupted file', { cause })`; otzi's own messages pass through unchanged;
    - network mismatch → `Error('share file <path> is for <share network>, [network].name is <configured network>')`;
    - other read errors (anything but ENOENT).
  - **Invariant:** the password is never logged and never part of an error message.

- `async removeCommittedStaging(path: string, log: Logger): Promise<boolean>`
  - **Post:** When `pendingPath(path)` and `path` are both regular files (`lstat`, no symlinks) with the same device and inode — the second name `commit` leaves when its `unlink` after the `link` failed — unlinks `pendingPath(path)`, logs one info line naming both, and returns `true`; a failed unlink is a warn line (remove it by hand) and also returns `true`. In every other case (no share, no `.pending`, a different file, a symlink, any `lstat` error) it touches nothing, logs nothing and returns `false`. The file is the committed share itself, so there is nothing to recover and no rename or overwrite advice.

- `async warnOnPendingShare(path: string, log: Logger): Promise<void>`
  - **Post:** When `pendingPath(path)` exists, logs one warn line naming it: it is left over from an unfinished DKG and is not loaded; it may be this node's share of a vault the other nodes committed — when `otzi vault` on another node shows that vault, rename it to `path` and restart; otherwise the next DKG overwrites it. When the file's plaintext header (`network`, `internalKey`) reads, the line names the vault address (`vaultPaymentFromInternalKey`); the file is never decrypted. Otherwise does nothing.

- `interface ShareStagerOptions { path: string; password: string; network: NetworkName; partyId: PartyId; vaultPubkeyPath?: string; logger?: Logger }`
  - `logger` (default `NOOP_LOGGER`) receives the warnings `commit` logs once the share is in place.

- `createShareStager(opts: ShareStagerOptions): ShareStager`
  - **`sharePath`** = `path`; **`stagedPath`** = `pendingPath(path)`.
  - **`stage(r)`:** writes `JSON.stringify(await encryptShareFile(r.keyPackage, r.publicKeyPackage, network, partyId, password))` to `pendingPath(path)` with mode 0600, creating the parent directory and overwriting any earlier `.pending`; then fsyncs the file and its directory. It resolves only once the staged share is durable, because the DKG publishes this node's confirmation right after it.
  - **`commit()`:**
    - **Pre:** `stage` resolved.
    - **Post:** `link(pendingPath(path), path)` — no-clobber: a link never replaces an existing entry — fsync of the directory (the new name is durable before the old one goes), `unlink(pendingPath(path))`, fsync of the directory again, and `writeVaultPubkeyFile(vaultPubkeyFromPackage(r.publicKeyPackage, network), vaultPubkeyPath)`. Once the link succeeded the share is in place and `commit` resolves: a failure to fsync the directory after the link (the staging file is then kept and not unlinked), to unlink the staging file, to fsync the directory after the unlink or to write `vault-pubkey.json` is logged at warn level naming the path (the daemon rewrites `vault-pubkey.json` on its next start; a leftover `.pending` is the same file as the share, and the next start removes it with `removeCommittedStaging`).
    - **Throws:** (nothing placed at `path` in each case)
      - `Error('share path already exists: <path>')` when an entry exists at `path` (EEXIST from the link, a dangling symlink included);
      - `Error('commit called before stage')` when `stage` has not resolved;
      - any other `link` error.
  - **`discard()`:** removes `pendingPath(path)` only when this stager instance wrote it (its `stage` created the file, and `commit` has not since linked it into place); ENOENT is ignored. A `discard` before or without a `stage` is a no-op and leaves any existing `.pending` alone: that file may be the share this node kept after publishing its `dkg-verified` in an earlier ceremony (ruling R41), and a later DKG that fails before staging (`otzi generate`, or an `announce-dkg` the committed nodes drop) must not delete it. `runDkgCeremony` calls it only before this node published its `dkg-verified`.

**Invariants:**
- A share reaches `path` only through `commit`, i.e. only after the DKG's all-N confirmation, and `commit` never replaces an entry at `path`.
- Share files are mode 0600 from the first byte written (`.pending` and after the commit).
- The staged share is synced to disk before the node's confirmation is published, and the directory is synced between the commit's link and unlink and after the unlink.
- Share files are byte-compatible with web Ötzi in both directions.

**Cross-component contracts:**
- Depends on: `encryptShareFile`, `decryptShareFile`, `assertShareMatchesVault` (`src/otzi/lib/share-file.ts`), `vaultPaymentFromInternalKey` (`src/otzi/lib/bitcoin.ts`), `vault-pubkey.ts`.
- Used by: `config-merge.ts` (`loadVaultShare`, `removeCommittedStaging`, `warnOnPendingShare`), `Daemon` (`vaultFileExists`, `createShareStager` for orchestrator and leader).

---

### `vault-pubkey.ts`
**Purpose:** The public vault metadata file `/var/lib/otzi/vault-pubkey.json`, so the CLI can build transactions and show the vault without decrypting the share.

**Public surface:**
- `const DEFAULT_VAULT_PUBKEY_PATH = '/var/lib/otzi/vault-pubkey.json'`

- `interface VaultPubkeyFile { network: NetworkName; address: string; internalKey: string; outputKey: string; threshold: number; parties: number; vaultKey: VaultKey }`
  - **Schema:**
    ```json
    {
      "network": "mainnet" | "testnet4" | "signet",
      "address": "<bech32m P2TR, bc1p… / tb1p…>",
      "internalKey": "<33-byte SEC1 hex = vaultKey.untweakedVerifyingKey>",
      "outputKey": "<32-byte x-only hex = vaultPayment(vaultKey, network).outputKey>",
      "threshold": 3,
      "parties": 3,
      "vaultKey": { "minSigners": 3, "verifyingKey": "…", "untweakedVerifyingKey": "…", "verifyingShares": {…}, "untweakedVerifyingShares": {…} }
    }
    ```
    `vaultKey` is Ötzi's public `VaultKey`, needed by `buildSend` in the CLI.

- `vaultPubkeyFromPackage(publicKeyPackage: PublicKeyPackage, network: NetworkName): VaultPubkeyFile`
  - **Post:** `vaultKey = toVaultKey(publicKeyPackage)`; `address` / `outputKey` from `vaultPayment(vaultKey, network)`; `internalKey = vaultKey.untweakedVerifyingKey`; `threshold = minSigners`; `parties` = number of verifying shares.
  - **Throws:** Never.

- `async writeVaultPubkeyFile(file: VaultPubkeyFile, outputPath?: string): Promise<void>`
  - **Post:** Creates the parent directory; writes pretty-printed JSON to a temporary file beside `outputPath` (default `DEFAULT_VAULT_PUBKEY_PATH`) with mode 0644 (chmod applied after write), fsyncs it and renames it over `outputPath`. A reader sees the old file or the new one, never a partial one, and an existing file is replaced whatever its owner or mode. On failure the temporary file is removed.

- `async readVaultPubkeyFile(path?: string): Promise<VaultPubkeyFile>`
  - **Post:** Parsed file at `path` (default `DEFAULT_VAULT_PUBKEY_PATH`).
  - **Throws:** ENOENT → `Error` pointing the operator at `otzi generate`; malformed JSON or missing fields → `Error`.

**Invariants:**
- Every value is public; mode 0644 lets `otzi` group members and other users run read-only CLI commands.
- Written:
  - at daemon startup whenever a share is loaded (`loadAndValidate`, at its `vaultPubkeyPath` option; best-effort — a write failure is logged and does not stop startup);
  - by the share stager's `commit()` after a DKG completes (best-effort: a write failure is logged at warn level, the share is in place).

**Cross-component contracts:**
- Depends on: `toVaultKey`, `vaultPayment` (`src/otzi/lib`).
- Written by: `config-merge.ts` (`loadAndValidate` at startup, path from its `vaultPubkeyPath` option), `vault-share.ts` (`createShareStager().commit()`, path from `ShareStagerOptions.vaultPubkeyPath`).
- Consumed by: `otzi vault` (read-only; checked against the daemon's `vault-info`, since any member of the `otzi` group can rewrite the file), `otzi btc balance|send|sign` (read-only).

---

### `api.ts`
**Purpose:** Daemon API request parsing and input rules (spec §6.1).

**Public surface:**
- `class RequestError extends Error { constructor(readonly status: 400 | 409, message: string) }`
- `const NO_VAULT_MESSAGE = 'no vault loaded — run otzi generate, then restart the daemon'` — the 409 text for every op that needs a loaded vault (`vault-info`, `sign`).
- `interface LeaderSignRequest { ceremonyId: string; signers: PartyId[]; proposal: SendProposal }`

- `defaultCeremonyId(op: 'dkg' | 'sign'): string`
  - **Post:** `` `${op}-${crypto.randomUUID()}` `` (matches `CEREMONY_ID_RE`).

- `parseVaultInfoRequest(body: Record<string, unknown>): void`
  - **Post:** Allowed key: `op`.
  - **Throws:** `RequestError(400, "unknown field '<key>'")` on any other key.

- `parseDkgRequest(body: Record<string, unknown>): { ceremonyId: string }`
  - **Pre:** `body` is the JSON request object (`op === 'dkg'`).
  - **Post:** Allowed keys: `op`, `ceremonyId`. `ceremonyId` must satisfy `isCeremonyId` when present; `defaultCeremonyId('dkg')` when absent.
  - **Throws:** `RequestError(400, …)` on any other key or an invalid `ceremonyId` (texts below).

- `parseProposal(raw: unknown): SendProposal`
  - **Post:** The `proposal` rules of `parseSignRequest` on their own: an object with string `tx` and array `prevouts` of at most `MAX_INPUTS`; `tx`, `prevouts[].txid` and `prevouts[].script` lowercased into a new object (the input is not mutated); the result passes `isProposalShape`.
  - **Throws:** `RequestError(400, <reason>)`, with the proposal rows of the error table below.
  - **Notes:** Also used by `otzi btc sign`, so the CLI refuses exactly what the daemon refuses.

- `parseSignRequest(body: Record<string, unknown>, ring: { partyIds: readonly PartyId[]; self: PartyId; minSigners: number }): LeaderSignRequest`
  - **Pre:** `body` is the JSON request object (`op === 'sign'`); `ring.partyIds` = every ring member; `ring.minSigners` = the loaded share's threshold.
  - **Post:** Allowed keys: `op`, `ceremonyId`, `signers`, `proposal`.
    - `ceremonyId`: `isCeremonyId` when present; `defaultCeremonyId('sign')` when absent.
    - `signers`: defaults to all of `ring.partyIds` (ascending); otherwise an array of safe integers, unique, each in `ring.partyIds`, containing `ring.self`, with at least `ring.minSigners` entries.
    - `proposal`: `parseProposal(body.proposal)`.
  - **Throws:** `RequestError(400, <reason>)` on any violation.
  - **Notes:** Shape and ring rules only; `analyzeProposal` runs in `LeaderDispatcher.sign`.

- **Error texts** (`RequestError(400, …)`, exact; checked in this order: keys, `ceremonyId`, `signers`, `proposal`):

  | Rule | Text |
  |---|---|
  | key other than the allowed ones | `unknown field '<key>'` |
  | `ceremonyId` fails `isCeremonyId` | `ceremonyId must match ^[A-Za-z0-9._:-]{1,128}$` |
  | `signers` not an array of safe integers | `signers must be an array of party ids` |
  | duplicate signer | `signers must be unique` |
  | signer not in `ring.partyIds` | `signer <id> is not in the ring` |
  | `ring.self` missing | `signers must include this node (party <self>)` |
  | fewer than `ring.minSigners` | `signers needs at least <minSigners> entries, got <n>` |
  | `proposal` not an object with string `tx` and array `prevouts` | `proposal must be an object with string tx and array prevouts` |
  | more than 255 prevouts | `proposal has <k> inputs; at most 255 fit in one transaction` |
  | `isProposalShape` fails | `proposal does not have the expected shape { network, tx, prevouts: [{ txid, vout, amount, script }] }` |

**Cross-component contracts:**
- Depends on: `isCeremonyId`, `isProposalShape`, `MAX_INPUTS` (`src/core/messages.ts`).
- Used by: `buildDefaultHttpHandler`, `LeaderDispatcher` (`RequestError`, `NO_VAULT_MESSAGE`), `src/cli/cmd/btc.ts` (`parseProposal`).

---

### `leader.ts`
**Purpose:** Leader-side ceremony dispatcher: the leader half of the DKG and of proposal signing.

**Public surface:**
- `class GateRejection extends Error { constructor(readonly ceremonyId: string, readonly decision: Decision) }`
  - **Post:** Thrown when the leader's own gate does not approve (`reject`, `pending`, or a gate that throws, which counts as `reject` and is logged at warn); the handler maps it to 403. Nothing was announced.

- `interface LocalCeremonySlots`
  ```ts
  beginLocalDkg(ceremonyId: string): { signal: AbortSignal; end(): void } | null;
  beginLocalSigning(ceremonyId: string): { end(): void } | null;
  ceremonyIdInUse(ceremonyId: string): boolean;
  ```
  - **Post:** This node's DKG slot and its led-signing id reservations (see [orchestrator.md](orchestrator.md), `beginLocalDkg` / `beginLocalSigning` / `ceremonyIdInUse`). Implemented by `Orchestrator`; the daemon passes its one orchestrator. An id this node led stays taken for its retention period after `end()`, so reusing it is a 409 before anything is announced.

- `interface LeaderDeps`
  ```ts
  io: CeremonyIo; gate: ApprovalGate; node: { id: string; partyId: PartyId };
  peersById: ReadonlyMap<PartyId, string>; network: NetworkName; vault?: DecryptedShare;
  vaultExists: () => Promise<boolean>; createStager: () => ShareStager; rng: Rng;
  ceremonyDeadlines: { signingMs: number; dkgMs: number };   // config.deadlines
  slots: LocalCeremonySlots;
  blobRetentionMs?: { signing: number; dkg: number };   // default BLOB_RETENTION_MS
  addressBook?: () => Promise<AddressBookEntry[]>; logger?: Logger;
  ```
  - **Pre:** Same meaning as the matching `OrchestratorDeps` fields; the daemon passes the same values to both, and `slots` is the same orchestrator.

- **Ceremony deadline:** each ceremony the leader runs is bounded as a whole. From the ceremony start (just before the announce) an `AbortController` is aborted after `ceremonyDeadlines.signingMs` / `dkgMs`; its timer is cleared in a `finally`.
  - Signing: the controller's signal is `leadSigning`'s `signal`. A deadline abort fails the request with `Error('ceremony deadline of <ms> ms passed')` (500), and `signoff-aborted` carries that reason.
  - DKG: the controller's signal is combined with the slot signal (`AbortSignal.any`) for `runDkgCeremony`, which takes its abort path (stager `discard` before this node's confirmation, the staged share kept after it; no broadcast of its own). When the deadline, not the slot, aborted it, the leader broadcasts `signoff-aborted {ceremonyId, reason: 'ceremony deadline of <ms> ms passed'}` and the request fails with `DKG aborted: ceremony deadline of <ms> ms passed` (500) — or, when this node had published its confirmation, with `DkgShareKeptError('ceremony deadline of <ms> ms passed', keptNote)`, so the message still says where the staged share was kept and to check the other nodes. A ceremony the deadline merely stopped fails with a bare `aborted`; when it failed with something else as the deadline passed (a refused commit, a full disk), that failure is appended to the reason in parentheses — `ceremony deadline of <ms> ms passed (share path already exists: <path>)` — in the error, the log line and the broadcast reason (cut to 1024 characters), and an `aborted (discard failed: …)` note survives the same way.
- **Leader pulls:** each ceremony the leader runs uses `{ ...io, pullOpts: { ...io.pullOpts, deadlineMs, maxAttempts: Number.MAX_SAFE_INTEGER } }` with `deadlineMs` = `ceremonyDeadlines.signingMs` or `ceremonyDeadlines.dkgMs` — pulls retry with backoff until the ceremony deadline, as on participants; `io.pullOpts` supplies only the backoff (`initialDelayMs`, `maxDelayMs`).

- `class LeaderDispatcher`
  - **`constructor(deps: LeaderDeps)`**

  - **`runDkg(req: { ceremonyId: string }): Promise<{ ceremonyId: string; address: string; internalKey: string; network: NetworkName }>`**
    1. `deps.vault` set → `RequestError(409, 'this node already holds a vault')`.
    2. `slots.ceremonyIdInUse(ceremonyId)` → `RequestError(409, 'ceremony id <ceremonyId> is already in use on this node')`.
    3. `slots.beginLocalDkg(ceremonyId)`; `null` → `RequestError(409, 'a DKG is already running on this node')`. From here on, `end()` runs in a `finally`.
    4. `await vaultExists()` → `RequestError(409, 'this node already holds a vault')`. Checked while the slot is held, so a DKG this node joined and committed meanwhile is seen.
    5. `threshold = parties = peersById.size`; gate on `buildDkgSpec({ ceremonyId, leader: node.id, role: 'leader' }, { threshold, parties, network, peerIds })` (`peerIds` = every `peersById` label in party order); non-approve → `GateRejection`.
    6. `createStager()`; random 32-byte session ID from `rng`; start the ceremony deadline; broadcast `announce-dkg {ceremonyId, sessionIdHex, threshold, parties, network}`; `runDkgCeremony(io, spec, stager, AbortSignal.any([slot.signal, deadline]))`.
    7. Returns `address` = `vaultPayment(toVaultKey(publicKeyPackage), network).address` and `internalKey` = untweaked group key (33-byte SEC1 hex).
    - **Throws:** `RequestError`, `GateRejection`, the deadline error above, or the `runDkgCeremony` error (which already broadcast `signoff-aborted`, unless its signal aborted it). A failure is logged at warn level, or at error level for a `DkgShareKeptError`: the 500 body's `error` then says the staged share was kept at `<share path>.pending` and to check the other nodes with `otzi vault`.
    - **Post:** From the announce on, success and failure both `scheduleClear` the ceremony with the DKG retention. The new vault is on disk but not loaded; signing on it needs a daemon restart.

  - **`sign(req: LeaderSignRequest): Promise<{ ceremonyId: string; txid: string; signedTxHex: string; signaturesHex: string[] }>`** — in this order:
    1. No vault → `RequestError(409, NO_VAULT_MESSAGE)`.
    2. `slots.ceremonyIdInUse(ceremonyId)` → `RequestError(409, 'ceremony id <ceremonyId> is already in use on this node')`. A reused id never reaches the gate: no policy rate-window approval is consumed and no exec / webhook approver is asked.
    3. `analysis = analyzeProposal(proposal, toVaultKey(vault.publicKeyPackage), network)`; a throw → `RequestError(400, <message>)`.
    4. Gate on `buildSigningSpec(analysis, { ceremonyId, leader: node.id, role: 'leader' }, network, labelFor)` (labels from `addressBook` when present; a rejected `addressBook()` means no labels and one warn line); non-approve → `GateRejection`.
    5. `slots.beginLocalSigning(ceremonyId)` — the authoritative reservation (an id taken while the gate deliberated is caught here); `null` → `RequestError(409, 'ceremony id <ceremonyId> is already in use on this node')`. From here on, a `finally` clears the deadline timer, schedules the blob clear (signing retention) and then calls `end()` — the orchestrator's settle order (clear, then record), so the id never comes free before its blobs' clear is scheduled.
    6. Start the ceremony deadline; `leadSigning(io, { ceremonyId, signers, sighashes: analysis sighashes, keyPackage, publicKeyPackage, rng }, proposal, deadline)` — this broadcasts `announce-sign`.
    7. `finalizeSend(proposal.tx, proposal.prevouts, signatures as { index, signature: hex }, vaultPayment(vaultKey, network).outputKey)` (`src/otzi/backend/bitcoin.ts`) → signed hex and txid.
    8. Broadcast `signoff-done {ceremonyId, signaturesHex}`; return `{ ceremonyId, txid, signedTxHex, signaturesHex }`. A failed `signoff-done` broadcast is logged at warn and the signed transaction is still returned (participants settle `timeout` at their deadline).
    - **Failure in steps 6–7:** broadcast `signoff-aborted {ceremonyId, reason}` (`reason` = the error message — `ceremony deadline of <ms> ms passed` when the deadline aborted it — at most 1024 characters; the broadcast is best-effort) and rethrow (handler → 500).

**Invariants:**
- Nothing is announced unless the leader's own analysis and gate passed (400 / 403 leave peers untouched) and this node holds the ceremony's slot (409 otherwise).
- The leader never broadcasts the transaction; it returns it.
- The leader's own gate is evaluated once per request.
- Signoffs come only from the leader for signing; DKG aborts come from whichever node fails.
- The slot is released (`end()`) on every exit path once taken.
- A ceremony the leader runs fails at its ceremony deadline at the latest, however many pull phases it has.

**Cross-component contracts:**
- Depends on: `runDkgCeremony`, `leadSigning`, `encodeMessage`, `analyzeProposal` / `toVaultKey` / `vaultPayment` / `labelFor` (`src/otzi/lib`), `finalizeSend` (`src/otzi/backend/bitcoin.ts`), `spec-builder.ts`, `scheduleClear`, `LocalCeremonySlots` (`Orchestrator`), `api.ts` (`RequestError`, `NO_VAULT_MESSAGE`).
- Used by: `Daemon` (one instance; the handler dispatches to it).

---

### `daemon.ts`
**Purpose:** Composition root. Wires blob infrastructure, gate, orchestrator, leader dispatcher and triggers into one `Daemon`.

**Public surface:**
- `interface DaemonDeps`
  ```ts
  state: LoadedDaemonState; transport: Transport; selfPartyId: number;
  peersById: ReadonlyMap<PartyId, string>; rng: Rng; pullOpts: PullOpts; logger?: Logger;
  httpHandler?: HttpHandler; cronHandlers?: ReadonlyMap<string, CronHandler>;
  env?: Readonly<Record<string, string | undefined>>; vaultPubkeyPath?: string; addressBookPath?: string;
  ```
  - **Pre:** `selfPartyId` and `peersById` come from `TransportBundle` (book lookup by pubkey); `transport.partyId === selfPartyId`. `vaultPubkeyPath` is where a DKG commit writes `vault-pubkey.json` (default `DEFAULT_VAULT_PUBKEY_PATH`); pass the same path given to `loadAndValidate`. `addressBookPath` is this node's address book (default `DEFAULT_ADDRESS_BOOK_PATH`); production passes nothing, tests point it at a temporary file.

- `class Daemon`
  - **`constructor(deps: DaemonDeps)`**
    - **Post:** Builds `BlobStore`, `BlobServer`, `BlobPuller`, one `CeremonyIo` (`pullOpts` = `deps.pullOpts`); the gate via `createGate(config.gate, { network, loadAddressBook, logger, secretEnv: [config.share.passwordEnv, ...triggerTokenEnvNames(config.triggers)] })` (`triggerTokenEnvNames` = the `auth_token_env` of every `http` trigger), and one info line `daemon: gate strategy <strategy>`; `Orchestrator` and `LeaderDispatcher` with the same `io`, `gate`, `node = { id: config.node.id, partyId: selfPartyId }`, `peersById`, `network = config.network.name`, `vault = state.share`, `vaultExists` (`true` when a share is loaded, otherwise `vaultFileExists(config.share.path)`), `createStager = () => createShareStager({ path: config.share.path, password: state.password, network, partyId: selfPartyId, vaultPubkeyPath, logger })`, `rng`, `ceremonyDeadlines = config.deadlines`, and `addressBook = () => readAddressBook(addressBookPath, network)` (`addressBookPath` = `deps.addressBookPath ?? DEFAULT_ADDRESS_BOOK_PATH`); the leader's `slots` is the orchestrator; trigger sources from `config.triggers`. `loadAddressBook` reads the same file with `readAddressBook(addressBookPath, network, { missing: 'error' })` and returns its addresses, so it throws when the file does not exist (ENOENT) as well as when it is invalid — where the `addressBook` labelling read returns `[]` on ENOENT — and `allowed_recipients = "address-book"` rejects every signing spec on a node without a book.
    - **Throws:** `ConfigError` from `createGate` for invalid `[gate]` params, an `allowed_recipients` entry that is no address of `[network].name` included (the daemon does not start; see gate.md, `parsePolicyParams`).
    - **Invariant:** Does NOT start anything. The share password reaches only the share stager; it is never logged or returned, and an `exec` gate's command inherits neither its environment variable nor an HTTP trigger's token variable.
  - **`async start(): Promise<void>`** — starts the orchestrator and every trigger. Reentrant.
  - **`async stop(): Promise<void>`** — stops triggers, the orchestrator, and closes the blob server. Reentrant.
  - **`onCompleted(handler): Unsubscribe`** — forwards orchestrator outcomes.

- **Trigger assembly** (`buildTriggers`)
  - `http`: requires `bind`; optional `auth_token_env`; uses `httpHandler` (default or injected).
  - `uds`: requires `path`; same handler.
  - `cron`: requires `job_name` + `schedule`; optional `timezone`; handler from `cronHandlers`.
  - **Throws:** `Error` on missing required params or a missing cron handler.

- `buildDefaultHttpHandler(leader: LeaderDispatcher, state: LoadedDaemonState, peersById: ReadonlyMap<PartyId, string>, selfPartyId: PartyId, logger: Logger): HttpHandler`
  - **Pre:** POST with a JSON object body; dispatch on `body.op`.
  - **Ops:**

    | Op | Request | 200 response |
    |---|---|---|
    | `vault-info` | `{ op }` | `{ partyIds, threshold, parties, network, address, internalKey, outputKey }` — `partyIds` ascending from `peersById`; `threshold` / `parties` from the share; key fields as in `vault-pubkey.json` (`vaultPubkeyFromPackage`). 409 `NO_VAULT_MESSAGE` when no vault is loaded. |
    | `dkg` | `{ op, ceremonyId? }` | `{ ceremonyId, status: 'done', address, internalKey, network }`. `parties` = ring size, `threshold` = `parties`. 409 when this node already holds a vault, a DKG is running, or the `ceremonyId` is in use on this node (live, or led or settled here within its retention period). |
    | `sign` | `{ op, ceremonyId?, signers?, proposal }` | `{ ceremonyId, status: 'done', txid, signedTxHex, signaturesHex }`. 409 `NO_VAULT_MESSAGE` when no vault is loaded (checked before the body is parsed); 409 when the `ceremonyId` is in use on this node (live, or led or settled here within its retention period). |

  - `vault-info` runs `parseVaultInfoRequest`; `dkg` runs `parseDkgRequest` then `leader.runDkg`; `sign` runs `parseSignRequest(body, { partyIds, self: selfPartyId, minSigners: share.threshold })` then `leader.sign`.
  - **Status codes:**
    - 405 `{ error: 'method not allowed' }` for anything but POST;
    - 400 `{ error }` for a body that is not a JSON object (`body must be a JSON object`), a missing op (`missing 'op' field`), an unknown op (`unknown op '<op>'`), an unknown top-level field, bad input, or a proposal rejected by analysis (message from `analyzeProposal`);
    - `RequestError` → its status with `{ error }`;
    - `GateRejection` → 403 `{ error: 'gate rejected', decision, ceremonyId }`;
    - anything else → 500 `{ error, ceremonyId }`, logged at error level.

**Invariants:**
- One gate, one orchestrator, one leader dispatcher, one blob server per daemon.
- The daemon makes no chain requests; Esplora and broadcast are used only by CLI verbs.
- The HTTP trigger is loopback-only (enforced by the config parser); the UDS socket is the default operator API.
- A vault created by a DKG is loaded only by a restart: until then `vault-info` and `sign` answer 409 `NO_VAULT_MESSAGE` and `dkg` answers 409.

**Cross-component contracts:**
- Depends on: all of `src/core`, `src/gate`, `src/orchestrator`, `src/triggers`, `src/address-book/store.ts`, `vault-share.ts`, `vault-pubkey.ts`, `api.ts`, `leader.ts`.
- Used by: `entrypoint.ts` (after state and transport are ready).

---

### `console-logger.ts`
**Purpose:** The daemon's `Logger`: one line per entry on stderr, which systemd hands to journald (and the fail2ban filter in `examples/fail2ban/otzi.conf` reads).

**Public surface:**
- `createConsoleLogger(opts?: { minLevel?: 'debug' | 'info' | 'warn' | 'error'; write?: (line: string) => void }): Logger`
  - **Post:** Each call at or above `minLevel` (default `info`) writes exactly one line: `<LEVEL> <msg>` or `<LEVEL> <msg> <extra as compact JSON>`, then `\n`. Bigints in `extra` render as decimal strings.
  - **Escaping:** every C0 control character (U+0000–U+001F), DEL, every C1 control character (U+0080–U+009F) and U+2028 / U+2029 in `msg` is written escaped — `\n`, `\r`, `\t`, otherwise `\u00XX` / `\u2028` — and in string values and keys of `extra` likewise (JSON escapes C0; the logger escapes the rest). A message can carry peer-controlled text (a `signoff-aborted` reason) and still never starts a second journal entry.

**Invariants:**
- One call, one line: a forged log line can only appear in the middle of a line, never at its start, so the fail2ban filter, anchored to the start of the logger's line, never matches peer-supplied text.
- Stdout is never written (it carries CLI output).

**Cross-component contracts:**
- Used by: `entrypoint.ts` (`runDaemonCommand` and `runRelayCommand`; the other CLI verbs keep `NOOP_LOGGER`).
- `examples/fail2ban/otzi.conf` matches `WARN peer-allowlist: dropped connection from non-peer source {"ip":"<HOST>"…` at the start of the line (after journald's optional `<host> <ident>[<pid>]: ` prefix).

---

### `transport-factory.ts`
**Purpose:** Loads the identity key file and pubkey book, identifies self by pubkey match, cross-checks the share and `[[peers]]` against the book, derives the ringId and the `peersById` label map, and builds the peer-mesh or relay transport.

**Public surface:**
- `TransportBundle`
  - **Post:** Carries `transport`, `identity` keypair, `pubkeyBook`, authoritative `selfPartyId` (book lookup by pubkey), `selfEntry`, `peersById` (`peer-${partyId}` for non-self, `config.node.id` for self), `ringId`, and `start`/`stop`.

- `buildTransportFromFiles(state, options): Promise<TransportBundle>`
  - **Pre:** `config.node.identityKeyFile` + `pubkeyBookFile` paths are set.
  - **Post:** Loads identity + book from disk, runs `resolveSelfFromBook`, runs `validatePeersAgainstBook` for peer-mesh (after the endpoint check below), derives ringId + peersById, returns bundle.
  - **Throws:** `Error` on file read, JSON parse, identity-not-in-book, `[[peers]]`/book mismatch, a peer-mesh book entry without an `advertisedEndpoint`, missing paths, or share/book disagreement.

- `buildTransportFromMemory(state, identity, book, options): Promise<TransportBundle>`
  - **Pre:** Identity + book are pre-built (test path).
  - **Post:** Same validation, same bundle, no disk I/O.

- **Identity file format** (JSON): `{ pkcs8Hex: <hex>, publicKeyHex: <hex> }` — PKCS#8 DER, 130-char hex uncompressed P-256 public key.

- **Pubkey book format:** produced by bootstrap (`runMasterBootstrap` / `runMemberRegister`), parsed by `parseBook`. Entries: `{ partyId, publicKeyHex (130-char), advertisedEndpoint? (canonical host:port) }`. `advertisedEndpoint` is optional in the file (a relay book has none); only peer-mesh reads it.

- **`resolveSelfFromBook(identity, book)`** (internal)
  - **Post:** Returns the book entry whose `publicKeyHex` (case-insensitive) matches the loaded identity. When a share is loaded: `share.partyId === selfEntry.partyId` and `share.parties === book.entries.length`.
  - **Throws:** `Error` if no entry matches the identity (re-run `otzi setup` for a stale book); if `share.partyId` disagrees with the book; `Error('share is for <p> parties but the pubkey book has <n>')`.

- **`requireBookEndpoint(entry)`** (internal, peer-mesh only)
  - **Post:** Returns the entry's `advertisedEndpoint`.
  - **Throws:** `Error('transport-factory: pubkey book entry for party <id> has no advertisedEndpoint; peer-mesh needs one for every peer')` when the entry has none. The peer-mesh branch applies it to every non-self book entry, in ascending `partyId` order, before `validatePeersAgainstBook`, so the first endpoint-less party is the one named. The self entry needs no endpoint: self listens on `config.transport.advertisedEndpoint`.

- **`validatePeersAgainstBook(book, configPeers, selfPartyId)`** (internal, peer-mesh only)
  - **Pre:** Every non-self book entry has an `advertisedEndpoint` (`requireBookEndpoint` throws otherwise).
  - **Post:** Returns when the set of non-self book `advertisedEndpoint` values equals the set of `[[peers]].endpoint` values. The book is authoritative for partyId + pubkey; `[[peers]]` is a typo check.
  - **Throws:** `Error` on any endpoint present on one side only.

- **ringId derivation:** SHA-256 over all raw pubkeys concatenated in partyId order, hex-encoded. Identical on every peer. Endpoints are not an input, so a book with and without endpoints for the same keys gives the same ringId.

- **Transport branching**
  - **peer-mesh:** requires `config.transport.advertisedEndpoint`; requires an `advertisedEndpoint` on every non-self book entry (`requireBookEndpoint`); runs `validatePeersAgainstBook`; builds `PeerMeshTransport` from the book (`endpoint: ws://${advertisedEndpoint}`).
  - **relay:** requires `config.transport.url`; builds `RelayTransport` with partyId + pubkey per book entry. Never reads a book endpoint, so a book without endpoints is accepted (and `[[peers]]` may be empty). The relay routes by partyId; cryptographic auth alone gates relay traffic.

**Invariants:**
- The private key is loaded once at startup and never leaves the daemon.
- The pubkey book is read-only at runtime.
- Self identification is by raw-pubkey match; partyId comes from the book.
- A loaded share must belong to this book's ring: same partyId, same party count.
- `peersById` labels are local-only.

**Cross-component contracts:**
- Depends on: `PubkeyBook` / `parseBook`, identity crypto, transport implementations, `canonicalizeEndpoint`.
- Used by: `entrypoint.ts` (`buildTransportFromFiles`); tests via `buildTransportFromMemory`.

**Notes / gotchas:**
- `book.advertisedEndpoint` (when present) is bare `host:port`; transport-factory prepends `ws://` for `PeerMeshTransport`.
- `peersById` reaches the `Daemon` via `DaemonDeps.peersById`; `peersById.size` is the ring size used for DKG `parties` and the default `signers`.

---

### `entrypoint.ts`
**Purpose:** The `otzi` executable. Dispatches verbs, runs the daemon and the relay server, prints operator banners, maps errors to exit codes.

**Verbs:**

| Verb | Behaviour |
|---|---|
| `otzi daemon <config>` | Run the daemon (`runDaemonCommand`). |
| `otzi relay --listen <host:port>` | Run the relay server for `[transport] kind = "relay"` rings (`runRelayCommand`); needs no config and no vault. |
| `otzi setup <config>` | Bootstrap pubkey exchange (endpoint allowlist under peer-mesh, count under relay); prints the 96-bit fingerprint and the key ids of this node and every ring entry. |
| `otzi generate [--config <path>] [--ceremony-id <id>]` | Daemon `dkg` op (`generate`); banner prints the vault address and the restart instruction. |
| `otzi vault [--json] [--config <path>]` | Address, network, threshold/parties, checked against the daemon's loaded share (`vault`); the full file (keys included) with `--json`. |
| `otzi btc balance [--unit sats\|btc\|mbtc\|ubtc] [--config <path>]` | Esplora balance: confirmed and unconfirmed. |
| `otzi btc send <label\|address> <amount[unit]\|max> [--fee-rate N] [--config <path>]` | `btcSend`: prints the txid and explorer URL. |
| `otzi btc sign <proposal.json> [--broadcast] [--config <path>]` | `btcSign`: prints the analysis summary, txid and signed hex; `--broadcast` posts it. |
| `otzi book list` | Print entries. |
| `otzi book add <label> <address> [--note <text>]` | Add or update an entry. |
| `otzi book remove <label\|address>` | Remove an entry. |
| `otzi book import <file> [--replace]` | Merge (default) or replace; prints added/updated/unchanged counts. |
| `otzi book export [path]` | Write the book file (stdout without a path). |
| `otzi backup` / `otzi restore <archive> [--password-stdin]` | Archive and restore node state. |

- `--config` defaults to `/etc/otzi/daemon.toml`. Every `book` verb takes it too, to learn the network, and `vault` to find the daemon.
- CLI verbs other than `daemon` and `relay` keep `NOOP_LOGGER` and write machine output to stdout only; banners, summaries and errors go to stderr. Stdout per verb: `vault` the text or JSON; `btc balance` the two balance lines; `btc send` the txid, then the explorer URL; `btc sign` the txid, then the signed hex, then (with `--broadcast`) the explorer URL; `book list` one tab-separated line per entry; `book import` the line `added <a>, updated <u>, unchanged <n>, removed <r>`; `book export` the book file when no path is given. `generate`, `book add` and `book remove` print only to stderr, as does `book export <path>`.
- `parseVerbArgs(args, { values?, booleans? }): { positional: string[]; flags: Map<string, string> }` — positionals and `--flags` in any order. A `values` flag takes the next argument (`flag '--x' needs a value` when it is missing or starts with `--`); a `booleans` flag takes none (so `btc sign --broadcast <file>` works); any other `--flag` is `unknown flag '--x'`, so a typo never falls back to a default.
- `reportCliError(err, write?)` — the message on stderr. A `BroadcastFailedError` also prints a line naming the txid and saying the transaction is signed but not broadcast, then the signed transaction hex as the last line, so the operator can broadcast it by other means. The process exits 1 on any error.
- `otzi generate` takes no positional argument; a positional (the pre-0.3 `otzi generate <config.toml>`) fails with a hint to use `--config`. Its banner (stderr) prints the ceremony ID, network, vault address, share path and `Restart every daemon to load its share before signing.`
- `otzi btc send` and `otzi btc sign` write the analysis summary to stderr before the daemon is asked to sign (`btcSend` / `btcSign` do it through `deps.summary`; the entrypoint does not print it again). `btc sign` then notes that nothing was broadcast unless `--broadcast` is given.
- `--fee-rate` must be a number (`btcSend` enforces more than 0 and at most `MAX_FEE_RATE`); `--unit` one of `sats`, `btc`, `mbtc`, `ubtc`.

- **`runDaemonCommand`**
  - **Post:** `loadAndValidate(configPath, { logger })` → `buildTransportFromFiles` → `Daemon` → `start`; SIGINT/SIGTERM stop the daemon and the transport, then exit 0. The startup line names the mode: signing (vault loaded) or setup (no vault). In setup mode it states that signing requests are rejected until the DKG runs (`otzi generate`) and every daemon restarts to load its share. The ceremony pull backoff comes from `pullOpts` (`initialDelayMs` 100, `maxDelayMs` 2 000); orchestrator and leader replace its `deadlineMs` and `maxAttempts` with the ceremony deadlines. The stale-`.pending` warning and the `vault-pubkey.json` rewrite come from `loadAndValidate` (through the logger passed in); `runDaemonCommand` does not warn a second time.

- **`runRelayCommand(args: string[]): Promise<void>`**
  - **Pre:** `args` holds exactly `--listen <host:port>`. The host is required and there is no default: the verb never binds every interface by accident (the packaged default `127.0.0.1:7100` lives in `/etc/otzi/relay.env`, which the unit passes as `--listen`).
  - **Post:** `parseVerbArgs(args, { values: ['listen'] })`, then a `RelayServer({ listen, logger: createConsoleLogger() })` is started (default heartbeat). Resolves once the relay is listening; the open listener keeps the process alive. The console logger's `RelayServer: listening {"host":…,"port":…}` line on stderr is the listen line (the real port when `--listen` names port 0), followed by one line per connect and disconnect. SIGINT/SIGTERM log `received <signal>, shutting down`, stop the server, then exit 0. Nothing is written to stdout.
  - **Throws:** `unknown flag '--x'` for any other flag; `flag '--listen' needs a value`; `unexpected argument '<x>'` plus the usage for a positional; `otzi relay needs --listen <host:port>` plus the usage when `--listen` is absent; `RelayServer`'s `invalid listen '<x>' — expected 'host:port'` / `invalid port` for a malformed address; the bind error (e.g. `listen EADDRINUSE: address already in use …`) when the address cannot be bound. In every case the process exits 1 through `reportCliError`, and no signal handler is installed (they are installed after the bind).
  - **Scope:** the relay serves plain WebSocket and has no TLS; anything beyond loopback or a VPN goes behind a TLS reverse proxy (`wss://`). It reads no daemon config, share, identity or pubkey book.

**Invariants:**
- The daemon and the relay are the only long-lived verbs; every other verb talks to the daemon over the daemon client (UDS by default) or works on local files.
- TOML + share password are required by the daemon; absence fails at load time. `otzi relay` needs neither.

**Cross-component contracts:**
- Depends on: `config-merge`, `transport-factory`, `Daemon`, `setup`, `src/cli/cmd/*`, `RelayServer` (`src/transport/relay/server.ts`; see [transport.md](transport.md)), `console-logger`.

---

### `setup.ts`
**Purpose:** Bootstrap CLI wrappers: identity key generation, pubkey book exchange and persistence.

**CLI surface (`entrypoint.ts`)**
  - `otzi setup <config.toml>` — zero-arg. Reads `[bootstrap].role` from config to dispatch:
    - `role = "leader"` → `setupMaster(configPath, config.bootstrap.bind)`.
    - `role = "leaf"` → `setupMember(configPath, config.bootstrap.leaderUrl)`.
  - Throws `Error` if `[bootstrap]` is missing, role is unknown, or the role-specific field is absent.

**Public surface:**
- **`setupMaster(configPath, bind): Promise<void>`**
  - **Pre:** Config path + bind address (host:port) provided.
  - **Post:** Loads config; picks the admission from `[transport] kind` (peer-mesh → `{ kind: 'endpoints', selfEndpoint: transport.advertised_endpoint, expectedPeers: [[peers]] }`; relay → `{ kind: 'count', parties: bootstrap.parties }`); loads/generates identity key; runs bootstrap master; writes pubkey book; prints the setup banner.
  - **Throws:** peer-mesh without `transport.advertised_endpoint`; relay without `[bootstrap] parties` (`setup: relay mode needs [bootstrap] parties on the leader …` — the config parser already requires it on a relay leader, so only a config with no `[bootstrap]` reaches this).
  - **Idempotent:** If the pubkey book already exists, re-prints the banner without re-bootstrapping.
  - **Identity:** Reused if file exists; generated if missing (mode 0660).

- **`setupMember(configPath, masterUrl): Promise<void>`**
  - **Pre:** Config path + master URL provided.
  - **Post:** Loads config; loads/generates identity key; registers with master (peer-mesh: with `transport.advertised_endpoint`, which must be set; relay: with no endpoint); writes pubkey book; prints the setup banner.
  - **Idempotent:** If the pubkey book already exists, re-prints the banner.

- **Setup banner** (`announceComplete`, both roles, both transports, and on the idempotent re-print):
  - `fingerprint: xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` from `computeFingerprint`;
  - `this node: <keyId>` — this node's identity pubkey (`keyId` from `pubkey-book.ts`); on a re-print with no identity file, `this node: no identity key at <file>`;
  - a warning right after that line when the daemon could not start with this book: `⚠ no identity key — the daemon cannot start; restore it from a backup, or delete pubkeys.json on every node and redo setup` (no identity file), or `⚠ this node's key is not in this book — the daemon will not start; delete pubkeys.json on every node and redo setup` (an identity whose pubkey matches no entry). A fresh setup never prints either, since the member and master checks guarantee the key is in the book; only a re-print can;
  - one line per book entry in partyId order: `party <partyId>: <keyId>`, followed by two spaces and the entry's endpoint when it has one (peer-mesh);
  - the instruction to compare the fingerprint out of band with every other operator before any DKG, and `Confirm every key id above belongs to one of your nodes; an unknown id means someone else registered — delete pubkeys.json on every node and redo setup.`

- **Validation:** `identity_key_file` and `pubkey_book_file` must be set in config; missing paths fail immediately.

- **File I/O**
  - **Identity:** Mode 0660 (group read/write); the daemon user (`otzi`) reads it through group membership when an operator in the `otzi` group ran `setup`.
  - **Pubkey book:** Mode 0644 (world-readable).
  - **Parent directories:** Created recursively.

**Invariants:**
- Setup is idempotent; re-running after abort is safe.
- The fingerprint must match across all nodes (operators compare it); a mismatch means tampering — delete the books and redo setup.
- Every key id in the banner must belong to one of the operators' own nodes; an unknown one means someone else registered (in relay mode anyone who reaches the bootstrap port can) — delete the books and redo setup.

**Cross-component contracts:**
- Depends on: Config loader, bootstrap runners (`runMasterBootstrap`, `runMemberRegister`), identity crypto, pubkey book serialization.
- Used by: `entrypoint.ts`.

---

**Cross-file contracts (orchestrator/triggers/daemon):**

- **HTTP listener binding:** `HttpTrigger` binds loopback only (parser-enforced). Localhost binding is load-bearing: it is why the API needs no mTLS.
- **Verify-before-gate:** leader (`LeaderDispatcher.sign`) and participants (`Orchestrator`) both run `analyzeProposal` against their own key before the gate; specs are built from that analysis.
- **Leadership:** the leader is the node whose trigger fired. For signing it announces, aggregates, finalizes and sends the signoff; for DKG it only generates the session ID and announces.
- **Share persistence:** leader and participants persist a DKG result through the same `ShareStager`: stage to `.pending` (synced), commit after all-N confirmation. A failure discards the `.pending` this ceremony staged on a node that had not yet published its `dkg-verified` (a `.pending` from an earlier ceremony is never touched by a ceremony that did not stage); a node that had keeps it and logs an error naming it and the recovery (core.md, `runDkgCeremony`).
- **No chain access:** the daemon returns signed transactions; the CLI broadcasts.

---

## src/cli/

### `daemon-client.ts`
**Purpose:** HTTP-over-UDS client for the local daemon.

**Public surface:**
- `class DaemonClientError extends Error { readonly status: number }`
- `interface VaultInfo { partyIds: number[]; threshold: number; parties: number; network: NetworkName; address: string; internalKey: string; outputKey: string }` — the `vault-info` response.
- `class DaemonClient`
  - `static fromConfig(configPath): Promise<DaemonClient>` / `static fromParsed(cfg): DaemonClient` — prefers the `uds` trigger's `path`; falls back to the `http` trigger's `bind` (a `/`-path is a socket path).
  - `request<T>(body: unknown, options?: RequestOptions): Promise<T>` — POSTs JSON; 200 → parsed body; non-200 → `DaemonClientError(status, message)`. `RequestOptions = { signal?: AbortSignal }`: aborting it cancels the request, closes its connection, and rejects with an `AbortError` (an already-aborted signal never connects).
  - `vaultInfo(options?: RequestOptions): Promise<VaultInfo>` — `{ op: 'vault-info' }`.
  - **Throws:** `Error` when the config has neither trigger.

**Cross-component contracts:** Used by every CLI verb that talks to the daemon (`generate`, `vault`, `btc send`, `btc sign`). Commands take an injectable `{ request }` (`CliDeps.client`) for tests; `vault` takes `{ vaultInfo }` (`VaultDeps.client`).

### `units.ts`
**Purpose:** CLI amount parsing and formatting.

- `type BtcUnit = 'sats' | 'btc' | 'mbtc' | 'ubtc'`
- `parseBtcAmount(input: string): { sats: bigint; unit: BtcUnit; raw: string }`
  - **Post:** `<number>[sats|btc|mbtc|ubtc]` (default sats) converted to integer sats without floating point.
  - **Throws:** On empty input, an unknown unit, a fractional sat, or a negative amount.
- `formatSats(sats: bigint, unit?: BtcUnit): string` — decimal string in `unit` (default sats), trailing zeros trimmed; a negative amount (an unconfirmed balance can fall when a spend is in the mempool) is `-` plus the formatted magnitude.

### `state-paths.ts`
**Purpose:** The one rule for where a node's operator-configurable state files may live, shared by `otzi backup` and `otzi restore` (restore imports from `backup.ts`, so the rule cannot live in either without a cycle). The share, identity and pubkey-book paths come from `daemon.toml`; restore runs as root and writes them, so they are confined to the two directories the `.deb` creates, and backup refuses what restore would refuse rather than write an archive that cannot be restored.

**Public surface:**
- `CONFIG_DIR` = `'etc/otzi'`, `DATA_DIR` = `'var/lib/otzi'` (tar-relative, no leading slash): the config directory, and the data directory whose files belong to the user `otzi` (`restore.ts` chowns what it places there).
- `STATE_DIRS` — `[CONFIG_DIR, DATA_DIR]`.
- `FIXED_STATE_FILES` — `{ daemonConfig: 'etc/otzi/daemon.toml', addressBook: 'etc/otzi/address-book.otzi.json', vaultPubkey: 'var/lib/otzi/vault-pubkey.json' }` (`as const`): the tar paths of the files whose place `daemon.toml` does not choose. The one list: `backup.ts` packs these (its `DAEMON_CONFIG_TAR`, `ADDRESS_BOOK_TAR`, `VAULT_PUBKEY_TAR` are its members, and a test asserts that backup's `DEFAULT_*_PATH` strip to them), `restore.ts` keys its mode table (`FIXED_FILE_MODES`) by them, and both pass `FIXED_TAR_PATHS` as `resolveStatePaths`'s `fixed`. A fourth fixed file is added here.
- `FIXED_TAR_PATHS: readonly string[]` — `Object.values(FIXED_STATE_FILES)`.
- `resolveStatePaths(named: { key: string; path: string }[], fixed: readonly string[], refuse: (key: string, path: string, why: string) => Error): string[]`
  - **Post:** returns, in order, the tar path of each named path: `path.posix.resolve(path)` without the leading slash, a direct child of `etc/otzi` or `var/lib/otzi`.
  - **Throws** `refuse(key, path, why)` for the first named path that is (`why` is neutral text; each caller puts it in its own message):
    - relative, or resolving outside both directories — `is outside /etc/otzi and /var/lib/otzi`;
    - resolving below a subdirectory of them (`/var/lib/otzi/keys/share.json`) — `is not a direct child of /etc/otzi or /var/lib/otzi`;
    - resolving to the tar path of an earlier named path or of one of `fixed` — `names a file another key also names`.

**Invariants:** Pure (no file system access); `..` and `.` segments are resolved before the check, so `/var/lib/otzi/../../etc/x` is outside and `/var/lib/otzi/./share.json` is a direct child.

**Cross-component contracts:** Used by `backup.ts` and `restore.ts` only.

---

## src/cli/cmd/

### `generate.ts`
**Purpose:** `otzi generate` — run the run-once DKG through the local daemon.

- `generate(opts: { configPath: string; ceremonyId?: string }, deps?: CliDeps): Promise<{ ceremonyId: string; address: string; network: NetworkName }>`
  - **Pre:** The daemon on this node is running and holds no vault; every other daemon in the ring is running and holds no vault.
  - **Post:** Sends `{ op: 'dkg', ceremonyId? }` through `deps.client` or `DaemonClient.fromConfig(configPath)`; returns the response's `ceremonyId`, `address`, `network`.
  - **Throws:** `DaemonClientError` (409 when the node already holds a vault, 403 gate reject, 500 ceremony failure); `Error` when the reply lacks `ceremonyId`, `address` or `network`.
  - **Banner (entrypoint):** ceremony ID, network, vault address, share path, and the instruction to restart every daemon to load the new share.

### `vault.ts`
**Purpose:** `otzi vault [--json] [--config <path>]` — print the vault metadata, checked against the daemon. `vault-pubkey.json` is written by the daemon but can be rewritten by any member of the `otzi` group (it is mode 0644 in a group-writable directory), so a file the CLI shows without asking would be a way to put a wrong funding address in front of an operator. The asking and comparing is `vault-check.ts`.

- `interface VaultDeps { client?: VaultInfoSource; warn?: (text: string) => void }` — `client` defaults to `DaemonClient.fromConfig(configPath)` (built inside `askDaemon`, so a config the client cannot be built from counts as unreachable), `warn` to stderr (`console.error`).
- `vault(opts: { configPath: string; vaultPath?: string; json?: boolean }, deps?: VaultDeps): Promise<string>` — `vaultPath` defaults to `DEFAULT_VAULT_PUBKEY_PATH`.
  - **Pre:** none; the daemon may be down.
  - **Post:** `askDaemon` (10 s, see `vault-check.ts`) and acts on the answer:
    1. **Daemon holds a vault.** When the file exists it is read and compared with the reply (`vaultMismatch`). Any difference, or a file that cannot be read or validated (`unusableFile`), throws one `Error` that names the file path and each differing field as `<field>: file <x>, daemon <y>`, says the file does not match the daemon's loaded share, and tells the operator that restarting the daemon rewrites it; nothing is returned, so nothing reaches stdout. On a match, or when the file does not exist, the daemon's values are returned: three lines `network:   <network>`, `address:   <address>`, `threshold: <threshold>-of-<parties>`, or with `json` pretty JSON in the file's key order (`network`, `address`, `internalKey`, `outputKey`, `threshold`, `parties`, then `vaultKey`). `vaultKey` comes from the file, which the daemon does not send: with a matching file the output is the file's bytes, and `warn` gets `the per-party values of vaultKey.verifyingShares come from <path> and are not checked against the daemon` (`json` only; the other `vaultKey` fields are checked, see `vault-check.ts`); with no file it is left out and `warn` gets a line saying so (`json` only).
    2. **Daemon answers 409 (no vault loaded).** Without a file, throws `the daemon has no vault loaded — run 'otzi generate' …`. With a file (a DKG committed this node's share and the daemon has not restarted to load it; the recovery of a partly failed DKG reads the vault from such a node), the file is read (`readVaultPubkeyFile`, so an unreadable or invalid one still throws), `warn(NO_VAULT_NOTE)` = `the daemon has not loaded a vault — restart it to load the share; values not verified`, and the file's values are returned in the shape above (the file's bytes with `json`). Exit 0.
    3. **Daemon unreachable** (the reasons in `vault-check.ts`: client not buildable, system error, no answer within 10 s). `readVaultPubkeyFile(vaultPath)` is returned in the shape above, after `warn("not verified against the daemon (<reason>)")`. A missing or invalid file throws as `readVaultPubkeyFile` does (a missing one points at `otzi generate`).
  - **Throws:** a `DaemonClientError` for any status but 409 (401, 403, 500, …), and the `Error` of a reply that is not JSON or not a vault-info: the daemon answered, so the file is not shown as if the daemon were down.
  - **Invariants:** stdout carries only the returned text (the notes go to `warn`); a mismatch prints nothing there. The output shape is that of the file as before the cross-check; only `--json` without a file lacks `vaultKey`.

### `vault-check.ts` (`src/cli/vault-check.ts`)
**Purpose:** Asking the daemon for its vault and comparing it with `vault-pubkey.json`, for `otzi vault` and `otzi btc balance|send|sign`.

**Public surface:**
- `ASK_TIMEOUT_MS = 10_000`; `NO_VAULT_NOTE = 'the daemon has not loaded a vault — restart it to load the share; values not verified'`; `notVerifiedNote(reason) = 'not verified against the daemon (<reason>)'`.
- `interface VaultInfoSource { vaultInfo(options?: RequestOptions): Promise<VaultInfo> }` — a `DaemonClient`, or `infoFromRequest(client)` over anything with `request(body, options?)` (the `CliDeps.client` shape; sends `{ op: 'vault-info' }`).
- `type DaemonAnswer = { kind: 'vault'; info: VaultInfo } | { kind: 'no-vault' } | { kind: 'unreachable'; reason: string }`.
- `askDaemon(getClient: () => VaultInfoSource | Promise<VaultInfoSource>, timeoutMs = ASK_TIMEOUT_MS): Promise<DaemonAnswer>`
  - **Post:** `getClient()` throwing → `unreachable` (reason: the message through `displayText`). Otherwise `vaultInfo({ signal })` is raced against `timeoutMs`: no answer in time → the signal is aborted (so the request's socket closes and the process can exit) and the result is `unreachable` with reason `no answer within 10 s`; the failure of the aborted request is ignored, and the timer is cleared whatever happens. A `DaemonClientError` with status 409 → `no-vault`. A system error (an `Error` with a string `code`: `ENOENT` no socket, `ECONNREFUSED`, `EACCES`, …) → `unreachable` with its message. A reply is checked to carry `network` (a known one), `address`, `internalKey`, `outputKey`, `threshold` and `parties` → `vault`.
  - **Throws:** a `DaemonClientError` for any other status, an `Error` for a reply that is not JSON (`daemon returned invalid JSON`) or not a vault-info (`daemon reply to 'vault-info' has no vault (…)`): the daemon answered, so nobody may treat it as down.
- `vaultMismatch(path, file, info): Error | undefined` — compares `network`, `address`, `internalKey`, `outputKey`, `threshold`, `parties`, and for the `vaultKey` the CLI builds transactions from and prints with `--json`: `vaultKey.untweakedVerifyingKey` against `internalKey`, `vaultKey.minSigners` against `threshold`, the number of `vaultKey.verifyingShares` against `parties` (strict equality). The per-party values of `verifyingShares` cannot be checked (`vault-info` does not carry them). A difference gives one `Error` naming `path`, each differing field as `<field>: file <x>, daemon <y>` (file text through `displayText`), that the file does not match the daemon's loaded share, and that a restart rewrites it.
- `unusableFile(path, err): Error` — the same shape for a file that exists but cannot be read or validated (`cannot be used: <reason>`).

**Cross-component contracts:** Used by `vault.ts` and `btc.ts`. Depends on `DaemonClient` / `DaemonClientError` / `VaultInfo` (`daemon-client.ts`), `VaultPubkeyFile` (`vault-pubkey.ts`), `displayText` / `errorReason`.

### `btc.ts`
**Purpose:** `otzi btc balance|send|sign` — chain access through Esplora, signing through the daemon.

**Public surface:**
- `const MAX_FEE_RATE = 10_000` — the highest fee rate (sat/vB) the CLI accepts, from `--fee-rate` or from Esplora.
- `interface CliDeps { client?: { request<T>(body: unknown, options?: RequestOptions): Promise<T> }; summary?: (text: string) => void; warn?: (text: string) => void }` — `summary` receives the analysis summary before the daemon is asked to sign, `warn` non-fatal warnings; both default to stderr (`console.error`).
- `class BroadcastFailedError extends Error { constructor(message: string, readonly txid: string, readonly signedTxHex: string) }`

- **Context (all three verbs):** `readVaultPubkeyFile(vaultPath)` (default `DEFAULT_VAULT_PUBKEY_PATH`) and `loadDaemonConfig(configPath)`; `base = chainApiUrl({ network: vault.network, esploraUrl: config.network.esploraUrl })`. A config whose `[network].name` differs from the vault file's network is an `Error` naming both (it would query the wrong chain).
- **Esplora errors:** every Esplora call is wrapped as `Error('Esplora <base>: <reason>')`, where `<reason>` is the HTTP status and body for a non-2xx answer, or the connection error (`connect ECONNREFUSED …`) when Esplora is unreachable. The reason is untrusted text and is shown through `displayText` (control characters removed, line breaks as spaces).

- **The file against the daemon (all three verbs).** `vault-pubkey.json` is rewritable by any member of the `otzi` group and supplies the address, the change key and the network, so each verb asks the daemon (`askDaemon` over `infoFromRequest(deps.client ?? DaemonClient.fromParsed(config))`, 10 s) before it uses the file:
  - `btcSend` / `btcSign` **require** the daemon's loaded vault to match the file (`vaultMismatch`): a mismatch throws the mismatch error (path and each differing field; see `vault-check.ts`), a daemon without a vault throws `Error('the daemon has not loaded a vault — restart it to load the share')`, a daemon that cannot be reached (including no answer in 10 s) throws `Error('cannot check <path> against the daemon: <reason>')`. All before Esplora is asked, anything is built, summarised or signed, so stdout stays empty. Any other daemon error (a non-409 status, a reply that is not JSON) is thrown as it is.
  - `btcBalance` **verifies when it can**: a mismatch throws the same error before Esplora is asked; a daemon that cannot be reached leaves the balance with `deps.warn(notVerifiedNote(reason))`, a daemon without a vault with `deps.warn(NO_VAULT_NOTE)`.

- `btcBalance(opts: { configPath: string; vaultPath?: string; unit?: BtcUnit }, deps?: CliDeps): Promise<string>`
  - **Post:** the file against the daemon (above), then `getBalance(base, vault.address)`; returns `"confirmed: X\nunconfirmed: Y"` formatted in `unit` (default sats).

- `btcSend(opts: { configPath: string; vaultPath?: string; bookPath?: string; to: string; amount: string; feeRate?: number }, deps?: CliDeps): Promise<{ txid: string; explorerUrl: string }>`
  1. Read `vault-pubkey.json` and the config (Esplora base: `esplora_url` or the `chainApiUrl` default).
  2. Resolve `to` with `resolveRecipient(await readAddressBook(bookPath, network), to, network)` (`bookPath` defaults to `DEFAULT_ADDRESS_BOOK_PATH`): a label of this node's book, or an address valid for the vault's network; anything else is `Error('unknown label or invalid address: <to>')`, and a label that is an address (on any supported network) but names a different address is refused (see [address-book.md](address-book.md) `resolveRecipient`). A book that cannot be read or validated is an error naming the book path; a missing book file is an empty book.
  3. Local checks, before Esplora or the daemon is touched: `amount` is `'max'` (case-insensitive) or `parseBtcAmount(amount).sats`, and a sats amount below `MIN_SEND_SATS` (546) is `Error('amount <n> sats is below the minimum send of 546 sats')`; a given `feeRate` must be finite, greater than 0 and at most `MAX_FEE_RATE` (`Error('fee rate must be more than 0 and at most 10000 sat/vB (got <n>)')`); the daemon connection is built from the config (`deps.client` or `DaemonClient.fromParsed`). Then the file is required to match the daemon's loaded vault (above): `vault-info` is the first daemon call of a send, before Esplora.
  4. `getUtxos`, keeping confirmed ones only; fee rate is `feeRate` or `getFeeRates(base).normal`. An Esplora `normal` rate that is not a finite number greater than 0 and at most `MAX_FEE_RATE` is `Error('Esplora <base> returned an unusable fee rate (<value> sat/vB; expected more than 0 and at most 10000); pass --fee-rate to choose one')`, before any daemon call.
  5. `buildSend({ utxos, vault: vaultKey, network, to, amount, feeRate })`. `InsufficientFundsError` becomes `Error('insufficient funds: <available> sats (<btc> BTC) confirmed, <needed> sats (<btc> BTC) needed at <rate> sat/vB')`, plus `; a further <n> sats (<btc> BTC) is unconfirmed and is not spent until it confirms` when unconfirmed coins exist.
  6. More than 255 prevouts → `Error('this send needs <k> inputs; at most 255 fit in one transaction — consolidate first')` before any daemon call.
  7. `analyzeProposal` on the built proposal gives the summary (format under `btcSign`, labels from the book read in step 2), written through `deps.summary` (default stderr) before the daemon is asked to sign. A send refused in steps 1–6 prints no summary.
  8. Daemon `{ op: 'sign', proposal: { network, tx, prevouts } }`, then the reply check (below).
  9. `broadcastTx(base, signedTxHex)`; on failure throw `BroadcastFailedError('broadcast failed — Esplora <base>: <reason>', txid, signedTxHex)`. The txid Esplora answers only cross-checks the daemon's: when it differs, `deps.warn` gets `warning: Esplora <base> answered txid '<x>' for the broadcast, but the signed transaction is <txid>` and the send still succeeds.
  - **Reply check (`btcSend` and `btcSign`, before anything is broadcast or returned):** the reply must carry a string `txid` and hex `signedTxHex` (`Error("daemon reply to 'sign' has no signed transaction (txid, signedTxHex)")`), and `signedTxHex` must decode as a transaction (`the signed transaction in the daemon's reply cannot be decoded: …`) whose txid equals the reply's `txid` (`daemon reply is inconsistent: it names txid <a> but its signed transaction is <b>`), equals `analyzeProposal`'s txid for the proposal, and whose serialization without witnesses equals `proposal.tx` (`daemon signed a different transaction than the proposal (proposal <a>, signed <b>); not broadcasting it`), and every input must carry witness data (`the daemon's signed transaction has no signature for input <i>; not broadcasting it`). Anything else is thrown and nothing is broadcast; a txid alone proves nothing, because a segwit txid ignores witnesses.
  - **Post:** Returns the daemon's txid and `explorerTxUrl(base, txid)`.
  - **Throws:** recipient, amount, fee-rate, Esplora, `InsufficientFundsError` (as above), input-limit, daemon (`DaemonClientError`), reply-check and broadcast errors.

- `btcSign(opts: { configPath: string; vaultPath?: string; bookPath?: string; proposalPath: string; broadcast: boolean }, deps?: CliDeps): Promise<{ txid: string; signedTxHex: string; summary: string; explorerUrl?: string }>`
  - **Post:** Reads a `SendProposal` JSON file and checks it with `parseProposal` (so more than 255 prevouts is refused with the daemon's text); requires the file to match the daemon's loaded vault (above; after the proposal file is read, before the file's key analyses it); `analyzeProposal` against `vault-pubkey.json`'s `vaultKey` and network gives `summary`, which is written through `deps.summary` (default stderr) before the daemon is asked to sign and is also returned; the output labels come from `readAddressBook(bookPath, network)` (default `DEFAULT_ADDRESS_BOOK_PATH`) through `labelFor`, as the daemon labels its specs, and a book that cannot be read means no labels and one `deps.warn` line naming the book; daemon `{ op: 'sign', proposal }` and the reply check (see `btcSend`); broadcasts only when `broadcast` is true (`explorerUrl` then set; a failure throws `BroadcastFailedError`; a differing txid from Esplora is a warning).
  - **`summary`:** `network: <n>`, `inputs: <k>, <sats> sats (<btc> BTC)`, `outputs:` and one line per output (`<address>  <sats> sats (<btc> BTC)`, `  change` appended for a change output, then `  "<label>"` when the address is in the book, the label shown through `displayText`), `fee: <sats> sats (<btc> BTC), <rate> sat/vB`.
  - **Throws:** file errors (`cannot read proposal file <path>: …`), `proposal file <path> is not valid JSON`, shape errors (`proposal file <path>: <parseProposal message>`), analysis errors (`proposal refused: <analyzeProposal message>`, before the daemon is asked to sign), the vault-check errors above, daemon errors, `BroadcastFailedError`.

**Invariants:**
- The CLI is the only component that talks to the chain.
- A signed transaction is never lost: if broadcast fails after signing, the hex reaches the operator.

### `book.ts`
**Purpose:** `otzi book list|add|remove|import|export` — manage this node's address book.

**Public surface:**
- `interface BookOpts { configPath: string; bookPath?: string }` — network from the config; `bookPath` defaults to `DEFAULT_ADDRESS_BOOK_PATH`.
- `bookList(o: BookOpts): Promise<string>` — one line per entry: label, address, note, separated by tabs; label and note are shown through `displayText` (control characters removed, a tab or line break becoming a space), the stored book is not altered; empty string for an empty book.
- `bookAdd(o: BookOpts & { label: string; address: string; note?: string }): Promise<void>` — adds the entry, or updates the label and note of the entry with the same address (an omitted `note` clears the note); the result must pass `validateEntries`; written with `writeAddressBook`. **Throws** `Error("cannot save '<label>': <reason>")` for an invalid entry (`<reason>` is the `validateEntries` message without its `Entry <n>:` prefix); nothing is written then.
- `bookRemove(o: BookOpts & { key: string }): Promise<void>` — removes the entry whose address equals `key` (addresses are unique); only when none does, the entry whose label equals `key`. **Throws** when nothing matches, or when a label matches more than one entry (remove it by address); nothing is written then.
- `bookImport(o: BookOpts & { file: string; replace: boolean }): Promise<{ added: number; updated: number; unchanged: number; removed: number }>` — reads the file with `readAddressBook(file, network, { missing: 'error' })` (`Error('cannot import: address book <file>: <reason>')` for a missing, unreadable, invalid or other-network file; nothing is written); merges with `mergeAddressBooks` (default) or makes the file's entries the book (`replace`); writes; returns the counts `mergeAddressBooks(current, incoming)` reports, plus `removed` = the current entries whose address the file does not have (`replace`; always 0 for a merge).
- `bookExport(o: BookOpts & { out?: string }): Promise<string>` — `addressBookFile(entries, network)` as pretty JSON (no trailing newline); also written to `out` (with a trailing newline, mode 0640 — chmod'd, so an existing file gets it too) when given.

**Invariants:**
- Every write goes through `writeAddressBook` (validation, atomic replace, mode 0640). Writing needs the same privilege as editing `daemon.toml`.
- Import/export files are Ötzi address-book files and move between nodes and web Ötzi unchanged.

### `backup.ts`
**Purpose:** Pack full node state (config, share, identity, pubkey book, vault metadata, address book, meta) into one password-protected archive so an operator who loses their host can recover into a fresh `.deb` install via `otzi restore`.

**Public surface:**
- `runBackup(opts?: BackupOptions): Promise<BackupResult>`
  - **Pre:** `configPath` (default `/etc/otzi/daemon.toml`) exists and is readable; share file (`[share].path`, loose-parsed from daemon.toml), identity file (`[node].identity_key_file`) and pubkey-book file (`[node].pubkey_book_file`) exist. Each of those three paths is absolute and a direct child of `/etc/otzi` or `/var/lib/otzi`, no two name the same file, and none names `daemon.toml`, `vault-pubkey.json` or the address book (the rule restore applies: `state-paths.ts`). Optional files (`vault-pubkey.json`, the address book) are skipped if absent.
  - **Post:** Single archive written at `<outputDir>/otzi-backup-<safe-ISO>.otzi-backup` (default `outputDir` is `os.homedir()`); mode 0600; atomic via `.tmp` + rename. Returns `{ path, password, filesIncluded }`.
  - **Throws:**
    - A share, identity or pubkey-book path that breaks the rule above → `Error('cannot back up: <key> = <path> <why>; otzi restore would refuse the archive')`, `<key>` one of `[share].path`, `[node].identity_key_file`, `[node].pubkey_book_file`, `<why>` as in `state-paths.ts`. Checked right after daemon.toml is parsed, before any other file is looked at or anything is written (no staging directory, no archive); `<path>` goes through `displayText`.
    - Required file missing → `Error` with message ending in `". This looks like a fresh / pre-bootstrap install; nothing meaningful to back up yet."`.
    - daemon.toml unreadable (ENOENT) → propagates with the same canonical tail.

- `BackupOptions`
  - `configPath?: string` — daemon.toml location (default `/etc/otzi/daemon.toml`).
  - `outputDir?: string` — archive destination directory (default `os.homedir()`).
  - `passwordOverride?: string` — bypasses the generated 32-char base62 password. Production callers MUST NOT set this; tests use it for determinism.
  - `now?: () => Date` — clock seam for the filename timestamp.
  - `pathOverrides?: { vaultPubkey?: string; addressBook?: string }` — test seam for the fixed paths not derived from daemon.toml (`vault-pubkey.json`, the address book).
  - `rootOverride?: string` — test seam, the counterpart of `RestoreOptions.rootOverride`: every absolute path backup reads (the default `configPath`, the paths daemon.toml names, the fixed defaults) is read under this directory; tar paths are unchanged.

- `BackupResult`
  - `path: string` — absolute path to the written archive.
  - `password: string` — generated (or override) password; the entrypoint prints it once.
  - `filesIncluded: string[]` — tar paths actually packed.

**Invariants:**
- Password is generated by `runBackup` (32 chars from `[A-Za-z0-9]`, ≈190 bits entropy); operators do not choose it.
- Tar paths are RELATIVE (no leading slash) so restore can place each entry at the corresponding absolute path. The three configurable ones are the resolved tar paths of `state-paths.ts` (so `/var/lib/otzi/./share.json` is archived as `var/lib/otzi/share.json`, the path restore resolves it to); the three fixed ones are `FIXED_STATE_FILES` of the same module.
- `meta.json` is generated in-tar (version, createdAt, hostname, partyId); never copied from disk.
- `runBackup` is pure-ish: filesystem I/O + crypto only, no logging, no `process.exit`, no banner.

**Cross-component contracts:**
- Depends on: `node:crypto` (PBKDF2-SHA256, AES-256-GCM, randomBytes), `tar` (gzip), `smol-toml` (loose parse for share/identity/pubkey paths), `resolveStatePaths`, `FIXED_STATE_FILES` and `FIXED_TAR_PATHS` (`src/cli/state-paths.ts`), `DEFAULT_ADDRESS_BOOK_PATH` (`src/address-book/store.ts`).
- Used by: `entrypoint.ts`.
- Exports the wire-format constants `BACKUP_MAGIC`, `BACKUP_MAGIC_LEN`, `BACKUP_SALT_LEN`, `BACKUP_IV_LEN`, `BACKUP_TAG_LEN`, `BACKUP_HEADER_LEN`, `BACKUP_PBKDF2_ITERATIONS`, the default file paths and `stripLeadingSlash` — `restore.ts` consumes all of these.

### `restore.ts`
**Purpose:** Reverse of `runBackup`. Decrypt a `.otzi-backup` archive, read its tar members in memory, validate every member and every target path, then create each file at its canonical absolute path with the mode the daemon expects. Usable as a CLI verb and as the engine the debconf postinst pipes the password into via stdin. Restore runs as root, so it writes only the vault's own files, only directly inside `/etc/otzi` and `/var/lib/otzi`, and never replaces or follows anything already there. When it runs as root and a system user `otzi` exists, it also gives the files it places in `/var/lib/otzi` to that user, so the daemon (`User=otzi`) can read the share.

**Public surface:**
- `runRestore(opts: RestoreOptions): Promise<RestoreResult>`
  - **Pre-flight (in order; each step throws on failure):**
    1. Magic byte check on the archive (cheap precheck before decryption).
    2. Existing `/etc/otzi/daemon.toml` MUST NOT exist (refuses to clobber).
    3. `systemctl is-active otzi` MUST report inactive (refuses while daemon is running).
  - **Validation (after decryption, before anything is written; each failure throws and writes nothing):**
    1. Every tar member name is relative and has no `..` segment (`archive entry <name>: absolute path refused` / `… '..' refused`).
    2. Every member is a regular file, or a directory that is not a target path (skipped). A symlink, hardlink, character or block device or FIFO anywhere, and a directory at a target path, is refused (`archive entry <name>: <symlink|hardlink|character device|block device|FIFO|directory where a regular file is expected> refused`). A file named twice is refused.
    3. The targets are the fixed tar paths `etc/otzi/daemon.toml` (required), `etc/otzi/address-book.otzi.json`, `var/lib/otzi/vault-pubkey.json`, plus the three paths the archived daemon.toml names (`[share].path`, `[node].identity_key_file`, `[node].pubkey_book_file`, loose-parsed; the backup defaults when absent). Each of those three must be absolute and resolve (`path.posix.resolve`) to a direct child of `/etc/otzi` or `/var/lib/otzi` (the rule of `state-paths.ts`, which `otzi backup` applies too): a path elsewhere is refused with `daemon.toml in the archive: <key> = <path> is outside /etc/otzi and /var/lib/otzi; refused`, a path below a subdirectory of them (`/var/lib/otzi/keys/share.json`) with `… <key> = <path> is not a direct child of /etc/otzi or /var/lib/otzi; refused`; no two targets may be the same path. With every target directly inside an allowed directory there is no directory in between that a symlink could replace between the checks and the write.
    4. Every other member (and `meta.json`, read for the result) is not written: it is skipped and listed in `skippedEntries`.
    5. **No target exists** (`lstat`; a symlink, dangling or not, counts): otherwise `restore would replace existing files: <path>, …; move them aside and run restore again`, listing every one.
    - **Display:** every piece of archive-derived text in these refusals (entry names, the paths and parse errors of the archived daemon.toml, the target paths) is shown through `displayText` (`src/util/text.ts`): control characters are removed, so an archive cannot inject terminal escape sequences into the error.
  - **Placement:** in archive order, each target is created with `open(path, 'wx', mode)` (fails if anything appeared there meanwhile; never follows a symlink at the final component), given to the `otzi` user when ownership applies (below), written, `chmod`'d to its mode and synced; the allowed directory is created when missing.
  - **Ownership:** applies only when the process runs as root (`process.getuid?.() === 0`) and the `otzi` lookup finds a user. `readOtziOwner(root, run)` does the lookup: `findOtziOwner` over `<root>/etc/passwd` (uid and primary gid of the user `otzi`) and `<root>/etc/group` (gid of the group `otzi`, which wins over the user's primary gid), a missing file counting as empty. When that finds no user **and `root` is `/`** (no `rootOverride`; the host is the system being restored into), the directory service is asked: `getent passwd otzi` and `getent group otzi` through `run` (`RestoreOptions.execFile`, `timeout` 10 s each), their output parsed by `findOtziOwner` as passwd and group text. A `getent` that exits non-zero (2: not found), is absent, times out or prints something `findOtziOwner` rejects counts as no user. Another `root` never asks `getent`. Then every file placed directly inside `/var/lib/otzi` (the share, identity and pubkey-book files when `daemon.toml` puts them there, and `vault-pubkey.json`) is `fchown`ed to that uid and gid on the handle `open` returned, before the handle is closed, so no file is ever left mis-owned by a crash after it was closed. Files placed in `/etc/otzi` (`daemon.toml`, the address book, and any of the three that `daemon.toml` puts there) keep the owner they were created with: root, group `otzi` through the setgid directory. A failing `fchown` is a placement failure (rollback below) whose error is `could not give <path> to otzi (<uid>:<gid>): <reason>` (`cause` = the original error; `<path>` and `<reason>` through `displayText`). Not root: nothing is chowned, the files belong to the invoking user, and there is no warning. Root with no `otzi` user (the lookup above found none): nothing is chowned and `warnings` gets one entry, saying that no system user `otzi` was found, that the restored files in `/var/lib/otzi` stay root-owned and the daemon (`User=otzi`) will not be able to read its share, and giving the command `chown otzi:otzi <the files placed in /var/lib/otzi>` to run once the user exists, every path shell-quoted (`shellQuote`, `src/util/text.ts`: single quotes, an embedded single quote as `'\''`, so a space or a quote in a path cannot split a word or run anything); the entrypoint prints it on stderr as `WARNING: …`. Directories restore creates are not chowned.
  - **Post:** Every target in the archive exists at its canonical (or `rootOverride`-prefixed) absolute path with its mode and, where ownership applies, its owner (see "Restored file modes and owners"). `meta.json` is read into the result but NEVER written to disk. Returns `{ restoredFiles: { path, mode, owner? }[], skippedEntries: string[], warnings: string[], metaPartyId?, metaCreatedAt?, metaHostname? }`.
  - **Throws:**
    - Bad magic → `Error('not an otzi backup archive (magic mismatch)')`.
    - Existing daemon.toml → `Error('config already present at <path>; move it aside first')`.
    - Daemon running → `Error('daemon is running; stop it with \`systemctl stop otzi\` first')`.
    - Wrong password OR tampered ciphertext → BOTH surface as `Error('wrong password or corrupted archive')`. Distinguishing the two would give an attacker an oracle.
    - The validation errors above.
    - A failure during placement → every file this call created is removed (LIFO); the original error is rethrown. Files that existed before the call are never touched (none is a target, by step 5), and parent directories are NOT rolled back.

- `RestoreOptions`
  - `archivePath: string` — required positional CLI arg.
  - `password?: string` — explicit password (test path or `--password` flag; the flag leaks via `/proc/<pid>/cmdline`, docs steer operators to stdin).
  - `passwordStdin?: boolean` — read password from stdin until newline (postinst path).
  - `rootOverride?: string` — chroot-style prefix for all extraction targets (test seam; default `/`). The allowed directories become `<rootOverride>/etc/otzi` and `<rootOverride>/var/lib/otzi`; the paths daemon.toml names are still checked as production paths. The default `otzi` lookup reads `<rootOverride>/etc/passwd` and `<rootOverride>/etc/group` and does not ask `getent`, so a test root without them never chowns.
  - `daemonStatusCheck?: () => Promise<boolean>` — override the `systemctl is-active otzi` probe (test seam).
  - `execFile?: RunCommand` — runs the external commands, `systemctl is-active otzi` and `getent` (test seam; default `child_process.execFile`). `RunCommand = (file: string, args: readonly string[], options?: { timeout?: number }) => Promise<{ stdout: string }>`, rejecting on a non-zero exit, a timeout or a missing command.
  - `configExistsCheck?: () => Promise<boolean>` — override the daemon.toml-exists probe (test seam).
  - `stdinStream?: Readable` — alternate stream for the `passwordStdin` path (test seam).
  - `isRoot?: boolean` — overrides `process.getuid?.() === 0` (test seam).
  - `lookupOtziOwner?: () => Promise<OtziOwner | undefined>` — overrides the `readOtziOwner` lookup of the `otzi` user (test seam); `undefined` means there is no such user.
  - `chownFile?: (handle: FileHandle, path: string, owner: OtziOwner) => Promise<void>` — overrides the `handle.chown(owner.uid, owner.gid)` call (test seam); called with the still-open handle.

- `OtziOwner` — `{ uid: number; gid: number }`.
- `readOtziOwner(root: string, run?: RunCommand): Promise<OtziOwner | undefined>` — the lookup described under **Ownership**; `run` defaults to `child_process.execFile`.
- `findOtziOwner(passwd: string, group: string): OtziOwner | undefined` — pure parser of `passwd` / `group` file text: the uid of the user `otzi` and the gid of the group `otzi`, falling back to the user's primary gid; `undefined` when the user is missing or a field is not a non-negative integer.

- `RestoreResult`
  - `restoredFiles: { path: string; mode: number; owner?: OtziOwner }[]` — `owner` is present exactly for the files restore `fchown`ed.
  - `skippedEntries: string[]` — tar member names that are not part of a backup and were not written (the CLI prints one warning line per entry).
  - `warnings: string[]` — what the operator must act on although the restore succeeded (only the root-without-an-`otzi`-user case above; the CLI prints each as `WARNING: <text>` on stderr). Empty otherwise.
  - `metaPartyId?: number`, `metaCreatedAt?: string`, `metaHostname?: string` — from in-archive `meta.json`; missing/malformed meta is non-fatal.

**Invariants:**
- Pre-flights run in the order listed above.
- Wrong-password and tampered-archive surface IDENTICALLY.
- Members are parsed in memory (`tar` `Parser`); nothing from the archive is extracted to disk before validation, and nothing is ever written outside the target list.
- Restore only creates files: it never replaces, truncates, deletes or writes through an existing file system entry. A throw mid-place removes only the files this call created.
- Ownership never widens access: `fchown` happens on a file restore itself created with its final mode (the share is 0600), and only to the `otzi` user, whose daemon is the share's one legitimate reader. Restore never chowns a pre-existing entry, a directory, or anything in `/etc/otzi`.
- `meta.json` and unknown members are never written to disk; unknown members are reported in `skippedEntries`.
- Password resolution precedence: explicit `password` → `passwordStdin` → interactive readline prompt on stderr.
- `runRestore` is pure-ish: filesystem I/O + crypto + `systemctl` and (real root only) `getent` exec; a single `console.error` on rollback.

**Cross-component contracts:**
- Depends on: `node:crypto`, `tar` (`Parser`), `smol-toml`, `node:child_process`, constants from `backup.ts`, `resolveStatePaths`, `DATA_DIR` and `FIXED_STATE_FILES` (`src/cli/state-paths.ts`), `displayText` / `errorReason` / `shellQuote` (`src/util/text.ts`).
- Used by: `entrypoint.ts`, debconf postinst (via `--password-stdin`).

---

## src/testing/mock-esplora.ts (test only)

**Purpose:** In-process Esplora stand-in (Node `http`) for CLI end-to-end tests.

- `interface MockEsplora { url: string; broadcasts: string[]; fund(address: string, value: number, opts?: { confirmed?: boolean }): { txid: string; vout: number }; rejectBroadcasts(message: string | null): void; answerBroadcastsWith(txid: string | null): void; setFeeRates(rates: { fastestFee: unknown; halfHourFee: unknown; hourFee: unknown }): void; close(): Promise<void> }`
- `startMockEsplora(): Promise<MockEsplora>`
  - **Post:** Listens on loopback; `url` is the Esplora base, `http://127.0.0.1:<port>/<random 8 hex>` — the random path makes every instance's base unique, so the Esplora client's per-base fee-rate cache (60 s) never carries rates between instances. Serves `GET /address/:a/utxo`, `GET /address/:a`, `POST /tx`, `GET /v1/fees/recommended` → `{ fastestFee: 10, halfHourFee: 5, hourFee: 2 }` (until `setFeeRates`), and test-only `POST /_fund {address, value, confirmed}`. `fund` (default confirmed) adds a UTXO and returns its outpoint.
  - **`POST /tx`:** fails with status 400 and the `rejectBroadcasts` message while one is set; otherwise decodes the transaction and fails with status 400 (`… Witness program was passed an empty witness`) when any input has no witness data, so an unsigned transaction is never "broadcast"; otherwise records the hex in `broadcasts` and answers the transaction's txid (or the `answerBroadcastsWith` value).

---

## Backup archive wire format (invariant)

Wire layout, version 1:

```
0..32     "OTZI-BACKUP-V1\0\0\0..." (32B magic, NUL-padded; trailing bytes MUST be NUL)
32..48    salt (16B random; PBKDF2-SHA256 input, 600,000 iter → AES-256 key)
48..60    iv   (12B random; AES-256-GCM IV)
60..76    tag  (16B; AES-GCM auth tag, captured AFTER cipher.final())
76..end   ciphertext (AES-256-GCM(gzip(tar(file set))))
```

Bumping the format requires changing the magic to `OTZI-BACKUP-V2` (or similar) so old restores reject the new format cleanly. The strict NUL-padding check on bytes 14..32 means future versions cannot reuse the 32-byte magic block without a clean break.

Constants exported by `backup.ts`: `BACKUP_MAGIC`, `BACKUP_MAGIC_LEN`, `BACKUP_SALT_LEN`, `BACKUP_IV_LEN`, `BACKUP_TAG_LEN`, `BACKUP_HEADER_LEN`, `BACKUP_PBKDF2_ITERATIONS`, and the default paths `DEFAULT_DAEMON_CONFIG_PATH`, `DEFAULT_SHARE_PATH`, `DEFAULT_IDENTITY_PATH`, `DEFAULT_PUBKEY_BOOK_PATH`, `DEFAULT_VAULT_PUBKEY_PATH` and `DEFAULT_ADDRESS_BOOK_PATH` (the last is re-exported from `src/address-book/store.ts`, which owns it).

---

## Backup file set (invariant)

| Tar path | Source | Required |
|---|---|---|
| `etc/otzi/daemon.toml` | `--config` path | yes |
| share file (from `[share].path`) | v4 share | yes |
| identity file (from `[node].identity_key_file`) | P-256 identity | yes |
| pubkey-book file (from `[node].pubkey_book_file`) | pubkey book | yes |
| `var/lib/otzi/vault-pubkey.json` | vault metadata | no (skipped if absent) |
| `etc/otzi/address-book.otzi.json` | address book | no (skipped if absent) |
| `meta.json` | generated in-tar | always |

---

## Restored file modes and owners (invariant)

`restore.ts` creates each file with these modes. They match what the `.deb` postinst sets up. The owner column is the result of a restore run as root on an install with a system user `otzi` (normal ownership: see `docs/install.md` § File layout); a file `restore` did not chown belongs to whoever created it, and gets group `otzi` from the setgid directory when root creates it.

| Path | Mode | Owner after restore as root |
|---|---|---|
| `/etc/otzi/daemon.toml` | 0640 | root:otzi (setgid dir) |
| `/etc/otzi/address-book.otzi.json` | 0640 | root:otzi (setgid dir) |
| share file (configurable path) | 0600 | otzi:otzi in `/var/lib/otzi` |
| identity file | 0660 | otzi:otzi in `/var/lib/otzi` |
| pubkey-book file | 0644 | otzi:otzi in `/var/lib/otzi` |
| `/var/lib/otzi/vault-pubkey.json` | 0644 | otzi:otzi |

A share, identity or pubkey-book file that `daemon.toml` puts directly in `/etc/otzi` stays root:otzi (mode as in the table). Without a user `otzi` (after `getent`, on the real root), or when not root, no file is chowned; as root without the user, `warnings` says so (see **Ownership** under `runRestore`).

Operator-configurable paths (share / identity / pubkeys per `[share].path`, `[node].identity_key_file`, `[node].pubkey_book_file` in daemon.toml) are resolved at restore time by loose-parsing the archived daemon.toml, and must be direct children of `/etc/otzi` or `/var/lib/otzi` (no nested layouts); `otzi backup` refuses a daemon.toml that breaks this, so every archive it writes can be restored. Unrecognized tar entries are not written; `otzi restore` prints `warning: skipped archive entry <name>: not part of an otzi backup` to stderr for each.

---
