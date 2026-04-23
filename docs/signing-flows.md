# Ötzi — Signing Flow Reference

Visual reference for the two main ceremonies: key generation (DKG) and transaction signing.

---

## DKG Ceremony (Key Generation)

Creates both an ML-DSA threshold signing key (post-quantum, for OPNet contract calls) and a FROST threshold BTC key (secp256k1, for funding transactions). Nine steps, one uninterrupted session.

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                         DKG CEREMONY                               │
 │                                                                    │
 │  Party A (leader)          Relay           Party B (joiner)        │
 │  ─────────────────         ─────           ──────────────────      │
 │                                                                    │
 │  ① JOIN                                                            │
 │  Create session ──────────────────────────► Join with code         │
 │  Set T, N, level                           Receive session config  │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                     ML-DSA PHASES                                  │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │  ② COMMIT — ML-DSA Phase 1                                        │
 │  Generate random nonces ◄════════════════► Generate random nonces  │
 │  Broadcast commitments                     Broadcast commitments   │
 │  · Each party commits to secret randomness without revealing it    │
 │                                                                    │
 │  ③ REVEAL — ML-DSA Phase 2                                        │
 │  Reveal public blobs   ◄════════════════► Reveal public blobs      │
 │  Send private shares ──── per-party ────► Receive private shares   │
 │  · Polynomial secret sharing: each party gets a unique private     │
 │    share that only they can use                                    │
 │                                                                    │
 │  ④ MASKS — ML-DSA Phase 3                                         │
 │  Compute mask values   ◄════════════════► Compute mask values      │
 │  Broadcast responses                      Broadcast responses      │
 │  · Zero-knowledge proofs that shares are consistent                │
 │  · SHA-256 checksums for blob integrity                            │
 │                                                                    │
 │  ⑤ AGGREGATE — ML-DSA Phase 4                                     │
 │  Aggregate all masks   ◄════════════════► Aggregate all masks      │
 │  ═══ Combined ML-DSA public key derived ═══                       │
 │  · All parties independently verify the same combined public key   │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                     FROST PHASES                                   │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │  ⑥ FROST-COMMIT — FROST DKG Round 1                               │
 │  Generate secp256k1    ◄════════════════► Generate secp256k1       │
 │  nonces + commitments                     nonces + commitments     │
 │  · Verifiable secret sharing over secp256k1 (BIP340-compatible)    │
 │                                                                    │
 │  ⑦ FROST-SHARES — FROST DKG Round 2                               │
 │  Distribute key shares ◄════════════════► Distribute key shares    │
 │  ═══ FROST aggregate key derived (BTC address) ═══                │
 │  · Each party holds a KeyPackage with their signing share          │
 │  · Untweaked + tweaked aggregate keys computed                     │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                     KEY LINK                                       │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │  ⑧ FROST-LINK — Key-Link Signing                                  │
 │  Compute key-link hash ◄════════════════► Compute key-link hash    │
 │  FROST-sign the hash   ◄════════════════► FROST-sign the hash      │
 │  (2-round FROST ceremony over the link message)                    │
 │  · Binds ML-DSA identity to FROST BTC key for OPNet verification   │
 │  · Legacy Schnorr sig stored in config for transaction injection   │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │  ⑨ COMPLETE                                                        │
 │  Download encrypted    ◄════════════════► Download encrypted       │
 │  share file (V3)                          share file (V3)          │
 │  · Share file contains ML-DSA ThresholdKeyShare + FROST KeyPackage │
 │  · Server auto-generates internal wallet for SDK protocol sigs     │
 │  · FROST P2TR address derived as the vault's BTC address           │
 └─────────────────────────────────────────────────────────────────────┘
```

### What each party holds after DKG

| Data | Where | Purpose |
|------|-------|---------|
| Encrypted share file (`.json`) | Downloaded locally | ML-DSA key share + FROST key package |
| Combined ML-DSA public key | In share file + server config | OPNet contract signing identity |
| FROST aggregate key (tweaked) | Server config | BTC P2TR address derivation |
| FROST aggregate key (untweaked) | Server config | Taproot internal key for signing |
| FROST legacy signature | Server config | Key-link proof for OPNet VM |
| Auto-generated wallet | Server config only | SDK protocol-level sigs (not user-facing) |

---

## Transaction Signing

Signs and broadcasts an OPNet contract call. Two ceremonies back-to-back: ML-DSA (3 rounds) produces the contract signature, then FROST (2 rounds) signs the Bitcoin transaction inputs. From the user's perspective, this is one continuous flow.

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                     TRANSACTION SIGNING                            │
 │                                                                    │
 │  Leader                   Relay              Joiner(s)             │
 │  ──────                   ─────              ─────────             │
 │                                                                    │
 │  BUILD TRANSACTION                                                 │
 │  Select contract + method                                          │
 │  Enter parameters ────────────────────────►  Receive tx details    │
 │  Load share file + password                  Load share file + pw  │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             ML-DSA THRESHOLD SIGNING (3 rounds)                    │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  ROUND 1 — Commitments                                            │
 │  Generate random nonces ◄════════════════► Generate random nonces  │
 │  Broadcast commitment                      Broadcast commitment    │
 │  · Each party commits to signing randomness                        │
 │                                                                    │
 │  ROUND 2 — Proofs                                                  │
 │  Compute proof blob    ◄════════════════► Compute proof blob       │
 │  Broadcast proof                          Broadcast proof          │
 │  · Zero-knowledge proofs of correct participation                  │
 │                                                                    │
 │  ROUND 3 — Signature shares                                        │
 │  Compute partial sig   ◄════════════════► Compute partial sig      │
 │  Broadcast response                       Broadcast response       │
 │  · Each party contributes their share of the final signature       │
 │                                                                    │
 │  COMBINE (leader only)                                             │
 │  Aggregate all shares ═══════════════════► Receive COMPLETE msg    │
 │  ═══ ML-DSA signature produced ═══                                │
 │  · FIPS 204 threshold signature over the message hash              │
 │  · If norm check fails, auto-retry from Round 1 (up to 50×)       │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             TEMPLATE TX CAPTURE (leader's backend)                 │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  POST /api/tx/sighash                                              │
 │  ┌──────────────────────────────────────┐                          │
 │  │ Build OPNet tx with DummySigner      │                          │
 │  │ Capture sighash per input:           │                          │
 │  │   input 0: hash=abc... (script-path) │                          │
 │  │   input 1: hash=def... (key-path)    │                          │
 │  │   input 2: hash=ghi... (key-path)    │                          │
 │  │ Cache template txs + challengeToken  │                          │
 │  └──────────────────────────────────────┘                          │
 │  Broadcast sighashes ════════════════════► Receive sighashes       │
 │  · Template tx has dummy sigs — real FROST sigs injected later     │
 │  · Script-path = OPNet interaction input                           │
 │  · Key-path = BTC funding inputs                                   │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             FROST BTC SIGNING (2 rounds × N sighashes)             │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  FROST ROUND 1 — Nonces (batched over all sighashes)               │
 │  For each sighash:     ◄════════════════► For each sighash:        │
 │    signRound1() →                           signRound1() →         │
 │    nonces + commitment                      nonces + commitment    │
 │  Broadcast R1 blob                        Broadcast R1 blob        │
 │  · All sighashes handled in one blob exchange round                │
 │                                                                    │
 │  FROST ROUND 2 — Partial signatures (batched)                      │
 │  For each sighash:     ◄════════════════► For each sighash:        │
 │    signRound2() →                           signRound2() →         │
 │    partial BIP340 sig                       partial BIP340 sig     │
 │  Broadcast R2 blob                        Broadcast R2 blob        │
 │  · Each partial sig is a 64-byte Schnorr signature share           │
 │                                                                    │
 │  FROST AGGREGATE (leader only)                                     │
 │  For each sighash:                                                 │
 │    signAggregate() →                                               │
 │    64-byte Schnorr sig ══════════════════► Receive FROST-COMPLETE  │
 │  ═══ BIP340 signatures produced (one per input) ═══               │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             BROADCAST (leader's backend)                           │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  POST /api/tx/broadcast                                            │
 │  ┌──────────────────────────────────────┐                          │
 │  │ Retrieve cached template txs         │                          │
 │  │ Inject FROST sigs into witness:      │                          │
 │  │   script-path → witness[2]           │                          │
 │  │   key-path    → witness[0]           │                          │
 │  │ Inject key-link legacy sig           │                          │
 │  │ Send to OPNet network                │                          │
 │  └──────────────────────────────────────┘                          │
 │  ═══ Transaction broadcast ═══            See result               │
 │  · Server-side lock prevents double-broadcast                      │
 │  · Other parties polling /broadcast-status get cached result       │
 └─────────────────────────────────────────────────────────────────────┘
```

### Signature summary

| Signature | Algorithm | Purpose | Produced by |
|-----------|-----------|---------|-------------|
| ML-DSA threshold sig | FIPS 204 (Dilithium) | OPNet contract call authorization | 3-round ceremony, leader combines |
| FROST Schnorr sigs | BIP340 (secp256k1-SHA256-TR) | Bitcoin transaction input signing | 2-round ceremony, leader aggregates |
| Key-link legacy sig | BIP340 via FROST | Binds ML-DSA identity → BTC key | Produced once during DKG, stored in config |

### Why two signature schemes?

OPNet transactions require **two layers of authorization**:

1. **Contract layer** (ML-DSA): The OPNet VM verifies that the contract call was authorized by the vault's ML-DSA public key. This is a post-quantum signature — resistant to future quantum attacks.

2. **Bitcoin layer** (FROST/Schnorr): The Bitcoin network requires valid Taproot signatures on every transaction input. FROST produces standard BIP340 signatures that are indistinguishable from single-key signatures on-chain.

The **key-link** ties them together: a FROST signature over a message binding both public keys, verified by the OPNet VM to confirm that the ML-DSA signer controls the BTC address.

---

## BTC Vault Send

Sends BTC from the FROST P2TR address to any Bitcoin address. FROST-only — no ML-DSA, no OPNet SDK. Simpler and faster than contract signing.

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                       BTC VAULT SEND                               │
 │                                                                    │
 │  Leader                   Relay              Joiner(s)             │
 │  ──────                   ─────              ─────────             │
 │                                                                    │
 │  PREPARE TRANSACTION                                               │
 │  Enter destination addr                                            │
 │  Enter amount + fee rate                                           │
 │  Click "Initiate"                                                  │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             TX CONSTRUCTION (leader's backend)                     │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  POST /api/btc/prepare                                             │
 │  ┌──────────────────────────────────────┐                          │
 │  │ Fetch UTXOs for FROST P2TR address   │                          │
 │  │ Coin selection (largest first)       │                          │
 │  │ Build Transaction (key-path only):   │                          │
 │  │   inputs: selected UTXOs             │                          │
 │  │   output 1: destination (amount)     │                          │
 │  │   output 2: change → FROST P2TR     │                          │
 │  │ Compute sighash per input (0x00)     │                          │
 │  │ Cache tx + challengeToken (5 min)    │                          │
 │  └──────────────────────────────────────┘                          │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             RELAY SESSION                                          │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  Load share file + pw                    Load share file + pw      │
 │  Create relay session ──────────────────► Join with code           │
 │  Broadcast sighashes  ══════════════════► Receive sighashes        │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             FROST BTC SIGNING (2 rounds)                           │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  FROST ROUND 1 — Nonces                                           │
 │  For each sighash:     ◄════════════════► For each sighash:        │
 │    signRound1() →                           signRound1() →         │
 │    nonces + commitment                      nonces + commitment    │
 │  · All inputs are key-path (tweaked: true)                         │
 │                                                                    │
 │  FROST ROUND 2 — Partial signatures                                │
 │  For each sighash:     ◄════════════════► For each sighash:        │
 │    signRound2() →                           signRound2() →         │
 │    partial Schnorr sig                      partial Schnorr sig    │
 │                                                                    │
 │  FROST AGGREGATE (leader only)                                     │
 │  For each sighash:                                                 │
 │    signAggregate() →                                               │
 │    64-byte Schnorr sig ══════════════════► Receive FROST-COMPLETE  │
 │  ═══ BIP340 signatures produced ═══                               │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │             BROADCAST (leader's backend)                           │
 │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
 │                                                                    │
 │  POST /api/btc/broadcast                                           │
 │  ┌──────────────────────────────────────┐                          │
 │  │ Retrieve cached tx                   │                          │
 │  │ Inject FROST sigs as key-path        │                          │
 │  │   witness = [64-byte Schnorr sig]    │                          │
 │  │ Broadcast to network                 │                          │
 │  └──────────────────────────────────────┘                          │
 │  ═══ Transaction broadcast ═══            See result               │
 └─────────────────────────────────────────────────────────────────────┘
```

### Key differences from contract signing

| Aspect | Contract signing | BTC vault send |
|--------|-----------------|---------------|
| ML-DSA ceremony | Required (3 rounds) | Skipped |
| FROST ceremony | 2 rounds | 2 rounds |
| Input types | Mixed (script-path + key-path) | Key-path only |
| TX construction | OPNet SDK capture pattern | Direct Transaction build |
| Broadcast target | OPNet provider | OPNet provider (testnet) / mempool.space (mainnet) |

---

### Template transaction approach

Rather than having the SDK re-derive transactions (which involves non-deterministic UTXO selection and fee estimation), Ötzi uses a **capture-and-inject** pattern:

1. **Capture**: Build the full transaction with a dummy signer that records every sighash the SDK requests, producing template transactions with placeholder signatures.
2. **Sign**: Run the FROST ceremony over the captured sighashes.
3. **Inject**: Replace the placeholder signatures in the template transactions with real FROST signatures.
4. **Broadcast**: Send the final transactions to the network.

This avoids the problem of the SDK producing a different transaction on rebuild (different UTXOs, different fees), which would invalidate the FROST signatures.
