# Contracts: src/wire/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/wire/

> **Lifted from `~/projects/otzi/src/lib/`. DO NOT EDIT — byte-compatibility with Ötzi is a hard contract. New sibling files are fine; existing files are read-only here.**

### `crypto.ts`
**Purpose:** AES-256-GCM encryption/decryption for PERMAFROST share files using Web Crypto API.

**Public surface:**
- `encrypt(data: Uint8Array, password: string): Promise<string>`
  - **Pre:** `data` is plaintext bytes; `password` is UTF-8 string.
  - **Post:** Returns base64-encoded result: `salt(16B) ‖ iv(12B) ‖ ciphertext`. PBKDF2: 600k iterations, SHA-256. AES-256-GCM per Web Crypto spec.
  - **Throws:** Never (encryption is deterministic given random salt/IV).

- `decrypt(encoded: string, password: string): Promise<Uint8Array>`
  - **Pre:** `encoded` is base64 string from `encrypt()`; `password` must match.
  - **Post:** Returns original plaintext bytes.
  - **Throws:** On wrong password (GCM auth failure), corrupted data, or base64 decode error.

**Byte-format / wire contract:**
- Ciphertext layout: `salt(16B) ‖ iv(12B) ‖ ciphertext_bytes` (no explicit auth tag appended; GCM includes tag in ciphertext per Web Crypto).
- PBKDF2: 600,000 iterations, SHA-256 hash, salt length 16 bytes, derived key 32 bytes.

**Invariants:**
- Byte-equal to Ötzi `src/lib/crypto.ts`.
- Random salt/IV per encryption ensures non-deterministic output.

**Cross-component contracts:**
- Used by: `share-crypto.ts` (decrypt), `share-write.ts` (encrypt)
- Depends on: Web Crypto API only.

**Notes / gotchas:**
- Browser-only (no Node.js crypto module). Daemon has separate Node.js version in `src/node/encryption.ts`.
- Web Crypto GCM does NOT append auth tag separately; tag is embedded in ciphertext.

---

### `dkg.ts`
**Purpose:** DKG blob encoding/decoding and ceremony helpers. Envelope format: base64-encoded JSON. Phase 1–4 + FROST Round 1–2 codecs.

**Public surface:**
- `encodeEnvelope(type: BlobType, from: number, to: number, sid: Uint8Array, data: Uint8Array): string`
  - **Pre:** `type` ∈ `{'session', 'p1', 'p2pub', 'p2priv', 'p3priv', 'p4', 'frost-r1', 'frost-r2', 'frost-sign-r1', 'frost-sign-r2'}`; `from`, `to` are party IDs (to = -1 for broadcast); `sid` is session ID bytes; `data` is payload.
  - **Post:** Returns base64(`{v: 2, type, from, to, sid: first 16 hex chars, data: toHex(data)}`).

- `decodeEnvelope(blob: string): DKGBlobEnvelope | null`
  - **Pre:** `blob` is base64 JSON.
  - **Post:** Parses and validates `v === 2`; returns envelope or null on parse/version error.

- `encodePhase1Broadcast(broadcast: DKGPhase1Broadcast, sessionId: Uint8Array): string`
  - **Pre:** broadcast has `partyId`, `rhoCommitment` (32B), `bitmaskCommitments` Map.
  - **Post:** Payload layout: `1B partyId ‖ 32B rhoCommitment ‖ [per bitmask: 2B LE ‖ 32B commitment]`. Returns base64 envelope.

- `decodePhase1Broadcast(blob: string): DKGPhase1Broadcast | null`
  - **Pre:** `blob` is phase-1 envelope.
  - **Post:** Reconstructs `DKGPhase1Broadcast` with `partyId`, `rhoCommitment`, `bitmaskCommitments` Map.

- `encodePhase2Broadcast(broadcast: DKGPhase2Broadcast, sessionId: Uint8Array): string`
  - **Pre:** broadcast has `partyId`, `rho` (32B).
  - **Post:** Payload: `1B partyId ‖ 32B rho`. Returns base64 envelope.

- `decodePhase2Broadcast(blob: string): DKGPhase2Broadcast | null`
  - **Pre:** phase-2 envelope.
  - **Post:** Reconstructs `{partyId, rho}`.

- `encodePhase2Private(priv: DKGPhase2Private, targetPartyId: number, sessionId: Uint8Array): string`
  - **Pre:** `priv` has `fromPartyId`, `bitmaskReveals` Map.
  - **Post:** Payload: `1B fromPartyId ‖ [per bitmask: 2B LE ‖ 32B reveal]`. Returns base64 envelope with `to=targetPartyId`.

- `decodePhase2Private(blob: string): DKGPhase2Private | null`
  - **Pre:** phase-2 private envelope.
  - **Post:** Reconstructs `{fromPartyId, bitmaskReveals}`.

- `encodePhase3Private(priv: DKGPhase3Private, targetPartyId: number, sessionId: Uint8Array): string`
  - **Pre:** `priv` has `fromGeneratorId`, `maskPieces` Map of (bitmask → `Int32Array[]`). Each poly has 256 coefficients in [0, Q) where Q = 8380417.
  - **Post:** Payload: `1B fromGeneratorId ‖ [per bitmask: 2B LE ‖ 1B numPolys ‖ per poly: 256×4B int32 LE] ‖ 32B SHA-256 checksum`. Returns base64 envelope.
  - **Throws:** Never during encoding (validation is on decode).

- `decodePhase3Private(blob: string): DKGPhase3Private | null`
  - **Pre:** phase-3 private envelope.
  - **Post:** Verifies SHA-256 checksum; validates each coefficient ∈ [0, Q). Returns reconstructed object or null on integrity/validation failure.

- `encodePhase4Broadcast(broadcast: DKGPhase4Broadcast, sessionId: Uint8Array): string`
  - **Pre:** broadcast has `partyId`, `aggregate` array of `Int32Array` (each 256 coefficients).
  - **Post:** Payload: `1B partyId ‖ 1B numPolys ‖ [per poly: 256×4B int32 LE] ‖ 32B SHA-256 checksum`. Returns base64 envelope.

- `decodePhase4Broadcast(blob: string): DKGPhase4Broadcast | null`
  - **Pre:** phase-4 broadcast envelope.
  - **Post:** Verifies SHA-256 checksum; returns reconstructed object or null.

- `encodeFrostRound1(pkg: FrostRound1Package, sessionId: Uint8Array): string`
  - **Pre:** pkg has `identifier` (FROST ID, bigint), `commitment` array of 33B SEC1 points, `proofOfKnowledge {R: 33B SEC1, z: bigint}`.
  - **Post:** Payload: `1B partyId ‖ 1B numCommitments ‖ [per commitment: 33B ‖ ...] ‖ 33B R ‖ 32B z (BE)`. Returns base64 envelope.

- `decodeFrostRound1(blob: string): FrostRound1Package | null`
  - **Pre:** FROST round-1 envelope.
  - **Post:** Reconstructs package with `identifier` (from partyId + 1), commitment points, proof.

- `encodeFrostRound2(pkg: FrostRound2Package, sessionId: Uint8Array): string`
  - **Pre:** pkg has `sender`, `recipient` (FROST IDs, bigint), `signingShare` (bigint).
  - **Post:** Payload: `1B senderPartyId ‖ 1B recipientPartyId ‖ 32B signingShare (BE)`. Returns base64 envelope with `to=recipientPartyId`.

- `decodeFrostRound2(blob: string): FrostRound2Package | null`
  - **Pre:** FROST round-2 envelope.
  - **Post:** Reconstructs package.

- `identifyBlob(blob: string): BlobInfo | null`
  - **Pre:** Any blob string.
  - **Post:** Returns `{type, from, to, sid}` or null if blob is not decodable.

- `createDKGInstance(level: number, t: number, n: number): ThresholdMLDSA`
  - **Pre:** `level` ∈ {44, 65, 87, 128, 192, 256}; `1 <= t <= n`.
  - **Post:** Returns `ThresholdMLDSA` instance.

- `generateSessionId(): Uint8Array`
  - **Post:** 32-byte random session ID.

- `getSessionIdPrefix(sessionId: Uint8Array): string`
  - **Post:** First 16 hex characters of session ID.

- `partyIdToFrostId(partyId: number): bigint`
  - **Pre:** `0 <= partyId < 256`.
  - **Post:** Returns `BigInt(partyId + 1)` (FROST IDs are 1-indexed).

- `frostIdToPartyId(id: bigint): number`
  - **Pre:** `id >= 1n`.
  - **Post:** Returns `Number(id) - 1` (0-indexed).

- `getKL(level: number): {K: number, L: number}`
  - **Pre:** `level` ∈ {44, 65, 87, 128, 192, 256}.
  - **Post:** Returns `{K, L}` parameters for ML-DSA:
    - 44/128 → {K: 4, L: 4}
    - 65/192 → {K: 6, L: 5}
    - 87/256 → {K: 8, L: 7}
  - **Throws:** Unknown level.

**Byte-format / wire contract:**
- Blob envelope (base64 JSON): `{v: 2, type: BlobType, from: number, to: number, sid: string (16 hex chars), data: string (hex)}`.
- Phase-1 broadcast: `1B partyId, 32B rhoCommitment, [per bitmask: 2B LE bitmask, 32B commitment]`.
- Phase-2 broadcast: `1B partyId, 32B rho`.
- Phase-2 private: `1B fromPartyId, [per bitmask: 2B LE, 32B reveal]`.
- Phase-3 private: `1B fromGeneratorId, [per bitmask: 2B LE, 1B numPolys, per poly: 256×4B int32 LE], 32B SHA-256 checksum`.
- Phase-4 broadcast: `1B partyId, 1B numPolys, per poly: 256×4B int32 LE, 32B SHA-256 checksum`.
- FROST round-1: `1B partyId, 1B numCommitments, [per commitment: 33B], 33B R, 32B z (BE)`.
- FROST round-2: `1B senderPartyId, 1B recipientPartyId, 32B signingShare (BE)`.

**Invariants:**
- Byte-equal to Ötzi `src/lib/dkg.ts`.
- Phase-3 and Phase-4 checksums are **mandatory** for integrity verification on decode.
- Bitmask field uses little-endian encoding (LE) consistently.
- Polynomial coefficients must be in [0, Q) where Q = 8380417.

**Cross-component contracts:**
- Re-exports: `ThresholdMLDSA`, DKG phase types.
- Used by: `threshold.ts` (signing session creation), `share-crypto.ts` (FROST ID conversion).

**Notes / gotchas:**
- Phase-3/4 **checksums are required for byte-stability**; Ötzi and headless must compute identical hashes.
- Blob type string is the authoritative routing key for `identifyBlob()`.
- Integer conversion: partyId is 0-indexed in protocol; FROST IDs are 1-indexed (add/subtract 1 on conversion).

---

### `frost-reconstruct.ts`
**Purpose:** Build a `PublicKeyPackage` from a persisted per-party `KeyPackage`. Provides empty-map semantics for `verifyingShares`.

**Public surface:**
- `buildFrostPublicKeyPackage(kp: FrostKeyPackage): PublicKeyPackage`
  - **Pre:** `kp` is a `KeyPackage` with `verifyingKey`, `untweakedVerifyingKey`, `minSigners`.
  - **Post:** Returns `PublicKeyPackage` with:
    - `verifyingKey` = kp.verifyingKey (33B SEC1 post-tweak)
    - `untweakedVerifyingKey` = kp.untweakedVerifyingKey (33B SEC1)
    - `minSigners` = kp.minSigners
    - `verifyingShares` = empty Map
    - `untweakedVerifyingShares` = empty Map
  - **Throws:** Never.

**Byte-format / wire contract:**
- None; output is in-memory `PublicKeyPackage` object.

**Invariants:**
- Empty-map semantics match Ötzi's pattern (`DKGWizard.tsx:1155`, `FrostSign.tsx:165`).
- `verifyingShares` is documented unused on happy path in frots `sign.ts:690` — only cheater-detection uses it.
- Matches Ötzi backend behavior (aggregation failure yields empty culprits list, acceptable because transport layer provides authenticated `from`).

**Cross-component contracts:**
- Used by: FROST signing flow (after `serializeCombinedV3` reconstruction).
- Depends on: `@mwaddip/frots` KeyPackage interface.

**Notes / gotchas:**
- Per-party persisted share carries ONLY that party's `KeyPackage`, not peers' verifying shares.
- Re-deriving peer shares would require group commitment polynomial (not persisted).
- Cheater identification on aggregation failure is still possible via transport-layer `from` field; empty map is acceptable.

---

### `frost-sign.ts`
**Purpose:** FROST signing blob codec. Encodes/decodes SigningCommitments (R1) and SignatureShares (R2).

**Public surface:**
- `encodeFrostSignR1(partyId: number, commitments: readonly SigningCommitment[], sessionId: Uint8Array): string`
  - **Pre:** `commitments` array of `{identifier: number, hiding: 33B SEC1, binding: 33B SEC1}`.
  - **Post:** Payload: `1B partyId ‖ 1B count ‖ [per commitment: 2B identifier LE ‖ 33B hiding ‖ 33B binding]`. Returns base64 envelope.

- `decodeFrostSignR1(blob: string): {partyId: number, commitments: SigningCommitment[]} | null`
  - **Pre:** frost-sign-r1 envelope.
  - **Post:** Reconstructs commitments array.

- `encodeFrostSignR2(partyId: number, shares: readonly SignatureShare[], sessionId: Uint8Array): string`
  - **Pre:** `shares` array of `{identifier: number, share: bigint}`.
  - **Post:** Payload: `1B partyId ‖ 1B count ‖ [per share: 2B identifier LE ‖ 32B share BE]`. Returns base64 envelope.

- `decodeFrostSignR2(blob: string): {partyId: number, shares: SignatureShare[]} | null`
  - **Pre:** frost-sign-r2 envelope.
  - **Post:** Reconstructs shares array.

**Byte-format / wire contract:**
- FROST sign R1: `1B partyId, 1B count, [per commitment: 2B LE identifier, 33B hiding, 33B binding]`.
- FROST sign R2: `1B partyId, 1B count, [per share: 2B LE identifier, 32B share BE]`.

**Invariants:**
- Byte-equal to Ötzi signing codec.
- Identifier field is little-endian 16-bit (partyId bitmask in sighash stream).

**Cross-component contracts:**
- Uses: `encodeEnvelope`/`decodeEnvelope` from `dkg.ts`.
- Used by: FROST signing protocol layers.

**Notes / gotchas:**
- Commitment count and share count are 1B each (max 255 signers, sufficient for threshold schemes).

---

### `hex.ts`
**Purpose:** Hex encoding/decoding helpers.

**Public surface:**
- `toHex(bytes: Uint8Array): string`
  - **Pre:** Any bytes.
  - **Post:** Lowercase hex string (2 chars per byte, zero-padded).

- `fromHex(hex: string): Uint8Array`
  - **Pre:** Even-length hex string.
  - **Post:** Decoded bytes.
  - **Throws:** On invalid hex character (parseInt base 16).

- `uint8ToBase64(bytes: Uint8Array): string`
  - **Pre:** Any bytes.
  - **Post:** Base64-encoded string (binary→charCode→btoa pipeline).

**Byte-format / wire contract:**
- None; pure transformation.

**Invariants:**
- Hex is lowercase and zero-padded (canonical).

**Notes / gotchas:**
- No input length validation; relies on caller to check.
- `fromHex` requires even-length input (if odd, slicing `i * 2 + 2` may read past end → undefined behavior).

---

### `manifest.ts`
**Purpose:** Manifest validation, ABI resolution, condition evaluation, and formatting helpers.

**Public surface:**
- `validateManifest(data: unknown): {valid: true, manifest: ProjectManifest} | {valid: false, error: string}`
  - **Pre:** Any JSON data.
  - **Post:** Validates schema: `version === 1`, name (non-empty string), contracts (object), operations (array with required fields).
  - **Throws:** Never; returns error object.

- `resolveAbi(abi: unknown[] | string): unknown[]`
  - **Pre:** ABI can be array of objects OR string shorthand (`'OP_20'`, `'OP_20S'`, `'OP_721'`).
  - **Post:** Flattens recursive ABI resolution. `'OP_20'` and `'OP_20S'` expand to standard method signatures; `'OP_721'` returns `[]`.
  - **Throws:** Never.

- `evaluateCondition(condition: ManifestCondition, reads: Record<string, unknown>, currentBlock?: number): boolean`
  - **Pre:** Condition object with logical/comparative operators; `reads` map from read keys to values.
  - **Post:** Recursively evaluates `and`, `or`, `not`, `blockWindow`, `eq`, `neq`, `gt`, `lt`.
  - **Throws:** Never; returns boolean.

- `formatReadValue(value: unknown, format?: ManifestRead['format'], map?: Record<string, string>): string`
  - **Pre:** Value (any), format type, optional enum map.
  - **Post:** Formats according to format spec: `'token8'` / `'btc8'` / `'price8'` divide by 100M with decimal point; `'percent8'` divide by 1M; `'address'` truncates to `0x...abcd`.
  - **Throws:** Never.

- `resolveParamValue(param: ManifestParam, config: ManifestConfig, reads: Record<string, unknown>): string | undefined`
  - **Pre:** param with optional `source` field (e.g., `'contract:key'`, `'setting:key'`, `'read:key'`).
  - **Post:** Resolves source and returns value or undefined.

- `encodeParamValue(value: string, param: ManifestParam): string`
  - **Pre:** param with optional `scale` field.
  - **Post:** If `param.type === 'uint256'` and `scale` is defined, multiplies value by scale; otherwise returns value as-is.

**Byte-format / wire contract:**
- None; these are data-processing helpers.

**Invariants:**
- Condition evaluation is boolean-complete; no short-circuit side effects.

**Cross-component contracts:**
- Used by: Frontend manifest UI (condition display, parameter encoding).

**Notes / gotchas:**
- Format `'percent8'` has 6 decimal places internally (not 8); division by 1M matches OPNet display convention.
- `'address'` truncation rule: show first 10 chars + `...` + last 6 if longer than 16.

---

### `manifest-types.ts`
**Purpose:** TypeScript interface definitions for manifest schema, read operations, and configuration.

**Public surface:**
- `ProjectManifest` interface
  - `version: number` (expected 1)
  - `name: string` (non-empty)
  - `description?: string`
  - `icon?: string`
  - `theme?: ManifestTheme` (dark/light color overrides)
  - `contracts: Record<string, ManifestContract>`
  - `reads?: Record<string, ManifestRead>`
  - `status?: ManifestStatusEntry[]`
  - `operations: ManifestOperation[]`

- `ManifestCondition` type union
  - `{read: string, eq: number | string | boolean}`
  - `{read: string, neq: ...}` / `{read: string, gt: number}` / `{read: string, lt: number}`
  - `{blockWindow: {read: string, minBlocks?: number, maxBlocks?: number}}`
  - `{and: ManifestCondition[]}` / `{or: ...}` / `{not: ...}` (recursive)

- `ManifestParam` interface
  - `name: string` (param name in transaction)
  - `type: 'uint256' | 'address' | 'bool' | 'bytes'`
  - `label?: string` (UI label)
  - `scale?: number` (multiply before encoding)
  - `placeholder?: string`
  - `source?: string` (resolution hint: `'contract:key'` / `'setting:key'` / `'read:key'`)
  - `options?: {count: {contract, method}, item: {contract, method}}` (dynamic list)

- `ManifestRead` interface
  - `contract: string` (contract key)
  - `method: string` (method name)
  - `params?: ManifestReadParam[]` (optional parameters)
  - `returns: 'uint8' | 'uint256' | 'address' | 'bool' | 'string'`
  - `format?: 'raw' | 'token8' | 'btc8' | 'percent8' | 'price8' | 'address'`

- `ManifestConfig` interface
  - `manifest: ProjectManifest`
  - `addresses: Record<string, string>` (contract address map)
  - `settings?: Record<string, string>` (per-vault settings)

**Byte-format / wire contract:**
- JSON schema; no binary encoding.

**Invariants:**
- Version field is required and expected to be 1.
- `type` in params must align with encoding rules in `manifest.ts::encodeParamValue`.

**Notes / gotchas:**
- Legacy flat theme fields (`accent`, `accentHover`, `bg`, `radius`) are treated as dark-mode values if nested dark/light colors not provided.
- `ManifestReadParam.source` is a colon-separated string; parsing is done by `manifest.ts::resolveParamValue`.

---

### `op20-methods.ts`
**Purpose:** Standard OP-20 contract method definitions for the signing page.

**Public surface:**
- `OP20_METHODS: MethodDef[]`
  - **Post:** Array of 8 standard OP-20 methods:
    1. `transfer(to: address, amount: u256)`
    2. `transferFrom(from: address, to: address, amount: u256)`
    3. `safeTransfer(to: address, amount: u256, data: bytes)`
    4. `safeTransferFrom(from: address, to: address, amount: u256, data: bytes)`
    5. `increaseAllowance(spender: address, amount: u256)`
    6. `decreaseAllowance(spender: address, amount: u256)`
    7. `burn(amount: u256)`
    8. `mint(address: address, amount: u256)`

Each method has:
- `name: string` (method identifier)
- `label: string` (UI display label)
- `params: MethodParam[]` (with name, type, optional placeholder)

**Byte-format / wire contract:**
- JSON schema; no binary encoding.

**Invariants:**
- Matches IOP20Contract interface from opnet SDK.
- Method signatures are fixed (no variadic overloads).

**Cross-component contracts:**
- Used by: `manifest.ts::resolveAbi` to expand `'OP_20'` shorthand.

**Notes / gotchas:**
- `u256` type is converted to `'uint256'` in ABI shorthand expansion.
- Placeholder text provides user guidance (e.g., "0x... or opt1..." for address fields, "Amount (smallest unit)" for u256).

---

### `relay-crypto.ts`
**Purpose:** E2E encryption for the relay using ECDH (P-256) + HKDF + AES-256-GCM. All Web Crypto API.

**Public surface:**
- `generateECDHKeyPair(): Promise<CryptoKeyPair>`
  - **Post:** P-256 keypair (private key not extractable).

- `exportPublicKey(key: CryptoKey): Promise<Uint8Array>`
  - **Post:** 65-byte uncompressed P-256 public key.

- `importPublicKey(raw: Uint8Array): Promise<CryptoKey>`
  - **Pre:** 65-byte uncompressed P-256 public key.
  - **Post:** CryptoKey for ECDH.

- `deriveAESKey(myPrivateKey: CryptoKey, theirPublicKey: CryptoKey, sessionCode: string): Promise<CryptoKey>`
  - **Pre:** Two ECDH keys; session code is ASCII string.
  - **Post:** AES-256-GCM key derived via:
    1. ECDH → shared secret (256 bits)
    2. HKDF-SHA256 with salt = `TextEncoder(sessionCode)`, info = `"permafrost-relay-v1"`
    3. AES-256-GCM key (256-bit)

- `encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array>`
  - **Post:** Returns `iv(12B) ‖ ciphertext`.

- `decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array>`
  - **Pre:** `data` is `iv(12B) ‖ ciphertext` from `encrypt()`.
  - **Post:** Plaintext.
  - **Throws:** On GCM auth failure.

- `sessionFingerprint(pubkeys: Map<number, Uint8Array>): Promise<string>`
  - **Pre:** Map of partyId → 65B uncompressed P-256 public key (sorted by partyId).
  - **Post:** First 8 hex chars of SHA-256(concatenated sorted pubkeys).

- `toBase64(bytes: Uint8Array): string`
  - **Post:** Base64 string (binary→charCode→btoa).

- `fromBase64(b64: string): Uint8Array`
  - **Post:** Decoded bytes.

**Byte-format / wire contract:**
- Encrypted relay message: `iv(12B) ‖ ciphertext`.
- ECDH: standard P-256 NIST curve, uncompressed format (65 bytes).
- HKDF: SHA-256, salt = ASCII-encoded session code, info = "permafrost-relay-v1" (18 bytes).

**Invariants:**
- Session fingerprint is deterministic given a fixed set of pubkeys (same ordering).
- ECDH keys are ephemeral per relay session (not persisted).

**Cross-component contracts:**
- Depends on: Web Crypto API.
- Used by: Relay coordination layer.

**Notes / gotchas:**
- P-256 uncompressed is 65 bytes (0x04 prefix + 32B X + 32B Y), NOT compressed SEC1 format.
- Session fingerprint is only 8 hex chars (4 bytes displayed), useful for human verification only.

---

### `serialize.ts`
**Purpose:** Binary serialization for ThresholdKeyShare, FrostKeyPackage, and combined V3 blob. Handles polynomial packing (23-bit coefficients) and envelope layout.

**Public surface:**
- `serializeKeyShare(share: ThresholdKeyShare, K: number, L: number): Uint8Array`
  - **Pre:** `share.id` (partyId, 0–255), `rho`, `key`, `tr` (32B each), `shares` Map of (bitmask → `SecretShare`). Each `SecretShare` has `s1`, `s2`, `s1Hat`, `s2Hat` (array of `Int32Array`, L and K polynomials respectively). Each polynomial has 256 coefficients ∈ [0, Q).
  - **Post:** Serialized blob: `1B version(0x02) ‖ 1B partyId ‖ 1B K ‖ 1B L ‖ 32B rho ‖ 32B key ‖ 64B tr ‖ 2B numShares LE ‖ [per share: 2B bitmask LE ‖ L×736B s1 ‖ K×736B s2 ‖ L×736B s1Hat ‖ K×736B s2Hat]`.
  - **Throws:** Never (assumes valid input).

- `deserializeKeyShare(bytes: Uint8Array): {share: ThresholdKeyShare, K: number, L: number}`
  - **Pre:** Serialized blob from `serializeKeyShare()`.
  - **Post:** Reconstructed share and parameters.
  - **Throws:** On version mismatch.

- `serializeFrostKeyPackage(kp: FrostKeyPackage): Uint8Array`
  - **Pre:** `kp` with `signingShare` (bigint), `verifyingShare` (33B SEC1), `verifyingKey` (33B SEC1), `minSigners` (1B), `untweakedVerifyingKey` (33B SEC1), `untweakedSigningShare` (bigint), `untweakedVerifyingShare` (33B SEC1).
  - **Post:** Serialized blob: `32B signingShare BE ‖ 33B verifyingShare ‖ 33B verifyingKey ‖ 1B minSigners ‖ 33B untweakedVerifyingKey ‖ 32B untweakedSigningShare BE ‖ 33B untweakedVerifyingShare` (197 bytes total).

- `deserializeFrostKeyPackage(data: Uint8Array, identifier: bigint): FrostKeyPackage`
  - **Pre:** 197-byte serialized blob; `identifier` is 1-indexed FROST participant ID.
  - **Post:** Reconstructed `FrostKeyPackage`.

- `serializeCombinedV3(mldsaShare: ThresholdKeyShare, frostKP: FrostKeyPackage, K: number, L: number): Uint8Array`
  - **Pre:** Both shares.
  - **Post:** Serialized envelope: `1B version(0x03) ‖ 4B mldsaLen LE ‖ [mldsa serialized] ‖ [frost serialized]`.
  - **Throws:** Never.

- `deserializeCombinedV3(data: Uint8Array, frostIdentifier: bigint): {mldsaShare: ThresholdKeyShare, frostKeyPackage: FrostKeyPackage, K: number, L: number}`
  - **Pre:** Combined V3 blob.
  - **Post:** Reconstructed both shares.
  - **Throws:** On version mismatch.

**Byte-format / wire contract:**
- **ML-DSA KeyShare V2:** `1B version(0x02) ‖ 1B partyId ‖ 1B K ‖ 1B L ‖ 32B rho ‖ 32B key ‖ 64B tr ‖ 2B numShares LE ‖ [per share: 2B bitmask LE ‖ per-poly packed]`.
- **Polynomial packing:** 256 coefficients × 23-bit each (no gaps) = 736 bytes per polynomial. Bit-level packing with byte alignment at boundaries.
- **FROST KeyPackage:** 197 bytes exact layout (bigint BE, SEC1 points, minSigners as 1B).
- **Combined V3:** 1B version(0x03) + 4B length (LE) of MLDSA blob + MLDSA + FROST.

**Invariants:**
- Polynomial packing is canonical: Q = 8380417, fits in 23 bits (2^23 = 8388608 > Q).
- FROST keypackage size is exactly 197 bytes (fixed).
- Version 0x02 for ML-DSA standalone, 0x03 for combined (ML-DSA + FROST).

**Cross-component contracts:**
- Used by: `share-write.ts` (encryption), `share-crypto.ts` (decryption).
- Depends on: Input types from `@btc-vision/post-quantum` and `@mwaddip/frots`.

**Notes / gotchas:**
- **Lossy transformation:** `ChallengeSolution.toRaw()` returns 32B (post-tweak `legacyPublicKey`) instead of 33B SEC1 original. Handled at headless layer (`opnet-params-reconstruct.ts::serializeChallengeForWire`).
- Polynomial coefficient validation on unpack: if any coeff ≥ Q, decode fails with null (not raised as exception).
- MLDSA length field is 4B LE (supports up to 4GB, more than sufficient).

---

### `share-crypto.ts`
**Purpose:** PERMAFROST share file decryption and V2/V3 deserialization. Inverse operation to `share-write.ts`.

**Public surface:**
- `ShareFile` interface
  - `version: number` (2 or 3)
  - `publicKey: string` (ML-DSA pubkey, hex)
  - `partyId: number` (0–255)
  - `threshold: number` (t)
  - `parties: number` (n)
  - `level: number` (44, 65, or 87)
  - `encrypted: string` (base64 from `crypto.ts::encrypt`)

- `DecryptedShare` interface
  - `publicKey: string`, `partyId: number`, `threshold`, `parties`, `level` (same as ShareFile)
  - `shareBytes: Uint8Array` (raw deserialized bytes)
  - `keyShare: ThresholdKeyShare` (parsed ML-DSA share)
  - `K: number`, `L: number` (security parameters)
  - `frostKeyPackage?: FrostKeyPackage` (optional, v3 only)
  - `frostPublicKey?: string` (optional, v3 only, FROST aggregate key hex)

- `decryptShareFile(file: ShareFile & {frostPublicKey?: string}, password: string): Promise<DecryptedShare>`
  - **Pre:** `file` is JSON from disk (v2 or v3); `password` is UTF-8 string.
  - **Post:** Decrypts `file.encrypted` using `crypto.ts::decrypt()`, then deserializes:
    - v3: calls `deserializeCombinedV3()`, populates `frostKeyPackage` and `frostPublicKey`.
    - v2: calls `deserializeKeyShare()`, omits FROST fields.
  - **Throws:** On wrong password (GCM auth failure from `decrypt()`), invalid deserialized data.

**Byte-format / wire contract:**
- ShareFile is JSON on disk; `encrypted` field is base64 string.
- Decryption yields binary blob matching `serialize.ts` format.

**Invariants:**
- Version field determines deserialization path.
- `frostPublicKey` is optional field on input; must be present for v3 shares to reconstruct `FrostKeyPackage`.

**Cross-component contracts:**
- Uses: `crypto.ts::decrypt`, `serialize.ts::deserializeKeyShare` / `deserializeCombinedV3`, `dkg.ts::partyIdToFrostId`.
- Used by: Share loading in signing ceremony.

**Notes / gotchas:**
- v2 shares carry only ML-DSA key material; v3 adds FROST.
- Decryption can be slow on weak passwords (600k PBKDF2 iterations by design).

---

### `share-write.ts`
**Purpose:** PERMAFROST share file encryption and V3 serialization. Inverse of `share-crypto.ts`. Piggybacking of `frostLegacySig` outside typed contract is daemon-specific.

**Public surface:**
- `ShareFileV3` type
  - `ShareFile & {frostPublicKey: string}` (v3 shares require FROST pubkey)

- `encryptShareV3(mldsaShare: ThresholdKeyShare, frostKeyPackage: FrostKeyPackage, publicKeyHex: string, frostPublicKeyHex: string, threshold: number, parties: number, level: number, K: number, L: number, password: string): Promise<ShareFileV3>`
  - **Pre:** 
    - ML-DSA share and FROST keypackage (both validated)
    - Public keys as hex strings (1312B ML-DSA, variable-length FROST)
    - Threshold, party count, security level, K/L parameters
    - Password is UTF-8 string
  - **Post:** Returns `ShareFileV3` JSON object:
    ```json
    {
      "version": 3,
      "publicKey": publicKeyHex (ML-DSA),
      "frostPublicKey": frostPublicKeyHex,
      "partyId": mldsaShare.id,
      "threshold": number,
      "parties": number,
      "level": number,
      "encrypted": base64 string
    }
    ```
    The `encrypted` field contains `serialize.ts::serializeCombinedV3()` output, then `crypto.ts::encrypt()` with AES-256-GCM.
  - **Throws:** Never during encryption (randomized salt/IV).

**Byte-format / wire contract:**
- Output is JSON (not binary). `encrypted` field is base64 string.
- Serialization uses `serialize.ts::serializeCombinedV3()`, then `crypto.ts::encrypt()`.
- Daemon **piggybacking:** The V3 share file itself is standard Ötzi-compatible format. Daemon adds an **extra top-level field** `frostLegacySig` (64-byte hex, FROST Schnorr signature) to the JSON envelope **outside the typed ShareFileV3 contract**. This field is NOT part of the encrypted payload; it's set by the daemon at the headless layer (`opnet-params-reconstruct.ts`) and tolerated by Ötzi's decoder.

**Invariants:**
- Argument order mirrors Ötzi's `encryptShareV3` for source-level parity.
- Output is byte-compatible with Ötzi (excluding daemon-added `frostLegacySig` field).

**Cross-component contracts:**
- Uses: `serialize.ts::serializeCombinedV3`, `crypto.ts::encrypt`.
- Used by: DKG output persistence.

**Notes / gotchas:**
- Lives in sibling file to `share-crypto.ts` (both are halves of share lifecycle).
- Daemon-specific contract: `frostLegacySig` field is added AFTER `encryptShareV3()` returns, at the headless layer. Not part of the function's typed contract.
- Caller must write result to disk with file mode 0o600 (daemon responsibility).

---

### `threshold.ts`
**Purpose:** Threshold ML-DSA signing protocol with blob-exchange layer. Round 1–3 + combine flow.

**Public surface:**
- `SigningSession` interface (in-memory state)
  - `instance: ThresholdMLDSA` (ceremony instance)
  - `message: Uint8Array` (message to sign)
  - `msgPrefix: string` (first 16 hex chars, for validation)
  - `share: DecryptedShare` (local key material)
  - `activePartyIds: number[]` (participating signer list)
  - Round state fields (hashes, commitments, responses as Map<partyId, data>)
  - `signature: Uint8Array | null` (final signature)

- `createSession(message: Uint8Array, share: DecryptedShare, activePartyIds: number[]): SigningSession`
  - **Pre:** Message bytes, decrypted share (v2 or v3), list of active party IDs (0–255).
  - **Post:** Initialized session with all state cleared.
  - **Throws:** Never.

- `round1(session: SigningSession): string`
  - **Post:** Generates commitment hash and stores in `myRound1Hash`. Returns base64 blob for broadcast. Adds own hash to `collectedRound1Hashes`.

- `round2(session: SigningSession): string`
  - **Pre:** `round1State` is set; `collectedRound1Hashes` contains T hashes (including self).
  - **Post:** Sorts active party IDs, orders hashes canonically, computes commitment. Returns base64 blob. Adds own commitment to collection.

- `round3(session: SigningSession): string`
  - **Pre:** `round1State` and `round2State` are set; `collectedRound2Commitments` contains T commitments.
  - **Post:** Computes partial response. Returns base64 blob. Adds own response to collection.

- `combine(session: SigningSession): Uint8Array | null`
  - **Pre:** All three rounds completed; `collectedRound3Responses` contains T responses.
  - **Post:** Combines responses into FIPS 204 ML-DSA signature (2592 bytes for level 44). Stores in `session.signature` and returns it. Returns null if combination failed (retry from round1).

- `addBlob(session: SigningSession, blob: string, expectedRound?: number): {ok: boolean, error?: string}`
  - **Pre:** Base64 blob from peer (or unchecked string).
  - **Post:** Validates:
    - Blob format (envelope version)
    - Message prefix matches (same message)
    - Party ID is in active set and not self
    - No duplicates for this round/party
    Then adds decoded data to the appropriate collection.
  - **Throws:** Never; returns error object.

- `decodeBlob(blob: string): {round: number, partyId: number} | null`
  - **Pre:** Base64 blob (any).
  - **Post:** Returns round and partyId for display, or null if not decodable.

- `destroySession(session: SigningSession): void`
  - **Pre:** Completed or cancelled session.
  - **Post:** Clears sensitive round state (calls `.destroy()` on Round1State/Round2State).

**Byte-format / wire contract:**
- Signing blob envelope (base64 JSON): `{v: 1, round: number, partyId: number, msgPrefix: string (16 hex chars), data: hex string}`.
- Round 1: data is commitment hash (32B).
- Round 2: data is commitment (variable length, extracted from `ThresholdMLDSA.round2` result).
- Round 3: data is response (variable length, from `ThresholdMLDSA.round3` result).

**Invariants:**
- Party IDs must be sorted canonically (ascending) in round2 and round3.
- Message prefix is first 16 hex chars (8 bytes) — provides basic message validation without full hash.
- Signature is 2592 bytes for level 44 (FIPS 204 ML-DSA-44).

**Cross-component contracts:**
- Uses: `ThresholdMLDSA` from `@btc-vision/post-quantum`, `hex.ts` helpers.
- Used by: Signing ceremony orchestration.

**Notes / gotchas:**
- **Party ID ordering is load-bearing:** `round2()` and `combine()` must use the same canonical sort order. Mismatch causes signature verification failure.
- `destroySession()` is critical for clearing sensitive state (round1/2 intermediate values can leak message).
- All blobs for a message must have the same `msgPrefix`; invalid blob is rejected silently with error object (not thrown).

---

### `vault-types.ts`
**Purpose:** Shared types for API client and frontend components. Vault configuration schemas.

**Public surface:**
- `StorageMode` type: `'persistent' | 'encrypted-persistent' | 'encrypted-portable'`.
- `NetworkName` type: `'testnet' | 'mainnet'`.

- `SetupState` interface
  - `wizardComplete: boolean` (initial configuration done)
  - `dkgComplete: boolean` (key ceremony done)

- `WalletPublic` interface (frontend-visible)
  - `p2tr: string` (BTC address)
  - `tweakedPubKey: string` (hex, 33B SEC1)
  - `publicKey: string` (hex, 1312B ML-DSA pubkey)
  - **Note:** `mnemonic` is NEVER sent to frontend.

- `PermafrostConfig` interface
  - `threshold: number` (t)
  - `parties: number` (n)
  - `level: number` (44, 65, 87)
  - `combinedPubKey: string` (hex, ML-DSA aggregate pubkey)
  - `shareData: string` (V3 share file JSON, encrypted)
  - `frostAggregateKey?: string` (hex, 33B SEC1, post-tweak)
  - `frostUntweakedAggregateKey?: string` (hex, 33B SEC1)
  - `frostP2tr?: string` (Taproot address derived from FROST key)

- `VaultConfig` interface (full daemon config)
  - `version: number` (1)
  - `network: NetworkName`
  - `storageMode: StorageMode`
  - `setupState: SetupState`
  - `hasAdminPassword?: boolean` (frontend sees only boolean, not hash)
  - `authMode?: 'password' | 'wallet'`
  - `wallet?: WalletPublic` (frontend-visible fields only)
  - `permafrost?: PermafrostConfig`
  - `contracts: ContractConfig[]` (deployed smart contracts)
  - `hosting?: HostingConfig` (domain/HTTPS config)
  - `manifestConfig?: ManifestConfig` (manifest + address bindings)

- `ContractConfig` interface
  - `name: string`
  - `address: string` (OPNet contract address)
  - `abi: unknown[]` (resolved ABI)
  - `methods: string[]` (method names available)

- `HostingConfig` interface
  - `domain: string` (e.g., "example.com")
  - `port?: number` (custom port)
  - `path?: string` (subpath)
  - `httpsEnabled: boolean`
  - `httpsStatus?: 'pending' | 'active' | 'error'`
  - `httpsError?: string` (error message if status is 'error')

**Byte-format / wire contract:**
- JSON schema; all fields are string, number, boolean, or nested object/array.
- `hasAdminPassword` is boolean flag (password hash is NOT sent to frontend).

**Invariants:**
- `network` field determines RPC endpoints and chain ID (from `opnet-client.ts`).
- `wallet` is present only if wizard is complete; `permafrost` is present only if DKG is complete.

**Cross-component contracts:**
- Used by: Frontend dashboard, API response serialization.

**Notes / gotchas:**
- Frontend receives `WalletPublic` (no mnemonic); backend holds full `WalletConfig` (includes mnemonic, never serialized).
- `manifestConfig` is an opaque object at this type level (resolved to `ManifestConfig` elsewhere).

---

