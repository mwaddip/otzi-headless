# Contracts: src/daemon/, src/cli/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/daemon/

### `config-merge.ts`
**Purpose:** Loads the daemon TOML config, the share password and the v4 share (if present) into `LoadedDaemonState`.

**Public surface:**
- `interface LoadedDaemonState { config: DaemonConfig; share?: DecryptedShare; password: string }`
  - **Post:** `share` is the decrypted v4 share, checked against `config.network.name`; `undefined` on a node without a vault (no file at `[share].path`). `password` is kept in memory so a DKG on this node can encrypt its new share with it.
  - **Invariant:** `share` presence gates signing; a node without a share can run the run-once DKG.

- `async loadAndValidate(configPath: string, options?: { env?: Readonly<Record<string, string | undefined>> }): Promise<LoadedDaemonState>`
  - **Pre:** `configPath` is a readable `daemon.toml`. The share password is in the env var named by `[share].password_env` (`options.env`, default `process.env`).
  - **Post:** Config parsed (`parseDaemonConfigToml`); `share = await loadVaultShare(config.share.path, password, config.network.name)`; a `.pending` file next to the share path is reported through `warnOnPendingShare` and never loaded. Whenever a share is loaded, `vault-pubkey.json` is rewritten from it (`writeVaultPubkeyFile(vaultPubkeyFromPackage(share.publicKeyPackage, network))`), in addition to the write on DKG commit. The rewrite is best-effort: a write failure is logged and does not stop startup.
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
  - **Post:** Reads the JSON at `path`, `decryptShareFile(raw, password)`, `assertShareMatchesVault(share, network)`; returns the share. Returns `undefined` when `path` does not exist (ENOENT).
  - **Throws:**
    - wrong password → `Error('cannot decrypt share file <path>: wrong password or corrupted file')`;
    - network mismatch → `assertShareMatchesVault`'s `Error('This share file belongs to a different vault')`;
    - other read, JSON or `decryptShareFile` validation errors.

- `async warnOnPendingShare(path: string, log: Logger): Promise<void>`
  - **Post:** When `pendingPath(path)` exists, logs one warn line naming it: it is left over from an unfinished DKG, is not loaded, and the next DKG overwrites it. Otherwise does nothing.

- `interface ShareStagerOptions { path: string; password: string; network: NetworkName; partyId: PartyId; vaultPubkeyPath?: string }`

- `createShareStager(opts: ShareStagerOptions): ShareStager`
  - **`stage(r)`:** writes `JSON.stringify(await encryptShareFile(r.keyPackage, r.publicKeyPackage, network, partyId, password))` to `pendingPath(path)` with mode 0600, creating the parent directory and overwriting any earlier `.pending`.
  - **`commit()`:**
    - **Pre:** `stage` resolved.
    - **Post:** `pendingPath(path)` renamed to `path`; then `writeVaultPubkeyFile(vaultPubkeyFromPackage(r.publicKeyPackage, network), vaultPubkeyPath)`.
    - **Throws:** `Error('share path already exists: <path>')` when a file exists at `path` (nothing renamed).
  - **`discard()`:** removes `pendingPath(path)`; ENOENT is ignored.

**Invariants:**
- A share reaches `path` only through `commit`, i.e. only after the DKG's all-N confirmation.
- Share files are mode 0600 from the first byte written (`.pending` and after the rename).
- Share files are byte-compatible with web Ötzi in both directions.

**Cross-component contracts:**
- Depends on: `encryptShareFile`, `decryptShareFile`, `assertShareMatchesVault` (`src/otzi/lib/share-file.ts`), `vault-pubkey.ts`.
- Used by: `config-merge.ts` (`loadVaultShare`, `warnOnPendingShare`), `Daemon` (`vaultFileExists`, `createShareStager` for orchestrator and leader).

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
  - **Post:** Creates the parent directory; writes pretty-printed JSON at `outputPath` (default `DEFAULT_VAULT_PUBKEY_PATH`) with mode 0644 (chmod applied after write).

- `async readVaultPubkeyFile(path?: string): Promise<VaultPubkeyFile>`
  - **Post:** Parsed file at `path` (default `DEFAULT_VAULT_PUBKEY_PATH`).
  - **Throws:** ENOENT → `Error` pointing the operator at `otzi generate`; malformed JSON or missing fields → `Error`.

**Invariants:**
- Every value is public; mode 0644 lets `otzi` group members and other users run read-only CLI commands.
- Written:
  - at daemon startup whenever a share is loaded (`loadAndValidate`; best-effort — a write failure is logged and does not stop startup);
  - by the share stager's `commit()` after a DKG completes.

**Cross-component contracts:**
- Depends on: `toVaultKey`, `vaultPayment` (`src/otzi/lib`).
- Written by: `config-merge.ts` (startup), `vault-share.ts` (`createShareStager().commit()`).
- Consumed by: `otzi vault`, `otzi btc balance|send|sign` (read-only).

---

### `api.ts`
**Purpose:** Daemon API request parsing and input rules (spec §6.1).

**Public surface:**
- `class RequestError extends Error { constructor(readonly status: 400 | 409, message: string) }`
- `interface LeaderSignRequest { ceremonyId: string; signers: PartyId[]; proposal: SendProposal }`

- `defaultCeremonyId(op: 'dkg' | 'sign'): string`
  - **Post:** `` `${op}-${crypto.randomUUID()}` `` (matches `CEREMONY_ID_RE`).

- `parseDkgRequest(body: Record<string, unknown>): { ceremonyId: string }`
  - **Pre:** `body` is the JSON request object (`op === 'dkg'`).
  - **Post:** Allowed keys: `op`, `ceremonyId`. `ceremonyId` must satisfy `isCeremonyId` when present; `defaultCeremonyId('dkg')` when absent.
  - **Throws:** `RequestError(400, …)` on any other key or an invalid `ceremonyId`.

- `parseSignRequest(body: Record<string, unknown>, ring: { partyIds: readonly PartyId[]; self: PartyId; minSigners: number }): LeaderSignRequest`
  - **Pre:** `body` is the JSON request object (`op === 'sign'`); `ring.partyIds` = every ring member; `ring.minSigners` = the loaded share's threshold.
  - **Post:** Allowed keys: `op`, `ceremonyId`, `signers`, `proposal`.
    - `ceremonyId`: `isCeremonyId` when present; `defaultCeremonyId('sign')` when absent.
    - `signers`: defaults to all of `ring.partyIds` (ascending); otherwise an array of integers, unique, each in `ring.partyIds`, containing `ring.self`, with at least `ring.minSigners` entries.
    - `proposal`: an object with string `tx` and array `prevouts`; hex fields (`tx`, `prevouts[].txid`, `prevouts[].script`) are lowercased, then the result must pass `isProposalShape` (1–255 prevouts).
  - **Throws:** `RequestError(400, <reason>)` on any violation.
  - **Notes:** Shape and ring rules only; `analyzeProposal` runs in `LeaderDispatcher.sign`.

**Cross-component contracts:**
- Depends on: `isCeremonyId`, `isProposalShape`, `MAX_INPUTS` (`src/core/messages.ts`).
- Used by: `buildDefaultHttpHandler`.

---

### `leader.ts`
**Purpose:** Leader-side ceremony dispatcher: the leader half of the DKG and of proposal signing.

**Public surface:**
- `class GateRejection extends Error { constructor(readonly ceremonyId: string, readonly decision: Decision) }`
  - **Post:** Thrown when the leader's own gate does not approve; the handler maps it to 403. Nothing was announced.

- `interface LeaderDeps`
  ```ts
  io: CeremonyIo; gate: ApprovalGate; node: { id: string; partyId: PartyId };
  peersById: ReadonlyMap<PartyId, string>; network: NetworkName; vault?: DecryptedShare;
  vaultExists: () => Promise<boolean>; createStager: () => ShareStager; rng: Rng;
  blobRetentionMs?: { signing: number; dkg: number };   // default BLOB_RETENTION_MS
  addressBook?: () => Promise<AddressBookEntry[]>; logger?: Logger;
  ```
  - **Pre:** Same meaning as the matching `OrchestratorDeps` fields; the daemon passes the same values to both.

- `class LeaderDispatcher`
  - **`constructor(deps: LeaderDeps)`**

  - **`runDkg(req: { ceremonyId: string }): Promise<{ ceremonyId: string; address: string; internalKey: string; network: NetworkName }>`**
    1. `deps.vault` set or `await vaultExists()` → `RequestError(409, 'this node already holds a vault')`.
    2. `threshold = parties = peersById.size`; gate on `buildDkgSpec({ ceremonyId, leader: node.id, role: 'leader' }, { threshold, parties, network, peerIds })`; non-approve (or a gate error) → `GateRejection`.
    3. Random 32-byte session ID; broadcast `announce-dkg {ceremonyId, sessionIdHex, threshold, parties, network}`; `runDkgCeremony(io, spec, createStager())`.
    4. Returns `address` = `vaultPayment(toVaultKey(publicKeyPackage), network).address` and `internalKey` = untweaked group key (33-byte SEC1 hex).
    - **Throws:** `RequestError`, `GateRejection`, or the `runDkgCeremony` error (which already broadcast `signoff-aborted`).
    - **Post:** Success and failure both `scheduleClear` the ceremony with the DKG retention. The new vault is on disk but not loaded; signing on it needs a daemon restart.

  - **`sign(req: LeaderSignRequest): Promise<{ ceremonyId: string; txid: string; signedTxHex: string; signaturesHex: string[] }>`**
    1. No vault → `RequestError(409, 'no vault loaded — run otzi generate, then restart the daemon')`.
    2. `analysis = analyzeProposal(proposal, toVaultKey(vault.publicKeyPackage), network)`; a throw → `RequestError(400, <message>)`.
    3. Gate on `buildSigningSpec(analysis, { ceremonyId, leader: node.id, role: 'leader' }, network, labelFor)` (labels from `addressBook` when present); non-approve (or a gate error) → `GateRejection`.
    4. `leadSigning(io, { ceremonyId, signers, sighashes: analysis sighashes, keyPackage, publicKeyPackage, rng }, proposal)` — this broadcasts `announce-sign`.
    5. `finalizeSend(proposal.tx, proposal.prevouts, signatures as { index, signature: hex }, vaultPayment(vaultKey, network).outputKey)` → signed hex and txid.
    6. Broadcast `signoff-done {ceremonyId, signaturesHex}`; return `{ ceremonyId, txid, signedTxHex, signaturesHex }`.
    - **Failure after the announce:** broadcast `signoff-aborted {ceremonyId, reason}` and rethrow (handler → 500).
    - **Post:** Settle and failure both `scheduleClear` the ceremony with the signing retention.

**Invariants:**
- Nothing is announced unless the leader's own analysis and gate passed (400 / 403 leave peers untouched).
- The leader never broadcasts the transaction; it returns it.
- The leader's own gate is evaluated once per request.
- Signoffs come only from the leader for signing; DKG aborts come from whichever node fails.

**Cross-component contracts:**
- Depends on: `runDkgCeremony`, `leadSigning`, `encodeMessage`, `analyzeProposal` / `toVaultKey` / `vaultPayment` / `labelFor` (`src/otzi/lib`), `finalizeSend` (`src/otzi/backend/bitcoin.ts`), `spec-builder.ts`, `scheduleClear`.
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
  env?: Readonly<Record<string, string | undefined>>; vaultPubkeyPath?: string;
  ```
  - **Pre:** `selfPartyId` and `peersById` come from `TransportBundle` (book lookup by pubkey); `transport.partyId === selfPartyId`.

- `class Daemon`
  - **`constructor(deps: DaemonDeps)`**
    - **Post:** Builds `BlobStore`, `BlobServer`, `BlobPuller`, one `CeremonyIo`; the gate via `createGate(config.gate, { loadAddressBook })`; `Orchestrator` and `LeaderDispatcher` with the same `io`, `gate`, `node`, `peersById`, `network = config.network.name`, `vault = state.share`, `vaultExists = () => vaultFileExists(config.share.path)`, `createStager = () => createShareStager({ path, password, network, partyId: selfPartyId, vaultPubkeyPath })`, `rng`, and `addressBook = () => readAddressBook(DEFAULT_ADDRESS_BOOK_PATH, network)`; trigger sources from `config.triggers`. `loadAddressBook` returns the book's addresses.
    - **Invariant:** Does NOT start anything.
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
    | `vault-info` | `{ op }` | `{ partyIds, threshold, parties, network, address, internalKey, outputKey }` — `partyIds` ascending from `peersById`; key fields as in `vault-pubkey.json`. 409 when no vault is loaded. |
    | `dkg` | `{ op, ceremonyId? }` | `{ ceremonyId, status: 'done', address, internalKey, network }`. `parties` = ring size, `threshold` = `parties`. 409 when this node already holds a vault. |
    | `sign` | `{ op, ceremonyId?, signers?, proposal }` | `{ ceremonyId, status: 'done', txid, signedTxHex, signaturesHex }`. 409 when no vault is loaded. |

  - `dkg` runs `parseDkgRequest` then `leader.runDkg`; `sign` runs `parseSignRequest(body, { partyIds, self: selfPartyId, minSigners: share.threshold })` then `leader.sign`.
  - **Status codes:** 400 for a malformed body, an unknown op, an unknown top-level field, bad input, or a proposal rejected by analysis (message from `analyzeProposal`); `RequestError` → its status with `{ error }`; `GateRejection` → 403 `{ error: 'gate rejected', decision, ceremonyId }`; anything else → 500 `{ error, ceremonyId }`.

**Invariants:**
- One gate, one orchestrator, one leader dispatcher, one blob server per daemon.
- The daemon makes no chain requests; Esplora and broadcast are used only by CLI verbs.
- The HTTP trigger is loopback-only (enforced by the config parser); the UDS socket is the default operator API.

**Cross-component contracts:**
- Depends on: all of `src/core`, `src/gate`, `src/orchestrator`, `src/triggers`, `src/address-book/store.ts`, `vault-share.ts`, `api.ts`, `leader.ts`.
- Used by: `entrypoint.ts` (after state and transport are ready).

---

### `transport-factory.ts`
**Purpose:** Loads the identity key file and pubkey book, identifies self by pubkey match, cross-checks the share and `[[peers]]` against the book, derives the ringId and the `peersById` label map, and builds the peer-mesh or relay transport.

**Public surface:**
- `TransportBundle`
  - **Post:** Carries `transport`, `identity` keypair, `pubkeyBook`, authoritative `selfPartyId` (book lookup by pubkey), `selfEntry`, `peersById` (`peer-${partyId}` for non-self, `config.node.id` for self), `ringId`, and `start`/`stop`.

- `buildTransportFromFiles(state, options): Promise<TransportBundle>`
  - **Pre:** `config.node.identityKeyFile` + `pubkeyBookFile` paths are set.
  - **Post:** Loads identity + book from disk, runs `resolveSelfFromBook`, runs `validatePeersAgainstBook` for peer-mesh, derives ringId + peersById, returns bundle.
  - **Throws:** `Error` on file read, JSON parse, identity-not-in-book, `[[peers]]`/book mismatch, missing paths, or share/book disagreement.

- `buildTransportFromMemory(state, identity, book, options): Promise<TransportBundle>`
  - **Pre:** Identity + book are pre-built (test path).
  - **Post:** Same validation, same bundle, no disk I/O.

- **Identity file format** (JSON): `{ pkcs8Hex: <hex>, publicKeyHex: <hex> }` — PKCS#8 DER, 130-char hex uncompressed P-256 public key.

- **Pubkey book format:** produced by bootstrap (`runMasterBootstrap` / `runMemberRegister`), parsed by `parseBook`. Entries: `{ partyId, publicKeyHex (130-char), advertisedEndpoint (canonical host:port) }`.

- **`resolveSelfFromBook(identity, book)`** (internal)
  - **Post:** Returns the book entry whose `publicKeyHex` (case-insensitive) matches the loaded identity. When a share is loaded: `share.partyId === selfEntry.partyId` and `share.parties === book.entries.length`.
  - **Throws:** `Error` if no entry matches the identity (re-run `otzi setup` for a stale book); if `share.partyId` disagrees with the book; `Error('share is for <p> parties but the pubkey book has <n>')`.

- **`validatePeersAgainstBook(book, configPeers, selfPartyId)`** (internal, peer-mesh only)
  - **Post:** Returns when the set of non-self book `advertisedEndpoint` values equals the set of `[[peers]].endpoint` values. The book is authoritative for partyId + pubkey; `[[peers]]` is a typo check.
  - **Throws:** `Error` on any endpoint present on one side only.

- **ringId derivation:** SHA-256 over all raw pubkeys concatenated in partyId order, hex-encoded. Identical on every peer.

- **Transport branching**
  - **peer-mesh:** requires `config.transport.advertisedEndpoint`; runs `validatePeersAgainstBook`; builds `PeerMeshTransport` from the book (`endpoint: ws://${advertisedEndpoint}`).
  - **relay:** requires `config.transport.url`; builds `RelayTransport` with partyId + pubkey per book entry. The relay routes by partyId; cryptographic auth alone gates relay traffic.

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
- `book.advertisedEndpoint` is bare `host:port`; transport-factory prepends `ws://` for `PeerMeshTransport`.
- `peersById` reaches the `Daemon` via `DaemonDeps.peersById`; `peersById.size` is the ring size used for DKG `parties` and the default `signers`.

---

### `entrypoint.ts`
**Purpose:** The `otzi` executable. Dispatches verbs, runs the daemon, prints operator banners, maps errors to exit codes.

**Verbs:**

| Verb | Behaviour |
|---|---|
| `otzi daemon <config>` | Run the daemon (`runDaemonCommand`). |
| `otzi setup <config>` | Bootstrap pubkey exchange; prints the 96-bit fingerprint. |
| `otzi generate [--config <path>] [--ceremony-id <id>]` | Daemon `dkg` op (`generate`); banner prints the vault address and the restart instruction. |
| `otzi vault [--json]` | Address, network, threshold/parties; the full file (keys included) with `--json`. |
| `otzi btc balance [--unit sats\|btc\|mbtc\|ubtc] [--config <path>]` | Esplora balance: confirmed and unconfirmed. |
| `otzi btc send <label\|address> <amount[unit]\|max> [--fee-rate N] [--config <path>]` | `btcSend`: prints the txid and explorer URL. |
| `otzi btc sign <proposal.json> [--broadcast] [--config <path>]` | `btcSign`: prints the analysis summary, txid and signed hex; `--broadcast` posts it. |
| `otzi book list` | Print entries. |
| `otzi book add <label> <address> [--note <text>]` | Add or update an entry. |
| `otzi book remove <label\|address>` | Remove an entry. |
| `otzi book import <file> [--replace]` | Merge (default) or replace; prints added/updated/unchanged counts. |
| `otzi book export [path]` | Write the book file (stdout without a path). |
| `otzi backup` / `otzi restore <archive> [--password-stdin]` | Archive and restore node state. |

- `--config` defaults to `/etc/otzi/daemon.toml`.
- CLI verbs other than `daemon` keep `NOOP_LOGGER` and write machine output to stdout only; banners and errors go to stderr.
- `BroadcastFailedError` → the signed transaction hex is printed to stderr (so the operator can broadcast it by other means) and the process exits 1. Any other error → message on stderr, exit 1.

- **`runDaemonCommand`**
  - **Post:** `loadAndValidate` → `buildTransportFromFiles` → `Daemon` → `start`; SIGINT/SIGTERM stop the daemon and the transport, then exit 0. The startup line names the mode: signing (vault loaded) or setup (no vault). In setup mode it states that signing is refused until `otzi generate` completes and the daemon restarts. A stale `.pending` share is reported at warn level.

**Invariants:**
- The daemon is the only long-lived verb; every other verb talks to it over the daemon client (UDS by default) or works on local files.
- TOML + share password are required by the daemon; absence fails at load time.

**Cross-component contracts:**
- Depends on: `config-merge`, `transport-factory`, `Daemon`, `setup`, `src/cli/cmd/*`.

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
  - **Post:** Loads config; loads/generates identity key; runs bootstrap master; writes pubkey book; prints the fingerprint banner.
  - **Idempotent:** If the pubkey book already exists, re-prints the fingerprint without re-bootstrapping.
  - **Identity:** Reused if file exists; generated if missing (mode 0660).

- **`setupMember(configPath, masterUrl): Promise<void>`**
  - **Pre:** Config path + master URL provided.
  - **Post:** Loads config; loads/generates identity key; registers with master; writes pubkey book; prints the fingerprint banner.
  - **Idempotent:** If the pubkey book already exists, re-prints the fingerprint.

- **Fingerprint banner:** the 96-bit fingerprint `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` from `computeFingerprint`, with the instruction to compare it out of band with every other operator before any DKG.

- **Validation:** `identity_key_file` and `pubkey_book_file` must be set in config; missing paths fail immediately.

- **File I/O**
  - **Identity:** Mode 0660 (group read/write); the daemon user (`otzi`) reads it through group membership when an operator in the `otzi` group ran `setup`.
  - **Pubkey book:** Mode 0644 (world-readable).
  - **Parent directories:** Created recursively.

**Invariants:**
- Setup is idempotent; re-running after abort is safe.
- The fingerprint must match across all nodes (operators compare it); a mismatch means tampering — delete the books and redo setup.

**Cross-component contracts:**
- Depends on: Config loader, bootstrap runners (`runMasterBootstrap`, `runMemberRegister`), identity crypto, pubkey book serialization.
- Used by: `entrypoint.ts`.

---

**Cross-file contracts (orchestrator/triggers/daemon):**

- **HTTP listener binding:** `HttpTrigger` binds loopback only (parser-enforced). Localhost binding is load-bearing: it is why the API needs no mTLS.
- **Verify-before-gate:** leader (`LeaderDispatcher.sign`) and participants (`Orchestrator`) both run `analyzeProposal` against their own key before the gate; specs are built from that analysis.
- **Leadership:** the leader is the node whose trigger fired. For signing it announces, aggregates, finalizes and sends the signoff; for DKG it only generates the session ID and announces.
- **Share persistence:** leader and participants persist a DKG result through the same `ShareStager`: stage to `.pending`, commit after all-N confirmation. A failure discards `.pending` on every node.
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
  - `request<T>(body: unknown): Promise<T>` — POSTs JSON; 200 → parsed body; non-200 → `DaemonClientError(status, message)`.
  - `vaultInfo(): Promise<VaultInfo>` — `{ op: 'vault-info' }`.
  - **Throws:** `Error` when the config has neither trigger.

**Cross-component contracts:** Used by every CLI verb that talks to the daemon (`generate`, `btc send`, `btc sign`). Commands take an injectable `{ request }` (`CliDeps.client`) for tests.

### `units.ts`
**Purpose:** CLI amount parsing and formatting.

- `type BtcUnit = 'sats' | 'btc' | 'mbtc' | 'ubtc'`
- `parseBtcAmount(input: string): { sats: bigint; unit: BtcUnit; raw: string }`
  - **Post:** `<number>[sats|btc|mbtc|ubtc]` (default sats) converted to integer sats without floating point.
  - **Throws:** On empty input, an unknown unit, a fractional sat, or a negative amount.
- `formatSats(sats: bigint, unit?: BtcUnit): string` — decimal string in `unit` (default sats), trailing zeros trimmed.

---

## src/cli/cmd/

### `generate.ts`
**Purpose:** `otzi generate` — run the run-once DKG through the local daemon.

- `generate(opts: { configPath: string; ceremonyId?: string }, deps?: CliDeps): Promise<{ ceremonyId: string; address: string; network: NetworkName }>`
  - **Pre:** The daemon on this node is running and holds no vault; every other daemon in the ring is running and holds no vault.
  - **Post:** Sends `{ op: 'dkg', ceremonyId? }` through `deps.client` or `DaemonClient.fromConfig(configPath)`; returns the response's `ceremonyId`, `address`, `network`.
  - **Throws:** `DaemonClientError` (409 when the node already holds a vault, 403 gate reject, 500 ceremony failure).
  - **Banner (entrypoint):** vault address, network, share path, and the instruction to restart every daemon to load the new share.

### `vault.ts`
**Purpose:** `otzi vault [--json]` — print the vault metadata from `vault-pubkey.json`.

- `vault(opts?: { vaultPath?: string; json?: boolean }): Promise<string>`
  - **Post:** Reads `readVaultPubkeyFile(opts.vaultPath)`. Default output: address, network, `threshold`-of-`parties`. With `json`: the whole file as pretty JSON (keys and `vaultKey` included).
  - **Throws:** `readVaultPubkeyFile` errors (missing file points at `otzi generate`).

### `btc.ts`
**Purpose:** `otzi btc balance|send|sign` — chain access through Esplora, signing through the daemon.

**Public surface:**
- `interface CliDeps { client?: { request<T>(body: unknown): Promise<T> } }`
- `class BroadcastFailedError extends Error { constructor(message: string, readonly txid: string, readonly signedTxHex: string) }`

- `btcBalance(opts: { configPath: string; vaultPath?: string; unit?: BtcUnit }): Promise<string>`
  - **Post:** `getBalance(base, address)` with `base = config.network.esploraUrl` or `chainApiUrl({ network })`; returns `"confirmed: X\nunconfirmed: Y"` formatted in `unit` (default sats).

- `btcSend(opts: { configPath: string; vaultPath?: string; to: string; amount: string; feeRate?: number }, deps?: CliDeps): Promise<{ txid: string; explorerUrl: string }>`
  1. Read `vault-pubkey.json` and the config (Esplora base: `esplora_url` or the `chainApiUrl` default).
  2. Resolve `to` with `resolveRecipient(readAddressBook(DEFAULT_ADDRESS_BOOK_PATH, network), to, network)`.
  3. `getUtxos`, keeping confirmed ones only.
  4. `amount` is `'max'` or `parseBtcAmount(amount).sats`; fee rate is `feeRate` or `getFeeRates(base).normal`.
  5. `buildSend({ utxos, vault: vaultKey, network, to, amount, feeRate })`.
  6. More than 255 prevouts → `Error('this send needs <k> inputs; at most 255 fit in one transaction — consolidate first')` before any daemon call.
  7. Daemon `{ op: 'sign', proposal: { network, tx, prevouts } }`.
  8. `broadcastTx(base, signedTxHex)`; on failure throw `BroadcastFailedError(message, txid, signedTxHex)`.
  - **Post:** Returns the txid and `explorerTxUrl(base, txid)`.
  - **Throws:** recipient, UTXO, `InsufficientFundsError`, input-limit, daemon (`DaemonClientError`) and broadcast errors.

- `btcSign(opts: { configPath: string; vaultPath?: string; proposalPath: string; broadcast: boolean }, deps?: CliDeps): Promise<{ txid: string; signedTxHex: string; summary: string; explorerUrl?: string }>`
  - **Post:** Reads a `SendProposal` JSON file; refuses more than 255 prevouts; `analyzeProposal` against `vault-pubkey.json`'s `vaultKey` and network gives `summary` (outputs with labels, change, fee, fee rate); daemon `{ op: 'sign', proposal }`; broadcasts only when `broadcast` is true (`explorerUrl` then set; a failure throws `BroadcastFailedError`).
  - **Throws:** file / JSON errors, analysis errors (before any daemon call), daemon errors, `BroadcastFailedError`.

**Invariants:**
- The CLI is the only component that talks to the chain.
- A signed transaction is never lost: if broadcast fails after signing, the hex reaches the operator.

### `book.ts`
**Purpose:** `otzi book list|add|remove|import|export` — manage this node's address book.

**Public surface:**
- `interface BookOpts { configPath: string; bookPath?: string }` — network from the config; `bookPath` defaults to `DEFAULT_ADDRESS_BOOK_PATH`.
- `bookList(o: BookOpts): Promise<string>` — one line per entry: label, address, note.
- `bookAdd(o: BookOpts & { label: string; address: string; note?: string }): Promise<void>` — adds the entry, or updates the label and note of the entry with the same address; the result must pass `validateEntries`; written with `writeAddressBook`.
- `bookRemove(o: BookOpts & { key: string }): Promise<void>` — removes the entry whose label or address equals `key`. **Throws** when nothing matches.
- `bookImport(o: BookOpts & { file: string; replace: boolean }): Promise<{ added: number; updated: number; unchanged: number }>` — `parseAddressBookFile` on the file for the configured network; merges with `mergeAddressBooks` (default) or makes the file's entries the book (`replace`); writes; returns the counts `mergeAddressBooks(current, incoming)` reports.
- `bookExport(o: BookOpts & { out?: string }): Promise<string>` — `addressBookFile(entries, network)` as pretty JSON; also written to `out` when given.

**Invariants:**
- Every write goes through `writeAddressBook` (validation, atomic replace, mode 0640). Writing needs the same privilege as editing `daemon.toml`.
- Import/export files are Ötzi address-book files and move between nodes and web Ötzi unchanged.

### `backup.ts`
**Purpose:** Pack full node state (config, share, identity, pubkey book, vault metadata, address book, meta) into one password-protected archive so an operator who loses their host can recover into a fresh `.deb` install via `otzi restore`.

**Public surface:**
- `runBackup(opts?: BackupOptions): Promise<BackupResult>`
  - **Pre:** `configPath` (default `/etc/otzi/daemon.toml`) exists and is readable; share file (`[share].path`, loose-parsed from daemon.toml), identity file (`[node].identity_key_file`) and pubkey-book file (`[node].pubkey_book_file`) exist. Optional files (`vault-pubkey.json`, the address book) are skipped if absent.
  - **Post:** Single archive written at `<outputDir>/otzi-backup-<safe-ISO>.otzi-backup` (default `outputDir` is `os.homedir()`); mode 0600; atomic via `.tmp` + rename. Returns `{ path, password, filesIncluded }`.
  - **Throws:**
    - Required file missing → `Error` with message ending in `". This looks like a fresh / pre-bootstrap install; nothing meaningful to back up yet."`.
    - daemon.toml unreadable (ENOENT) → propagates with the same canonical tail.

- `BackupOptions`
  - `configPath?: string` — daemon.toml location (default `/etc/otzi/daemon.toml`).
  - `outputDir?: string` — archive destination directory (default `os.homedir()`).
  - `passwordOverride?: string` — bypasses the generated 32-char base62 password. Production callers MUST NOT set this; tests use it for determinism.
  - `now?: () => Date` — clock seam for the filename timestamp.
  - `pathOverrides?` — test seam for the fixed paths not derived from daemon.toml (`vault-pubkey.json`, the address book).

- `BackupResult`
  - `path: string` — absolute path to the written archive.
  - `password: string` — generated (or override) password; the entrypoint prints it once.
  - `filesIncluded: string[]` — tar paths actually packed.

**Invariants:**
- Password is generated by `runBackup` (32 chars from `[A-Za-z0-9]`, ≈190 bits entropy); operators do not choose it.
- Tar paths are RELATIVE (no leading slash) so restore can place each entry at the corresponding absolute path.
- `meta.json` is generated in-tar (version, createdAt, hostname, partyId); never copied from disk.
- `runBackup` is pure-ish: filesystem I/O + crypto only, no logging, no `process.exit`, no banner.

**Cross-component contracts:**
- Depends on: `node:crypto` (PBKDF2-SHA256, AES-256-GCM, randomBytes), `tar` (gzip), `smol-toml` (loose parse for share/identity/pubkey paths).
- Used by: `entrypoint.ts`.
- Exports the wire-format constants `BACKUP_MAGIC`, `BACKUP_MAGIC_LEN`, `BACKUP_SALT_LEN`, `BACKUP_IV_LEN`, `BACKUP_TAG_LEN`, `BACKUP_HEADER_LEN`, `BACKUP_PBKDF2_ITERATIONS`, the default file paths and `stripLeadingSlash` — `restore.ts` consumes all of these.

### `restore.ts`
**Purpose:** Reverse of `runBackup`. Decrypt a `.otzi-backup` archive, untar it into a tmpdir, validate, then place each file at its canonical absolute path with the mode the daemon expects. Usable as a CLI verb and as the engine the debconf postinst pipes the password into via stdin.

**Public surface:**
- `runRestore(opts: RestoreOptions): Promise<RestoreResult>`
  - **Pre-flight (in order; each step throws on failure):**
    1. Magic byte check on the archive (cheap precheck before decryption).
    2. Existing `/etc/otzi/daemon.toml` MUST NOT exist (refuses to clobber).
    3. `systemctl is-active otzi` MUST report inactive (refuses while daemon is running).
  - **Post:** All tar entries placed at canonical (or `rootOverride`-prefixed) absolute paths; each file `chmod`'d to its mode (see "Restored file modes"). `meta.json` is read into the result but NEVER written to disk. Returns `{ restoredFiles: { path, mode }[], metaPartyId?, metaCreatedAt?, metaHostname? }`.
  - **Throws:**
    - Bad magic → `Error('not an otzi backup archive (magic mismatch)')`.
    - Existing daemon.toml → `Error('config already present at <path>; remove it first')`.
    - Daemon running → `Error('daemon is running; stop it with \`systemctl stop otzi\` first')`.
    - Wrong password OR tampered ciphertext → BOTH surface as `Error('wrong password or corrupted archive')`. Distinguishing the two would give an attacker an oracle.
    - Mid-extract failure → every file already placed is `rm`'d in LIFO order; the original error is rethrown. Parent directories are NOT rolled back.

- `RestoreOptions`
  - `archivePath: string` — required positional CLI arg.
  - `password?: string` — explicit password (test path or `--password` flag; the flag leaks via `/proc/<pid>/cmdline`, docs steer operators to stdin).
  - `passwordStdin?: boolean` — read password from stdin until newline (postinst path).
  - `rootOverride?: string` — chroot-style prefix for all extraction targets (test seam; default `/`).
  - `daemonStatusCheck?: () => Promise<boolean>` — override the `systemctl is-active otzi` probe (test seam).
  - `configExistsCheck?: () => Promise<boolean>` — override the daemon.toml-exists probe (test seam).
  - `stdinStream?: Readable` — alternate stream for the `passwordStdin` path (test seam).

- `RestoreResult`
  - `restoredFiles: { path: string; mode: number }[]`.
  - `metaPartyId?: number`, `metaCreatedAt?: string`, `metaHostname?: string` — from in-archive `meta.json`; missing/malformed meta is non-fatal.

**Invariants:**
- Pre-flights run in the order listed above.
- Wrong-password and tampered-archive surface IDENTICALLY.
- Extraction is staged-then-placed: `tar.extract` lands files in a tmpdir, modes are computed by parsing the staged daemon.toml, then files are copied to their real destinations. A throw mid-place triggers LIFO rollback of placed files only.
- `meta.json` is the only entry never written to disk.
- Unrecognized tar entries fall back to the most-restrictive mode (0600).
- Password resolution precedence: explicit `password` → `passwordStdin` → interactive readline prompt on stderr.
- `runRestore` is pure-ish: filesystem I/O + crypto + `systemctl` exec only; a single `console.error` on rollback.

**Cross-component contracts:**
- Depends on: `node:crypto`, `tar`, `smol-toml`, `node:child_process`, constants from `backup.ts`.
- Used by: `entrypoint.ts`, debconf postinst (via `--password-stdin`).

---

## src/testing/mock-esplora.ts (test only)

**Purpose:** In-process Esplora stand-in (Node `http`) for CLI end-to-end tests.

- `interface MockEsplora { url: string; broadcasts: string[]; fund(address: string, value: number, opts?: { confirmed?: boolean }): { txid: string; vout: number }; rejectBroadcasts(message: string | null): void; close(): Promise<void> }`
- `startMockEsplora(): Promise<MockEsplora>`
  - **Post:** Listens on loopback; `url` is the Esplora base. Serves `GET /address/:a/utxo`, `GET /address/:a`, `POST /tx` (records the hex in `broadcasts`, returns its txid, or fails with the `rejectBroadcasts` message), `GET /v1/fees/recommended` → `{ fastestFee: 10, halfHourFee: 5, hourFee: 2 }`, and test-only `POST /_fund {address, value, confirmed}`. `fund` (default confirmed) adds a UTXO and returns its outpoint.

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

Constants exported by `backup.ts`: `BACKUP_MAGIC`, `BACKUP_MAGIC_LEN`, `BACKUP_SALT_LEN`, `BACKUP_IV_LEN`, `BACKUP_TAG_LEN`, `BACKUP_HEADER_LEN`, `BACKUP_PBKDF2_ITERATIONS`.

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

## Restored file modes (invariant)

`restore.ts` applies these modes after extraction. They match what the `.deb` postinst sets up (chmod-only; ownership inherits from `/etc/otzi` and `/var/lib/otzi` setgid bits).

| Path | Mode |
|---|---|
| `/etc/otzi/daemon.toml` | 0640 |
| `/etc/otzi/address-book.otzi.json` | 0640 |
| share file (configurable path) | 0600 |
| identity file | 0660 |
| pubkey-book file | 0644 |
| `/var/lib/otzi/vault-pubkey.json` | 0644 |

Operator-configurable paths (share / identity / pubkeys per `[share].path`, `[node].identity_key_file`, `[node].pubkey_book_file` in daemon.toml) are resolved at restore time by loose-parsing the staged daemon.toml. Unrecognized tar entries fall back to 0600 (most restrictive default).

---
