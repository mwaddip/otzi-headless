/**
 * Reconstruct OPNet capture inputs from an on-wire `AnnounceOpnetParams` blob.
 *
 * The leader computes `OpnetCaptureInputs` from operator-supplied fields +
 * provider-fetched UTXOs/challenge + a freshly-generated random-bytes seed,
 * runs the capture, and asserts all three on-wire. Participants receive the
 * announce, reconstruct equivalent capture inputs here, and re-run the capture
 * to verify the leader's asserted sighashes match. Identical inputs → identical
 * sighashes thanks to phase-1 determinism.
 *
 * Unverified pass-through for `mldsaThresholdSignatureHex`: a forged ML-DSA
 * sig would produce sighashes that still verify (they commit to tx bytes
 * including the bad sig) and fail at OPNet broadcast consensus — DoS, not
 * theft. Federation-trust posture covers this (see feedback memory).
 */

import { ChallengeSolution } from '@btc-vision/transaction';
import { payments, toXOnly } from '@btc-vision/bitcoin';
import { UTXO as OpnetUtxo } from 'opnet';
import type { ScriptPubKey } from '@btc-vision/bitcoin-rpc';
import type { AnnounceOpnetParams, AnnounceOpnetUtxoRaw } from '../core/ceremony-messages';
import { fromHex } from '../wire/hex';
import { getNetwork } from '../node/opnet-client';
import type { NetworkName } from '../node/types';
import type { OpnetCaptureInputs } from './opnet-capture';

/**
 * Node-local key material that complements the on-wire `AnnounceOpnetParams`.
 * All fields come from the peer's decrypted share + static config — they
 * are identical across peers (same DKG output), so we don't ship them on-wire.
 */
export interface OpnetParamsKeyMat {
  mldsaPubKey: Uint8Array;
  frostTweakedPubKey: Uint8Array;
  frostUntweakedPubKey: Uint8Array;
  frostLegacySig?: Uint8Array;
  network: NetworkName;
}

/**
 * Derive the vault P2TR bech32 address from its 33B SEC1-compressed untweaked
 * FROST aggregate pubkey. Leader uses this to populate `refundAddress` on
 * the wire — never operator-supplied, since a bogus address would redirect
 * the OPNet SDK's change output away from the vault (theft of change, not
 * DoS). Computed locally from DKG-derived key material so all peers agree.
 */
export function deriveVaultP2tr(
  untweakedPubKey: Uint8Array,
  networkName: NetworkName,
): string {
  const network = getNetwork(networkName);
  const internalXOnly = toXOnly(Buffer.from(untweakedPubKey) as never);
  const addr = payments.p2tr({ internalPubkey: internalXOnly as never, network }).address;
  if (!addr) throw new Error('deriveVaultP2tr: p2tr() returned no address');
  return addr;
}

/**
 * Reconstruct OPNet SDK `UTXO` instances from on-wire raw form. Mirrors the
 * SDK's own `new UTXO(iUTXO, isCSV)` constructor path — `value` comes through
 * as a decimal string (JSON-safe) and the class converts to bigint internally.
 */
export function reconstructOpnetUtxos(
  raws: ReadonlyArray<AnnounceOpnetUtxoRaw>,
): OpnetUtxo[] {
  return raws.map((u) => {
    // Match the leader-side UTXO instance shape exactly: pass-through
    // optional fields only when present on the wire so participant's UTXO
    // has identical truthy/undefined semantics (the SDK's UTXO constructor
    // checks `if (iUTXO.raw)` to install a lazy getter — empty string `''`
    // would mismatch the leader's `undefined`).
    const iUTXO: Record<string, unknown> = {
      transactionId: u.transactionId,
      outputIndex: u.outputIndex,
      value: u.value,
      scriptPubKey: u.scriptPubKey as ScriptPubKey,
    };
    if (u.raw !== undefined) iUTXO.raw = u.raw;
    if (u.witnessScript !== undefined) iUTXO.witnessScript = u.witnessScript;
    if (u.redeemScript !== undefined) iUTXO.redeemScript = u.redeemScript;
    return new OpnetUtxo(iUTXO as never, u.isCSV ?? false);
  });
}

/**
 * Reconstruct a `ChallengeSolution` from its `toRaw()` form. The SDK's
 * constructor validates structure and throws on malformed data — at the
 * orchestrator verify layer that surfaces as a silent drop.
 */
export function reconstructChallengeSolution(
  raw: Record<string, unknown>,
): ChallengeSolution {
  // The SDK's RawChallenge type is strict; cast through after the
  // parser's structural check in `parseOpnetParams`.
  return new ChallengeSolution(raw as never);
}

/**
 * Assemble the full `OpnetCaptureInputs` for `captureOpnetSighashes`.
 * Leader and participant both invoke this — leader uses its own key material
 * + self-generated seed before announcing; participant uses local key
 * material + the asserted wire values.
 *
 * Throws on any structural failure (bad hex, bad UTXO shape, bad challenge).
 * Callers should catch + silent-drop per federation-trust posture.
 */
export function buildCaptureInputsFromParams(
  p: AnnounceOpnetParams,
  keyMat: OpnetParamsKeyMat,
): OpnetCaptureInputs {
  const inputs: OpnetCaptureInputs = {
    contractAddress: p.contractAddress,
    method: p.method,
    params: [...p.params],
    ...(p.paramTypes ? { paramTypes: [...p.paramTypes] } : {}),
    network: keyMat.network,
    mldsaThresholdSignature: fromHex(p.mldsaThresholdSignatureHex),
    mldsaPubKey: keyMat.mldsaPubKey,
    frostTweakedPubKey: keyMat.frostTweakedPubKey,
    frostUntweakedPubKey: keyMat.frostUntweakedPubKey,
    ...(keyMat.frostLegacySig ? { frostLegacySig: keyMat.frostLegacySig } : {}),
    refundAddress: p.refundAddress,
    feeRate: p.feeRate,
    priorityFee: BigInt(p.priorityFeeSat),
    maximumAllowedSatToSpend: BigInt(p.maxSatToSpendSat),
    utxos: reconstructOpnetUtxos(p.utxos),
    challenge: reconstructChallengeSolution(p.challenge),
    rndBytesSeed: fromHex(p.randomBytesSeedHex),
  };
  return inputs;
}

/**
 * Serialize leader-side inputs back into the on-wire form. Used by the
 * leader when building its announce — ensures the fields the participant
 * reconstructs match bit-for-bit what the leader used during its own
 * capture.
 */
export interface SerializeOpnetParamsInputs {
  contractAddress: string;
  method: string;
  params: ReadonlyArray<unknown>;
  paramTypes?: ReadonlyArray<'address' | 'u256' | 'bytes'>;
  refundAddress: string;
  feeRate: number;
  priorityFee: bigint;
  maximumAllowedSatToSpend: bigint;
  randomBytesSeed: Uint8Array;
  mldsaThresholdSignature: Uint8Array;
  utxos: ReadonlyArray<OpnetUtxo>;
  challenge: ChallengeSolution;
  hints?: { contractAddress?: string; method?: string; amountTokenAtomic?: string };
}

export function serializeOpnetParams(
  inputs: SerializeOpnetParamsInputs,
): AnnounceOpnetParams {
  const out: AnnounceOpnetParams = {
    contractAddress: inputs.contractAddress,
    method: inputs.method,
    params: [...inputs.params],
    refundAddress: inputs.refundAddress,
    feeRate: inputs.feeRate,
    priorityFeeSat: inputs.priorityFee.toString(),
    maxSatToSpendSat: inputs.maximumAllowedSatToSpend.toString(),
    randomBytesSeedHex: Buffer.from(inputs.randomBytesSeed).toString('hex'),
    mldsaThresholdSignatureHex: Buffer.from(inputs.mldsaThresholdSignature).toString('hex'),
    utxos: inputs.utxos.map((u) => {
      const raw: AnnounceOpnetUtxoRaw = {
        transactionId: u.transactionId,
        outputIndex: u.outputIndex,
        value: u.value.toString(),
        scriptPubKey: u.scriptPubKey as unknown,
      };
      // SDK's `nonWitnessUtxoBase64` is the canonical `raw` field; the
      // instance also lazily decodes it to `nonWitnessUtxo`.
      if (u.nonWitnessUtxoBase64 !== undefined) raw.raw = u.nonWitnessUtxoBase64;
      if (u.witnessScript !== undefined && typeof u.witnessScript === 'string') {
        raw.witnessScript = u.witnessScript;
      }
      if (u.redeemScript !== undefined && typeof u.redeemScript === 'string') {
        raw.redeemScript = u.redeemScript;
      }
      if (u.isCSV !== undefined) raw.isCSV = u.isCSV;
      return raw;
    }),
    challenge: serializeChallengeForWire(inputs.challenge),
  };
  if (inputs.paramTypes) out.paramTypes = [...inputs.paramTypes];
  if (inputs.hints) {
    out.hints = {};
    if (inputs.hints.contractAddress !== undefined) out.hints.contractAddress = inputs.hints.contractAddress;
    if (inputs.hints.method !== undefined) out.hints.method = inputs.hints.method;
    if (inputs.hints.amountTokenAtomic !== undefined) out.hints.amountTokenAtomic = inputs.hints.amountTokenAtomic;
  }
  return out;
}

/**
 * `ChallengeSolution.toRaw()` is LOSSY — its `legacyPublicKey` field is the
 * post-tweak 32-byte x-only form (via `tweakedToHex`), not the original
 * 33-byte SEC1 compressed mining key. Reconstructing from the tweaked form
 * stores it as `#tweakedPublicKey` directly and skips `Address.autoFormat`,
 * which is the only path that populates `#originalPublicKey`. The OPNet SDK
 * then calls `challenge.publicKey.originalPublicKeyBuffer()` during tx
 * construction (e.g. `ConsolidatedInteractionTransaction.js:118` for the
 * epoch-challenge timelock address) and throws "Legacy public key not set".
 *
 * Fix: override `legacyPublicKey` on the wire with the 33-byte original so
 * participant-side `Address.fromString` triggers `autoFormat` and the
 * Address ends up byte-identical to the leader's live one.
 */
export function serializeChallengeForWire(c: ChallengeSolution): Record<string, unknown> {
  const raw = c.toRaw() as unknown as Record<string, unknown>;
  const original = c.publicKey.originalPublicKey;
  if (original && original.length > 0) {
    raw.legacyPublicKey = '0x' + Buffer.from(original).toString('hex');
  }
  return raw;
}
