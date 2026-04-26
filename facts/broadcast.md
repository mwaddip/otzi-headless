# Contracts: src/broadcast/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/broadcast/

### `btc-fees.ts`

**Purpose:** Fetch Bitcoin fee rates from mempool.space for on-chain transaction fee estimation.

**Public surface:**
- `fetchBtcFees(network: NetworkName) → Promise<BtcFeeRates>`
  - **Pre:** `network` must be a valid `NetworkName` ('mainnet' | 'testnet'); mempool.space must be reachable.
  - **Post:** Returns `{ low, normal, high }` (sat/vB rates) for next-hour, half-hour, and next-block confirms respectively.
  - **Throws:** `Error` if HTTP response is not 2xx or JSON parsing fails.
  - **Concurrency:** Safe; pure async fetch with no shared state.
  - **Determinism:** Not deterministic (network I/O); results vary per call.

**Invariants:**
- No state mutations; no caching or fallback logic.
- Network selection is static per invocation.

**Cross-component contracts:**
- Used by: `btc-vault.ts` for dynamic fee estimation in coin selection.
- Byte/format contract: JSON responses parsed as `{ fastestFee, halfHourFee, hourFee }` (mempool.space API contract).

**Notes / gotchas:**
- No in-module cache; caller responsible for caching if desired.
- Silent failures upward — no retry or fallback logic.

---

### `btc-vault.ts`

**Purpose:** BTC vault P2TR key-path spend preparation, fee estimation, UTXO selection, and broadcast with FROST signatures.

**Public surface:**
- `selectBtcUtxos(utxos: readonly BtcUtxo[], amount: bigint, feeRate: number) → SelectedCoins`
  - **Pre:** `utxos` may be empty (throws); `amount` must be positive; `feeRate` must be positive (sat/vB).
  - **Post:** Returns selected UTXOs (largest-first greedy), final fee (bigint), and change amount (0n if dust). Throws if sum < amount + fee.
  - **Throws:** `Error` on insufficient funds.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic given inputs; sort is stable (largest-first breaks ties via input order stability).

**Invariants:**
- Coin selection is greedy: largest-first until sum >= amount + estimated fee.
- Change folded into fee if < 546 sat (dust threshold).
- vsize estimates: INPUT_VBYTES (57.5) per input, OUTPUT_VBYTES (43) per output, OVERHEAD_VBYTES (10.5) overhead.
- Final fee recomputed with chosen input/output count (not earlier estimate).

- `buildBtcTxFromParams(params: BtcBuildParams) → BtcBuildResult`
  - **Pre:** `params.amountSat` must be a positive bigint; `params.feeRate` must be positive; `params.to` must be valid bech32 for network; `params.frostUntweakedPubKey` must be 33B SEC1 compressed; `params.utxos` snapshot must be internally consistent (UTXO value types match assertions).
  - **Post:** Returns unsigned tx hex, BIP-341 key-path sighashes (Uint8Array, tweaked=true for all), prevout info (scriptHex, valueSat), decoded outputs, estimated fee, and change amount.
  - **Throws:** `Error` on invalid address, nonpositive amount/fee, UTXO selection failure, or type mismatches.
  - **Concurrency:** Safe; pure function (no I/O, no state).
  - **Determinism:** Fully deterministic: two peers with identical params produce identical tx bytes and sighashes.

**Invariants:**
- Outputs in order: [recipient, change] (change omitted if 0).
- Sighashes use SIGHASH_DEFAULT (0x00) — commits to all inputs + outputs.
- Tweaked field always `true` (P2TR key-path).
- ScriptPubKey for all inputs is the P2TR output script.

- `extractBtcSighashes(unsignedTxHex: string, inputs: readonly BtcSighashInput[]) → Array<{ index: number; hash: Uint8Array; tweaked: boolean }>`
  - **Pre:** `unsignedTxHex` must deserialize to a valid Transaction; `inputs.length` must match tx input count; each `BtcSighashInput` must have valid hex scriptHex and numeric string valueSat.
  - **Post:** Returns per-input BIP-341 sighashes with tweaked flag from input spec.
  - **Throws:** `Error` on tx/inputs length mismatch.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic — same tx + inputs → same sighashes.

**Invariants:**
- Sighash type is always SIGHASH_DEFAULT (0x00).
- Output order in sighashes follows input iteration (index 0, 1, …).

- `decodeBtcOutputs(unsignedTxHex: string, networkName: NetworkName) → DecodedBtcOutput[]`
  - **Pre:** `unsignedTxHex` must deserialize to a valid Transaction; network must be valid.
  - **Post:** Returns array of [address (string | null), amountSat (bigint), scriptHex (string)]. Address is null for non-standard scripts (OP_RETURN, etc.).
  - **Throws:** Never; address decode failures caught and nullified.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic.

**Invariants:**
- Gate layer treats `address: null` as non-matching in recipient rules.
- No filtering applied; outputs are returned in tx order.

- `prepareBtcTx(inputs: PrepareBtcInputs) → Promise<PrepareBtcResult>`
  - **Pre:** `inputs.amount` must be a positive integer; `inputs.feeRate` must be positive; `inputs.to` must be valid bech32; `inputs.frostP2tr` must be valid; `inputs.frostUntweakedPubKey` must be 33B SEC1; provider must be reachable.
  - **Post:** Returns sighashes (all key-path type), captureContext (for later broadcast correlation), estimatedFee, and changeAmount.
  - **Throws:** `Error` on validation failure, invalid address, provider fetch failure, or UTXO selection failure.
  - **Concurrency:** Safe; async but no shared state.
  - **Determinism:** Non-deterministic (UTXOs fetched from live provider); token generated via `randomBytes(16)`.

**Invariants:**
- captureContext.token is a random 32-char hex string for logging/correlation.
- estimatedFee and changeAmount returned as `number` (lossy for large bigints > 53-bit precision).

- `broadcastBtcTx(inputs: BroadcastBtcInputs) → Promise<BroadcastBtcResult>`
  - **Pre:** `inputs.frostSignatures.length` must equal `captureContext.numInputs`; each signature must be exactly 128 hex chars (64 bytes); `inputs.frostTweakedPubKey` must be 33B SEC1 tweaked (P2TR output key); sighashes in captureContext must still be valid (not stale from replayed ceremony).
  - **Post:** Returns txid (from broadcast response or derived from tx). Sigs injected as sole witness element (key-path). Tx broadcast via OPNet provider (testnet) or mempool.space (mainnet).
  - **Throws:** `Error` on sig count mismatch, invalid sig hex format, BIP340 verification failure, provider broadcast failure, or mempool.space rejection.
  - **Concurrency:** Safe; async broadcast.
  - **Determinism:** Non-deterministic (network broadcast).

**Invariants:**
- BIP340 verification uses x-only (tweaked) key derived from 33B tweaked SEC1 pubkey.
- Witness set to `[frostSig]` (single element).
- Mainnet uses mempool.space POST /api/tx; testnet uses OPNet provider.
- Verification failure is non-fatal to tx construction — can retry ceremony without rebroadcasting.

**Cross-component contracts:**
- Depends on: `@btc-vision/bitcoin` (Transaction, payments, address, toXOnly), `@noble/curves/secp256k1.js` (schnorr), `opnet-client.js` (getProvider, getNetwork).
- Used by: Orchestrator `/sign` path for BTC creation; operator for BTC broadcast.
- Byte/format contract: BIP-341 sighashes (32B), BIP340 Schnorr sigs (64B), P2TR key-path scriptPubKey.

**Notes / gotchas:**
- `broadcastBtcTx` verifies under TWEAKED key. This is correct per BIP341 (key-path signs the output key, which is tweaked).
- `prepareBtcTx` returns estimatedFee as `number`, losing precision for >= 2^53 sat. Daemon should avoid such fees.
- Signature format check is strict: exactly 128 hex chars, no whitespace.

---

### `opnet-calldata.ts`

**Purpose:** Pure encoding of OPNet contract method calls into BinaryWriter-compatible calldata (selector + packed args).

**Public surface:**
- `resolveAbi(abi: unknown) → unknown[]`
  - **Pre:** None (abi can be string shorthand, full array, single object, or falsy).
  - **Post:** Returns normalized ABI array. Shorthand 'OP_20' or 'OP_20S' resolved to `OP_20_ABI`; default is `OP_20_ABI` if abi is falsy.
  - **Throws:** Never.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic given abi.

**Invariants:**
- ABI_SHORTHANDS maps 'OP_20' and 'OP_20S' to `OP_20_ABI` (extendable for future shorthands).
- normalizeAbiEntry lowercases type names and uppercases ABI_TYPE_MAP values.

- `encodeCalldata(method: string, params: readonly string[], paramTypes: readonly ParamType[]) → { calldata: Uint8Array; messageHash: Uint8Array }`
  - **Pre:** `params.length` must equal `paramTypes.length`; each param must be properly formatted (address: hex 0x-ok, u256: decimal or hex bigint-safe, bytes: hex 0x-ok).
  - **Post:** Returns calldata (selector || packed args) and messageHash (SHA256 of calldata, used as broadcast-status cache key in Ötzi).
  - **Throws:** `Error` on params/paramTypes length mismatch or unknown paramType.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic given inputs.

**Invariants:**
- Selector is first 4 bytes of SHA256(methodName).
- Wire format: selector (4B) || param_0 || param_1 || …
- address = 32 bytes (hex-decoded, no length prefix).
- u256 = BinaryWriter.writeU256 (32 bytes, big-endian).
- bytes = raw hex-decoded (no length prefix — OPNet convention).

**Cross-component contracts:**
- Depends on: `@btc-vision/transaction` (BinaryWriter), `opnet` (OP_20_ABI).
- Used by: OPNet capture flow for method encoding.
- Byte/format contract: OPNet ABI calldata (Solidity-like selector + packed args).

**Notes / gotchas:**
- bytes type has no length prefix (OPNet convention, not Solidity).
- messageHash is the broadcast-status cache key in Ötzi — must match exactly.

---

### `opnet-capture.ts`

**Purpose:** Deterministic OPNet contract-call sighash capture via SDK transaction construction with monkey-patched RNG and broadcast interception.

**Public surface:**
- `convertOpnetParams(rawParams: readonly unknown[], paramTypes: readonly ParamType[] | undefined) → unknown[]`
  - **Pre:** `rawParams.length` must be ≤ `paramTypes.length` if paramTypes is defined.
  - **Post:** Returns array where address params are converted to `Address.wrap(Buffer)`, u256 params to `BigInt(string)`, others pass through.
  - **Throws:** `Error` if bigint conversion fails (non-numeric u256).
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic.

**Invariants:**
- Conversion is type-driven; missing paramTypes treat param as pass-through.

- `deriveCaptureRndBytes(seed: Uint8Array, counter: number) → Uint8Array`
  - **Pre:** `seed` must be Uint8Array; `counter` must be non-negative integer.
  - **Post:** Returns 64 bytes = HMAC-SHA-512(seed, BE32(counter)).
  - **Throws:** `Error` if counter is not a non-negative integer.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic; same seed + counter → same 64 bytes.

**Invariants:**
- Counter is 0-indexed.
- Output is exactly 64 bytes (HMAC-SHA-512 digest size).

- `installRndBytesPatch(seed: Uint8Array) → RndBytesPatchHandle`
  - **Pre:** `seed` must be Uint8Array.
  - **Post:** Returns `{ restore: () => void, getCallCount: () => number }`. Monkey-patches `BitcoinUtils.rndBytes` to return deterministic sequence.
  - **Throws:** Never.
  - **Concurrency:** NOT safe without serialization. Calling twice without restore between leaves counter stomped. Use `captureMutex` to serialize.
  - **Determinism:** Deterministic if serialized.

**Invariants:**
- `restore()` reinstates the original `BitcoinUtils.rndBytes`.
- Counter is module-scoped and increments per call; calls are 0-indexed.
- Each patch handle has its own independent counter (not shared).

- `captureOpnetSighashes(inputs: OpnetCaptureInputs) → Promise<OpnetCaptureResult>`
  - **Pre:**
    - `contractAddress` must be valid (format-wise).
    - `method` must exist on contract ABI.
    - `params` / `paramTypes` must align (if both supplied).
    - `mldsaThresholdSignature` and `mldsaPubKey` must be consistent.
    - `frostTweakedPubKey` and `frostUntweakedPubKey` must be 33B SEC1 compressed (tweaked and untweaked respectively).
    - `frostLegacySig` required iff vault was DKG'd with V3 shares (detected by caller).
    - `refundAddress` must be valid bech32 for network.
    - `sdkWalletMnemonic` must be valid (never signed with, just produces keypair slot).
    - `utxos` (if set) must be UTXO snapshot peer agrees on; `challenge` (if set) must be ChallengeSolution matching network state.
    - `rndBytesSeed` (if set) must be Uint8Array; used to patch BitcoinUtils.rndBytes.
  - **Post:** Returns sighashes (array of {index, hash, type}) and captureContext (templateTxs list, sighashMap for wire correlation). Sighashes indexed 0, 1, … across all template txs in order.
  - **Throws:** `Error` on method not found, contract revert, SDK tx construction failure, or insufficient captured data. Wrapped sdkError in `out.cause` chain.
  - **Concurrency:** Serialized via process-global `captureMutex`; only one capture active at a time.
  - **Determinism:** Fully deterministic if `utxos`, `challenge`, and `rndBytesSeed` are provided and identical across peers. Without them, SDK fetches from provider (live, non-deterministic).

**Invariants:**
- captureMutex is process-global; all captures (across ceremony instances) serialized.
- RNG patch (if installed) lives only within capture; restored in finally.
- Monkey-patched sendRawTransaction/sendRawTransactionPackage throw `__capture_only__` to abort broadcast.
- Sighashes correspond to final N multiSignPsbt calls matching N template txs (fee estimation rounds discarded).
- captureContext.sighashMap keys are sighash hex strings; values map to {txIndex, inputIndex, type}.
- `frostLegacySig` usage is transparent to caller — wrapped in `withFrostLegacySig` if present.

**Cross-component contracts:**
- Depends on: `@btc-vision/transaction` (Address, BitcoinUtils, ChallengeSolution), `opnet` (getContract, UTXO), `opnet-client` (getProvider, getNetwork, generateWallet), `frost-link` (computeKeyLinkHash, withFrostLegacySig), `opnet-calldata` (resolveAbi).
- Used by: Orchestrator for OPNet construction-params capture; participants to verify sighashes.
- Byte/format contract: Sighash format opaque (captured hex strings); UTXO/ChallengeSolution are SDK native types.

**Notes / gotchas:**
- **CRITICAL:** RNG patching is global and NOT re-entrant. `captureMutex` serializes to prevent interleaved counter increments.
- `rndBytesSeed` is advisory; without it, SDK's default RNG is used (non-deterministic). Callers MUST set it for cross-peer determinism.
- Challenge solution determinism requires both snapshot (`challenge`) and seed.
- `installRndBytesPatch` is exported for testability but must be guarded by `captureMutex` in production.
- Simulation succeeds but real sighash capture depends on SDK internals remaining stable.

---

### `opnet-broadcast.ts`

**Purpose:** Inject FROST signatures into OPNet template transaction witnesses and broadcast.

**Public surface:**
- `broadcastOpnetTx(inputs: OpnetBroadcastInputs) → Promise<OpnetBroadcastResult>`
  - **Pre:**
    - `captureContext.templateTxs` must be non-empty.
    - `frostSignatures` must cover every sighash in `captureContext.sighashMap` (no extras, no missing).
    - Each signature must be exactly 128 hex chars (64 bytes).
    - `frostTweakedPubKey` and `frostUntweakedPubKey` must be 33B SEC1 compressed.
    - Sighashes must still be valid (not replayed from old ceremony).
  - **Post:** Returns transactionId. Witnesses modified in-place; template txs serialized to hex and broadcast via provider. For package (2+ txs), interaction tx (index 1) txid returned; for single tx, provider-returned txid.
  - **Throws:** `Error` on missing signature, invalid signature format, BIP340 verification failure, broadcast failure, or malformed template tx.
  - **Concurrency:** Safe; async broadcast.
  - **Determinism:** Non-deterministic (network broadcast).

**Invariants:**
- BIP340 verification: key-path inputs verified under tweaked x-only key; script-path under untweaked.
- Witness injection per input type:
  - script-path: witness[2] ← frostSig (assumes 5-element witness: [contractSecret, scriptSignerSig, mainSig, script, controlBlock]).
  - key-path: witness[0] ← frostSig (assumes ≥1-element witness).
- Single-tx broadcasts via `sendRawTransaction(tx, false)`; package broadcasts via `sendRawTransactionPackage(txs, true)`.
- Package result txid sourced from sequentialResults[1] (interaction tx) or fallback 'broadcast-ok'.

**Cross-component contracts:**
- Depends on: `@btc-vision/bitcoin` (Transaction, toXOnly), `@noble/curves/secp256k1.js` (schnorr), `opnet-client` (getProvider).
- Used by: Orchestrator for OPNet FROST broadcast; follow-up to `captureOpnetSighashes`.
- Byte/format contract: BIP340 sigs (64B hex), witness element positions per Taproot spec.

**Notes / gotchas:**
- Script-path witness assumes rigid structure; non-conforming witness aborts.
- Broadcast can fail at consensus even after BIP340 verify succeeds (SDK tx construction error, mempool rejection); caller should retry ceremony if broadcast fails.
- Single-tx vs. package detection is automatic (2+ txs → package).

---

### `opnet-params-reconstruct.ts`

**Purpose:** Reconstruct OPNet capture inputs from on-wire announce blob; derive local vault address; serialize/deserialize UTXO and ChallengeSolution types.

**Public surface:**
- `deriveVaultP2tr(untweakedPubKey: Uint8Array, networkName: NetworkName) → string`
  - **Pre:** `untweakedPubKey` must be 33B SEC1 compressed (untweaked FROST aggregate key); `networkName` must be valid.
  - **Post:** Returns bech32 P2TR address for the vault (locally computed, reproducible across all peers).
  - **Throws:** `Error` if p2tr() returns no address (interior library failure).
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic; two peers with same key and network derive the same address.

**Canonical helper.** Called by:
  - Phase 8 OPNet construction-params (refundAddress derivation — leader + participant both invoke).
  - Phase 9b vault-pubkey cache writer (`src/daemon/vault-pubkey.ts`).
  - Phase 9b CLI read commands (indirectly — they read the cache, which holds the result of this derivation).

**Invariants:**
- Address is used as refundAddress for OPNet change outputs (never operator-supplied).
- Locally derived on every peer to prevent refund-address theft.

- `reconstructOpnetUtxos(raws: ReadonlyArray<AnnounceOpnetUtxoRaw>) → OpnetUtxo[]`
  - **Pre:** Each raw UTXO must have valid structure (transactionId, outputIndex, value as decimal string, scriptPubKey object); optional `raw`, `witnessScript`, `redeemScript`, `isCSV`.
  - **Post:** Returns array of OPNet SDK `UTXO` instances with identical truthy/undefined semantics as wire form (e.g., missing `raw` on wire → undefined in instance, not empty string).
  - **Throws:** Never (SDK constructor validates internally; malformed raises on next SDK call).
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic.

**Invariants:**
- Optional fields (raw, witnessScript, redeemScript) only set in iUTXO if present on wire (preserves undefined vs. falsy semantics for SDK's `if (iUTXO.raw)` check).
- value is decimal string on wire, converted to bigint by UTXO constructor.

- `reconstructChallengeSolution(raw: Record<string, unknown>) → ChallengeSolution`
  - **Pre:** `raw` must be a valid ChallengeSolution.toRaw() blob (or close approximation).
  - **Post:** Returns SDK ChallengeSolution instance. Constructor validates structure.
  - **Throws:** Never (SDK constructor validates; malformed raises on next SDK call).
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic.

**Invariants:**
- toRaw() is lossy: legacyPublicKey field is post-tweak 32B x-only, not original 33B. Reconstruction skips Address.autoFormat (only path populating originalPublicKey).
- serializeChallengeForWire() patches legacyPublicKey back to original 33B to allow participant-side Address.fromString to trigger autoFormat.

- `buildCaptureInputsFromParams(p: AnnounceOpnetParams, keyMat: OpnetParamsKeyMat) → OpnetCaptureInputs`
  - **Pre:**
    - `p` must be on-wire AnnounceOpnetParams blob (structurally valid).
    - `keyMat` must contain DKG-derived materials (identical across all peers).
    - `p.mldsaThresholdSignatureHex` must be valid hex.
    - `p.randomBytesSeedHex` must be valid hex.
  - **Post:** Returns full OpnetCaptureInputs ready for captureOpnetSighashes(). All wire fields converted to SDK types.
  - **Throws:** `Error` on hex decode failure, bad UTXO structure, or bad ChallengeSolution.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic (no I/O, conversions are deterministic).

**Invariants:**
- All fields are copied (spread for arrays/objects to avoid mutation).
- refundAddress passed through from wire (derived locally by leader before announce).
- mldsaThresholdSignature is pass-through (bad sig would fail at broadcast consensus, not sighash stage).

- `serializeOpnetParams(inputs: SerializeOpnetParamsInputs) → AnnounceOpnetParams`
  - **Pre:** All inputs must be valid (bigints, hex-encodable, valid SDK types).
  - **Post:** Returns on-wire AnnounceOpnetParams blob (JSON-safe).
  - **Throws:** Never (conversions are safe).
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic.

**Invariants:**
- bigint values (priorityFee, maximumAllowedSatToSpend) serialized as decimal strings.
- UTXO optional fields only set on wire if present in SDK instance (preserves undefined semantics).
- paramTypes optional array copied only if present.
- hints optional object constructed only if inputs.hints provided.

- `serializeChallengeForWire(c: ChallengeSolution) → Record<string, unknown>`
  - **Pre:** `c` must be a valid ChallengeSolution instance.
  - **Post:** Returns raw object suitable for wire transport. If originalPublicKey is set, legacyPublicKey is patched to 33B hex (0x-prefixed); otherwise left as-is from toRaw().
  - **Throws:** Never.
  - **Concurrency:** Safe; pure function.
  - **Determinism:** Deterministic.

**Invariants:**
- LOSSY FIX: c.toRaw() returns post-tweak 32B x-only legacyPublicKey. If c.publicKey.originalPublicKey exists (33B SEC1), override it on wire.
- Participant-side Address.fromString then reads the 33B form, triggers autoFormat, and Address ends up byte-identical to leader's live one.
- Without this patch, participant SDK calls challenge.publicKey.originalPublicKeyBuffer() and throws "Legacy public key not set".

**Cross-component contracts:**
- Depends on: `@btc-vision/transaction` (ChallengeSolution), `@btc-vision/bitcoin` (payments, toXOnly), `opnet-client` (getNetwork), `wire/hex` (fromHex).
- Used by: Orchestrator announce/reconstruct flow; leader to serialize, participants to rebuild.
- Byte/format contract: AnnounceOpnetParams (JSON blob), UTXO/ChallengeSolution serialization conventions.

**Notes / gotchas:**
- **CRITICAL:** refundAddress is locally derived (deriveVaultP2tr); operator MUST NOT supply it. Bogus refund = theft of change via OPNet SDK's change redirect.
- **CRITICAL:** ChallengeSolution.toRaw() is lossy; serializeChallengeForWire() patches legacyPublicKey back to 33B to fix participant-side SDK reconstruction.
- Optional field semantics are load-bearing: `undefined` vs. falsy must be preserved (SDK checks `if (iUTXO.raw)` which fails if raw is empty string vs. undefined).
- All conversions (hex decode, bigint parse, UTXO reconstruct) are deterministic; bad input surfaces on first SDK call, not during reconstruction.

---

**Cross-component notes (broadcast subsystem):**
1. **Determinism boundary:** BTC construction is fully deterministic (`buildBtcTxFromParams`). OPNet construction requires `utxos` + `challenge` + `rndBytesSeed` to be fully deterministic (`captureOpnetSighashes` without them uses live SDK fetches).
2. **RNG serialization:** `captureMutex` is process-global; concurrent ceremony instances are serialized at the rndBytes level (single counter sequence).
3. **Verify-key convention:** BTC uses tweaked key (output key = P2TR key path). OPNet uses tweaked for key-path, untweaked for script-path (inferred from OP_RETURN spec).
4. **ChallengeSolution quirk:** `toRaw()` lossy fix in `serializeChallengeForWire()` is a workaround for SDK Address.fromString requiring originalPublicKey.
5. **Refund address contract:** Leader locally derives via `deriveVaultP2tr()`; operator never supplies (prevents theft).

---

