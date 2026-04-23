/**
 * OPNet transaction broadcast with FROST signatures.
 *
 * Ported from `otzi/backend/src/routes/tx.ts` POST /broadcast (FROST path
 * only — the legacy single-keypair path is dropped since the daemon is
 * threshold-only). Takes the opaque `OpnetCaptureContext` produced by
 * `captureOpnetSighashes` plus the FROST signatures the ceremony produced
 * for each sighash, injects them into the template tx witnesses, and
 * broadcasts.
 *
 * Witness injection per input type:
 * - script-path: witness `[contractSecret, scriptSignerSig, mainSig(dummy), script, controlBlock]`
 *   — replace `witness[2]` with the FROST sig.
 * - key-path: witness `[tapKeySig(dummy)]`
 *   — replace `witness[0]` with the FROST sig.
 *
 * BIP340 verification runs under the tweaked key for key-path inputs and
 * the untweaked key for script-path inputs. A failed verify aborts before
 * broadcast so a bad FROST ceremony can be retried without burning a tx.
 */

import { Transaction, toXOnly } from '@btc-vision/bitcoin';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NetworkName } from '../node/types.js';
import { getProvider } from '../node/opnet-client.js';
import type { OpnetCaptureContext, SighashType } from './opnet-capture.js';

export interface FrostSignatureEntry {
  /** Sighash hex, matching an entry returned by captureOpnetSighashes. */
  hash: string;
  /** 64-byte BIP340 Schnorr signature as 128 hex chars. */
  signature: string;
}

export interface OpnetBroadcastInputs {
  captureContext: OpnetCaptureContext;
  frostSignatures: FrostSignatureEntry[];
  /** 33B SEC1 compressed — tweaked FROST aggregate pubkey. */
  frostTweakedPubKey: Uint8Array;
  /** 33B SEC1 compressed — untweaked FROST aggregate pubkey. */
  frostUntweakedPubKey: Uint8Array;
  network: NetworkName;
}

export interface OpnetBroadcastResult {
  transactionId: string;
}

export async function broadcastOpnetTx(
  inputs: OpnetBroadcastInputs,
): Promise<OpnetBroadcastResult> {
  const { captureContext, frostSignatures, frostTweakedPubKey, frostUntweakedPubKey, network } = inputs;

  if (captureContext.templateTxs.length === 0) {
    throw new Error('No template transactions to broadcast');
  }

  const sigsByHash = new Map<string, Uint8Array>();
  for (const fs of frostSignatures) {
    if (typeof fs.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(fs.signature)) {
      throw new Error(`Invalid FROST signature for hash ${fs.hash?.slice(0, 16) ?? '<missing>'} — must be 128 hex chars`);
    }
    sigsByHash.set(fs.hash, Buffer.from(fs.signature, 'hex'));
  }

  for (const hashHex of captureContext.sighashMap.keys()) {
    if (!sigsByHash.has(hashHex)) {
      throw new Error(`Missing FROST signature for sighash ${hashHex.slice(0, 16)}`);
    }
  }

  const tweakedXOnly = toXOnly(Buffer.from(frostTweakedPubKey) as never);
  const untweakedXOnly = toXOnly(Buffer.from(frostUntweakedPubKey) as never);

  for (const [hashHex, mapping] of captureContext.sighashMap) {
    const sig = sigsByHash.get(hashHex)!;
    const verifyKey = mapping.type === 'key-path' ? tweakedXOnly : untweakedXOnly;
    if (!schnorr.verify(sig, Buffer.from(hashHex, 'hex'), verifyKey)) {
      throw new Error(`BIP340 verification failed for ${mapping.type} input ${mapping.inputIndex} — FROST ceremony may need to be repeated`);
    }
  }

  const modifiedTxs: string[] = [];
  for (let txIdx = 0; txIdx < captureContext.templateTxs.length; txIdx++) {
    const tx = Transaction.fromHex(captureContext.templateTxs[txIdx]!);

    for (const [hashHex, mapping] of captureContext.sighashMap) {
      if (mapping.txIndex !== txIdx) continue;
      const frostSig = sigsByHash.get(hashHex)!;
      const input = tx.ins[mapping.inputIndex];
      if (!input) {
        throw new Error(`Template tx ${txIdx} has no input at index ${mapping.inputIndex}`);
      }
      injectWitness(input.witness, frostSig, mapping.type, mapping.inputIndex);
    }

    modifiedTxs.push(tx.toHex());
  }

  const provider = getProvider(network);

  if (modifiedTxs.length >= 2) {
    const pkgResult = await provider.sendRawTransactionPackage(modifiedTxs, true);
    if (!pkgResult.success) {
      throw new Error(`Package broadcast failed: ${pkgResult.error ?? 'unknown'}`);
    }
    // Order is [funding, interaction]; the interaction tx carries the txid we return.
    const interactionResult = pkgResult.sequentialResults?.[1];
    if (interactionResult && !interactionResult.success) {
      throw new Error(`Interaction tx failed: ${interactionResult.error ?? 'unknown'}`);
    }
    return { transactionId: interactionResult?.txid ?? 'broadcast-ok' };
  }

  const txResult = await provider.sendRawTransaction(modifiedTxs[0]!, false);
  if (!txResult.success) {
    throw new Error(`Broadcast failed: ${txResult.error ?? 'unknown'}`);
  }
  return { transactionId: txResult.result ?? 'broadcast-ok' };
}

function injectWitness(
  witness: Uint8Array[],
  frostSig: Uint8Array,
  type: SighashType,
  inputIndex: number,
): void {
  if (type === 'script-path') {
    if (witness.length < 5) {
      throw new Error(`Unexpected witness length ${witness.length} for script-path input ${inputIndex}`);
    }
    witness[2] = frostSig;
  } else {
    if (witness.length < 1) {
      throw new Error(`Empty witness for key-path input ${inputIndex}`);
    }
    witness[0] = frostSig;
  }
}
