# FROST-only Bitcoin Vault Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn otzi-headless into a FROST-only Bitcoin vault that is share-file and protocol-rule compatible with otzi `71eb9bd`, with every ML-DSA and OPNet path removed and security findings S1–S15 closed.

**Architecture:** Keep the daemon's shape (pull-based ceremonies over Noise-KK, bootstrap pubkey book, triggers, per-node gate, orchestrator + leader, CLI). Lift otzi's protocol modules verbatim into `src/otzi/`, build the new ceremonies (`dkg-ceremony`, `sign-ceremony`, `messages`) next to the old ones, then switch the gate, orchestrator, leader, daemon and CLI over in one block and delete the old stack.

**Tech Stack:** Node 22, TypeScript (strict, `moduleResolution: Bundler`), vitest, `node --test` for lifted otzi tests, `@mwaddip/frots` 0.1.1, `@scure/btc-signer` 2.4.1, `@scure/base` 2.4.0, `@noble/*` 2.x, `ws`, `smol-toml`, `tar`, `croner`.

**Spec:** `docs/superpowers/specs/2026-10-10-btc-only-pivot-design.md` (read it before starting any task; section numbers below refer to it).

## Global Constraints

- Networks are exactly `mainnet`, `testnet4`, `signet` (`NetworkName` from `src/otzi/lib/vault-types.ts` / `src/otzi/backend/types.ts`).
- Files under `src/otzi/` are byte-identical to otzi commit `71eb9bd07822583ffc7424b1c419dd8d76e78e9c`; never edit them.
- Ceremony messages carry `v: 2`; every `ceremonyId` matches `^[A-Za-z0-9._:-]{1,128}$`.
- A proposal has at most 255 inputs (the signing codec's count is one byte).
- Blob retention after a ceremony ends on a node: 300 000 ms signing, 900 000 ms DKG.
- Default ceremony deadlines stay 300 000 ms signing, 900 000 ms DKG.
- DKG: `parties` = ring size, `threshold` = `parties`; signing `signers` defaults to all n.
- No DKG on a node that has a share loaded or a file at the share path.
- Share files are otzi v4 (`encryptShareFile`), mode 0600; staging path is `<share path>.pending`.
- `vault-pubkey.json`: mode 0644, `{ network, address, internalKey, outputKey, threshold, parties, vaultKey }`.
- Address book: `/etc/otzi/address-book.otzi.json`, otzi `AddressBookFile`, mode 0640.
- Bootstrap fingerprint: first 96 bits of SHA-256 over the book's raw pubkeys, `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`.
- Release version 0.3.0; `.deb` stays under 2 MB.
- Contract-first: `facts/*.md` describe the target (Tasks 1–2); a commit that crosses an interface cites the `facts/` file.
- Contract and doc text states current facts and their purpose; no "previously" or "changed because".
- Conventional commits; `git add` lists explicit paths (never `git add -A`; `git rm` stages immediately, so commit it in the same task); every commit ends with the session attribution trailer lines; no model identifiers in any committed text.
- Work on branch `claude/lucid-meitner-ona23c`; deliver as a PR into `master`.
- `npm run typecheck` and `npm test` pass at the end of every task except inside the switch-over block (Tasks 11–15), where each task's own tests pass and the whole suite is green at the end of Task 15.

## Review Focus

1. **A leader lies about prevout amounts.** Signatures are then invalid on chain and Esplora rejects the broadcast. The operator must see the Esplora error and the signed hex, never a silent success (test in Task 15).
2. **A daemon crashes mid-DKG and leaves `<share>.pending`.** On restart it must log a warning, not load the file, and still accept a fresh DKG (tests in Tasks 12 and 13).
3. **The share password env var is wrong or a share belongs to another network.** Startup must refuse with a message naming the cause, not a stack trace (tests in Task 12).
4. **Esplora is unreachable or returns garbage during `btc send`.** The CLI fails before asking the daemon to sign anything (test in Task 15).
5. **Signing right after `otzi generate`, before the daemons restart.** `sign` returns 409 with "restart the daemon", not a 500 (test in Task 14).

---

## Phase 0 — Contracts and docs

### Task 1: Rewrite contracts (CLAUDE.md, INTERFACES.md, facts/)

**Files:**
- Modify: `CLAUDE.md`, `INTERFACES.md`, `facts/bootstrap.md`, `facts/config.md`, `facts/core.md`, `facts/daemon.md`, `facts/gate.md`, `facts/orchestrator.md`, `facts/transport.md`, `facts/triggers.md`
- Create: `facts/otzi.md`, `facts/address-book.md`
- Delete: `facts/wire.md`, `facts/node.md`, `facts/broadcast.md`

**Interfaces:**
- Produces: the contracts every later task implements. Every public name used in Tasks 3–17 appears in the matching `facts/` file with pre/post conditions.

- [ ] **Step 1: Rewrite `CLAUDE.md`**
  - Project overview: a FROST-only Bitcoin vault daemon.
  - Replace the OPNet dependency section with the Bitcoin stack (frots, `@scure/*`, `@noble/*`).
  - Identity table:
    - the transport identity is the P-256 pubkey in the bootstrap book;
    - the vault key is only used to build and sign transactions.
  - "What to share with otzi" becomes the `src/otzi/` lift rule and drift script (spec §3, §4.1).
  - Security model:
    - Add per-node analysis of every proposal (spec §5.4).
    - Add the setup trust assumption and the run-once DKG (spec §5.3).
  - Keep the Git Workflow section as it is.
- [ ] **Step 2: Rewrite `INTERFACES.md` global invariants**
  - Remove: OPNet traps, Phase-4d, ML-DSA, keylink, `#N` retries, the manifest/control plane, regtest.
  - Add:
    - verify-before-gate means `analyzeProposal` against the node's own key;
    - addressed-blob access control;
    - sender binding;
    - the nonce rules;
    - no DKG while a vault exists;
    - the network set;
    - the `src/otzi/` lift rule.
  - Update the index table:
    - `facts/otzi.md` replaces `wire.md` and `node.md`;
    - `broadcast.md` is removed;
    - `address-book.md` is added.
- [ ] **Step 3: Write `facts/otzi.md`.** Cover the lifted file list (spec §4.1), `OTZI_COMMIT`, the drift script, and the functions headless consumes. From `lib`: `encodeFrostRound1/2`, `decodeFrostRound1/2`, `encodeFrostSignR1/R2`, `decodeFrostSignR1/R2`, `dkgVerifyMessage`, `toVaultKey`, `fromVaultKey`, `encryptShareFile`, `decryptShareFile`, `assertShareMatchesVault`, `analyzeProposal`, `vaultPayment`, the address-book helpers. From `backend`: `buildSend`, `finalizeSend`, `chainApiUrl`, `getUtxos`, `getBalance`, `broadcastTx`, `getFeeRates`, `verifyBitcoinMessage`. Copy pre/post conditions from otzi `facts/INTERFACES.md` §4, §5, §8, §11 and §15.
- [ ] **Step 4: Rewrite `facts/core.md`.** Cover the interfaces in Tasks 4 and 7–10: `BlobServer` access rule, `BlobPuller.pullAll(expected, opts, signal?)`, session `addBlob(..., from)`, `CeremonyIo`, `messages.ts`, `dkg-ceremony.ts`, `sign-ceremony.ts`, `blob-retention.ts`. Remove the runner, ML-DSA DKG and keylink.
- [ ] **Step 5: Rewrite `facts/gate.md`, `facts/orchestrator.md`, `facts/daemon.md` and `facts/config.md`** from the Interfaces blocks of Tasks 11–16. Include:
  - in `daemon.md`: the API table (spec §6.1), `vault-share.ts`, the `vault-pubkey.json` schema, and the backup file and mode tables without the manifest or bootstrap secret, plus the address book at 0640;
  - in `config.md`: the rejected keys.
- [ ] **Step 6: Update `facts/bootstrap.md` (96-bit fingerprint, Task 6), `facts/transport.md` (wording: the pubkey book holds P-256 keys) and `facts/triggers.md` (wording only), and write `facts/address-book.md` (Task 16).**
- [ ] **Step 7: Check for leftovers**

Run: `grep -rniE "opnet|ml-?dsa|keylink|op20|manifest|frostLegacySig|bootstrap-secret|post-quantum" CLAUDE.md INTERFACES.md facts/`
Expected: matches only in lines that name rejected config keys (`opnet_rpc`, `allowed_contracts`, `method_allowlist`) in `facts/config.md` and `facts/gate.md`.

- [ ] **Step 8: Commit**

```bash
git rm facts/wire.md facts/node.md facts/broadcast.md
git add CLAUDE.md INTERFACES.md facts/
git commit -m "docs(contracts): FROST-only Bitcoin vault contracts"
```

### Task 2: Rewrite operator docs

**Files:**
- Modify: `README.md`, `docs/api.md`, `docs/cli.md`, `docs/config.md`, `docs/gates.md`, `docs/install.md`, `docs/signing-flows.md`
- Delete: `PLAN.md`, `docs/manifest-builder-spec.md`

**Interfaces:**
- Consumes: the contracts from Task 1.

- [ ] **Step 1: `docs/api.md`.** The three ops from spec §6.1 with request/response JSON examples, input rules and status codes.
- [ ] **Step 2: `docs/cli.md`.** Every verb from spec §6.5. Examples use `tb1p…` addresses and `testnet4`.
- [ ] **Step 3: `docs/config.md` and `docs/gates.md`.** The `[network]` section and the policy rules table from spec §6.3, including the rejected keys and their replacements.
- [ ] **Step 4: `docs/signing-flows.md`.**
  - DKG steps 1–7 (spec §5.3).
  - Signing leader and participant flows (spec §5.4).
  - Where each check happens.
- [ ] **Step 5: `README.md` and `docs/install.md`.**
  - Walkthrough: install → `otzi setup` (compare the 96-bit fingerprint) → `otzi generate` → restart → `otzi vault` → fund → `otzi btc send`.
  - The debconf prompts from spec §6.7.
- [ ] **Step 6: Check for leftovers**

Run: `grep -rniE "opnet|ml-?dsa|keylink|op20|manifest|otzi sync|otzi sign|regtest" README.md docs/*.md`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git rm PLAN.md docs/manifest-builder-spec.md
git add README.md docs/api.md docs/cli.md docs/config.md docs/gates.md docs/install.md docs/signing-flows.md
git commit -m "docs: operator docs for the FROST-only Bitcoin vault"
```

---

## Phase 1 — Additive changes (green after every task)

### Task 3: Lift otzi modules, test scripts, drift check, CI

**Files:**
- Create: `src/otzi/lib/` (14 files), `src/otzi/backend/` (7 files), `src/otzi/OTZI_COMMIT`, `scripts/check-otzi-drift.sh`, `vitest.config.ts`, `.github/workflows/ci.yml`
- Modify: `package.json`, `package-lock.json`, `.github/workflows/release.yml`

**Interfaces:**
- Produces: `src/otzi/lib/*` and `src/otzi/backend/*` exactly as in otzi (see `facts/otzi.md`); `npm test` runs vitest then `npm run test:otzi`.

- [ ] **Step 1: Copy the files.** `OTZI` is an otzi checkout at `71eb9bd07822583ffc7424b1c419dd8d76e78e9c`.

```bash
mkdir -p src/otzi/lib src/otzi/backend
for f in dkg dkg.fixture dkg.test frost-sign frost-sign.test share-file share-file.test bitcoin bitcoin.test crypto hex vault-types address-book address-book.test; do cp "$OTZI/src/lib/$f.ts" src/otzi/lib/; done
for f in bitcoin bitcoin.test test-vault.fixture esplora btc-message btc-message.test types; do cp "$OTZI/backend/src/lib/$f.ts" src/otzi/backend/; done
echo 71eb9bd07822583ffc7424b1c419dd8d76e78e9c > src/otzi/OTZI_COMMIT
```

- [ ] **Step 2: Add dependencies:** `npm install --save-exact @scure/btc-signer@2.4.1 @scure/base@2.4.0`
- [ ] **Step 3: Write `vitest.config.ts`.** Exclude `src/otzi/**` on top of `configDefaults.exclude`.
- [ ] **Step 4: Update `package.json` scripts:**
  - `"test": "vitest run && npm run test:otzi"`
  - `"test:otzi": "node --import tsx --test src/otzi/lib/*.test.ts src/otzi/backend/*.test.ts"`
- [ ] **Step 5: Write `scripts/check-otzi-drift.sh <otzi-dir>`.**
  - Map every file in `src/otzi/lib` to `<otzi-dir>/src/lib/<same name>`, and every file in `src/otzi/backend` to `<otzi-dir>/backend/src/lib/<same name>`.
  - `cmp` each pair.
  - Print `DRIFT <path>` for each difference and `OK: 21 files match <git -C otzi-dir rev-parse HEAD>` on success.
  - Exit 1 on any drift or missing file.
- [ ] **Step 6: Write `.github/workflows/ci.yml`.**
  - Trigger on `push` and `pull_request`; Node 22.
  - Run `npm ci`, `npm run typecheck`, `npm test`.
  - Then fetch otzi at `$(cat src/otzi/OTZI_COMMIT)` with `git init otzi-ref && git -C otzi-ref fetch --depth 1 https://github.com/mwaddip/otzi <sha> && git -C otzi-ref checkout FETCH_HEAD`.
  - Then run `bash scripts/check-otzi-drift.sh otzi-ref`.
- [ ] **Step 7: Switch `release.yml`'s "Run tests" step to `npm test`.**
- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test && bash scripts/check-otzi-drift.sh "$OTZI"`
Expected:
- typecheck exits 0;
- vitest reports the existing files all passing;
- `node --test` reports `# pass 31` and `# fail 0`;
- the drift script prints `OK: 21 files match 71eb9bd07822583ffc7424b1c419dd8d76e78e9c`.

Run: `echo >> src/otzi/lib/hex.ts; bash scripts/check-otzi-drift.sh "$OTZI"; echo exit=$?; git checkout src/otzi/lib/hex.ts`
Expected: `DRIFT src/otzi/lib/hex.ts` and `exit=1`.

- [ ] **Step 9: Commit** (cite `facts/otzi.md`)

```bash
git add src/otzi scripts/check-otzi-drift.sh vitest.config.ts .github/workflows/ci.yml .github/workflows/release.yml package.json package-lock.json
git commit -m "feat(otzi): lift otzi 71eb9bd protocol modules verbatim with drift check"
```

### Task 4: BlobServer serves addressed blobs only to their recipient

**Files:**
- Modify: `src/core/blob-server.ts`
- Test: `src/core/blob-server.test.ts` (create)

**Interfaces:**
- Produces: a pull for a key with `to !== undefined` returns `null` unless the authenticated requester equals `key.to` (fixes S3).

- [ ] **Step 1: Write the failing tests**

```ts
// ring [0,1,2], each with BlobStore + BlobServer over createInMemoryRing
it('serves an addressed blob only to its recipient', async () => {
  const key = { ceremonyId: 'c1', round: 'dkg-r2', from: 0, to: 1 };
  stores[0].put(key, new Uint8Array([7]));
  expect(await ring.get(1)!.pull(key)).toEqual(new Uint8Array([7]));
  expect(await ring.get(2)!.pull(key)).toBeNull();
});
it('serves broadcast blobs to every ring member', async () => {
  const key = { ceremonyId: 'c1', round: 'dkg-r1', from: 0 };
  stores[0].put(key, new Uint8Array([9]));
  expect(await ring.get(1)!.pull(key)).toEqual(new Uint8Array([9]));
  expect(await ring.get(2)!.pull(key)).toEqual(new Uint8Array([9]));
});
```

- [ ] **Step 2: Run them.** `npx vitest run src/core/blob-server.test.ts`. Expected: the first test fails (party 2 receives the blob).
- [ ] **Step 3: Implement.** The handler returns `null` when `key.to !== undefined && key.to !== from`.
- [ ] **Step 4: Run `npx vitest run src/core && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/core/blob-server.ts src/core/blob-server.test.ts
git commit -m "fix(core): serve addressed blobs only to their recipient (facts/core.md)"
```

### Task 5: Remove manifests, control plane and OPNet CLI verbs

**Files:**
- Delete:
  - `src/cli/{builtin-abis,manifest-resolver,manifest-types,manifest-validate,validation}.ts` and their tests;
  - `src/cli/cmd/{sign,op20,install,uninstall,list,sync}.ts` and their tests;
  - `src/daemon/control-plane.ts` and `src/daemon/control-plane.test.ts`;
  - `examples/manifest-builder/`, `docs/headless-manifest-schema.json`, `src/wire/manifest.ts`, `src/wire/manifest-types.ts`, `src/wire/op20-methods.ts`, `src/wire/vault-types.ts` (unused, and it imports `manifest-types`).
- Modify:
  - `src/daemon/entrypoint.ts` (remove verbs and their usage lines);
  - `src/daemon/daemon.ts` (remove `ControlPlane`, `controlPlaneOpts`, the `sync` op);
  - `src/orchestrator/{orchestrator,types}.ts` (remove `handleManifestPush`, `controlPlane`);
  - `src/core/ceremony-messages.ts` (remove `manifest-push`);
  - `src/daemon/share-persistence.ts` (remove the bootstrap-secret unlink);
  - `src/daemon/config-merge.ts` (remove `bootstrapSecret`);
  - `src/cli/cmd/{backup,restore}.ts` (remove the manifest and bootstrap-secret entries, constants and modes);
  - `packaging/deb/DEBIAN/{templates,config,postinst}` (remove the bootstrap-secret prompt and file);
  - `package.json` (drop `ajv`, `@preact/signals`, `htm`, `preact`);
  - the tests touching these paths (`ceremony-messages.test.ts`, `orchestrator.test.ts`, `daemon.test.ts`, `daemon-integration.test.ts`, `backup.test.ts`, `restore.test.ts`).

**Interfaces:**
- Produces: a daemon without a control plane. Backups contain `daemon.toml`, the share, the identity, the pubkey book, `vault-pubkey.json` and `meta.json`.

- [ ] **Step 1: Update the backup/restore tests.** They expect no manifest and no bootstrap-secret entries, and an archive built without them restores. Run `npx vitest run src/cli/cmd/backup.test.ts src/cli/cmd/restore.test.ts`. Expected: FAIL while the old entries remain.
- [ ] **Step 2: Delete the files listed above (`git rm`) and remove every reference.**
- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && grep -rnE "manifest|bootstrap-secret|controlPlane|ControlPlane" src packaging`
Expected: typecheck and tests pass; grep prints nothing.

- [ ] **Step 4: Commit**

```bash
git add -u src packaging package.json package-lock.json examples docs
git commit -m "refactor: remove manifests, control plane and OPNet CLI verbs (facts/daemon.md)"
```

### Task 6: 96-bit bootstrap fingerprint

**Files:**
- Modify: `src/bootstrap/pubkey-book.ts`, `src/daemon/setup.ts` (banner text), `src/bootstrap/bootstrap.test.ts`

**Interfaces:**
- Produces: `computeFingerprint(book: PubkeyBook): Promise<string>`, the first 12 bytes of SHA-256 over the concatenated raw pubkeys in book order, as lowercase hex in groups of 4 joined by `-` (fixes S11).

- [ ] **Step 1: Write the failing test**

```ts
it('fingerprint is 96 bits in six groups', async () => {
  const fp = await computeFingerprint(book);
  expect(fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
  const raw = createHash('sha256').update(Buffer.concat(book.entries.map(e => Buffer.from(e.publicKeyHex, 'hex')))).digest('hex').slice(0, 24);
  expect(fp.replaceAll('-', '')).toBe(raw);
});
```

- [ ] **Step 2: Run `npx vitest run src/bootstrap`.** Expected: FAIL (8-char fingerprint).
- [ ] **Step 3: Implement it, and update the existing tests that hard-code 8-char fingerprints.**
- [ ] **Step 4: Run `npx vitest run src/bootstrap src/daemon && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/pubkey-book.ts src/bootstrap/bootstrap.test.ts src/daemon/setup.ts
git commit -m "feat(bootstrap): 96-bit pubkey-book fingerprint (facts/bootstrap.md)"
```

### Task 7: Harden FROST sessions (otzi codecs, sender binding, nonce drop)

**Files:**
- Modify: `src/core/frost-dkg-session.ts`, `src/core/frost-sign-session.ts`, `src/core/ceremony-runner.ts` (call sites only)
- Test: `src/core/frost-dkg-session.test.ts`, `src/core/frost-sign-session.test.ts` (create)

**Interfaces:**
- Consumes: codecs from `src/otzi/lib/dkg.ts` and `src/otzi/lib/frost-sign.ts`; `runDkg(t, n)` from `src/otzi/lib/dkg.fixture.ts` in tests.
- Produces:
  - `frost-dkg-session.addBlob(session, blob: string, round: 'r1' | 'r2', from: PartyId): { ok: true } | { ok: false; error: string }`
  - `frost-sign-session.addBlob(session, blob: string, expectedRound: FrostSignRound, from: PartyId): same result type`
  - `CreateFrostSessionInput.sessionId: Uint8Array`, which replaces `ceremonyId`; the envelope sid is taken from it.
  - `FrostSigningSession.round2Started: boolean`, set before round 2 computes; `myNonces` is `null` after `round2` returns.

- [ ] **Step 1: Write the failing tests**

```ts
// frost-sign-session.test.ts — vault from runDkg(3, 3); sighash = 32 random bytes
it('rejects an r1 blob whose party differs from the sender', () => {
  const blob = round1(sessions[1]);
  expect(addBlob(sessions[0], blob, 1, 2)).toEqual({ ok: false, error: expect.stringMatching(/claims party 1/) });
});
it('rejects commitments whose identifiers are not the sender', () => {
  const s1 = sessions[1]; round1(s1);
  const forged = encodeFrostSignR1(1, s1.myCommitments!.map(c => ({ ...c, identifier: 3 })), sid);
  expect(addBlob(sessions[0], forged, 1, 1).ok).toBe(false);
});
it('drops nonces after round 2 and refuses a second round 2', () => {
  // all three run round1 and exchange r1
  round2(sessions[0]);
  expect(sessions[0].myNonces).toBeNull();
  expect(() => round2(sessions[0])).toThrow('round2 already run');
});
// frost-dkg-session.test.ts
it('rejects a round-1 package with the wrong number of commitments', () => {
  const { package: pkg } = dkgRound1(2n, 3, 3, rng);   // session threshold is 2
  expect(addBlob(dkgSessions[0], encodeFrostRound1(pkg, sessionId), 'r1', 1)).toEqual({ ok: false, error: expect.stringMatching(/expected 2 commitments, got 3/) });
});
it('rejects a round-1 package from a party other than the sender', () => {
  const blob = round1(dkgSessions[1]);
  expect(addBlob(dkgSessions[0], blob, 'r1', 2).ok).toBe(false);
});
```

- [ ] **Step 2: Run `npx vitest run src/core/frost-dkg-session.test.ts src/core/frost-sign-session.test.ts`.** Expected: FAIL (`addBlob` ignores `from`).
- [ ] **Step 3: Implement.**
  - Switch both sessions' codec imports to `../otzi/lib/dkg` and `../otzi/lib/frost-sign`.
  - Add the `from` checks and the commitment count, and set `round2Started` before computing.
  - Null `myNonces` after round 2.
  - Replace the hashing of `ceremonyId` with the given `sessionId`.
  - Old runner call sites: pass `key.from`, and pass `createHash('sha256').update(ceremonyId).digest()` as `sessionId`.
- [ ] **Step 4: Run `npm run typecheck && npm test`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/core/frost-dkg-session.ts src/core/frost-sign-session.ts src/core/ceremony-runner.ts src/core/frost-dkg-session.test.ts src/core/frost-sign-session.test.ts
git commit -m "fix(core): bind FROST blobs to their sender, check commitment count, drop nonces (facts/core.md)"
```

### Task 8: Ceremony messages v2

**Files:**
- Create: `src/core/messages.ts`, `src/core/messages.test.ts`

**Interfaces:**
- Produces:

```ts
export const CEREMONY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_INPUTS = 255;
export interface AnnounceDkg { v: 2; kind: 'announce-dkg'; ceremonyId: string; sessionIdHex: string; threshold: number; parties: number; network: NetworkName }
export interface AnnounceSign { v: 2; kind: 'announce-sign'; ceremonyId: string; signers: PartyId[]; proposal: SendProposal }
export interface SignoffDone { v: 2; kind: 'signoff-done'; ceremonyId: string; signaturesHex: string[] }
export interface SignoffAborted { v: 2; kind: 'signoff-aborted'; ceremonyId: string; reason?: string }
export type CeremonyMessage = AnnounceDkg | AnnounceSign | SignoffDone | SignoffAborted;
export function isCeremonyId(s: unknown): s is string;
export function isProposalShape(p: unknown): p is SendProposal;
export function encodeMessage(msg: CeremonyMessage): Uint8Array;           // UTF-8 JSON
export function parseMessage(bytes: Uint8Array): CeremonyMessage | null;   // never throws
```

  Parser rules:
  - Each kind has an exact key set; extra keys mean `null`.
  - `sessionIdHex`: 64 lowercase hex characters.
  - `threshold` and `parties`: integers from 2 to 255, with `threshold ≤ parties`.
  - `network`: one of the three networks.
  - `signers`: 1–255 integers in `0..254`.
  - `isProposalShape`: exact keys `{network, tx, prevouts}`; `tx` is non-empty even-length lowercase hex; `prevouts` has 1–255 entries, each with exact keys `{txid: 64 lowercase hex, vout: safe int ≥ 0, amount: safe int ≥ 0, script: non-empty even-length lowercase hex}`.
  - `signaturesHex`: 1–255 strings of 128 lowercase hex characters.
  - `reason`: a string of at most 1024 characters.

- [ ] **Step 1: Write the failing tests.**
  - A round-trip for each kind: `parseMessage(encodeMessage(m))` deep-equals `m`.
  - Each of these parses to `null`:
    - `v: 1`;
    - unknown kind;
    - an extra key;
    - each of these `ceremonyId`s: `''`, `'a b'`, `'x#1'`, `'a'.repeat(129)`;
    - `threshold: 1`;
    - `network: 'testnet'`;
    - 256 prevouts;
    - an uppercase `txid`;
    - signer `255`;
    - a 127-character signature;
    - non-UTF-8 bytes.
- [ ] **Step 2: Run `npx vitest run src/core/messages.test.ts`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/core/messages.ts`.**
- [ ] **Step 4: Run `npx vitest run src/core/messages.test.ts && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/core/messages.ts src/core/messages.test.ts
git commit -m "feat(core): v2 ceremony messages with strict parsing (facts/core.md)"
```

### Task 9: DKG ceremony with verification and all-N confirmation

**Files:**
- Create: `src/core/ceremony-io.ts`, `src/core/dkg-ceremony.ts`, `src/core/blob-retention.ts`, `src/testing/ring.ts`, `src/core/dkg-ceremony.test.ts`
- Modify: `src/core/blob-puller.ts` (optional signal), `src/core/blob-puller.test.ts`

**Interfaces:**
- Consumes: Task 7 sessions, Task 8 `encodeMessage`, `dkgVerifyMessage` from `src/otzi/lib/dkg.ts`, `verifySignature` from frots.
- Produces:

```ts
// ceremony-io.ts
export interface CeremonyIo { transport: Transport; store: BlobStore; puller: BlobPuller; pullOpts: PullOpts }
// blob-puller.ts
pullAll(expected: readonly BlobKey[], opts: PullOpts, signal?: AbortSignal): Promise<void>  // rejects Error('aborted') on signal
// blob-retention.ts
export const BLOB_RETENTION_MS = { signing: 300_000, dkg: 900_000 } as const;
export function scheduleClear(store: BlobStore, ceremonyId: string, delayMs: number): void  // unref'd timer → store.clear
// dkg-ceremony.ts
export const DKG_ROUNDS = { r1: 'dkg-r1', r2: 'dkg-r2', verifyR1: 'dkg-verify-r1', verifyR2: 'dkg-verify-r2', verified: 'dkg-verified' } as const;
export interface DkgCeremonyResult { keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage }
export interface ShareStager { stage(r: DkgCeremonyResult): Promise<void>; commit(): Promise<void>; discard(): Promise<void> }
export interface DkgCeremonySpec { ceremonyId: string; sessionId: Uint8Array; threshold: number; parties: number; network: NetworkName; rng: Rng }
export async function runDkgCeremony(io: CeremonyIo, spec: DkgCeremonySpec, stager: ShareStager, signal?: AbortSignal): Promise<DkgCeremonyResult>
// testing/ring.ts
export interface RingNode { partyId: PartyId; io: CeremonyIo; server: BlobServer }
export function makeRing(n: number, pullOpts?: Partial<PullOpts>): RingNode[]  // defaults: maxAttempts 50, initialDelayMs 5, maxDelayMs 20, deadlineMs 3000
```

  `runDkgCeremony` follows spec §5.3 steps 2–7 exactly:
  - Verification signing uses `sighashes = [M]`, `tweaked: true`, `activeSigners` = all parties, `sessionId` = spec.sessionId.
  - Every node aggregates.
  - The `dkg-verified` blob is the raw 64-byte signature.
  - On any error:
    1. `await stager.discard()`;
    2. unless `signal?.aborted`, broadcast `signoff-aborted {ceremonyId, reason}`;
    3. throw `Error('DKG aborted: <reason>')`.
  - Announcing is the caller's job.

- [ ] **Step 1: Write the failing tests** (3-node ring, `threshold = parties = 3`, recording stagers)

```ts
it('three nodes agree on one vault and commit their shares', async () => {
  const results = await Promise.all(ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i])));
  const keys = results.map(r => toHex(r.publicKeyPackage.verifyingKey));
  expect(new Set(keys).size).toBe(1);
  for (const s of stagers) expect(s.calls).toEqual(['stage', 'commit']);
  expect(Object.keys(toVaultKey(results[0].publicKeyPackage).verifyingShares)).toEqual(['1', '2', '3']);
});
it('a node that fails before confirming keeps everyone else from committing', async () => {
  stagers[2].failStage = true;
  const out = await Promise.allSettled(ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i])));
  expect(out.every(o => o.status === 'rejected')).toBe(true);
  for (const s of stagers) expect(s.calls).not.toContain('commit');
});
it('an inconsistent round-2 share aborts and nobody commits', ...);   // node 2 serves recipient 1 a dkg-r2 with signingShare + 1n (decode/re-encode via otzi codec)
it('an equivocating round-1 node keeps every node from committing', ...);   // ring[2].server.close(), then register the custom handler below on ring[2].io.transport
it('a dkg-r1 blob claiming another party aborts naming the sender', ...);
it('an abort signal stops the ceremony and discards the staged share', ...);
```

  The equivocating node in the fourth test (node 2) runs no ceremony. Its `servePulls` handler:
  - serves `dkg-r1` variant A to node 0 and variant B to node 1 (two `dkgRound1` outputs for identifier 3);
  - serves `dkg-r2` for each recipient computed with `dkgRound2(secretA | secretB, r1 of nodes 0 and 1)`, precomputed once both honest `dkg-r1` blobs have been pulled;
  - serves nothing for the verify rounds.

  Expected: both honest nodes reject and neither commits.

- [ ] **Step 2: Run `npx vitest run src/core/dkg-ceremony.test.ts src/core/blob-puller.test.ts`.** Expected: FAIL (modules missing). Add a `blob-puller` test: `pullAll` rejects with `'aborted'` when the signal fires.
- [ ] **Step 3: Implement `ceremony-io.ts`, the `blob-puller` signal, `blob-retention.ts`, `testing/ring.ts` and `dkg-ceremony.ts`.**
- [ ] **Step 4: Run `npx vitest run src/core && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/core/ceremony-io.ts src/core/dkg-ceremony.ts src/core/dkg-ceremony.test.ts src/core/blob-retention.ts src/core/blob-puller.ts src/core/blob-puller.test.ts src/testing/ring.ts
git commit -m "feat(core): FROST DKG with verify signature and all-N confirmation (facts/core.md)"
```

### Task 10: Proposal signing ceremony

**Files:**
- Create: `src/core/sign-ceremony.ts`, `src/core/sign-ceremony.test.ts`, `src/testing/proposal.ts`

**Interfaces:**
- Consumes: Task 7 sign session, Task 8 `encodeMessage`, Task 9 `CeremonyIo` and `makeRing`.
- Produces:

```ts
export const SIGN_ROUNDS = { r1: 'sign-r1', r2: 'sign-r2' } as const;
export interface SignCeremonySpec { ceremonyId: string; signers: readonly PartyId[]; sighashes: readonly Uint8Array[]; keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage; rng: Rng }
export async function leadSigning(io: CeremonyIo, spec: SignCeremonySpec, proposal: SendProposal): Promise<Uint8Array[]>
export async function participateInSigning(io: CeremonyIo, spec: SignCeremonySpec, signal?: AbortSignal): Promise<void>
// testing/proposal.ts
export function testVault(t: number, n: number): { keyPackages: KeyPackage[]; publicKeyPackage: PublicKeyPackage; vaultKey: VaultKey }
export function makeProposal(vaultKey: VaultKey, network: NetworkName, opts?: {
  inputs?: Array<{ amount: number; script?: string }>;          // default [{ amount: 100_000 }] paying the vault script
  outputs?: Array<{ address: string; amount: number }>;          // default one external output of 50_000
  change?: number;                                               // default 49_000 back to the vault
}): SendProposal                                                 // sequence 0xfffffffd, lockTime 0, random prevout txids
```

  - `leadSigning` broadcasts `announce-sign {ceremonyId, signers, proposal}`.
  - Envelope sid = `sighashes[0]`, with `tweaked: true` for every sighash.
  - Signers' blobs are pulled.
  - `leadSigning` aggregates with `publicKeyPackage` and checks `verifySignature(sig, sighash, publicKeyPackage.verifyingKey)` per input.
  - It does not broadcast a signoff; the leader dispatcher does (Task 14).
  - `participateInSigning` stops after producing `sign-r2`.

- [ ] **Step 1: Write the failing tests**

```ts
it('signers produce signatures that finalize into a valid transaction', async () => {
  const proposal = makeProposal(vaultKey, 'testnet4');
  const analysis = analyzeProposal(proposal, vaultKey, 'testnet4');
  const sighashes = analysis.sighashes.map(s => fromHex(s.hash));
  const [sigs] = await Promise.all([
    leadSigning(ring[0].io, spec(0, sighashes), proposal),
    participateInSigning(ring[1].io, spec(1, sighashes)),
    participateInSigning(ring[2].io, spec(2, sighashes)),
  ]);
  const out = finalizeSend(proposal.tx, proposal.prevouts, sigs.map((s, index) => ({ index, signature: toHex(s) })), vaultPayment(vaultKey, 'testnet4').outputKey);
  expect(out.txid).toBe(analysis.txid);
});
it('announce-sign carries the proposal and no sighashes', ...);   // capture ring[1] onBroadcast, parseMessage → kind 'announce-sign', proposal deep-equal, !('sighashes' in msg)
it('a signer whose blob claims another party makes the leader abort naming it', ...);
it('a 2-of-3 ceremony never pulls from the non-signer', ...);      // testVault(2, 3), signers [0, 1]; count pulls on ring[2]'s server: 0
```

- [ ] **Step 2: Run `npx vitest run src/core/sign-ceremony.test.ts`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `sign-ceremony.ts` and `testing/proposal.ts`** (`testVault` uses otzi `runDkg` and `toVaultKey`).
- [ ] **Step 4: Run `npx vitest run src/core && npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/core/sign-ceremony.ts src/core/sign-ceremony.test.ts src/testing/proposal.ts
git commit -m "feat(core): proposal signing ceremony (facts/core.md)"
```

---

## Phase 2 — Switch-over block (Tasks 11–15; whole suite green at the end of Task 15)

Inside this block, `npm run typecheck` reports errors only in files a later task of the block rewrites or deletes. Each task's listed tests pass.

### Task 11: Bitcoin gate spec and policy rules

**Files:**
- Modify: `src/gate/types.ts`, `src/gate/policy.ts`, `src/orchestrator/spec-builder.ts`, `src/gate/gate.test.ts`

**Interfaces:**
- Produces:

```ts
// gate/types.ts (ApprovalGate, Decision, CeremonyRole unchanged)
export interface CeremonySpecBase { ceremonyId: string; leader: string; role: CeremonyRole }
export interface SpecOutput { address: string; amount: number; isChange: boolean; label?: string }
export interface SigningSpec extends CeremonySpecBase {
  kind: 'signing'; network: NetworkName; txid: string;
  inputs: Array<{ txid: string; vout: number; amount: number }>; outputs: SpecOutput[];
  amount: number; totalIn: number; totalOut: number; fee: number; vsize: number; feeRate: number;
}
export interface DkgSpec extends CeremonySpecBase { kind: 'dkg'; threshold: number; parties: number; network: NetworkName; peerIds: string[] }
export type CeremonySpec = SigningSpec | DkgSpec;
// orchestrator/spec-builder.ts
export function resolveLeaderId(from: PartyId, peersById: ReadonlyMap<PartyId, string>): string;   // unchanged
export function buildSigningSpec(analysis: ProposalAnalysis, base: CeremonySpecBase, network: NetworkName, labelFor?: (address: string) => string | undefined): SigningSpec;
export function buildDkgSpec(base: CeremonySpecBase, p: { threshold: number; parties: number; network: NetworkName; peerIds: string[] }): DkgSpec;
// gate/policy.ts
export interface PolicyConfig { maxSatsPerTx?: number; maxSatsPer24h?: number; allowedRecipients?: string[]; maxFeeSats?: number; maxFeeRate?: number; maxCeremoniesPerHour?: number; dkgLeaderAllowlist?: string[] }
export interface PolicyGateOptions { now?: () => number }
export class PolicyGate implements ApprovalGate { constructor(config: PolicyConfig, opts?: PolicyGateOptions) }
export function parsePolicyParams(params: Record<string, unknown>): PolicyConfig;   // throws ConfigError from ../config/parse
```

  Rules:
  - The rules are those of spec §6.3. `amount` is the sum of outputs with `isChange === false`.
  - `max_sats_per_24h` records `{ at: now(), amount }` per approval and prunes entries older than 86 400 000 ms. The check and the record happen in one synchronous section.
  - Legacy keys are rejected with these messages:
    - `max_amount`, `max_btc_per_tx` → `use max_sats_per_tx`;
    - `allowed_btc_recipients`, `destination_allowlist` → `use allowed_recipients`;
    - `method_allowlist`, `allowed_contracts` → `no longer supported`.

- [ ] **Step 1: Write the failing tests** (`gate.test.ts`, replacing the OPNet and generic cases; keep the exec/webhook cases with the new spec shape)

```ts
it('max_sats_per_tx approves at the cap and rejects one sat above', async () => {
  const gate = new PolicyGate({ maxSatsPerTx: 50_000 });
  expect(await gate.approve(signing({ external: 50_000 }))).toBe('approve');
  expect(await gate.approve(signing({ external: 50_001 }))).toBe('reject');
});
it('max_sats_per_24h counts approvals in a rolling day', async () => {
  let t = 0; const gate = new PolicyGate({ maxSatsPer24h: 100_000 }, { now: () => t });
  expect(await gate.approve(signing({ external: 60_000 }))).toBe('approve');
  expect(await gate.approve(signing({ external: 40_000 }))).toBe('approve');
  expect(await gate.approve(signing({ external: 1 }))).toBe('reject');
  t = 86_400_001;
  expect(await gate.approve(signing({ external: 60_000 }))).toBe('approve');
});
it('allowed_recipients ignores change and rejects any other external output', ...);
it('max_fee_sats and fractional max_fee_rate cap the fee', ...);
it('parsePolicyParams rejects legacy keys with the replacement', () => {
  expect(() => parsePolicyParams({ max_btc_per_tx: 1 })).toThrow(/use max_sats_per_tx/);
  expect(() => parsePolicyParams({ allowed_contracts: [] })).toThrow(/no longer supported/);
});
it('caps accept integers and decimal strings and reject negatives, fractions and unsafe integers', ...);
it('buildSigningSpec sums non-change outputs and applies labels', ...);
```

- [ ] **Step 2: Run `npx vitest run src/gate`.** Expected: FAIL.
- [ ] **Step 3: Implement `types.ts`, `policy.ts` and `spec-builder.ts`.**
- [ ] **Step 4: Run `npx vitest run src/gate`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/gate/types.ts src/gate/policy.ts src/gate/gate.test.ts src/orchestrator/spec-builder.ts
git commit -m "feat(gate): Bitcoin signing spec and policy rules (facts/gate.md)"
```

### Task 12: Network config, v4 share files, vault-pubkey.json

**Files:**
- Create: `src/daemon/vault-share.ts`, `src/daemon/vault-share.test.ts`
- Modify: `src/config/types.ts`, `src/config/parse.ts`, `src/config/parse.test.ts`, `src/daemon/vault-pubkey.ts`, `src/daemon/vault-pubkey.test.ts`, `src/daemon/config-merge.ts`, `src/daemon/transport-factory.ts`
- Delete: `src/daemon/share-persistence.ts`

**Interfaces:**
- Consumes: `encryptShareFile`, `decryptShareFile`, `assertShareMatchesVault`, `vaultPayment`, `toVaultKey` from `src/otzi/lib`; `ShareStager` from Task 9.
- Produces:

```ts
// config/types.ts
export { NETWORK_NAMES } from '../otzi/backend/types';
export type { NetworkName } from '../otzi/backend/types';
export interface NetworkConfig { name: NetworkName; esploraUrl?: string }
// daemon/vault-share.ts
export function pendingPath(path: string): string;   // `${path}.pending`
export async function vaultFileExists(path: string): Promise<boolean>;
export async function loadVaultShare(path: string, password: string, network: NetworkName): Promise<DecryptedShare | undefined>;   // undefined on ENOENT
export async function warnOnPendingShare(path: string, log: Logger): Promise<void>;
export interface ShareStagerOptions { path: string; password: string; network: NetworkName; partyId: PartyId; vaultPubkeyPath?: string }
export function createShareStager(opts: ShareStagerOptions): ShareStager;
// daemon/vault-pubkey.ts
export const DEFAULT_VAULT_PUBKEY_PATH = '/var/lib/otzi/vault-pubkey.json';
export interface VaultPubkeyFile { network: NetworkName; address: string; internalKey: string; outputKey: string; threshold: number; parties: number; vaultKey: VaultKey }
export function vaultPubkeyFromPackage(publicKeyPackage: PublicKeyPackage, network: NetworkName): VaultPubkeyFile;
export async function writeVaultPubkeyFile(file: VaultPubkeyFile, outputPath?: string): Promise<void>;   // mode 0644
export async function readVaultPubkeyFile(path?: string): Promise<VaultPubkeyFile>;
// daemon/config-merge.ts
export interface LoadedDaemonState { config: DaemonConfig; share?: DecryptedShare; password: string }
export async function loadAndValidate(configPath: string, options?: { env?: Readonly<Record<string, string | undefined>> }): Promise<LoadedDaemonState>
```

  - **Stager:**
    - `stage` writes `encryptShareFile(...)` JSON to `pendingPath(path)` with mode 0600, creating the parent directory and overwriting.
    - `commit` throws `Error('share path already exists: <path>')` when `path` exists. Otherwise it renames, then writes `vault-pubkey.json`.
    - `discard` removes the pending file and ignores ENOENT.
  - **`loadVaultShare` errors:**
    - a wrong password throws `Error('cannot decrypt share file <path>: wrong password or corrupted file')`;
    - an otzi check failure passes through `assertShareMatchesVault`'s message.
  - **Config parse errors:**
    - `network.opnet_rpc` → `ConfigError('network.opnet_rpc', 'no longer supported — remove it; the CLI reaches the chain through network.esplora_url')`;
    - name `testnet` → `'use testnet4 or signet'`;
    - name `regtest` → `'not supported'`;
    - `esplora_url` must be an `http://` or `https://` URL.
  - **`transport-factory`:** add the check `share.parties !== book.entries.length` → `Error('share is for <p> parties but the pubkey book has <n>')`.
  - **`config-merge`:** calls `warnOnPendingShare` on startup.

- [ ] **Step 1: Write the failing tests**

```ts
it('stage then commit writes a share otzi can decrypt and a matching vault-pubkey.json', async () => {
  const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
  await stager.stage({ keyPackage: kps[0], publicKeyPackage: pkp });
  expect(existsSync(pendingPath(path))).toBe(true);
  await stager.commit();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const share = await decryptShareFile(JSON.parse(readFileSync(path, 'utf8')), 'pw');
  expect(toHex(share.publicKeyPackage.verifyingKey)).toBe(toHex(pkp.verifyingKey));
  const vp = await readVaultPubkeyFile(vaultPubkeyPath);
  expect(vp.address).toBe(vaultPayment(toVaultKey(pkp), 'testnet4').address);
  expect(vp.address.startsWith('tb1p')).toBe(true);
});
it('commit refuses when a share already exists', ...);
it('discard removes the pending file', ...);
it('loadVaultShare returns undefined when no file exists', ...);
it('loadVaultShare names a wrong password', ...);              // Review Focus 3
it('loadVaultShare rejects a share for another network', ...);  // message 'This share file belongs to a different vault'
it('warnOnPendingShare logs a warning for a leftover pending file and loads nothing', ...);   // Review Focus 2
// parse.test.ts
it('rejects network.opnet_rpc, testnet and regtest with explicit messages', ...);
it('accepts an optional esplora_url', ...);
```

- [ ] **Step 2: Run `npx vitest run src/daemon/vault-share.test.ts src/daemon/vault-pubkey.test.ts src/config`.** Expected: FAIL.
- [ ] **Step 3: Implement, then `git rm src/daemon/share-persistence.ts`.**
- [ ] **Step 4: Run `npx vitest run src/daemon/vault-share.test.ts src/daemon/vault-pubkey.test.ts src/config`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/config src/daemon/vault-share.ts src/daemon/vault-share.test.ts src/daemon/vault-pubkey.ts src/daemon/vault-pubkey.test.ts src/daemon/config-merge.ts src/daemon/transport-factory.ts
git commit -m "feat(daemon): v4 share files, pending staging, Bitcoin network config (facts/daemon.md, facts/config.md)"
```

### Task 13: Participant orchestrator

**Files:**
- Modify (rewrite): `src/orchestrator/orchestrator.ts`, `src/orchestrator/types.ts`, `src/orchestrator/orchestrator.test.ts`

**Interfaces:**
- Consumes: Tasks 8–12.
- Produces:

```ts
export type OutcomeStatus = 'done' | 'aborted' | 'timeout' | 'rejected' | 'invalid-signoff';
export interface CeremonyOutcome { ceremonyId: string; kind: 'signing' | 'dkg'; status: OutcomeStatus; signaturesHex?: string[]; address?: string; reason?: string }
export interface Logger { debug; info; warn; error }   // unchanged, plus NOOP_LOGGER
export interface OrchestratorDeps {
  io: CeremonyIo; gate: ApprovalGate;
  node: { id: string; partyId: PartyId }; peersById: ReadonlyMap<PartyId, string>;
  network: NetworkName; vault?: DecryptedShare;
  vaultExists: () => Promise<boolean>; createStager: () => ShareStager;
  rng: Rng; ceremonyDeadlines: { signingMs: number; dkgMs: number };
  blobRetentionMs?: { signing: number; dkg: number };            // default BLOB_RETENTION_MS
  addressBook?: () => Promise<AddressBookEntry[]>;               // wired in Task 16
  logger?: Logger;
}
export class Orchestrator {
  constructor(deps: OrchestratorDeps);
  start(): void; stop(): void;
  onCompleted(handler: (o: CeremonyOutcome) => void): Unsubscribe;
  waitFor(ceremonyId: string, timeoutMs?: number): Promise<CeremonyOutcome>;
}
```

  Behaviour (spec §5.3 and §5.4, participant side):
  - **`announce-dkg`:** drop unless all of these hold:
    - no tracker exists for the `ceremonyId`;
    - `!vault && !(await vaultExists())`;
    - `network` equals `deps.network`;
    - `parties === peersById.size`;
    - the gate approves `buildDkgSpec`.

    Then run `runDkgCeremony` with an `AbortController` signal. A deadline of `dkgMs` aborts and settles `timeout`. Success settles `done` with `address`.
  - **`announce-sign`:** apply the participant checks in spec §5.4, then:
    1. `analyzeProposal(proposal, toVaultKey(vault.publicKeyPackage), network)`;
    2. `buildSigningSpec` with labels from `addressBook` when present;
    3. gate;
    4. `participateInSigning`.

    The sighashes are kept for signoff verification.
  - **`signoff-done`:** accepted from the pinned leader only. Every signature must verify against the kept sighashes with `verifySignature(sig, sighash, vault.publicKeyPackage.verifyingKey)` and the count must match → `done`; otherwise `invalid-signoff`.
  - **`signoff-aborted`:** for signing, accepted from the pinned leader; for DKG, from any ring member. Aborts the controller and settles `aborted`.
  - Every settle calls `scheduleClear(store, ceremonyId, retention)`. A silent drop logs one line with the reason.

- [ ] **Step 1: Write the failing tests** (3-node `makeRing`; node 0 drives with `encodeMessage`, `runDkgCeremony` and `leadSigning` directly)

```ts
it('participates in a DKG and settles done with the vault address', ...);
it('drops announce-dkg when a vault exists and never creates a stager', ...);   // vaultExists → true; createStager spy not called; store.list(id) empty
it('drops announce-dkg for another network or party count', ...);
it('stops a DKG when any ring member aborts', ...);
it('signs an approved proposal and settles done on a valid signoff', ...);
it('stays silent on a proposal spending a foreign input', ...);   // makeProposal inputs [{ amount, script: other vault script }]; no sign-r1 in node 1's store
it('stays silent on a proposal for another network', ...);
it('stays silent when the policy gate rejects a fee burn', ...);  // PolicyGate({ maxFeeSats: 1_000 }), proposal fee 50_000
it('drops announce-sign from a non-leader for a pinned ceremony', ...);
it('settles invalid-signoff on a forged signoff-done', ...);
it('clears ceremony blobs after the retention period', ...);       // blobRetentionMs { signing: 50, dkg: 50 }
it('accepts a fresh DKG after a leftover pending file', ...);        // Review Focus 2: vaultExists false while .pending exists
```

- [ ] **Step 2: Run `npx vitest run src/orchestrator`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run src/orchestrator src/core`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/orchestrator/types.ts src/orchestrator/orchestrator.test.ts
git commit -m "feat(orchestrator): participant side of FROST DKG and proposal signing (facts/orchestrator.md)"
```

### Task 14: Leader dispatcher, daemon composition and API

**Files:**
- Create: `src/daemon/api.ts`, `src/daemon/api.test.ts`
- Modify (rewrite): `src/daemon/leader.ts`, `src/daemon/daemon.ts`, `src/daemon/daemon.test.ts`, `src/daemon/daemon-integration.test.ts`; modify `src/daemon/entrypoint.ts` (`runDaemonCommand` wiring and pending-share warning)
- Delete: `src/core/ceremony-runner.ts`, `src/core/ceremony-runner.test.ts`, `src/core/ceremony-messages.ts`, `src/core/ceremony-messages.test.ts`, `src/core/dkg-session.ts`

**Interfaces:**
- Consumes: Tasks 8–13.
- Produces:

```ts
// daemon/api.ts
export class RequestError extends Error { constructor(readonly status: 400 | 409, message: string) }
export interface LeaderSignRequest { ceremonyId: string; signers: PartyId[]; proposal: SendProposal }
export function defaultCeremonyId(op: 'dkg' | 'sign'): string;   // `${op}-${crypto.randomUUID()}`
export function parseDkgRequest(body: Record<string, unknown>): { ceremonyId: string };
export function parseSignRequest(body: Record<string, unknown>, ring: { partyIds: readonly PartyId[]; self: PartyId; minSigners: number }): LeaderSignRequest;   // lowercases hex fields, then isProposalShape
// daemon/leader.ts
export class GateRejection extends Error { constructor(readonly ceremonyId: string, readonly decision: Decision) }
export interface LeaderDeps { io: CeremonyIo; gate: ApprovalGate; node: { id: string; partyId: PartyId }; peersById: ReadonlyMap<PartyId, string>; network: NetworkName; vault?: DecryptedShare; vaultExists: () => Promise<boolean>; createStager: () => ShareStager; rng: Rng; blobRetentionMs?: { signing: number; dkg: number }; addressBook?: () => Promise<AddressBookEntry[]>; logger?: Logger }
export class LeaderDispatcher {
  constructor(deps: LeaderDeps);
  runDkg(req: { ceremonyId: string }): Promise<{ ceremonyId: string; address: string; internalKey: string; network: NetworkName }>;
  sign(req: LeaderSignRequest): Promise<{ ceremonyId: string; txid: string; signedTxHex: string; signaturesHex: string[] }>;
}
// daemon/daemon.ts
export interface DaemonDeps { state: LoadedDaemonState; transport: Transport; selfPartyId: number; peersById: ReadonlyMap<PartyId, string>; rng: Rng; pullOpts: PullOpts; logger?: Logger; httpHandler?: HttpHandler; cronHandlers?: ReadonlyMap<string, CronHandler>; env?: Readonly<Record<string, string | undefined>>; vaultPubkeyPath?: string }
export function buildDefaultHttpHandler(leader: LeaderDispatcher, state: LoadedDaemonState, peersById: ReadonlyMap<PartyId, string>, selfPartyId: PartyId, logger: Logger): HttpHandler;
```

  - **`runDkg`:**
    1. A loaded vault or `vaultExists()` gives `RequestError(409, 'this node already holds a vault')`.
    2. Gate on `buildDkgSpec` with `threshold = parties = peersById.size`.
    3. Random 32-byte session ID; broadcast `announce-dkg`; `runDkgCeremony`.
    4. Return the address via `vaultPayment`.
  - **`sign`:**
    1. No vault gives `RequestError(409, 'no vault loaded — run otzi generate, then restart the daemon')`.
    2. A throw from `analyzeProposal` gives `RequestError(400, <message>)`.
    3. A gate reject throws `GateRejection`.
    4. `leadSigning`, then `finalizeSend`, then broadcast `signoff-done`.
    5. Any failure after the announce broadcasts `signoff-aborted` and rethrows.
    6. Settle and failure both `scheduleClear`.
  - **Handler:** ops `vault-info`, `dkg`, `sign`.
    - An unknown op or unknown top-level field gives 400.
    - `RequestError` maps to its status, `GateRejection` to 403 `{ error: 'gate rejected', decision, ceremonyId }`, anything else to 500 `{ error, ceremonyId }`.
    - `vault-info` with no vault gives 409.

- [ ] **Step 1: Write the failing tests**

```ts
// api.test.ts
it('rejects unknown fields, bad ceremonyIds and bad signer sets', ...);    // duplicate, non-member, missing self, fewer than minSigners
it('rejects more than 255 inputs', ...);
it('lowercases proposal hex before shape checks', ...);
// daemon.test.ts (3 Daemons on createInMemoryRing, tmpdir share paths, auto gate)
it('vault-info returns 409 before DKG', ...);
it('dkg returns 409 when a share file exists', ...);
it('sign returns 409 with a restart hint when no vault is loaded', ...);      // Review Focus 5
it('dkg, restart, then sign returns a transaction that finalizes', ...);     // restart = new Daemon instances with loadAndValidate; after DKG every share decrypts with otzi decryptShareFile, all addresses match, no .pending file remains
it('sign returns 400 with the analysis reason for a foreign input', ...);
it('sign returns 403 when the gate rejects', ...);
// daemon-integration.test.ts (peer-mesh on loopback, real Noise-KK identities from the existing helpers)
it('three daemons over peer-mesh run DKG, restart and sign a proposal', ...);
```

- [ ] **Step 2: Run `npx vitest run src/daemon/api.test.ts src/daemon/daemon.test.ts src/daemon/daemon-integration.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement, then remove the old core:** `git rm src/core/ceremony-runner.ts src/core/ceremony-runner.test.ts src/core/ceremony-messages.ts src/core/ceremony-messages.test.ts src/core/dkg-session.ts`
- [ ] **Step 4: Run `npx vitest run src/daemon src/orchestrator src/core src/gate`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/daemon/api.ts src/daemon/api.test.ts src/daemon/leader.ts src/daemon/daemon.ts src/daemon/daemon.test.ts src/daemon/daemon-integration.test.ts src/daemon/entrypoint.ts
git commit -m "feat(daemon): leader dispatcher and API for DKG and proposal signing (facts/daemon.md)"
```

### Task 15: CLI on Esplora; remove the old stack (end of block)

**Files:**
- Create: `src/cli/cmd/generate.ts`, `src/cli/cmd/generate.test.ts`, `src/testing/mock-esplora.ts`
- Modify (rewrite): `src/cli/cmd/btc.ts`, `src/cli/cmd/btc.test.ts`, `src/cli/cmd/vault.ts`, `src/cli/cmd/vault.test.ts`; modify `src/daemon/entrypoint.ts` (verbs `generate`, `vault`, `btc balance|send|sign`; `generate` takes `--config`), `src/cli/daemon-client.ts` (`VaultInfo` type), `package.json`, `scripts/build-deb.sh` (comment about vendor)
- Delete: `src/broadcast/`, `src/wire/`, `src/node/`, `vendor/post-quantum/`, `scripts/testnet-e2e.ts`; dependencies `@btc-vision/bip32`, `@btc-vision/bitcoin`, `@btc-vision/post-quantum`, `@btc-vision/transaction`, `opnet`; `"vendor"` from `package.json` `files`

**Interfaces:**
- Consumes: `chainApiUrl`, `getUtxos`, `getBalance`, `broadcastTx`, `getFeeRates` from `src/otzi/backend/esplora.ts`; `buildSend` from `src/otzi/backend/bitcoin.ts`; `analyzeProposal` and `explorerTxUrl` from `src/otzi/lib/bitcoin.ts`; `readVaultPubkeyFile`; `DaemonClient`.
- Produces:

```ts
// cli/cmd/btc.ts
export interface CliDeps { client?: { request<T>(body: unknown): Promise<T> } }
export class BroadcastFailedError extends Error { constructor(message: string, readonly txid: string, readonly signedTxHex: string) }
export async function btcBalance(opts: { configPath: string; vaultPath?: string; unit?: BtcUnit }): Promise<string>;   // "confirmed: X\nunconfirmed: Y"
export async function btcSend(opts: { configPath: string; vaultPath?: string; to: string; amount: string; feeRate?: number }, deps?: CliDeps): Promise<{ txid: string; explorerUrl: string }>;
export async function btcSign(opts: { configPath: string; vaultPath?: string; proposalPath: string; broadcast: boolean }, deps?: CliDeps): Promise<{ txid: string; signedTxHex: string; summary: string; explorerUrl?: string }>;
// cli/cmd/generate.ts
export async function generate(opts: { configPath: string; ceremonyId?: string }, deps?: CliDeps): Promise<{ ceremonyId: string; address: string; network: NetworkName }>;
// testing/mock-esplora.ts
export interface MockEsplora { url: string; broadcasts: string[]; fund(address: string, value: number, opts?: { confirmed?: boolean }): { txid: string; vout: number }; rejectBroadcasts(message: string | null): void; close(): Promise<void> }
export async function startMockEsplora(): Promise<MockEsplora>;   // GET /address/:a/utxo, GET /address/:a, POST /tx, GET /v1/fees/recommended {fastestFee:10, halfHourFee:5, hourFee:2}, POST /_fund {address, value, confirmed}
```

  **`btcSend` flow:**
  1. Read `vault-pubkey.json` and the config (`esplora_url` or `chainApiUrl` default).
  2. `getUtxos`, keeping confirmed ones only.
  3. `amount` is `'max'` or `parseBtcAmount` sats; fee rate is `--fee-rate` or `getFeeRates().normal`.
  4. `buildSend` with `vault: vaultKey`.
  5. More than 255 prevouts → `Error('this send needs <k> inputs; at most 255 fit in one transaction — consolidate first')` before any daemon call.
  6. Daemon `{ op: 'sign', proposal }`.
  7. `broadcastTx`; on failure throw `BroadcastFailedError`.

  The entrypoint prints the signed hex to stderr on `BroadcastFailedError` and exits 1. `btcSign` reads a `SendProposal` JSON file, prints the `analyzeProposal` summary (outputs, change, fee, fee rate), signs, and broadcasts only with `--broadcast`.

- [ ] **Step 1: Write the failing tests.** A fake client signs with `makeTestVault(2, 3)` from `src/otzi/backend/test-vault.fixture.ts`: it computes the sighashes, signs each with `schnorr.sign(sighash, tweakedSecret)`, and returns `finalizeSend(...)`.

```ts
it('send builds a proposal from confirmed UTXOs, signs and broadcasts', async () => {
  esplora.fund(address, 80_000); esplora.fund(address, 30_000, { confirmed: false });
  const r = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client });
  expect(esplora.broadcasts).toHaveLength(1);
  expect(client.lastProposal.prevouts).toHaveLength(1);   // the unconfirmed coin is not spent
  expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
});
it('send refuses before signing when more than 255 inputs are needed', ...);   // 300 × 1_000 sats, amount 'max'; client.request never called
it('send fails before signing when Esplora is unreachable', ...);              // Review Focus 4: closed port; client never called
it('a rejected broadcast surfaces the signed transaction hex', ...);            // Review Focus 1: rejectBroadcasts('bad-txns-inputs-missingorspent'); BroadcastFailedError.signedTxHex is hex
it('sign prints the analysis and broadcasts only with --broadcast', ...);
it('balance reports confirmed and unconfirmed sats', ...);
// vault.test.ts, generate.test.ts
it('vault prints network, address and threshold', ...);
it('generate sends op dkg and returns the address', ...);
```

- [ ] **Step 2: Run `npx vitest run src/cli`.** Expected: FAIL.
- [ ] **Step 3: Implement, then remove the old stack:** `git rm -r src/broadcast src/wire src/node vendor/post-quantum scripts/testnet-e2e.ts` and `npm uninstall @btc-vision/bip32 @btc-vision/bitcoin @btc-vision/post-quantum @btc-vision/transaction opnet`
- [ ] **Step 4: Verify the whole block**

Run: `npm run typecheck && npm test && grep -rniE "btc-vision|opnet|ml-?dsa|post-quantum|keylink|frostLegacySig" src package.json scripts`
Expected: typecheck exits 0; every vitest file passes; `node --test` passes 31; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/daemon/entrypoint.ts src/testing/mock-esplora.ts package.json package-lock.json scripts/build-deb.sh
git commit -m "feat(cli): Esplora-backed btc send/sign/balance; remove ML-DSA and OPNet stack (facts/daemon.md)"
```

---

## Phase 3 — Address book, packaging, delivery

### Task 16: Per-node address book

**Files:**
- Create: `src/address-book/store.ts`, `src/address-book/store.test.ts`, `src/cli/cmd/book.ts`, `src/cli/cmd/book.test.ts`
- Modify: `src/gate/policy.ts`, `src/gate/factory.ts`, `src/gate/gate.test.ts`, `src/daemon/daemon.ts` (wire `addressBook`), `src/cli/cmd/btc.ts` (label resolution), `src/cli/cmd/backup.ts`, `src/cli/cmd/restore.ts` and their tests, `src/daemon/entrypoint.ts` (`book` verb)

**Interfaces:**
- Consumes: `validateEntries`, `parseAddressBookFile`, `mergeAddressBooks`, `addressBookFile`, `labelFor` from `src/otzi/lib/address-book.ts`.
- Produces:

```ts
// address-book/store.ts
export const DEFAULT_ADDRESS_BOOK_PATH = '/etc/otzi/address-book.otzi.json';
export async function readAddressBook(path: string, network: NetworkName): Promise<AddressBookEntry[]>;   // [] on ENOENT; throws on invalid file or network mismatch
export async function writeAddressBook(path: string, network: NetworkName, entries: AddressBookEntry[]): Promise<void>;   // validateEntries, temp file + rename, mode 0640
export function resolveRecipient(entries: AddressBookEntry[], labelOrAddress: string, network: NetworkName): string;   // exact label match first, then a valid address, else Error('unknown label or invalid address: <x>')
// gate/policy.ts additions
PolicyConfig.allowedRecipients?: string[] | 'address-book';
PolicyGateOptions.loadAddressBook?: () => Promise<string[]>;
// gate/factory.ts
export function createGate(config: GateConfig, deps?: { loadAddressBook?: () => Promise<string[]> }): ApprovalGate;
// cli/cmd/book.ts
export async function bookList(o: BookOpts): Promise<string>;
export async function bookAdd(o: BookOpts & { label: string; address: string; note?: string }): Promise<void>;
export async function bookRemove(o: BookOpts & { key: string }): Promise<void>;
export async function bookImport(o: BookOpts & { file: string; replace: boolean }): Promise<{ added: number; updated: number; unchanged: number }>;
export async function bookExport(o: BookOpts & { out?: string }): Promise<string>;
export interface BookOpts { configPath: string; bookPath?: string }
```

  - With `allowed_recipients = "address-book"`, a failed load or an invalid file rejects and logs a warning.
  - The daemon passes `addressBook: () => readAddressBook(DEFAULT_ADDRESS_BOOK_PATH, network)` to the orchestrator and leader, so specs carry labels.
  - Backups add `etc/otzi/address-book.otzi.json` when present; restore sets mode 0640.

- [ ] **Step 1: Write the failing tests**

```ts
it('writes the book atomically with mode 0640 in otzi format', ...);   // JSON kind 'otzi-address-book', version 1
it('rejects a book for another network', ...);
it('import merges by default and reports counts; --replace replaces', ...);
it('address-book policy approves listed recipients and rejects others', ...);
it('address-book policy rejects when the book file is invalid', ...);
it('btc send resolves a label to its address', ...);
it('backup includes the address book and restore sets 0640', ...);
```

- [ ] **Step 2: Run `npx vitest run src/address-book src/cli src/gate`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run typecheck && npm test`.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/address-book src/cli src/gate src/daemon/daemon.ts src/daemon/entrypoint.ts
git commit -m "feat(address-book): per-node otzi-format address book, CLI and policy source (facts/address-book.md)"
```

### Task 17: Packaging, examples, version

**Files:**
- Modify: `packaging/deb/DEBIAN/{templates,config,postinst}`, `scripts/test-deb-container.sh` (if it references OPNet), `examples/gate-file-approver.sh`, `package.json` (version `0.3.0`, description)
- Create: `examples/gate-web-btc-message/{README.md,approver.ts,decision.ts,decision.test.ts,index.html}`
- Delete: `examples/gate-web-opwallet/`

**Interfaces:**
- Consumes: `verifyBitcoinMessage(address, message, signature): boolean` from `src/otzi/backend/btc-message.ts`.
- Produces:

```ts
// examples/gate-web-btc-message/decision.ts
export function decisionMessage(decision: 'approve' | 'reject', ceremonyId: string, nonce: string): string;   // `otzi-gate:${decision}:${ceremonyId}:${nonce}`
export function verifyDecision(p: { address: string; decision: 'approve' | 'reject'; ceremonyId: string; nonce: string; signature: string }): boolean;
```

  - **debconf:**
    - `otzi-headless/network` gets `Choices: mainnet, testnet4, signet` and `Default: testnet4`.
    - Remove `otzi-headless/opnet-rpc` everywhere.
    - Add the optional string `otzi-headless/esplora-url`; `postinst` writes `esplora_url` only when it is non-empty.
  - **Approver:**
    - env `APPROVER_ADDRESS` replaces `APPROVER_PUBKEY_HEX`;
    - run with `npx tsx examples/gate-web-btc-message/approver.ts`;
    - the page lists pending specs with outputs, labels, change, fee and fee rate.

- [ ] **Step 1: Write the failing test** (`decision.test.ts`, run by vitest because it lives under `examples/`)

```ts
it('accepts a legacy signmessage signature from the pinned P2WPKH address', () => {
  const priv = secp256k1.utils.randomSecretKey();
  const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address!;
  const msg = decisionMessage('approve', 'sign-1', 'ab'.repeat(16));
  const sig = secp256k1.sign(legacyMessageHash(msg), priv, { prehash: false, format: 'recovered' });   // [recid, r, s]
  const header = 27 + 4 + 8 + sig[0];                                                                  // compressed P2WPKH (BIP-137)
  const signature = base64.encode(Uint8Array.from([header, ...sig.slice(1)]));
  expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-1', nonce: 'ab'.repeat(16), signature })).toBe(true);
  expect(verifyDecision({ address, decision: 'reject', ceremonyId: 'sign-1', nonce: 'ab'.repeat(16), signature })).toBe(false);
});
```

- [ ] **Step 2: Run `npx vitest run examples`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Write the example; update the comment block of `examples/gate-file-approver.sh` so it describes the spec fields an operator sees (`outputs`, `fee`, `feeRate`, `txid`); make the debconf changes and the version bump; then `git rm -r examples/gate-web-opwallet`.
- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && bash -n packaging/deb/DEBIAN/postinst packaging/deb/DEBIAN/config && grep -rniE "opnet|testnet\b|regtest|bootstrap-secret" packaging examples`
Expected: all pass; grep prints nothing.

Run (where `dpkg-deb` exists): `npm run build:deb && stat -c%s dist/otzi-headless_0.3.0*.deb`
Expected: under 2097152.

- [ ] **Step 5: Commit**

```bash
git add packaging scripts examples package.json package-lock.json
git commit -m "feat(packaging): Bitcoin networks and Esplora prompt; message-signed approver example; v0.3.0"
```

### Task 18: Final verification, security review, pull request

**Files:** none planned; fixes from the review land in the files they concern.

- [ ] **Step 1: Run the full checks.** Run `npm run typecheck && npm test && bash scripts/check-otzi-drift.sh "$OTZI"`. Expected: all pass; drift prints `OK: 21 files match 71eb9bd…`.
- [ ] **Step 2: Independent security review.** Dispatch a reviewer subagent (superpowers:requesting-code-review, security focus) on `git diff master...HEAD` with the spec and this plan. Focus areas:
  - nonce lifecycle;
  - addressed-blob access;
  - sender binding;
  - `analyzeProposal` inputs and gate spec fields;
  - DKG agreement and the vault-exists guard;
  - API and message input validation;
  - share and pending-file handling;
  - the address-book privilege boundary.
- [ ] **Step 3: Fix every confirmed finding.** Each fix gets a failing test first, the fix, then a commit citing the finding. Re-run Step 1.
- [ ] **Step 4: Push.** `git push -u origin claude/lucid-meitner-ona23c`.
- [ ] **Step 5: Open the PR into `master`.**
  - Title: `FROST-only Bitcoin vault (v0.3.0)`.
  - Body: summary, the S1–S15 table from spec §8 with resolutions, breaking changes (share format, wire, config keys, API, CLI verbs), and test evidence. Use the repository's PR template if one exists.
  - Subscribe to PR activity.
