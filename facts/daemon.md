# Contracts: src/daemon/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/daemon/

### `config-merge.ts`
**Purpose:** Loads daemon TOML config + optional share file, validates alignment, assembles `LoadedDaemonState` with peers + persistence sink.

**Public surface:**
- `LoadedDaemonState`
  - **Pre:** Config loaded; share optionally decrypted; peers assembled.
  - **Post:** Carries config, share (undefined in DKG-only mode), FROST public material, peersById (includes self), persistence sink.
  - **Invariant:** `share` presence gates signing ceremonies; DKG-only mode has share == undefined.

- `loadAndValidate(configPath, options): Promise<LoadedDaemonState>`
  - **Pre:** Config file path is valid; share password is in env var.
  - **Post:** Loads TOML, attempts to read share file, validates alignment, returns full state.
  - **Throws:** `Error` on TOML parse, share JSON parse, share decrypt, alignment mismatch, missing password.
  - **Share-missing branch:** If share file does not exist (ENOENT), enters DKG-only mode; build state without share but with persistence sink ready for post-DKG write.

- `validateLoaded(config, options): Promise<LoadedDaemonState>`
  - **Pre:** Config is already parsed `DaemonConfig`; password is in env var.
  - **Post:** Same as `loadAndValidate` (file read skipped).

- `buildStateFromShare(config, share): LoadedDaemonState`
  - **Pre:** `share` is decrypted; config was not yet validated against it.
  - **Post:** Validates alignment (partyId match, peers count, contiguous partyIds); builds FROST public material if FROST key package is present; returns state WITHOUT persistence sink.
  - **Throws:** `Error` on alignment violation.
  - **Invariant:** Test-friendly (no disk I/O).

- `buildStateNoShare(config): LoadedDaemonState`
  - **Pre:** Daemon has no share file (DKG-only mode).
  - **Post:** Builds peers map from config; returns state without share, FROST material, or persistence sink.

- **Validation invariants**
  - **partyId alignment:** `share.partyId === config.node.partyId`.
  - **Peers count:** `len(config.peers) + 1 === share.parties` (self + peers == share total).
  - **Contiguous partyIds:** All partyIds in [0, share.parties) are present exactly once across config.
  - **Range check:** All partyIds are in range [0, share.parties).

- **Frost legacy sig extraction** (from share file JSON)
  - **Pre:** Share file is parsed as JSON.
  - **Post:** Extracts top-level `frostLegacySig` hex field; validates it's a valid hex string (non-empty).
  - **Throws:** `Error` if field is present but invalid.
  - **Invariant:** Absence is OK (returns undefined); field is a daemon-side add-on, not part of Ötzi's V3 byte format.

**Invariants:**
- Share file is optional; its absence triggers DKG-only mode, not failure.
- Password env var MUST be set (used for both existing share decrypt and future DKG output encrypt).
- FROST public material is derived from FROST key package (if present); external supply overrides.
- Persistence sink is pre-bound at load time; captures password + path in closure.

**Cross-component contracts:**
- Depends on: TOML loader, share crypto (`decryptShareFile`), FROST reconstruct.
- Used by: `entrypoint.ts` (loadAndValidate), `Daemon` constructor (passes state).

**Notes / gotchas:**
- `buildStateFromShare` is used by tests that inject a pre-built share (dealerKeygen result).
- `frostLegacySig` is piggy-backed on the V3 envelope; Ötzi's decoder tolerates unknown keys.
- DKG-only mode is a full operational mode (daemon can orchestrate + lead DKG); signing is rejected + logged.

**Bootstrap-secret lifecycle (phase 9a)**
- **Load:** `loadAndValidate` (in `config-merge.ts`) optionally reads `/var/lib/otzi/bootstrap-secret` if it exists. Stored on `LoadedDaemonState.bootstrapSecret: string | undefined`. ENOENT is fine — secret may have been wiped post-DKG.
- **Use:** Phase 9c's control-plane wire opcode verifies the operator-typed shared secret via HMAC-SHA-256. Phase 9a only loads it; 9c consumes it.
- **Wipe:** `share-persistence.persistCombinedDkgShare` `unlink()`s `/var/lib/otzi/bootstrap-secret` after the share is durably written. Daemon's in-memory `bootstrapSecret` is also cleared. Subsequent control-plane attempts get a defined "control plane closed" error.
- **Reentrancy:** ENOENT on unlink is silently ignored (idempotent on retries / repeat DKG).

---

### `share-persistence.ts`
**Purpose:** Persists combined-DKG result to disk as an Ötzi-compatible V3 encrypted file, with chmod 0600 + parent mkdir.

**Public surface:**
- `persistCombinedDkgShare(args): Promise<void>`
  - **Pre:** `args.result` is CombinedDkgResult (mldsa.share, mldsa.publicKey, frost.keyPackage, frost.keyPackage.verifyingKey populated); threshold, parties, level are positive integers; path is writable (or parent is); password is set.
  - **Post:** Encrypts share via `encryptShareV3` (Ötzi compat); adds `frostLegacySig` hex as top-level field; creates parent directory; writes JSON with mode 0600; applies explicit chmod after write (belt-and-suspenders against umask).
  - **Throws:** `Promise` rejection on mkdir / writeFile / chmod failure.
  - **Invariant:** File is overwritten (no append); parent directory is created if missing (recursive).

- **File format**
  - V3 envelope produced by `encryptShareV3` (Ötzi-compatible byte structure, JSON-serialized).
  - Extra top-level `frostLegacySig` field (hex string) piggybacked outside the byte-compat format.
  - JSON pretty-printed (2-space indent).

- **Permissions**
  - File mode is explicitly set to 0o600 (owner read/write only) at construction time AND after write (explicit chmod).
  - Parent directory is created with default permissions (recursive mkdir).

**Invariants:**
- Persistence is best-effort; errors do NOT abort the ceremony (participant-side behavior) but DO propagate to caller on leader side.
- Chmod is applied twice (once in writeFile options, once explicitly) to defend against umask.
- `frostLegacySig` is a daemon-side add-on; not part of Ötzi's canonical V3 byte format, but `decryptShareFile` + loader tolerate unknown JSON keys.

**Cross-component contracts:**
- Depends on: `encryptShareV3`, dkg utilities (getKL), hex encoding.
- Called by: `LeaderDispatcher.runCombinedDkg`, `Orchestrator.dispatchCombinedDkg` (both via pre-bound sink).

**Notes / gotchas:**
- `frostLegacySig` is populated from `CombinedDkgResult.frostLegacySig` (produced by runner); if absent, field is not added to JSON.
- Parent mkdir is recursive; supports operator workflows that point at e.g. `/etc/otzi/share.json` on a fresh box.
- File is synchronously readable after Promise resolves (await ensures chmod has finished).

---

### `control-plane.ts`
**Purpose:** Bootstrap-window-only control-plane handlers. Currently: `manifest-push` (Phase 9c). Verifies HMAC, validates schema, atomically installs the pushed manifest.

**Public surface:**
- `ControlPlane` (class)
  - **Constructor(opts: ControlPlaneOpts = {})**
    - `secretPath` defaults to `/var/lib/otzi/bootstrap-secret`; tests override.
    - `manifestPath` defaults to `/etc/otzi/manifest.otzi.json`; tests override.
    - `logger` defaults to `NOOP_LOGGER`.
- `installPushedManifest(input: { manifest: string; hmacHex: string }): Promise<void>`
  - **Pre:** Caller has decoded the wire message; `manifest` is verbatim text, `hmacHex` is the asserted HMAC.
  - **Post:** On success, manifest is at `manifestPath` (chmod 0o660, atomic write via `.tmp` + rename). Idempotent on byte-identical existing manifest (no-op write, info log).
  - **Throws:**
    - `ControlPlaneClosed` — `bootstrap-secret` file missing or empty (post-DKG).
    - `HmacMismatch` — HMAC verify failed (constant-time compare via `timingSafeEqual`).
    - `ManifestRejected` — JSON parse or schema validation failure.
    - `ManifestExists` — a different manifest already installed at `manifestPath` (operator must `otzi uninstall` locally first).

**Invariants:**
- HMAC compare is constant-time. HMAC computed as `HMAC-SHA-256(secret, manifestText)` with the secret read fresh from disk per request (so the post-DKG wipe takes effect immediately, no daemon-restart needed).
- Manifest is written verbatim — no canonicalization. The HMAC is over the exact bytes the operator sent.
- Trailing-whitespace tolerance on `existing.trim() !== input.manifest.trim()` so an existing file with a trailing newline is still considered identical.

**Cross-component contracts:**
- Depends on: `validateManifest` from `src/cli/manifest-validate.ts` (reuses the same schema check as `otzi install`); `node:crypto` for HMAC + constant-time compare.
- Used by: `Daemon`'s `op:'sync'` HTTP handler (local install path) and `Orchestrator.handleManifestPush` (remote-receive path).

**Lifecycle:**
- The `bootstrap-secret` is created by 9a's debconf flow at install time; persisted at `/var/lib/otzi/bootstrap-secret` chmod 660 root:otzi.
- `share-persistence.persistCombinedDkgShare` `unlink()`s the file on first successful DKG completion (Phase 9a.5).
- After the unlink, every `installPushedManifest` call throws `ControlPlaneClosed` — the control plane is permanently closed for that federation.

---

### `vault-pubkey.ts`
**Purpose:** Writes the operator-facing vault metadata cache `/var/lib/otzi/vault-pubkey.json`. Cache exists so the CLI (`otzi vault` / `otzi btc balance` / `otzi op20 balance` / `otzi btc send`) can answer "what's our vault address?" without ever decrypting the share file.

**Public surface:**
- `writeVaultPubkeyFile(input): Promise<void>`
  - **Pre:** `input.network` is a valid `NetworkName`; `input.frostUntweakedPubKey` is the 33B SEC1 untweaked aggregate FROST pubkey; `input.frostTweakedPubKey` is the 32B x-only post-tweak (or 33B SEC1, both accepted as raw bytes for hex-encoding); `input.mldsaPubKey` is the raw ML-DSA public key bytes.
  - **Post:** Creates parent dir (recursive); writes JSON with mode 0o644. Schema:
    ```json
    {
      "network": "mainnet" | "testnet" | "regtest",
      "btcAddress": "<bech32m P2TR>",
      "opnetAddress": "0x<64 hex>",
      "frostUntweakedPubKey": "<hex>",
      "frostTweakedPubKey": "<hex>",
      "mldsaPubKeyHex": "<hex>"
    }
    ```
  - **Trigger:** Written (overwriting) on every `loadAndValidate` (daemon startup post share decrypt) AND post-DKG via `share-persistence.persistCombinedDkgShare`.
  - **Permissions:** chmod 0o644 (world-readable) — values are public (BTC address, OPNet address, ML-DSA pubkey, FROST aggregate pubkeys). The CLI reads the file as the operator user; group + world readability avoids needing operator-group elevation for read-only commands.
  - **Output path override:** Callers may pass `outputPath` (defaults to `/var/lib/otzi/vault-pubkey.json`); production paths use the default.

**Invariants:**
- Address derivation matches `deriveVaultP2tr` (broadcast subsystem) — both compute the same bech32m for the same untweaked FROST aggregate + network.
- OPNet address is `0x` + hex(SHA256(mldsaPubKey)) — same identity model the rest of the codebase uses.
- File is overwritten (no append); writes are NOT atomic (write failure mid-flight could leave a truncated file). Acceptable: the file is rewritten on every daemon startup, and the schema is small (KB-scale), so partial-write corruption is rare and self-healing on restart.

**Failure mode:** ENOENT before first DKG completes. CLI commands that need the vault address print a clean error pointing the operator to `otzi generate`.

**Cross-component contracts:**
- Depends on: `deriveVaultP2tr` from `src/broadcast/opnet-params-reconstruct.ts`; sha256 from `@noble/hashes`; hex helpers.
- Called by: `config-merge.loadAndValidate` (startup), `share-persistence.persistCombinedDkgShare` (post-DKG).
- Consumed by: CLI commands `otzi vault`, `otzi btc balance`, `otzi btc send`, `otzi op20 balance` (read-only).

---

### `leader.ts`
**Purpose:** Leader-side ceremony dispatcher. Evaluates gate, invokes runner, broadcasts signoff, surfaces result. Discriminated DKG + signing requests.

**Public surface:**
- `LeaderDeps`
  - **Pre:** `runner`, `gate`, `node`, `peersById` are all set; share optional (signing requires it); FROST material optional (FROST ceremonies require it); network optional (set iff keylink needed); frostLegacySig optional (required for opnet-params).
  - **Post:** Fully configures a leader dispatcher.

- `LeaderSignRequest` (discriminated union)
  - **btc:** scheme='frost', protocol='btc'; provides BTC tx construction params (to, amount, fee, network, pubkey, utxos). Operator asserts UTXOs; leader + participants rebuild tx + sighashes locally.
  - **opnet:** scheme='frost', protocol='opnet'; provides raw unsigned tx + prevout info. Sighashes extracted from bytes. Hints are advisory.
  - **opnet-params:** scheme='frost', protocol='opnet-params'; provides contract + method + params + pre-computed ML-DSA threshold sig. Leader fetches UTXOs + challenge, generates rnd seed, runs capture, broadcasts tx internally.
  - **mldsa:** scheme='mldsa', protocol='raw'; provides opaque message bytes to sign. No intent fields.

- `LeaderSignResult`
  - **Pre:** Sign ceremony completed.
  - **Post:** Carries scheme + signatures; opnet-params includes transactionId (daemon broadcast it).

- `GateRejection` (Error subclass)
  - **Pre:** Gate returns non-approve decision.
  - **Post:** Thrown with ceremonyId + decision; HTTP handler catches and returns 403.
  - **Invariant:** Ceremony never announces when gate rejects (no side effect on peers).

- **runCombinedDkg(req)**
  - **Pre:** req.ceremonyId, threshold, parties, level set.
  - **Post:** Gates the spec; runs `runner.runCombinedDkg` with `network` passed if set; persists result (errors propagate).
  - **Throws:** `GateRejection` on gate non-approve; other errors propagate.

- **runMldsaDkg(req)**, **runFrostDkg(req)**
  - **Pre:** Same as combined (thresh, parties for mldsa; thresh, parties for frost).
  - **Post:** Gates, runs, persists (if applicable).

- **sign(req: LeaderSignRequest)**
  - **Pre:** `req.signers` includes self; FROST/ML-DSA key material present as required.
  - **Post:** Gates spec (varies by scheme/protocol); runs ceremony; broadcasts signoff on success; returns signatures.
  - **BTC:** Builds tx from params, gates spec with verified outputs, runs FROST signing, broadcasts, returns sigs.
  - **OPNet raw-tx:** Gates spec with advisory hints, runs FROST signing, broadcasts, returns sigs.
  - **OPNet opnet-params:** Fetches UTXOs + challenge, generates rnd seed, runs capture, gates with verified destination + method, runs FROST signing, broadcasts tx internally, returns sigs + txid.
  - **ML-DSA:** Gates generic signing spec, runs signing, broadcasts signoff, returns signature.
  - **Throws:** `GateRejection` on gate non-approve; `Error` on missing key material (e.g., DKG-only mode, no FROST material).

- **Spec building per protocol**
  - **btc:** Populates operation='btc-transfer'; filters self from outputs; computes amount + destination.
  - **opnet:** Populates operation='opnet-call'; copies advisory hints (contractAddress, method, amountTokenAtomic).
  - **opnet-params:** Populates operation='opnet-call'; destination + method are structurally verified (capture rebuilt them); amount from hints.
  - **mldsa generic:** Populates operation='generic' (no intent fields).

**Invariants:**
- Gate evaluation happens once per ceremony (decision is not cached, unlike participant-side; leader always evaluates fresh).
- BTC outputs are verified locally (rebuild); participants verify by matching sighashes.
- OPNet raw-tx hints are advisory; only sighash is trusted.
- OPNet opnet-params destination + method are structurally verified (deterministic capture is same on all peers).
- Signoff always comes from the leader (no exception for participants).
- Share + FROST material are required for signing ceremonies; absence produces clear error before side effects.
- Network field is only passed to combined DKG when mainnet/testnet (regtest passes undefined, key-link skipped).
- `frostLegacySig` is required for opnet-params leader flow; absence throws before capture.

**Cross-component contracts:**
- Depends on: `CeremonyRunner`, gate, BTC/OPNet rebuild/capture functions, OPNet provider.
- Used by: `Daemon` (instantiated once; HTTP handler dispatches to leader methods).

**Notes / gotchas:**
- Leader is NOT distinguished from participants in the DKG protocol itself; leadership is a node-level role in the daemon config.
- BTC UTXO mismatch is worst-case DoS (wasted ceremony); consensus rejects at broadcast.
- OPNet opnet-params is the most complex flow: async UTXO/challenge fetch, deterministic capture, broadcast.
- `opnetSeedFill` defaults to WebCrypto; tests inject a deterministic fill for reproducibility.
- `persistDkgShare` on leader side propagates errors (500 to HTTP caller); participant side logs errors but continues.

---

### `daemon.ts`
**Purpose:** Composition root. Wires blob infra + runner + gate + orchestrator + leader + triggers into a single Daemon object.

**Public surface:**
- `DaemonDeps`
  - **Pre:** `state` is LoadedDaemonState (config + optional share + peersById + persistence sink); transport is injected; rng, pullOpts provided; logger optional.
  - **Post:** Passed to Daemon constructor.

- `Daemon` (class)
  - **Constructor(deps: DaemonDeps)**
    - **Pre:** All deps are set.
    - **Post:** Constructs composition: BlobStore, BlobServer, BlobPuller, CeremonyRunner, ApprovalGate, Orchestrator, LeaderDispatcher, trigger sources.
    - **Invariant:** Does NOT call `start()` yet.

  - **async start(): Promise<void>**
    - **Pre:** Called exactly once (or after stop).
    - **Post:** Starts orchestrator + all triggers.
    - **Logs:** Info message with trigger count.
    - **Throws:** Any error from trigger.start() propagates.
    - **Invariant:** Reentrant (returns early if already started).

  - **async stop(): Promise<void>**
    - **Pre:** Called after start (or redundantly).
    - **Post:** Stops all triggers; stops orchestrator; closes blob server.
    - **Logs:** Info message on stop.
    - **Invariant:** Reentrant (returns early if not started).

  - **onCompleted(handler): Unsubscribe**
    - **Pre:** Called at any time.
    - **Post:** Wires listener to orchestrator.onCompleted; forwards ceremony outcomes.

- **Trigger assembly** (buildTriggers)
  - **Pre:** Trigger config entries from DaemonConfig.
  - **Post:** Instantiates HttpTrigger / CronTrigger per entry.
  - **HTTP:** Requires 'bind' param; optional 'auth_token_env'; uses httpHandler (default or injected).
  - **Cron:** Requires 'job_name' + 'schedule' params; optional 'timezone'; resolves handler from cronHandlers map.
  - **Throws:** `Error` on missing required params or missing cron handler.

- **Default HTTP handler** (buildDefaultHttpHandler)
  - **Pre:** POST requests to handler. Constructed with `(leader, network: NetworkName, state: LoadedDaemonState, controlPlane: ControlPlane, transport: Transport, logger)`.
  - **Post:** Discriminated dispatch on `req.body.op` field: 'vault-info', 'dkg-combined', 'dkg-mldsa', 'dkg-frost', 'sign', 'sync'.
  - **vault-info (read):** Returns `{ partyIds, threshold, parties, network, btcAddress, opnetAddress }` from in-memory state. 409 if no share is loaded yet (`vault-info: no share loaded (run 'otzi generate' first)`).
  - **dkg-combined:** Runs combined DKG; response carries `mldsaPublicKeyHex`, `frostVerifyingKeyHex`, plus operator-facing `btcAddress` + `opnetAddress` + `network` (computed via `deriveVaultAddresses`). The address triple matches what `vault-pubkey.json` will hold post-restart.
  - **DKG ops (mldsa, frost):** Extract threshold, parties, level; invoke leader; return ceremony result + public keys.
  - **sign op:** Discriminate on scheme + protocol; parse BTC/OPNet/opnet-params/raw-mldsa request; invoke leader.sign; return signatures + optional txid.
  - **sync op (Phase 9c):** Operator-facing manifest distribution endpoint.
    - **Pre:** Local `bootstrap-secret` exists; `manifest` is valid headless-manifest-v1 JSON; `hmac` matches HMAC-SHA-256(secret, manifest).
    - **Post:** Local manifest atomically installed via `controlPlane.installPushedManifest`; `manifest-push` wire message broadcast to every peer via `transport.broadcast`; response carries `{ ceremonyId, status, peersNotified }`.
    - **Status 410:** `{ error: 'control plane closed' }` when `bootstrap-secret` is missing (post-DKG).
    - **Status 400:** HMAC mismatch / schema failure / existing-non-identical-manifest (carries `kind` for the error class name).
    - **Status 502:** Manifest installed locally, but `transport.broadcast` failed.
    - **Invariant:** Local install runs first — failure short-circuits the broadcast.
  - **Status 403 on gate reject:** `{ error: 'gate rejected', decision, ceremonyId }`.
  - **Status 500 on other errors:** `{ error: <message>, ceremonyId }`.
  - **Status 400 on malformed input.**
  - **Invariant:** All field validation is strict (throws on type mismatch); missing fields are caught early.

- **Network branching**
  - **Pre:** config.network.name is 'mainnet' | 'testnet' | 'regtest'.
  - **Post:** Regtest → key-link skipped, opnetProvider undefined; mainnet/testnet → key-link enabled, opnetProvider set.

- **SDK mnemonic**
  - **Pre:** deps.sdkWalletMnemonic optional (or injected for tests).
  - **Post:** Generated once at startup (never signed; monkey-patched during capture); shared to both orchestrator + leader.

**Invariants:**
- HTTP listener should be localhost-bound (security assumption; should be enforced at HttpTrigger level).
- Daemon does NOT call `initEccLib` (phase-4d trap; double-init misroutes FROST legacy-sig monkey-patch).
- `sdkWalletMnemonic` is a disposable credential; daemon generates a new one each startup.
- `opnetProvider` is only used on mainnet/testnet (regtest passes undefined).

**Cross-component contracts:**
- Depends on: All ceremony infrastructure (runner, gate, orchestrator, leader, blob, triggers).
- Used by: `entrypoint.ts` (instantiated after state + transport are ready).

**Notes / gotchas:**
- `frostKeyPackage` is optional in DaemonDeps but required for FROST ceremonies; absence throws at ceremony time.
- HTTP handler errors are caught; GateRejection is special-cased to 403 (decision in body).
- Default handler is comprehensive; custom handlers can be injected for alternative APIs.
- Trigger assembly validates that all cron jobs have handlers; unknown job names fail at start() time.

---

### `transport-factory.ts`
**Purpose:** Loads identity key file + pubkey book, validates alignment, derives deterministic ringId (SHA-256 of sorted pubkeys), and builds peer-mesh or relay transport.

**Public surface:**
- `TransportBundle`
  - **Pre:** Transport is built and validated.
  - **Post:** Carries transport instance, identity keypair, pubkey book, ringId, and start/stop methods.

- `buildTransportFromFiles(state, options): Promise<TransportBundle>`
  - **Pre:** config.node.identityKeyFile + pubkeyBookFile paths are set.
  - **Post:** Loads files, validates identity matches book, validates all peers in book, derives ringId, returns bundle.
  - **Throws:** `Error` on file read, JSON parse, validation mismatch, missing paths.

- `buildTransportFromMemory(state, identity, book, options): Promise<TransportBundle>`
  - **Pre:** Identity + book are pre-built (test path).
  - **Post:** Same validation, same bundle, no disk I/O.

- **Identity file format** (JSON)
  - `{ pkcs8Hex: <hex>, publicKeyHex: <hex> }`
  - PKCS#8 DER encoding, 130-char hex uncompressed P-256 public key.

- **Pubkey book format**
  - Produced by bootstrap (phase 3c); parsed by `parseBook`.
  - Entries: partyId, nodeId, publicKeyHex (130-char).

- **Validation invariants**
  - **Identity matches book:** Identity's public key === self entry's publicKeyHex (case-insensitive).
  - **Self entry present:** Pubkey book has entry for config.node.partyId with matching nodeId.
  - **All peers in book:** Every config.peers[].partyId has an entry; entry.nodeId === peer.id.

- **ringId derivation**
  - **Pre:** Pubkey book entries are present (at least self).
  - **Post:** Concatenate all pubkeys in order (sorted by partyId), SHA-256 hash.
  - **Invariant:** Same on every peer (deterministic, used for relay identity).

- **Transport branching**
  - **peer-mesh:** Requires config.transport.listen; constructs PeerMeshTransport with self + peers + endpoints.
  - **relay:** Requires config.transport.url; constructs RelayTransport with self + peers + relay URL.

**Invariants:**
- Identity file is loaded once at startup; private key never leaves daemon (only public key is broadcast in book).
- Pubkey book is read-only at runtime (bootstrap produces it once; daemon consumes it).
- ringId is deterministic across all peers (enables relay routing + peer coordination).
- Transport.kind determines which transport is instantiated (peer-mesh vs relay).

**Cross-component contracts:**
- Depends on: File I/O, bootstrap types (PubkeyBook, parseBook), identity crypto, transport implementations.
- Used by: `entrypoint.ts` (buildTransportFromFiles).

**Notes / gotchas:**
- ringId is a SHA-256 hash of concatenated pubkeys; order is sorted by partyId.
- Identity validation is strict; mismatch with pubkey book is a fatal startup error.
- Peer endpoints are optional in config; presence is copied into peer list for peer-mesh.

---

### `entrypoint.ts`
**Purpose:** CLI entrypoint. Dispatches `otzi daemon`, `otzi setup`, `otzi generate` subcommands. Loads config + state + transport + daemon. Handles SIGINT/SIGTERM for graceful shutdown.

**Public surface:**
- **main(argv): Promise<void>**
  - **Pre:** argv is process.argv.
  - **Post:** Parses subcommand + args; dispatches to handler.
  - **Subcommands:**
    - `daemon <config.toml>` — Loads state, transport, daemon; starts; waits for signals.
    - `setup leader <config.toml> --bind <host:port>` — Runs bootstrap leader (master).
    - `setup leaf <config.toml> --leader <url>` — Runs bootstrap follower (member).
    - `generate <config.toml> [--threshold N] [--level 44] [--ceremony-id <id>]` — Triggers combined DKG via HTTP POST to local daemon.

- **runDaemonCommand**
  - **Pre:** Config path provided.
  - **Post:** Loads config + share (if present); builds transport; instantiates Daemon; starts; sets up signal handlers.
  - **Logs:** Startup message with mode (signing+DKG vs DKG-only).
  - **Shutdown:** SIGINT/SIGTERM trigger graceful shutdown (daemon.stop, bundle.stop).
  - **DKG-only mode:** Daemon announces that operator must run `otzi generate` from another shell, then restart.
  - **Invariant:** Does NOT call `initEccLib` (phase-4d trap).

- **runSetupCommand**
  - **Pre:** Subcommand + config path + flags provided.
  - **Post:** Dispatches to setupMaster or setupMember.

- **runGenerateCommand**
  - **Pre:** Config path + optional flags provided.
  - **Post:** Finds HTTP trigger in config; POSTs dkg-combined request to local daemon; awaits result; announces complete with public keys.
  - **Flags:** --threshold (defaults to 2/3 of parties), --level (defaults to 44), --ceremony-id (auto-generated).
  - **Invariant:** Daemon MUST have an HTTP trigger configured; error if not.

**Invariants:**
- Daemon is the primary entrypoint; setup + generate are supportive CLIs.
- DKG-only mode is fully operational; signing is rejected + logged until share is reloaded via restart.
- Graceful shutdown is enforced via signal handlers; process.exit(0) on completion.
- TOML + share password are required; absence fails at load time.

**Cross-component contracts:**
- Depends on: Config loader, state loader, transport factory, Daemon, setupMaster/setupMember, signal handlers.
- Entry point: Executed when module is main (if import.meta.url === ...).

**Notes / gotchas:**
- Phase 4d trap: `initEccLib` is NOT called in entrypoint (comment explains why; @btc-vision/transaction auto-inits).
- Generate command is a convenience; it POSTs to the daemon's HTTP trigger (same endpoint users would use).
- Setup is a one-time per-node workflow; pubkey book is re-used (idempotent).

---

### `setup.ts`
**Purpose:** Bootstrap CLI wrappers. Drives setupMaster (leader) + setupMember (member) with identity key generation + pubkey book persistence.

**CLI surface (`entrypoint.ts`)**
  - `otzi setup <config.toml>` — zero-arg. Reads `[bootstrap].role` from config to dispatch:
    - `role = "leader"` → calls `setupMaster(configPath, config.bootstrap.bind)`.
    - `role = "leaf"` → calls `setupMember(configPath, config.bootstrap.leaderUrl)`.
  - Throws `Error` if `[bootstrap]` is missing, role is unknown, or the role-specific field is absent. The legacy `setup leader|leaf` CLI form is REMOVED — config-driven dispatch is the only path.

**Public surface:**
- **setupMaster(configPath, bind): Promise<void>** — internal helper, unchanged signature.
  - **Pre:** Config path + bind address (host:port) provided.
  - **Post:** Loads config; loads/generates identity key; runs bootstrap master; writes pubkey book.
  - **Idempotent:** If pubkey book already exists, re-emits fingerprint without re-bootstrapping.
  - **Identity:** Reused if file exists; generated if missing (mode 0660).
  - **Logs:** Announcement of setup complete + fingerprint + verification warning.

- **setupMember(configPath, masterUrl): Promise<void>** — internal helper, unchanged signature.
  - **Pre:** Config path + master URL provided.
  - **Post:** Loads config; loads/generates identity key; registers with master; writes pubkey book.
  - **Idempotent:** If pubkey book already exists, re-emits fingerprint.

- **Validation**
  - **identity_key_file** must be set in config.
  - **pubkey_book_file** must be set in config.
  - **Errors:** Missing paths cause immediate failure.

- **File I/O**
  - **Identity:** Mode 0660 (group read/write — Phase 9a.3). Daemon-user (otzi) reads via group membership when an operator-user (in `otzi` group) ran `setup`.
  - **Pubkey book:** Mode 0644 (world-readable).
  - **Parent directories:** Created recursively.

**Invariants:**
- Setup is idempotent; re-running after abort is safe.
- Fingerprint must match across all nodes (operator manually verifies).
- Mismatch indicates tampering; operator deletes books + restarts setup.

**Cross-component contracts:**
- Depends on: Config loader, bootstrap runners (runMasterBootstrap, runMemberRegister), identity crypto, pubkey book serialization.
- Used by: `entrypoint.ts` (via `runSetupCommand`).

**Notes / gotchas:**
- Setup is a separate CLI invocation (not integrated into daemon startup).
- Fingerprint is a hash of the pubkey book; operator manually verifies it matches across peers.
- Identity key generation uses a secured random source (not mnemonic-based).

---

**Cross-file contracts (orchestrator/triggers/daemon):**

- **Phase-4d trap (initEccLib):** `daemon.ts` + `entrypoint.ts` MUST NOT call `initEccLib(createNobleBackend())` — `@btc-vision/transaction` auto-inits. Double-init silently misroutes FROST legacy-sig monkey-patch.
- **HTTP listener binding:** `HttpTrigger` should enforce strict host:port (no 0.0.0.0 defaults). This is load-bearing security: localhost binding justifies future lack of mTLS.
- **Verify-before-gate pattern:** `Orchestrator.verifyFrostAnnounce` runs before `evaluateGate`; participants verify sighashes locally (BTC rebuild, OPNet extract, opnet-params capture); gate policy operates over verified fields + advisory hints.
- **Asymmetric leadership:** Leader is distinguished by node-level config role; protocol itself treats all peers symmetrically (DKG). Leadership is for ceremony initiation + signoff broadcast, not protocol asymmetry.
- **Share persistence:** Leader-side persistence propagates errors (HTTP 500); participant-side persistence is best-effort (ceremony succeeds even if disk write fails; operator monitors logs).
- **Network gating:** `network` field gates key-link phase (mainnet/testnet only); regtest daemons skip key-link, `frostLegacySig` remains undefined, opnet-params announces silent-drop.

---

## src/cli/cmd/

### `backup.ts`
**Purpose:** Pack full daemon state (config + manifest + share + identity + pubkey-book + vault-pubkey cache + bootstrap-secret + meta) into a single password-protected archive so an operator who loses their host can recover into a fresh `.deb` install via `otzi restore`.

**Public surface:**
- `runBackup(opts?: BackupOptions): Promise<BackupResult>`
  - **Pre:** `configPath` (default `/etc/otzi/daemon.toml`) exists and is readable; share file (path resolved by loose-parsing `[share].path` from daemon.toml), identity file (`[node].identity_key_file`), and pubkey-book file (`[node].pubkey_book_file`) all exist on disk. Optional files (manifest, vault-pubkey, bootstrap-secret) are silently skipped if absent.
  - **Post:** Single archive written at `<outputDir>/otzi-backup-<safe-ISO>.otzi-backup` (default `outputDir` is `os.homedir()`); mode 0600; atomic via `.tmp` + rename. Returns `{ path, password, filesIncluded }` where `filesIncluded` is the list of tar paths that ended up in the archive.
  - **Throws:**
    - Required file missing → `Error` with message ending in `". This looks like a fresh / pre-bootstrap install; nothing meaningful to back up yet."`.
    - daemon.toml unreadable (ENOENT) → propagates with the same canonical tail.

- `BackupOptions`
  - `configPath?: string` — daemon.toml location (test seam; default `/etc/otzi/daemon.toml`).
  - `outputDir?: string` — archive destination directory (test seam; default `os.homedir()`).
  - `passwordOverride?: string` — bypasses generated 32-char base62 password. Production callers MUST NOT set this; tests use it for determinism.
  - `now?: () => Date` — clock seam for the filename ISO timestamp.
  - `pathOverrides?: { manifest?, vaultPubkey?, bootstrapSecret? }` — test seam for the three fixed paths that aren't derived from daemon.toml.

- `BackupResult`
  - `path: string` — absolute path to the written archive.
  - `password: string` — generated (or override) password. CLI wrapper in `entrypoint.ts` prints the operator-facing banner.
  - `filesIncluded: string[]` — tar paths actually packed (skipped optionals omitted).

**Invariants:**
- Password is generated by `runBackup` (32 chars from `[A-Za-z0-9]`, ≈190 bits entropy); operators do not choose. Returned for the wrapper to display once.
- Tar paths are RELATIVE (no leading slash) so restore can place each entry at the corresponding absolute path.
- `meta.json` is generated in-tar (version, createdAt, hostname, partyId); never copied from disk.
- `runBackup` is pure-ish: filesystem I/O + crypto only, no logging, no `process.exit`, no banner. The `entrypoint.ts` wrapper handles operator-facing output and exit codes.

**Cross-component contracts:**
- Depends on: `node:crypto` (PBKDF2-SHA256, AES-256-GCM, randomBytes), `tar` (tar.create with gzip), `smol-toml` (loose parse for share/identity/pubkey paths).
- Used by: `entrypoint.ts` `runBackupCommand` wrapper.
- Exports the wire-format constants `BACKUP_MAGIC`, `BACKUP_MAGIC_LEN`, `BACKUP_SALT_LEN`, `BACKUP_IV_LEN`, `BACKUP_TAG_LEN`, `BACKUP_HEADER_LEN`, `BACKUP_PBKDF2_ITERATIONS`, plus the default file paths and `stripLeadingSlash` helper — `restore.ts` consumes all of these.

---

### `restore.ts`
**Purpose:** Reverse of `runBackup`. Decrypt a `.otzi-backup` archive, untar it into a tmpdir, validate, then place each file at its canonical absolute path with the per-file mode the daemon expects. Usable both as a standalone CLI verb and as the engine the debconf postinst pipes the password into via stdin.

**Public surface:**
- `runRestore(opts: RestoreOptions): Promise<RestoreResult>`
  - **Pre-flight (in order; each step throws on failure):**
    1. Magic byte check on the archive (cheap precheck before decryption).
    2. Existing `/etc/otzi/daemon.toml` MUST NOT exist (refuses to clobber).
    3. `systemctl is-active otzi` MUST report inactive (refuses while daemon is running).
  - **Post:** All tar entries placed at canonical (or `rootOverride`-prefixed) absolute paths; each file `chmod`'d to its hardcoded mode (see "Restored file modes" invariant below). `meta.json` is read into the result for operator confirmation but NEVER written to disk. Returns `{ restoredFiles: { path, mode }[], metaPartyId?, metaCreatedAt?, metaHostname? }`.
  - **Throws:**
    - Bad magic → `Error('not an otzi backup archive (magic mismatch)')`.
    - Existing daemon.toml → `Error('config already present at <path>; remove it first')`.
    - Daemon running → `Error('daemon is running; stop it with \`systemctl stop otzi\` first')`.
    - Wrong password OR tampered ciphertext → BOTH surface as `Error('wrong password or corrupted archive')`. Distinguishing the two would give an attacker an oracle.
    - Mid-extract failure → track-and-rollback: every file already placed at a real-path destination is `rm`'d in LIFO order; original error is rethrown. Parent directories are NOT rolled back (postinst may have created them; idempotent mkdir can't be safely undone).

- `RestoreOptions`
  - `archivePath: string` — required positional CLI arg.
  - `password?: string` — explicit password (test path or `--password` flag; flag leaks via `/proc/<pid>/cmdline`, docs steer operators to stdin).
  - `passwordStdin?: boolean` — read password from stdin until newline (postinst path).
  - `rootOverride?: string` — chroot-style prefix for all extraction targets (test seam; default `/`). Also threaded into the default config-exists probe.
  - `daemonStatusCheck?: () => Promise<boolean>` — override the `systemctl is-active otzi` probe (test seam).
  - `configExistsCheck?: () => Promise<boolean>` — override the daemon.toml-exists probe (test seam).
  - `stdinStream?: Readable` — alternate stream for the `passwordStdin` path (test seam; default `process.stdin`).

- `RestoreResult`
  - `restoredFiles: { path: string; mode: number }[]` — absolute paths after extraction with the mode each was `chmod`'d to.
  - `metaPartyId?: number`, `metaCreatedAt?: string`, `metaHostname?: string` — parsed from in-archive `meta.json` for the CLI banner; missing/malformed meta is non-fatal (operator just loses the confirmation).

**Invariants:**
- Pre-flights run in the order listed above; each is independent of the others.
- Wrong-password and tampered-archive surface IDENTICALLY (`'wrong password or corrupted archive'`). Don't leak which.
- Extraction is staged-then-placed: `tar.extract` lands files in a tmpdir, modes are computed by parsing the staged daemon.toml, then files are copied to their real destinations. A throw mid-place triggers LIFO rollback of placed files only.
- `meta.json` (tar path `meta.json`) is the only entry never written to disk.
- Unrecognized tar entries fall back to the most-restrictive default mode (0600).
- Password resolution precedence: explicit `password` → `passwordStdin` (read until newline) → interactive readline prompt on stderr (no echo muting).
- `runRestore` is pure-ish: filesystem I/O + crypto + `systemctl` exec only. Single `console.error` on rollback for operator visibility; no other logging, no `process.exit`. The `entrypoint.ts` wrapper handles banners and exit codes.

**Cross-component contracts:**
- Depends on: `node:crypto` (AES-256-GCM, PBKDF2), `tar` (tar.extract with gzip), `smol-toml` (loose parse of staged daemon.toml for operator-configurable paths), `node:child_process` (`systemctl is-active otzi` default probe), wire-format constants imported from `backup.ts`.
- Used by: `entrypoint.ts` `runRestoreCommand` wrapper, debconf postinst (via `--password-stdin`).

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

## Restored file modes (invariant)

`restore.ts` applies these modes after extraction. Match what the `.deb` postinst sets up (chmod-only; ownership inherits from `/etc/otzi` and `/var/lib/otzi` setgid bits).

| Path | Mode |
|---|---|
| `/etc/otzi/daemon.toml` | 0640 |
| `/etc/otzi/manifest.otzi.json` | 0660 |
| share file (configurable path) | 0600 |
| identity file | 0660 |
| pubkey-book file | 0644 |
| `/var/lib/otzi/vault-pubkey.json` | 0644 |
| `/var/lib/otzi/bootstrap-secret` | 0660 |

Operator-configurable paths (share / identity / pubkeys per `[share].path`, `[node].identity_key_file`, `[node].pubkey_book_file` in daemon.toml) are resolved at restore time by loose-parsing the staged daemon.toml. Unrecognized tar entries fall back to 0600 (most restrictive default).

---

