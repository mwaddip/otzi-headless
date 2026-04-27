/**
 * OPNet contract-call sighash capture.
 *
 * Ported from `otzi/backend/src/routes/tx.ts` POST /sighash (lines 251-416)
 * with the Express wrapper stripped. Given a contract method call and the
 * precomputed ML-DSA threshold signature, drives the OPNet SDK through
 * transaction construction with a dummy-sig FROST signer, capturing the
 * finalized template tx hex and per-input sighashes for a subsequent
 * FROST ceremony.
 *
 * Mechanism:
 * 1. `FrostPsbtSigner.createCapture` builds a signer whose `multiSignPsbt`
 *    returns 64 dummy-zero sigs; the SDK's finalization accepts these and
 *    proceeds to broadcast. (Sighashes are captured along the way.)
 * 2. `sendRawTransaction(Package)` on the provider is monkey-patched to
 *    record the finalized tx hex, then throw `__capture_only__` — aborting
 *    the real broadcast.
 * 3. If DKG produced a V3 `frostLegacySig`, the whole call is wrapped in
 *    `withFrostLegacySig` so the SDK's internal key-link schnorr signing
 *    returns the precomputed FROST legacy sig instead of signing with the
 *    wallet's (wrong) private key.
 *
 * The returned `captureContext` is passed to `broadcastOpnetTx` once the
 * FROST ceremony produces real per-sighash signatures.
 */

import { createHmac } from 'node:crypto';
import { Address, BitcoinUtils, ChallengeSolution } from '@btc-vision/transaction';
import { toXOnly } from '@btc-vision/bitcoin';
import { getContract, UTXO as OpnetUtxo } from 'opnet';
import type { NetworkName } from '../node/types.js';
import { getProvider, getNetwork } from '../node/opnet-client.js';
import { ThresholdMLDSASigner } from '../node/threshold-signer.js';
import { computeKeyLinkHash, withFrostLegacySig } from '../node/frost-link.js';
import { resolveAbi } from './opnet-calldata.js';
import { CapturingProvider, isCaptureOnlyError } from './capturing-provider.js';
import { CaptureSigner } from './capture-signer.js';

const DEFAULT_FEE_RATE = 10;
const DEFAULT_PRIORITY_FEE = 1000n;
const DEFAULT_MAX_SAT_SPEND = 100000n;

export type SighashType = 'script-path' | 'key-path';
export type ParamType = 'address' | 'u256' | 'bytes';

/**
 * Convert OPNet contract method arguments from wire-shape (strings) into the
 * SDK-native shapes (`Address`, `bigint`, raw unknown for pass-through).
 * Exported for testability — called internally by `captureOpnetSighashes`.
 */
export function convertOpnetParams(
  rawParams: readonly unknown[],
  paramTypes: readonly ParamType[] | undefined,
): unknown[] {
  return rawParams.map((val, i) => {
    const t = paramTypes?.[i];
    const s = String(val);
    if (t === 'address') return Address.wrap(Buffer.from(s.replace(/^0[xX]/, ''), 'hex'));
    if (t === 'u256') return BigInt(s);
    return val;
  });
}

export interface OpnetCaptureInputs {
  contractAddress: string;
  method: string;
  params: unknown[];
  paramTypes?: ParamType[];
  abi?: unknown;
  network: NetworkName;

  /** Precomputed ML-DSA threshold signature (outer OPNet tx-level auth). */
  mldsaThresholdSignature: Uint8Array;
  /** ML-DSA combined public key (1312/1952/2592 bytes, level-dependent). */
  mldsaPubKey: Uint8Array;

  /** 33B SEC1 compressed — tweaked FROST aggregate pubkey (= permafrost.frostAggregateKey). */
  frostTweakedPubKey: Uint8Array;
  /** 33B SEC1 compressed — untweaked FROST aggregate pubkey (= permafrost.frostUntweakedAggregateKey). */
  frostUntweakedPubKey: Uint8Array;
  /** 64B BIP340 key-link signature. Required iff the vault was DKG'd with V3 shares. */
  frostLegacySig?: Uint8Array;

  /** Bech32 P2TR refund address — typically `permafrost.frostP2tr`. */
  refundAddress: string;

  feeRate?: number;
  priorityFee?: bigint;
  maximumAllowedSatToSpend?: bigint;

  /**
   * UTXO snapshot the operator asserts the vault holds. When set, skips the
   * SDK's implicit provider fetch (`provider.utxoManager.getUTXOs`) — required
   * for cross-peer determinism on construction-params (`protocol: 'opnet-params'`).
   * When unset, SDK falls back to its default UTXO fetcher (legacy `protocol: 'opnet'`
   * raw-tx path only — the leader builds once, participants verify against the bytes).
   */
  utxos?: OpnetUtxo[];

  /**
   * Network challenge solution. When set, skips the SDK's implicit
   * `provider.getChallenge()` RPC fetch (which is network-derived and
   * non-deterministic across peers). Leader fetches once and asserts on-wire;
   * participants use the same. If the leader lies, broadcast fails at OPNet
   * consensus — wasted ceremony, no theft.
   */
  challenge?: ChallengeSolution;

  /**
   * 32-byte seed enabling deterministic `BitcoinUtils.rndBytes()` during
   * capture. The OPNet CallResult layer does NOT forward `params.randomBytes`
   * through to the tx factory (it accepts `utxos` and `challenge` as
   * first-class construction inputs but silently drops `randomBytes`), so the
   * only way to make the full `sendTransaction` path deterministic is to
   * monkey-patch the global RNG source for the duration of the capture.
   * Each `rndBytes()` call returns `HMAC-SHA-512(seed, BE32(counter))` with
   * a counter that increments per call — same seed → same sequence across
   * peers. Restores the original `BitcoinUtils.rndBytes` in `finally`. A
   * module-level mutex (`captureMutex`) serializes captures so concurrent
   * ones don't interleave counter sequences.
   */
  rndBytesSeed?: Uint8Array;
}

export interface CapturedSighash {
  index: number;
  hash: string;
  type: SighashType;
}

export interface OpnetCaptureContext {
  templateTxs: string[];
  sighashMap: Map<string, { txIndex: number; inputIndex: number; type: SighashType }>;
}

export interface OpnetCaptureResult {
  sighashes: CapturedSighash[];
  captureContext: OpnetCaptureContext;
}

/**
 * HMAC-SHA-512(seed, BE32(counter)) → 64 bytes. Exported for testability and
 * for producers that want to pre-generate a deterministic sequence offline.
 * Counter is 0-indexed: `deriveCaptureRndBytes(seed, 0)` is the first chunk.
 */
export function deriveCaptureRndBytes(seed: Uint8Array, counter: number): Uint8Array {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`deriveCaptureRndBytes: counter must be a non-negative integer (got ${counter})`);
  }
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter, 0);
  return new Uint8Array(createHmac('sha512', seed).update(counterBuf).digest());
}

interface RndBytesPatchHandle {
  restore: () => void;
  /** Number of times the patched rndBytes was called. Useful for test assertions. */
  getCallCount: () => number;
}

/**
 * Install a deterministic stand-in for `BitcoinUtils.rndBytes` derived from
 * `seed`. Returns a handle whose `restore()` reinstates the original. Idempotent
 * across concurrent captures only when serialized by `captureMutex` — calling
 * this twice without restoring between leaves the inner call stomping the
 * outer's counter.
 */
export function installRndBytesPatch(seed: Uint8Array): RndBytesPatchHandle {
  const original = BitcoinUtils.rndBytes;
  let counter = 0;
  BitcoinUtils.rndBytes = () => deriveCaptureRndBytes(seed, counter++);
  return {
    restore: () => { BitcoinUtils.rndBytes = original; },
    getCallCount: () => counter,
  };
}

// Module-level mutex — serializes captures process-wide so the rndBytes patch
// and the sendRawTransaction monkey-patches don't interleave. Leader runs
// captures one-at-a-time; participants do too, but multiple ceremonies
// overlapping is possible. Lock is trivial and always engaged (even when no
// determinism knobs are set) since the sendRawTransaction patches are
// process-global regardless.
let captureMutex: Promise<void> = Promise.resolve();

async function acquireCaptureLock(): Promise<() => void> {
  const prev = captureMutex;
  let release!: () => void;
  captureMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  return release;
}

export async function captureOpnetSighashes(
  inputs: OpnetCaptureInputs,
): Promise<OpnetCaptureResult> {
  const {
    contractAddress,
    method,
    params: rawParams,
    paramTypes,
    abi,
    network: networkName,
    mldsaThresholdSignature,
    mldsaPubKey,
    frostTweakedPubKey,
    frostUntweakedPubKey,
    frostLegacySig,
    refundAddress,
    feeRate = DEFAULT_FEE_RATE,
    priorityFee = DEFAULT_PRIORITY_FEE,
    maximumAllowedSatToSpend = DEFAULT_MAX_SAT_SPEND,
    utxos: assertedUtxos,
    challenge: assertedChallenge,
    rndBytesSeed,
  } = inputs;

  const params = convertOpnetParams(rawParams ?? [], paramTypes);

  const releaseLock = await acquireCaptureLock();
  const rndBytesPatch = rndBytesSeed ? installRndBytesPatch(rndBytesSeed) : null;

  const realProvider = getProvider(networkName);
  const network = getNetwork(networkName);
  const contractAbi = resolveAbi(abi);

  const capturingProvider = new CapturingProvider(realProvider as never);

  try {
    const mldsaPubKeyHex = Buffer.from(mldsaPubKey).toString('hex');
    const tweakedPubKeyHex = Buffer.from(frostTweakedPubKey).toString('hex');
    const vaultAddr = Address.fromString(mldsaPubKeyHex, tweakedPubKeyHex);

    const contract = getContract(
      contractAddress,
      contractAbi as never,
      capturingProvider.proxy as never,
      network,
      vaultAddr,
    );
    const fn = (contract as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      throw new Error(`Method '${method}' not found on contract ${contractAddress}`);
    }

    const callResult = await (fn as (...args: unknown[]) => Promise<{
      revert?: string;
      sendTransaction: (params: unknown) => Promise<{ transactionId: string; estimatedFees?: bigint }>;
    }>).call(contract, ...params);

    if (callResult.revert) {
      throw new Error(`Simulation reverted: ${callResult.revert}`);
    }

    const thresholdSigner = new ThresholdMLDSASigner(mldsaThresholdSignature, mldsaPubKey);

    const tweakedPubKeyBuf = Buffer.from(frostTweakedPubKey);
    const untweakedPubKeyBuf = Buffer.from(frostUntweakedPubKey);
    const internalXOnly = toXOnly(untweakedPubKeyBuf as never);

    const captureSigner = new CaptureSigner(tweakedPubKeyBuf, internalXOnly, untweakedPubKeyBuf);

    const sendTxParams = {
      signer: captureSigner as never,
      mldsaSigner: thresholdSigner,
      refundTo: refundAddress,
      network,
      feeRate,
      priorityFee,
      maximumAllowedSatToSpend,
      // When operator-asserted, skips the SDK's provider fetch.
      ...(assertedUtxos !== undefined ? { utxos: assertedUtxos } : {}),
      ...(assertedChallenge !== undefined ? { challenge: assertedChallenge } : {}),
    };

    let sdkError: unknown;
    try {
      if (frostLegacySig) {
        const keyLinkHash = computeKeyLinkHash(mldsaPubKey, frostTweakedPubKey, frostUntweakedPubKey, networkName);
        await withFrostLegacySig(
          keyLinkHash, frostLegacySig, frostTweakedPubKey,
          () => callResult.sendTransaction(sendTxParams),
        );
      } else {
        await callResult.sendTransaction(sendTxParams);
      }
    } catch (err) {
      // `__capture_only__` is the expected sentinel — CapturingProvider
      // throws it after templates are finalized to abort broadcast.
      // Other errors are real and need to surface for diagnosis.
      if (!isCaptureOnlyError(err)) sdkError = err;
    }

    const capturedTemplateTxs = [...capturingProvider.capturedTxs];
    const capturedCalls = captureSigner.calls;

    if (capturedTemplateTxs.length === 0 || capturedCalls.length < capturedTemplateTxs.length) {
      const detail = sdkError instanceof Error ? `: ${sdkError.message}` : sdkError !== undefined ? `: ${String(sdkError)}` : '';
      const out = new Error(`Capture failed — no template transactions or insufficient signing rounds${detail}`);
      if (sdkError instanceof Error && sdkError.stack) {
        (out as Error & { cause?: unknown }).cause = sdkError;
      }
      throw out;
    }

    // signInteraction invokes multiSignPsbt multiple times (fee estimation
    // rounds + final builds). Only the last N calls correspond to the N
    // template txs that sendRawTransactionPackage recorded, in the same
    // [funding, interaction] order.
    const numTxs = capturedTemplateTxs.length;
    const finalCalls = capturedCalls.slice(-numTxs);

    const sighashMap = new Map<string, { txIndex: number; inputIndex: number; type: SighashType }>();
    const sighashes: CapturedSighash[] = [];
    let idx = 0;
    for (let txIdx = 0; txIdx < finalCalls.length; txIdx++) {
      for (const sh of finalCalls[txIdx]!.sighashes) {
        const hashHex = Buffer.from(sh.hash).toString('hex');
        sighashMap.set(hashHex, { txIndex: txIdx, inputIndex: sh.inputIndex, type: sh.type });
        sighashes.push({ index: idx++, hash: hashHex, type: sh.type });
      }
    }

    if (sighashes.length === 0) {
      throw new Error('No sighashes captured from final transaction builds');
    }

    return { sighashes, captureContext: { templateTxs: capturedTemplateTxs, sighashMap } };
  } finally {
    rndBytesPatch?.restore();
    releaseLock();
  }
}
