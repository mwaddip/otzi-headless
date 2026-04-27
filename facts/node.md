# Contracts: src/node/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/node/

> **Lifted from `~/projects/otzi/backend/src/lib/`. DO NOT EDIT — byte-compatibility with Ötzi is a hard contract.**

### `encryption.ts`
**Purpose:** AES-256-GCM encryption/decryption for daemon config using Node.js crypto module. Parallel to browser `src/wire/crypto.ts`.

**Public surface:**
- `encryptConfig(plaintext: string, password: string): string`
  - **Pre:** Plaintext is UTF-8 string (e.g., JSON config); password is UTF-8 string.
  - **Post:** Returns base64 string: `salt(16B) ‖ iv(12B) ‖ tag(16B) ‖ ciphertext`. PBKDF2: 600k iterations, SHA-256.

- `decryptConfig(encoded: string, password: string): string`
  - **Pre:** `encoded` is base64 from `encryptConfig()`.
  - **Post:** Returns plaintext UTF-8 string.
  - **Throws:** On wrong password (GCM auth tag mismatch), corrupted data, or base64 decode error.

**Byte-format / wire contract:**
- Encrypted config layout: `salt(16B) ‖ iv(12B) ‖ tag(16B) ‖ ciphertext_bytes`.
- PBKDF2: 600,000 iterations, SHA-256, salt length 16, key derivation length 32 bytes.
- GCM auth tag is explicitly appended (Node.js `cipher.getAuthTag()` returns 16 bytes).

**Invariants:**
- PBKDF2 parameters (iterations, hash, lengths) match browser `src/wire/crypto.ts` exactly.
- Auth tag is explicitly extracted and prepended to ciphertext (unlike Web Crypto's implicit embedding).

**Cross-component contracts:**
- Used by: Daemon config persistence (encryption/decryption on load/save).
- Parallel to: `src/wire/crypto.ts` (same password derivation, different tag handling).

**Notes / gotchas:**
- Node.js `aes-256-gcm` requires explicit IV (12 bytes) and explicit tag handling.
- Auth tag must be set on decipher BEFORE decryption begins, or verification is skipped.

---

### `frost-link.ts`
**Purpose:** Compute the OPNet-specific key-link message hash for FROST legacy signature generation. Load-bearing for V3 vault key-link FROST sig.

**Public surface:**
- `computeKeyLinkHash(mldsaPubKey: Uint8Array, frostAggregateKey: Uint8Array, frostUntweakedKey: Uint8Array, networkName: NetworkName): Uint8Array`
  - **Pre:**
    - `mldsaPubKey` = 1312B ML-DSA public key (from ceremony output)
    - `frostAggregateKey` = 33B SEC1 compressed (tweaked, post-BIP341)
    - `frostUntweakedKey` = 33B SEC1 compressed (untweaked)
    - `networkName` ∈ `{'testnet', 'mainnet'}`
  - **Post:** Computes and returns SHA-256 hash of preimage:
    ```
    1B level(0x2C = 44) ‖ 
    32B SHA-256(mldsaPubKey) ‖ 
    32B toXOnly(frostAggregateKey) ‖ 
    33B frostUntweakedKey ‖ 
    32B sha256("OP_NET") ‖ 
    32B chainId[networkName]
    ```
  - **Throws:** If `networkName` is unknown.

- `withFrostLegacySig<T>(keyLinkHash: Uint8Array, frostLegacySig: Uint8Array, frostTweakedKey: Uint8Array, fn: () => T | Promise<T>): Promise<T>`
  - **Pre:**
    - `keyLinkHash` = precomputed hash from `computeKeyLinkHash()`
    - `frostLegacySig` = 64B BIP340 Schnorr signature (from FROST ceremony)
    - `frostTweakedKey` = 33B SEC1 tweaked FROST key
    - `fn` is async callback (typically SDK `sendTransaction()`)
  - **Post:** Temporarily patches:
    1. `ecc.signSchnorr()` to return `frostLegacySig` if hash matches keyLinkHash, else call original.
    2. `TweakedSigner.tweakSigner()` to inject correct FROST `publicKey` instead of SDK-derived key.
    Then executes `fn()`, finally restores original functions.
  - **Throws:** Propagates exceptions from `fn()`.

**Byte-format / wire contract:**
- Preimage layout (before final SHA-256):
  ```
  1B security level (0x2C = MLDSASecurityLevel.LEVEL2)
  32B SHA-256 hash of ML-DSA pubkey
  32B x-only (32-bit strip of tweaked FROST key)
  33B untweaked FROST key (SEC1 full)
  32B protocol ID (SHA-256("OP_NET"))
  32B chain ID (network-specific from CHAIN_IDS)
  ```

**Invariants:**
- Chain IDs are fixed constants matching `getChainId(getNetwork(name))` from SDK.
- Protocol ID is fixed SHA-256 hash of "OP_NET" (must match OPNetConsensus.consensus.PROTOCOL_ID).
- Security level is hardcoded 0x2C (level 44 only, per project constraints).
- `toXOnly()` extracts 32-bit x-coordinate from 33-byte SEC1 compressed key.

**Cross-component contracts:**
- Used by: Signing ceremony (legacy signature generation), `withFrostLegacySig()` patches SDK.
- Depends on: `@btc-vision/bitcoin` (`toXOnly`), Node.js `crypto` (SHA-256).

**Notes / gotchas:**
- **Chain IDs are hardcoded:** Testnet uses `networks.opnetTestnet` (bech32 "opt"), NOT `networks.testnet` (bech32 "tb"). Mismatch causes silent signature failure.
- **Security level is hardcoded 0x2C:** If protocol ever supports levels 65/87, this function must be updated (currently assumes level 44 only).
- `withFrostLegacySig()` uses ECC library global state (shared with SDK). Mutations are scoped to callback execution; restores on exit. Concurrent calls would interfere (but not typical in practice).

---

### `frost-psbt-signer.ts`
**Purpose:** PSBT signer for OPNet transactions using FROST signatures. Captures sighashes for replay, or applies precomputed signatures. Handles script-path (input 0) and key-path (inputs 1+) separately.

**Public surface:**
- `SighashInfo` interface
  - `index: number` (global index across all PSBTs in capture call)
  - `hash: Uint8Array` (32B sighash)
  - `type: 'script-path' | 'key-path'`

- `InputSighash` interface (per-input)
  - `inputIndex: number` (input index within PSBT)
  - `hash: Uint8Array` (32B sighash)
  - `type: 'script-path' | 'key-path'`

- `CapturedCall` interface
  - `sighashes: InputSighash[]` (per input in this PSBT)

- `FrostPsbtSigner` class
  - `constructor(keyPathSignFn: SchnorrSignFn, tweakedPublicKey: Uint8Array, internalXOnly: Uint8Array, scriptPathSigner?: TaprootSigner)`
    - **Pre:** keyPathSignFn signs with tweaked key; tweakedPublicKey is 33B SEC1; internalXOnly is 32B x-only; scriptPathSigner (optional) signs script-path inputs with untweaked key.

  - `static fromSignature(sig: Uint8Array, tweakedPublicKey: Uint8Array, internalXOnly: Uint8Array, scriptPathSigner?: TaprootSigner): FrostPsbtSigner`
    - **Pre:** 64B BIP340 signature.
    - **Post:** Signer that always returns this signature (used for replay after ceremony).

  - `static createCapture(tweakedPublicKey: Uint8Array, internalXOnly: Uint8Array, untweakedPublicKey: Uint8Array): {signer: FrostPsbtSigner, sighashes: SighashInfo[], calls: CapturedCall[]}`
    - **Pre:** Tweaked and untweaked keys (33B and 33B SEC1 respectively); internalXOnly is 32B x-only.
    - **Post:** Returns signer + arrays of captured sighashes. Signer's `multiSignPsbt()` extracts sighashes using dummy (64-byte zero) signatures. Each `signTaprootInputAsync()` call captures hash, appends to sighashes array, stores call metadata in `calls`.
    - **Contract:** Dummy sigs pass SDK finalization without verification; caller must intercept at provider level (or skip broadcast in test).

  - `static createReplay(tweakedPublicKey: Uint8Array, internalXOnly: Uint8Array, untweakedPublicKey: Uint8Array, sigsByHash: Map<string, Uint8Array>): FrostPsbtSigner`
    - **Pre:** `sigsByHash` map is keyed by hex string of sighash (full 64-char hex), value is 64B BIP340 signature.
    - **Post:** Signer that extracts sighash in `multiSignPsbt()`, looks up matching signature in map, applies it. Throws if signature not found.

  - `async multiSignPsbt(transactions: Psbt[]): Promise<void>`
    - **Pre:** Array of PSBTs (from SDK during fee estimation and final build).
    - **Post:** Signs all Taproot inputs:
      - Script-path (has `tapLeafScript`): calls `scriptPathSigner.signSchnorr()` with untweaked key.
      - Key-path (has `tapInternalKey` matching `internalXOnly`): calls `keyPathSignFn()` with tweaked key or extracts from capture map.
    - **Throws:** If signature lookup fails (replay mode).

**Byte-format / wire contract:**
- No explicit wire format; sighashes are 32B SHA-256, signatures are 64B BIP340 (Schnorr).
- Sighash lookup key is hex string (64 characters for 32-byte hash).

**Invariants:**
- Script-path input (input 0) uses untweaked key; key-path inputs (1+) use tweaked key.
- Signature format is BIP340 (64 bytes, no recovery ID).
- All Taproot inputs are signed; non-Taproot inputs are skipped.

**Cross-component contracts:**
- Used by: OPNet transaction signing (two-round flow: capture → ceremony → replay).
- Depends on: `@btc-vision/bitcoin` (`Psbt`, `isTaprootInput`, `toXOnly`, `equals`).

**Notes / gotchas:**
- **Two-call SDK pattern:** SDK calls `multiSignPsbt()` multiple times (fee estimation, final build). Capture mode extracts sighashes from all calls; caller must identify which sighashes correspond to final transaction (typically the last call).
- **Sighash extraction is destructive in capture mode:** Dummy signatures are written and deleted; if an exception occurs mid-call, PSBT state may be corrupted.
- **Replay mode is strict:** If any sighash is missing from `sigsByHash`, the entire `multiSignPsbt()` call throws. Caller must ensure all sighashes are populated before replay.
- **Console logging:** Replay mode includes `console.log()` statements for debugging (production code should suppress or sanitize).

---

### `opnet-client.ts`
**Purpose:** OPNet provider construction, wallet generation, and network configuration. Wraps SDK initialization.

**Public surface:**
- `getNetwork(name: NetworkName): Network`
  - **Pre:** `name` ∈ `{'testnet', 'mainnet'}`.
  - **Post:** Returns SDK `Network` object:
    - `'mainnet'` → `networks.bitcoin` (standard Bitcoin mainnet)
    - `'testnet'` → `networks.opnetTestnet` (OPNet testnet, bech32 "opt")
  - **Throws:** Never.

- `getProvider(networkName: NetworkName): JSONRpcProvider`
  - **Pre:** `networkName` ∈ `{'testnet', 'mainnet'}`.
  - **Post:** Returns `JSONRpcProvider` with:
    - URL: `RPC_URLS[networkName]` (hardcoded `https://testnet.opnet.org` or `https://mainnet.opnet.org`)
    - Network object from `getNetwork(networkName)`
  - **Throws:** Never.

- `generateWallet(mnemonic: string, networkName: NetworkName)`
  - **Pre:** BIP39 mnemonic string; `networkName` ∈ `{'testnet', 'mainnet'}`.
  - **Post:** Returns `{mnemonic: Mnemonic, wallet: QuantumBIP32Interface}`:
    - `mnemonic` is `Mnemonic` instance with empty passphrase, ML-DSA security level 2 (44).
    - `wallet` is derived OPNet wallet (path m/0/0/0, hardened=false).
  - **Throws:** On invalid mnemonic.

**Byte-format / wire contract:**
- RPC URLs are hardcoded strings.
- Network configuration is opaque SDK object.

**Invariants:**
- Testnet uses `networks.opnetTestnet`, NOT `networks.testnet` (bech32 mismatch trap).
- Security level is hardcoded `MLDSASecurityLevel.LEVEL2` (44, only supported level).
- Wallet derivation path is fixed: m/0/0/0 (account 0, change 0, index 0).

**Cross-component contracts:**
- Uses: `@btc-vision/bitcoin` (networks), `@btc-vision/transaction` (Mnemonic, MLDSASecurityLevel).
- Used by: Wallet setup, transaction signing.

**Notes / gotchas:**
- **RPC URL hardcoding:** If endpoints change, code must be updated. No config override.
- **Testnet vs. OPNet testnet:** Calling `getNetwork('testnet')` returns `networks.opnetTestnet` (address format "opt", not "tb"). Crucial for address generation.
- **Security level hardcoding:** All wallets use ML-DSA-44. Protocol does not support 65 or 87 at daemon level.

---

### `threshold-signer.ts`
**Purpose:** Adapter wrapping precomputed threshold ML-DSA signature to satisfy `QuantumBIP32Interface` for OPNet SDK integration.

**Public surface:**
- `ThresholdMLDSASigner` class implements `QuantumBIP32Interface`
  - **Required stubs (never called during sendTransaction):**
    - `chainCode: Uint8Array` = 32 zero bytes
    - `network: Network` = empty object (stub)
    - `depth: number` = 0
    - `index: number` = 0
    - `parentFingerprint: number` = 0
    - `identifier: Uint8Array` = 20 zero bytes
    - `fingerprint: Uint8Array` = 4 zero bytes
    - `securityLevel: MLDSASecurityLevel` = `LEVEL2` (44)

  - `constructor(precomputedSignature: Uint8Array, publicKey: Uint8Array)`
    - **Pre:** `precomputedSignature` is 2592B ML-DSA-44 signature (from threshold ceremony); `publicKey` is 1312B ML-DSA-44 public key.
    - **Post:** Stores both for use by `sign()`.

  - `sign(message: Uint8Array): Uint8Array`
    - **Pre:** Any message (ignored).
    - **Post:** Returns stored `precomputedSignature` (ignores message).

  - `verify(_hash: Uint8Array, _signature: Uint8Array): boolean`
    - **Pre:** Any inputs.
    - **Post:** Throws `Error('ThresholdMLDSASigner.verify() not implemented')`.
    - **Rationale:** SDK should not call verify during `sendTransaction()` (uses callback-based signing instead).

  - `isNeutered(): boolean`
    - **Post:** Returns `true` (no private key available).

  - `neutered(): QuantumBIP32Interface`
    - **Post:** Returns `this`.

  - `derive()`, `deriveHardened()`, `derivePath()`, `toBase58()`
    - **Post:** All throw `Error` (not supported on threshold signer).

**Byte-format / wire contract:**
- Signature is 2592 bytes (FIPS 204 ML-DSA-44).
- Public key is 1312 bytes (ML-DSA-44 encoding).

**Invariants:**
- Signer is stateless (same signature returned every call to `sign()`).
- All non-essential interface methods throw; caller must not invoke them.

**Cross-component contracts:**
- Implements: `QuantumBIP32Interface` (from `@btc-vision/bip32`).
- Used by: OPNet SDK's wallet-based signing path (expects this interface).

**Notes / gotchas:**
- **Verify not implemented:** SDK should use callback-based verification (or skip it). If `verify()` is called, it throws immediately.
- **Signature is always identical:** Precomputed at ceremony time; does not depend on message. Caller must ensure correct message was signed during ceremony.
- **All stub fields are ignored by SDK:** During `sendTransaction()`, only `sign()` and `publicKey` are used.

---

### `types.ts`
**Purpose:** Shared types for daemon config (backend-visible, with secrets). Parallel to frontend-visible `vault-types.ts` in `src/wire/`.

**Public surface:**
- `StorageMode` type: `'persistent' | 'encrypted-persistent' | 'encrypted-portable'`.
- `NetworkName` type: `'testnet' | 'mainnet'`.

- `SetupState` interface
  - `wizardComplete: boolean`
  - `dkgComplete: boolean`

- `WalletConfig` interface (backend-only, includes mnemonic)
  - `mnemonic: string` (12-word BIP39 phrase, secret)
  - `p2tr: string` (BTC Taproot address, hex)
  - `tweakedPubKey: string` (33B SEC1 hex)
  - `publicKey: string` (1312B ML-DSA pubkey hex)

- `PermafrostConfig` interface
  - `threshold: number` (t)
  - `parties: number` (n)
  - `level: number` (44, 65, 87)
  - `combinedPubKey: string` (ML-DSA aggregate, hex)
  - `shareData: string` (V3 share file JSON, encrypted)
  - `frostAggregateKey?: string` (33B SEC1 tweaked, hex)
  - `frostUntweakedAggregateKey?: string` (33B SEC1, hex)
  - `frostP2tr?: string` (FROST Taproot address)
  - `frostLegacySig?: string` (64B FROST Schnorr sig, hex — daemon-specific)

- `VaultConfig` interface (full backend config)
  - `version: number` (1)
  - `network: NetworkName`
  - `storageMode: StorageMode`
  - `setupState: SetupState`
  - `adminPasswordHash?: string` (bcrypt or similar, secret)
  - `authMode?: 'password' | 'wallet'`
  - `wallet?: WalletConfig` (includes mnemonic, secret)
  - `permafrost?: PermafrostConfig`
  - `contracts: ContractConfig[]`
  - `hosting?: HostingConfig`
  - `manifestConfig?: unknown` (opaque)

- `ContractConfig` interface
  - `name: string`
  - `address: string`
  - `abi: unknown[]`
  - `methods: string[]`

- `HostingConfig` interface
  - `domain: string`
  - `port?: number`
  - `path?: string`
  - `httpsEnabled: boolean`
  - `httpsStatus?: 'pending' | 'active' | 'error'`
  - `httpsError?: string`

- `defaultConfig(network: NetworkName, storageMode: StorageMode): VaultConfig`
  - **Post:** Returns initialized `VaultConfig` with:
    - `version: 1`
    - `setupState: {wizardComplete: true, dkgComplete: false}`
    - `network`, `storageMode` as provided
    - `contracts: []` (empty, to be populated)

- `sanitizeConfig(config: VaultConfig): Record<string, unknown>`
  - **Pre:** Full `VaultConfig` (with secrets).
  - **Post:** Strips:
    - `wallet.mnemonic` (replaces with flag `hasAdminPassword`)
    - `adminPasswordHash` (replaces with flag)
    Returns safe object for frontend serialization.

**Byte-format / wire contract:**
- JSON schema (all fields are string, number, boolean, or nested objects).
- `mnemonic` is 12-space-separated words (BIP39).
- `adminPasswordHash` is opaque string (bcrypt output or equivalent).

**Invariants:**
- `frostLegacySig` is daemon-specific field (added after DKG ceremony, not part of Ötzi contract).
- `sanitizeConfig()` removes all secrets before sending to frontend.

**Cross-component contracts:**
- Parallel to: `src/wire/vault-types.ts` (frontend-visible types).
- Used by: Daemon config persistence, frontend API responses (via `sanitizeConfig()`).

**Notes / gotchas:**
- **Backend-only:** This file is NOT sent to frontend. Frontend uses `src/wire/vault-types.ts` instead.
- **Sanitization is critical:** `sanitizeConfig()` must be called on all API responses; returning raw `VaultConfig` exposes mnemonic and password hash.
- **frostLegacySig storage:** Daemon stores this field in `PermafrostConfig` for replay during transaction signing. Ötzi does not use or recognize this field (tolerated).

---

## Summary of Byte-Stability Contracts

**ML-DSA:**
- Pubkey: 1312 bytes (level 44 only, hardcoded in project).
- Signature: 2592 bytes (FIPS 204 ML-DSA-44).

**FROST:**
- Identifier: bigint, 1-indexed (partyId + 1 for conversion).
- Verification keys: 33 bytes SEC1 compressed (tweaked and untweaked).
- Signing share: 32 bytes big-endian.

**Polynomial packing:**
- 256 coefficients × 23-bit per polynomial = 736 bytes.
- Bit-level packing, no gaps.

**DKG blobs:**
- Phase 1–4 include SHA-256 checksums for phases 3–4 (mandatory).
- Bitmask field: 2B little-endian.

**Share files:**
- Version 3 (combined ML-DSA + FROST): `1B v(0x03) ‖ 4B mldsaLen LE ‖ [mldsa] ‖ [frost]`.
- Encryption: PBKDF2 600k SHA-256, AES-256-GCM, salt/IV/tag explicit.

**FROST key-link hash:**
- Preimage: security level (1B) ‖ hashed ML-DSA pubkey (32B) ‖ x-only tweaked FROST (32B) ‖ untweaked FROST (33B) ‖ protocol ID (32B) ‖ chain ID (32B).
- Final: SHA-256 of preimage.

---

