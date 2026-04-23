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

import { Address } from '@btc-vision/transaction';
import { toXOnly } from '@btc-vision/bitcoin';
import { getContract } from 'opnet';
import type { NetworkName } from '../node/types.js';
import { getProvider, getNetwork, generateWallet } from '../node/opnet-client.js';
import { ThresholdMLDSASigner } from '../node/threshold-signer.js';
import { FrostPsbtSigner } from '../node/frost-psbt-signer.js';
import { computeKeyLinkHash, withFrostLegacySig } from '../node/frost-link.js';
import { resolveAbi } from './opnet-calldata.js';

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

  /**
   * Mnemonic used to construct a real `wallet.keypair` for the SDK's signer
   * slot. It is NEVER used to produce signatures that reach the chain —
   * `multiSignPsbt` intercepts every signing call and `publicKey` is
   * overridden to the untweaked FROST key. The daemon trigger layer can
   * safely pass a constant throwaway mnemonic generated once at startup.
   */
  sdkWalletMnemonic: string;

  feeRate?: number;
  priorityFee?: bigint;
  maximumAllowedSatToSpend?: bigint;
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
    sdkWalletMnemonic,
    feeRate = DEFAULT_FEE_RATE,
    priorityFee = DEFAULT_PRIORITY_FEE,
    maximumAllowedSatToSpend = DEFAULT_MAX_SAT_SPEND,
  } = inputs;

  const params = convertOpnetParams(rawParams ?? [], paramTypes);

  const provider = getProvider(networkName);
  const network = getNetwork(networkName);
  const contractAbi = resolveAbi(abi);
  const { wallet, mnemonic } = generateWallet(sdkWalletMnemonic, networkName);

  try {
    const mldsaPubKeyHex = Buffer.from(mldsaPubKey).toString('hex');
    const tweakedPubKeyHex = Buffer.from(frostTweakedPubKey).toString('hex');
    const vaultAddr = Address.fromString(mldsaPubKeyHex, tweakedPubKeyHex);

    const contract = getContract(contractAddress, contractAbi as never, provider, network, vaultAddr);
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

    const { signer: captureSigner, calls: capturedCalls } =
      FrostPsbtSigner.createCapture(tweakedPubKeyBuf, internalXOnly, untweakedPubKeyBuf);

    // Graft capture behavior onto wallet.keypair: SDK internals read fields
    // on the signer object beyond what we control; starting from a real
    // keypair and overriding multiSignPsbt + publicKey is the minimal
    // contortion that satisfies both paths.
    const hybridSigner = wallet.keypair as typeof wallet.keypair & {
      multiSignPsbt: typeof captureSigner.multiSignPsbt;
    };
    (hybridSigner as unknown as Record<string, unknown>).multiSignPsbt =
      captureSigner.multiSignPsbt.bind(captureSigner);
    Object.defineProperty(hybridSigner, 'publicKey', {
      value: untweakedPubKeyBuf,
      configurable: true,
    });

    const capturedTemplateTxs: string[] = [];
    const origSendRawPkg = (provider as unknown as Record<string, unknown>).sendRawTransactionPackage as (...args: unknown[]) => Promise<unknown>;
    const origSendRaw = (provider as unknown as Record<string, unknown>).sendRawTransaction as (...args: unknown[]) => Promise<unknown>;
    (provider as unknown as Record<string, unknown>).sendRawTransactionPackage = async (txs: string[]) => {
      capturedTemplateTxs.push(...txs);
      throw new Error('__capture_only__');
    };
    (provider as unknown as Record<string, unknown>).sendRawTransaction = async (tx: string) => {
      capturedTemplateTxs.push(tx);
      throw new Error('__capture_only__');
    };

    const sendTxParams = {
      signer: hybridSigner as never,
      mldsaSigner: thresholdSigner,
      refundTo: refundAddress,
      network,
      feeRate,
      priorityFee,
      maximumAllowedSatToSpend,
    };

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
    } catch {
      // Expected: __capture_only__ from the monkey-patched provider aborts
      // the SDK after templates are finalized. A real error leaves
      // capturedTemplateTxs empty and is surfaced by the check below.
    } finally {
      (provider as unknown as Record<string, unknown>).sendRawTransactionPackage = origSendRawPkg;
      (provider as unknown as Record<string, unknown>).sendRawTransaction = origSendRaw;
    }

    if (capturedTemplateTxs.length === 0 || capturedCalls.length < capturedTemplateTxs.length) {
      throw new Error('Capture failed — no template transactions or insufficient signing rounds');
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
    mnemonic.zeroize();
    wallet.zeroize();
  }
}
