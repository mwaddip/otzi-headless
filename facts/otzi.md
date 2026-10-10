# Contracts: src/otzi/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

> **Lifted verbatim from Ötzi. DO NOT EDIT any file under `src/otzi/`.** Byte-identity with the recorded Ötzi commit is a hard contract. Headless code that needs more goes in its own modules outside `src/otzi/`.

Pre/post conditions below are taken from Ötzi's `facts/INTERFACES.md` at the recorded commit (§1, §3–§8, §11, §15) and restated for the functions otzi-headless consumes. Ötzi's own contracts stay authoritative for the code; this file records what headless relies on.

## Lift rule

### `src/otzi/OTZI_COMMIT`
**Purpose:** Records the Ötzi commit every lifted file is copied from.

- **Content:** the full 40-character commit hash, one line: `71eb9bd07822583ffc7424b1c419dd8d76e78e9c`.
- **Invariant:** every file in the table below is byte-identical to the file at the mapped path in Ötzi at this commit.

### Lifted files

| Destination | Ötzi source (at `OTZI_COMMIT`) |
|---|---|
| `src/otzi/lib/dkg.ts` | `src/lib/dkg.ts` |
| `src/otzi/lib/dkg.fixture.ts` | `src/lib/dkg.fixture.ts` |
| `src/otzi/lib/dkg.test.ts` | `src/lib/dkg.test.ts` |
| `src/otzi/lib/frost-sign.ts` | `src/lib/frost-sign.ts` |
| `src/otzi/lib/frost-sign.test.ts` | `src/lib/frost-sign.test.ts` |
| `src/otzi/lib/share-file.ts` | `src/lib/share-file.ts` |
| `src/otzi/lib/share-file.test.ts` | `src/lib/share-file.test.ts` |
| `src/otzi/lib/bitcoin.ts` | `src/lib/bitcoin.ts` |
| `src/otzi/lib/bitcoin.test.ts` | `src/lib/bitcoin.test.ts` |
| `src/otzi/lib/crypto.ts` | `src/lib/crypto.ts` |
| `src/otzi/lib/hex.ts` | `src/lib/hex.ts` |
| `src/otzi/lib/vault-types.ts` | `src/lib/vault-types.ts` |
| `src/otzi/lib/address-book.ts` | `src/lib/address-book.ts` |
| `src/otzi/lib/address-book.test.ts` | `src/lib/address-book.test.ts` |
| `src/otzi/backend/bitcoin.ts` | `backend/src/lib/bitcoin.ts` |
| `src/otzi/backend/bitcoin.test.ts` | `backend/src/lib/bitcoin.test.ts` |
| `src/otzi/backend/test-vault.fixture.ts` | `backend/src/lib/test-vault.fixture.ts` |
| `src/otzi/backend/esplora.ts` | `backend/src/lib/esplora.ts` |
| `src/otzi/backend/btc-message.ts` | `backend/src/lib/btc-message.ts` |
| `src/otzi/backend/btc-message.test.ts` | `backend/src/lib/btc-message.test.ts` |
| `src/otzi/backend/types.ts` | `backend/src/lib/types.ts` |

**Rules:**
- Files are copied byte for byte. Relative imports stay as Ötzi wrote them (extensionless `./hex` in `lib/`, `./types.js` in `backend/`).
- The directory mirrors Ötzi's layout (`lib/` = frontend `src/lib/`, `backend/` = `backend/src/lib/`), so lifted files never collide with headless modules.
- Browser-only helpers (`downloadShareFile`, `downloadAddressBook`) are present but never called by headless code. `tsconfig.json` keeps the `DOM` lib so they typecheck.
- `lib/` and `backend/` each define their own `NetworkName`, `VaultKey`, `AddressBookEntry`, `VaultPayment` and `RBF_SEQUENCE`; the definitions are structurally identical. Headless modules may import either; `src/config/types.ts` re-exports `NETWORK_NAMES` / `NetworkName` from `backend/types.ts`.
- Runtime requirements: `globalThis.crypto` (WebCrypto: `subtle`, `getRandomValues`), `btoa` / `atob`, `fetch`, `AbortSignal.timeout` — all present in the supported Node range (`>=22 <25`).

### `scripts/check-otzi-drift.sh <otzi-checkout>`
**Purpose:** Mechanical proof that `src/otzi/` matches Ötzi at the recorded commit.

- **Pre:** `<otzi-checkout>` is the top level of a git working tree of Ötzi (CI checks out `OTZI_COMMIT`); a plain directory, or one inside another repository, is refused (exit 2) — the reported HEAD must be the checkout's own.
- **Post:** The script embeds the 21 lifted file names of the table above. It diffs each against `<otzi-checkout>/<Ötzi source path>` and also fails on a listed file missing under `src/otzi/` and on any file under `src/otzi/lib` or `src/otzi/backend` that is not on the list. Exits 0 when all 21 files are identical (`OK: 21 files match <otzi HEAD>`); exits non-zero and names each differing, missing or extra file otherwise.
- **CI:** `.github/workflows/ci.yml` clones Ötzi at `OTZI_COMMIT` and runs the script on push and pull request; `.github/workflows/release.yml` runs it (and `npm run typecheck`) before building the `.deb`.

### Tests
- The lifted tests run unchanged under Node's test runner: `node --import tsx --test src/otzi/lib/*.test.ts src/otzi/backend/*.test.ts` (`npm run test:otzi`).
- vitest excludes `src/otzi/`. `npm test` runs vitest, then `npm run test:otzi`.

### Moving to a newer Ötzi commit
1. Copy every file in the table from the new commit; add or drop files only together with this table and the list in `scripts/check-otzi-drift.sh`.
2. Write the new hash to `src/otzi/OTZI_COMMIT`.
3. Re-read Ötzi's `facts/INTERFACES.md` §1, §3–§8, §11, §15 and update the sections below.
4. Run `scripts/check-otzi-drift.sh`, `npm run typecheck` and `npm test`.

---

## src/otzi/lib/

### `vault-types.ts`
**Purpose:** Shared Ötzi types (Ötzi §1, §8).

**Public surface consumed by headless:**
- `type NetworkName = 'mainnet' | 'testnet4' | 'signet'` — fixed per vault. Mainnet addresses use HRP `bc`; testnet4 and signet use `tb`.
- `interface VaultKey` — FROST `PublicKeyPackage`, hex-encoded:
  - `minSigners: number` (threshold T);
  - `verifyingKey: string` — 33-byte SEC1 hex, BIP341 output key;
  - `untweakedVerifyingKey: string` — 33-byte SEC1 hex, BIP341 internal key;
  - `verifyingShares: Record<string, string>` — FROST identifier (`"1"`..`"N"`) → 33-byte SEC1 hex (tweaked);
  - `untweakedVerifyingShares: Record<string, string>` — same keys, untweaked.
  - **Invariant:** party count N = number of keys in `verifyingShares`.
- `interface AddressBookEntry { label: string; address: string; note?: string }` — `label` trimmed, 1–64 chars; `address` valid for the network; `note` ≤ 256 chars.
- `interface Prevout { txid: string; vout: number; amount: number; script: string }`.
- `interface SendProposal { network: NetworkName; tx: string; prevouts: Prevout[] }` — `tx` is the unsigned transaction hex without witness data.

**Notes:** `VaultConfig`, `HostingConfig`, `StorageMode`, `AuthMode`, `UserPublic`, `Invite` are web-Ötzi types; headless does not use them.

---

### `hex.ts`
**Purpose:** Hex and base64 helpers.

**Public surface:**
- `toHex(bytes: Uint8Array): string`
  - **Post:** Lowercase hex, two characters per byte.
- `fromHex(hex: string): Uint8Array`
  - **Pre:** `hex` is even-length hex. Input is not validated: non-hex characters decode to `NaN` → 0 bytes.
  - **Post:** Decoded bytes.
- `uint8ToBase64(bytes: Uint8Array): string`
  - **Post:** Standard base64.

**Cross-component contracts:** Used by headless modules that need hex (sessions, transport-factory, setup, relay transport, daemon). Callers that take hex from untrusted input validate it first (the ceremony-message parser and `api.ts` check `^[0-9a-f]*$` and even length).

---

### `crypto.ts`
**Purpose:** Password-based encryption of share files (Ötzi §3, browser variant).

**Public surface:**
- `encrypt(data: Uint8Array, password: string): Promise<string>`
  - **Post:** PBKDF2-SHA256 (600,000 iterations, 16-byte random salt) → AES-256-GCM with a 12-byte random IV. Returns `base64(salt[16] ‖ iv[12] ‖ ciphertext‖tag)`. Fresh salt and IV per call: the same input yields a different ciphertext each call.
- `decrypt(encoded: string, password: string): Promise<Uint8Array>`
  - **Post:** `decrypt(encrypt(d, pw), pw)` equals `d`.
  - **Throws:** On wrong password or corruption (GCM tag failure).

**Cross-component contracts:** Used only through `share-file.ts`.

---

### `dkg.ts`
**Purpose:** Ceremony blob envelope, FROST DKG blob codecs, `PublicKeyPackage` ↔ `VaultKey`, and the DKG verification message (Ötzi §5, §6).

**Envelope invariants (Ötzi §5):**
- Every blob is `base64(JSON({ v: 2, type, from, to, sid, data }))`.
- `type ∈ { 'session', 'frost-r1', 'frost-r2', 'frost-sign-r1', 'frost-sign-r2' }`.
- `sid` is the first 16 hex characters of the 32-byte session ID.
- `to === -1` is a broadcast; `to >= 0` addresses one party.
- `data` is hex-encoded binary payload.
- Decoders return `null` (never throw) on a malformed envelope.

**Payload layouts:**

| Type | Layout of `data` |
|---|---|
| `frost-r1` | `1B partyId ‖ 1B count ‖ count×33B commitment ‖ 33B proof.R ‖ 32B proof.z (BE)` |
| `frost-r2` | `1B sender partyId ‖ 1B recipient partyId ‖ 32B signingShare (BE)` |

**Public surface consumed by headless:**
- `partyIdToFrostId(partyId: number): bigint` / `frostIdToPartyId(id: bigint): number`
  - **Post:** `partyIdToFrostId(p) = BigInt(p + 1)`; `frostIdToPartyId(id) = Number(id) - 1`.
- `encodeFrostRound1(pkg: FrostRound1Package, sessionId: Uint8Array): string`
  - **Pre:** `pkg` is a frots DKG round-1 package; its identifier maps to a partyId in `0..255`; at most 255 commitments.
  - **Post:** `frost-r1` envelope, `from` = sender partyId, `to = -1`, `sid` from `sessionId`.
- `decodeFrostRound1(blob: string): FrostRound1Package | null`
  - **Post:** Returns `{ identifier, commitment, proofOfKnowledge: { R, z } }` with `identifier = partyIdToFrostId(partyId)`.
  - **Returns `null`:** bad envelope, wrong type, zero commitments, payload length ≠ `2 + count·33 + 65`, or payload partyId ≠ envelope `from`.
- `encodeFrostRound2(pkg: FrostRound2Package, sessionId: Uint8Array): string`
  - **Post:** `frost-r2` envelope, `from` = sender partyId, `to` = recipient partyId.
- `decodeFrostRound2(blob: string): FrostRound2Package | null`
  - **Post:** Returns `{ sender, recipient, signingShare }` (FROST identifiers, bigint share).
  - **Returns `null`:** bad envelope, wrong type, payload length ≠ 34, payload sender ≠ envelope `from`, or payload recipient ≠ envelope `to`.
- `toVaultKey(pkp: PublicKeyPackage): VaultKey`
  - **Post:** Hex-encodes every field; share maps keyed by decimal identifier, sorted ascending.
- `fromVaultKey(v: VaultKey): PublicKeyPackage`
  - **Post:** Inverse of `toVaultKey` (bigint identifiers, `Uint8Array` points, `Map`s). Does not validate points.
- `dkgVerifyMessage(sessionId: Uint8Array, network: NetworkName, pkp: PublicKeyPackage): Uint8Array`
  - **Pre:** `pkp` has a tweaked verifying share for every untweaked one.
  - **Post (Ötzi §6):**
    ```
    M = taggedHash("Otzi/dkg-verify",
          sid[32] ‖ ascii(network) ‖ untweakedVerifyingKey[33] ‖ verifyingKey[33] ‖ u8(T) ‖
          for each identifier ascending: u16le(id) ‖ untweakedVerifyingShare[33] ‖ verifyingShare[33])
    taggedHash(tag, x) = SHA256(SHA256(tag) ‖ SHA256(tag) ‖ x)
    ```
    Each party computes `M` from its own view of the ceremony, so any disagreement on the session, network, group key, threshold or any verifying share makes the verification signature fail.
  - **Throws:** `Error('Missing verifying share <id>')`.

**Invariants:** Codecs are deterministic (same package → same string), as `BlobStore` conflict detection requires.

**Cross-component contracts:** `src/core/frost-dkg-session.ts` (round 1/2 codecs, id conversion), `src/core/dkg-ceremony.ts` (`dkgVerifyMessage`), `src/daemon/vault-share.ts` and `vault-pubkey.ts` (`toVaultKey`).

**Notes / gotchas:**
- `encodeSessionConfig` / `decodeSessionConfig`, `identifyBlob`, `generateSessionId`, `getSessionIdPrefix` belong to Ötzi's relay ceremony; headless announces its DKG with its own `announce-dkg` message.
- Ötzi's session-level checks (sid match, `to` filtering) live in the browser components; headless applies its own (sender binding, addressed-blob access) in `src/core/`.

---

### `frost-sign.ts`
**Purpose:** FROST signing blob codecs (Ötzi §5, §7).

**Payload layouts:**

| Type | Layout of `data` |
|---|---|
| `frost-sign-r1` | `1B partyId ‖ 1B count ‖ count×(2B identifier LE ‖ 33B hiding ‖ 33B binding)` |
| `frost-sign-r2` | `1B partyId ‖ 1B count ‖ count×(2B identifier LE ‖ 32B share BE)` |

**Public surface consumed by headless:**
- `encodeFrostSignR1(partyId: number, commitments: readonly SigningCommitment[], sessionId: Uint8Array): string`
  - **Pre:** `partyId` in `0..255`; `commitments.length ≤ 255` (one per sighash).
  - **Post:** `frost-sign-r1` broadcast envelope (`to = -1`).
- `decodeFrostSignR1(blob: string): { partyId: number; commitments: SigningCommitment[] } | null`
  - **Returns `null`:** bad envelope or wrong type.
- `encodeFrostSignR2(partyId: number, shares: readonly SignatureShare[], sessionId: Uint8Array): string`
  - **Pre:** as `encodeFrostSignR1`.
  - **Post:** `frost-sign-r2` broadcast envelope.
- `decodeFrostSignR2(blob: string): { partyId: number; shares: SignatureShare[] } | null`
  - **Returns `null`:** bad envelope or wrong type.

**Notes / gotchas:**
- The count is one byte: a ceremony signs at most 255 sighashes. Headless enforces this before any signing starts (`MAX_INPUTS`).
- The sign decoders check the envelope and type only. They do not check the payload length, that the payload partyId equals the envelope `from`, the entry identifiers or the points. Headless sessions apply those checks: payload partyId = authenticated `from`, entry count = sighash count, every identifier = `from + 1`, and in round 1 every `hiding` / `binding` a valid compressed secp256k1 point (see [core.md](core.md) `frost-sign-session.ts`). `decodeFrostSignR2` throws a `TypeError` on a truncated payload; the session catches it.
- Ötzi's `ParticipantBinding`, `SighashInfo` and `FrostSignatureSet` belong to its relay flow; `SighashInfo` is the element type of `ProposalAnalysis.sighashes`.

---

### `share-file.ts`
**Purpose:** Share file v4 — one party's FROST key package plus the vault's public key package, encrypted with the party's password (Ötzi §4).

**File format:**
```ts
interface ShareFile {
  version: 4;
  network: NetworkName;
  internalKey: string;   // 33-byte SEC1 hex — vault BIP341 internal key
  partyId: number;       // 0-based; FROST identifier = partyId + 1
  threshold: number;     // T
  parties: number;       // N
  encrypted: string;     // crypto.ts encrypt() of the UTF-8 JSON payload
}
// payload: { keyPackage: {identifier, signingShare, verifyingShare, verifyingKey, minSigners,
//   untweakedVerifyingKey, untweakedSigningShare, untweakedVerifyingShare}, publicKeyPackage: VaultKey, network }
```

**Public surface consumed by headless:**
- `encryptShareFile(keyPackage, publicKeyPackage, network, partyId, password): Promise<ShareFile>`
  - **Pre:** `keyPackage` and `publicKeyPackage` come from the same `dkgFinalize`; `keyPackage.identifier === partyId + 1`.
  - **Post:** A v4 `ShareFile` whose header is derived from the packages (`internalKey` = untweaked group key, `threshold` = `minSigners`, `parties` = share count).
  - **Throws:** `Error('Key package does not belong to this party')` when the identifier does not match.
- `decryptShareFile(raw: unknown, password: string): Promise<DecryptedShare>`
  - **Pre:** `raw` parsed from JSON.
  - **Post:** Returns `{ network, internalKey, partyId, threshold, parties, keyPackage, publicKeyPackage }` with frots-native types (bigints, `Uint8Array`s, `Map`s). Every check below has passed.
  - **Checks:** `version === 4`; payload `network` equals the header `network`; `keyPackage.identifier === partyId + 1`; `keyPackage.untweakedVerifyingKey`, `publicKeyPackage.untweakedVerifyingKey` and `internalKey` are equal; `keyPackage.verifyingKey === publicKeyPackage.verifyingKey`; `keyPackage.verifyingShare === publicKeyPackage.verifyingShares[identifier]` (tweaked and untweaked); `G·signingShare === verifyingShare` and `G·untweakedSigningShare === untweakedVerifyingShare`; `minSigners === threshold`; share count `=== parties`.
  - **Throws:** the decryption error on a wrong password (GCM failure); `Error('Unsupported share file version')`; `Error('Share file is corrupted')` on any failed check.
- `assertShareMatchesVault(share: DecryptedShare, network: NetworkName, vault?: VaultKey): void`
  - **Post:** Returns when `share.network === network` and, if `vault` is given, `vault.untweakedVerifyingKey === share.internalKey`.
  - **Throws:** `Error('This share file belongs to a different vault')`.
- `interface DecryptedShare`, `interface ShareFile` — types above.

**Invariants:** Byte-compatible with web Ötzi in both directions. `shareFileName` / `downloadShareFile` are browser helpers headless never calls.

**Cross-component contracts:** `src/daemon/vault-share.ts` (load, stage), `src/daemon/config-merge.ts` (via `loadVaultShare`).

---

### `bitcoin.ts`
**Purpose:** Vault address and analysis of send proposals; every signer runs `analyzeProposal` on what it is asked to sign (Ötzi §1, §8).

**Public surface consumed by headless:**
- `vaultPayment(vault: VaultKey, network: NetworkName): VaultPayment`
  - **Post:** Key-path-only P2TR for `vault.untweakedVerifyingKey`: `{ address, script, outputKey }`. `address` = `p2tr(xOnly(untweakedVerifyingKey), network)` (BIP341 tweak, empty script tree); `script` = `OP_1 <outputKey>`; `outputKey` = 32-byte x-only output key, equal to `xOnly(vault.verifyingKey)`.
- `analyzeProposal(proposal: SendProposal, vault: VaultKey, network: NetworkName): ProposalAnalysis`
  - **Pre:** `vault` is the `publicKeyPackage` from the caller's own share file (`toVaultKey(share.publicKeyPackage)`).
  - **Post:** Returns `{ txid, inputs: Array<{txid, vout, amount}>, outputs: Array<{ address, amount, isChange }>, totalIn, totalOut, fee, vsize, feeRate, sighashes }`. `isChange` ⇔ the output script equals the vault output script. `fee = totalIn − totalOut`. `vsize` assumes one 64-byte key-path signature per input. `feeRate = fee / vsize` (fractional). `sighashes[i] = { index: i, hash: <32-byte hex>, type: 'key-path' }`, the BIP341 `SIGHASH_DEFAULT` hash of input `i` over all prevout scripts and amounts.
  - **Throws (rejects):** `proposal.network !== network`; `tx` not a string or `prevouts` not an array; no inputs; input count ≠ prevout count; `lockTime ≠ 0`; malformed prevout (`txid` not 64 lowercase hex, `vout` / `amount` not safe non-negative integers); input `i` does not spend `prevouts[i]`; any input sequence ≠ `0xfffffffd`; any prevout script ≠ the vault output script; any output without a standard address encoding; no outputs; `fee < 0`. A malformed `tx` hex throws from the decoder.
  - **Guarantee:** BIP341 sighashes commit to every input amount and script, so false prevout data yields signatures that are invalid on chain; the analysed fee is the fee of any transaction these signatures can authorize.
- `interface ProposalAnalysis`, `interface ProposalOutput` — shapes above.
- `explorerTxUrl(chainApiUrl: string, txid: string): string`
  - **Post:** Chain API URL with a trailing `/api` removed, then `/tx/<txid>`.
- `isValidAddress(address, network): boolean`, `scriptAddress(script, network): string | null` — address helpers.

**Notes / gotchas:**
- Output addresses come from `@scure/btc-signer`'s encoder: segwit and taproot addresses are lowercase bech32/bech32m. Allowlists compare exact strings against these.
- `parseAmountSats`, `formatBtc`, `explorerAddressUrl`, `vaultParties`, `vaultPaymentFromInternalKey` exist; headless uses its own `src/cli/units.ts` for CLI amounts.

**Cross-component contracts:** `src/orchestrator/orchestrator.ts` and `src/daemon/leader.ts` (`analyzeProposal`, `vaultPayment`), `src/orchestrator/spec-builder.ts` (`ProposalAnalysis`), `src/cli/cmd/btc.ts` (`analyzeProposal`, `explorerTxUrl`), `src/daemon/vault-pubkey.ts` (`vaultPayment`).

---

### `address-book.ts`
**Purpose:** Address-book `.otzi.json` files: validate, parse, merge, export (Ötzi §15).

```ts
interface AddressBookFile {
  kind: 'otzi-address-book';
  version: 1;
  network: NetworkName;
  entries: AddressBookEntry[];
}
```
Limits: `MAX_ENTRIES = 1000`, `MAX_LABEL = 64`, `MAX_NOTE = 256`.

**Public surface consumed by headless:**
- `validateEntries(input: unknown, network: NetworkName): AddressBookEntry[]`
  - **Post:** Returns normalized entries: labels and notes trimmed, empty notes dropped, every address valid for `network`, addresses unique, at most 1000 entries.
  - **Throws:** `Error('entries must be an array')`, `Error('At most 1000 entries')`, or `Error('Entry <n>: <reason>')` for the first invalid entry (1-based).
- `parseAddressBookFile(json: unknown, network: NetworkName): AddressBookEntry[]`
  - **Post:** Returns the entries when `kind`, `version` and `network` match and every entry passes `validateEntries`.
  - **Throws:** Error naming the problem — not an address book file, wrong kind, unsupported version, network mismatch (`'Address book is for <x>, this vault is on <network>'`), or the first invalid entry.
- `mergeAddressBooks(current, incoming): { entries, added, updated, unchanged }`
  - **Post:** Entries keyed by address. Incoming entries replace the label and note of existing ones; existing addresses absent from `incoming` are kept in their original order; new addresses are appended. Counts describe the effect.
- `addressBookFile(entries, network): AddressBookFile`
  - **Post:** `{ kind: 'otzi-address-book', version: 1, network, entries }`.
- `labelFor(entries, address): string | undefined`
  - **Post:** Label of the entry whose address equals `address` exactly, if any.

**Cross-component contracts:** `src/address-book/store.ts` (`validateEntries`, `parseAddressBookFile`, `addressBookFile`), `src/cli/cmd/book.ts` (`mergeAddressBooks`, `parseAddressBookFile`), `src/orchestrator/orchestrator.ts` and `src/daemon/leader.ts` (`labelFor`, passed to `buildSigningSpec`).

---

### `dkg.fixture.ts` (test only)
**Purpose:** Run a complete FROST DKG in-process through the blob codecs.

- `runDkg(t: number, n: number): { sessionId, keyPackages, publicKeyPackages }`
  - **Pre:** `2 ≤ t ≤ n ≤ 255`.
  - **Post:** One key package and one public key package per party (index = partyId), all for the same group key.
- `rng` — WebCrypto-backed frots `Rng`.

**Cross-component contracts:** Headless tests (`src/core/*.test.ts`, `src/testing/proposal.ts`). Never imported by runtime code.

---

## src/otzi/backend/

### `types.ts`
**Purpose:** Backend copies of the shared types.

- `NETWORK_NAMES: readonly NetworkName[] = ['mainnet', 'testnet4', 'signet']`; `NetworkName`, `VaultKey`, `AddressBookEntry` (same shapes as `lib/vault-types.ts`).
- **Cross-component contracts:** Re-exported by `src/config/types.ts` (`NETWORK_NAMES`, `NetworkName`).

---

### `bitcoin.ts`
**Purpose:** Transaction building and finalizing for the vault (Ötzi §13 internals).

**Public surface consumed by headless:**
- `buildSend(params: { utxos: Utxo[]; vault: VaultKey; network: NetworkName; to: string; amount: bigint | 'max'; feeRate: number }): PreparedSend`
  - **Pre:** `utxos` are vault outputs (`{ txid, vout, value }`); `feeRate` in sat/vB.
  - **Post:** Returns `{ tx, prevouts, amount, fee, change, vsize }`: `tx` is an unsigned version-2 transaction hex (lockTime 0, every input sequence `0xfffffffd`) with the destination output first and, when change ≥ 330 sats, a change output paying the vault script; `prevouts` carries the vault script for every selected input. UTXOs are selected largest first. `'max'` spends every UTXO with no change. Change below 330 sats goes to the fee. `{ network, tx, prevouts }` is a `SendProposal` that `analyzeProposal` accepts for the same vault.
  - **Throws:** `InsufficientFundsError(available, needed)` when the UTXOs cannot cover amount + fee (or a `'max'` send would be below 546 sats); an address-decode error for an invalid `to`.
  - **Note:** No input-count limit. The CLI refuses more than 255 prevouts before contacting the daemon.
- `finalizeSend(txHex: string, prevouts: Prevout[], signatures: Array<{ index: number; signature: string }>, outputKey: Uint8Array): { hex: string; txid: string }`
  - **Pre:** One 64-byte hex signature per input; `outputKey` is the 32-byte x-only vault output key.
  - **Post:** Every signature verifies under BIP340 against its input's sighash and `outputKey`; signatures are placed as key-path witnesses; returns the signed transaction hex and its txid.
  - **Throws:** signature count mismatch; invalid, duplicate or out-of-range index; signature not 128 hex characters; `Error('BIP340 verification failed for input <i>')`.
- `interface Utxo`, `interface Prevout`, `interface PreparedSend`, `class InsufficientFundsError` — shapes above.

**Notes:** `validateVaultKey`, `sameVaultKey`, `computeSighashes`, `estimateVsize`, `outputScript`, `xOnly` are present; headless may use them but does not depend on them in contracts.

**Cross-component contracts:** `src/daemon/leader.ts` (`finalizeSend`), `src/cli/cmd/btc.ts` (`buildSend`).

---

### `esplora.ts`
**Purpose:** Esplora chain client (Ötzi §11). Used by the CLI only; the daemon never imports it.

**Default endpoints:**

| Network | Chain API URL |
|---|---|
| `mainnet` | `https://mempool.space/api` |
| `testnet4` | `https://mempool.space/testnet4/api` |
| `signet` | `https://mempool.space/signet/api` |

**Public surface consumed by headless:**
- `chainApiUrl(config: { network: NetworkName; esploraUrl?: string }): string`
  - **Post:** `esploraUrl` when set (non-empty), otherwise the network default.
- `getUtxos(base, address): Promise<Array<{ txid, vout, value, confirmed }>>` — `GET {base}/address/{address}/utxo`.
- `getBalance(base, address): Promise<{ confirmed, unconfirmed }>` — `GET {base}/address/{address}`; sats, `confirmed = chain funded − chain spent`, `unconfirmed = mempool funded − mempool spent`.
- `broadcastTx(base, hex): Promise<string>` — `POST {base}/tx` (text/plain); returns the txid. Throws with the API's error text on rejection.
- `getFeeRates(base): Promise<{ low, normal, high }>` — `GET {base}/v1/fees/recommended` (`hourFee` / `halfHourFee` / `fastestFee`), falling back to `GET {base}/fee-estimates` (6 / 3 / 1 blocks). sat/vB. Cached per base URL for 60 s.
- **Errors:** every request has a 15 s timeout; a non-2xx response throws `Error('<status> <body>')` (body trimmed to 300 characters).

**Cross-component contracts:** `src/cli/cmd/btc.ts`, `src/testing/mock-esplora.ts` (serves the same four endpoints).

---

### `btc-message.ts`
**Purpose:** Bitcoin message signature verification (Ötzi §16 internals).

**Public surface consumed by headless:**
- `verifyBitcoinMessage(address: string, message: string, signature: string): boolean`
  - **Pre:** `signature` is base64.
  - **Post:** `true` iff `signature` is a valid signature of `message` by `address`: BIP-322 "simple" (P2WPKH, P2TR key-path) or legacy signmessage / BIP-137 (P2PKH, P2SH-P2WPKH, P2WPKH). Accepts mainnet and test-network addresses.
  - **Throws:** Never.

**Cross-component contracts:** `examples/gate-web-btc-message/` (approver decisions). Not used by the daemon.

---

### `test-vault.fixture.ts` (test only)
- `makeTestVault(threshold, parties): { vault: VaultKey; tweakedSecret: Uint8Array }` — dealer-generated vault key whose tweaked group secret is known. Used by the lifted backend tests.
