/**
 * BTC vault prepare + broadcast for FROST-signed P2TR key-path spends.
 *
 * Ported from `otzi/backend/src/routes/btc.ts` with the Express wrapper
 * stripped. Flow:
 *   1. `prepareBtcTx` pulls UTXOs for the FROST P2TR address, greedy-selects
 *      enough to cover `amount + fee`, builds the unsigned Transaction, and
 *      computes Taproot key-path sighashes (SIGHASH_DEFAULT) for each input.
 *   2. The caller runs a FROST ceremony over the sighashes.
 *   3. `broadcastBtcTx` injects each 64-byte FROST sig as the sole witness
 *      element (key-path spend), BIP340-verifies under the untweaked x-only
 *      aggregate key, and broadcasts via the OPNet provider (testnet —
 *      Signet fork) or mempool.space (mainnet).
 */

import { randomBytes } from 'node:crypto';
import { Transaction, payments, address as btcAddress, toXOnly } from '@btc-vision/bitcoin';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NetworkName } from '../node/types.js';
import { getProvider, getNetwork } from '../node/opnet-client.js';

// Taproot key-path vbyte estimates used for fee calculation. Each input is
// ~57.5 vB (1 witness item of 64 B), each output ~43 vB (P2TR scriptPubKey),
// overhead ~10.5 vB (version + locktime + counts). Source: Ötzi's btc.ts.
const INPUT_VBYTES = 57.5;
const OUTPUT_VBYTES = 43;
const OVERHEAD_VBYTES = 10.5;

// Below this the change output is uneconomical; fold it into the fee.
const DUST_THRESHOLD_SATS = 546n;

const MEMPOOL_TX_MAINNET = 'https://mempool.space/api/tx';

export interface BtcUtxo {
  transactionId: string;
  outputIndex: number;
  value: bigint;
}

export interface PrepareBtcInputs {
  /** Destination bech32 address (must be valid for `network`). */
  to: string;
  /** Positive integer, satoshis. */
  amount: number;
  /** Positive, sat/vB. */
  feeRate: number;
  network: NetworkName;
  /** Bech32 P2TR of the FROST vault — source of UTXOs and change destination. */
  frostP2tr: string;
  /** 33B SEC1 compressed — untweaked FROST aggregate pubkey. Used as P2TR internal key. */
  frostUntweakedPubKey: Uint8Array;
}

export interface BtcSighashEntry {
  index: number;
  hash: string;
}

export interface BtcCaptureContext {
  txHex: string;
  numInputs: number;
  sighashes: BtcSighashEntry[];
  /** Opaque bookkeeping token. Not required for correctness; useful if the
   *  caller wants to correlate prepare with broadcast for logging. */
  token: string;
}

export interface PrepareBtcResult {
  sighashes: Array<BtcSighashEntry & { type: 'key-path' }>;
  captureContext: BtcCaptureContext;
  estimatedFee: number;
  changeAmount: number;
}

export interface BroadcastBtcInputs {
  captureContext: BtcCaptureContext;
  frostSignatures: Array<{ index: number; signature: string }>;
  /**
   * 33B SEC1 compressed — BIP341-tweaked FROST aggregate pubkey (= the P2TR
   * output key on-chain, = FROTS `publicKeyPackage.verifyingKey`, = Ötzi's
   * `permafrost.frostAggregateKey`). Used for BIP340 verify; FROST key-path
   * signing with `{ tweaked: true }` produces sigs valid under THIS key.
   */
  frostTweakedPubKey: Uint8Array;
  network: NetworkName;
}

export interface BroadcastBtcResult {
  txid: string;
}

export interface SelectedCoins {
  selected: BtcUtxo[];
  fee: bigint;
  change: bigint;
}

/**
 * Greedy largest-first coin selection for Taproot key-path sends.
 *
 * Picks UTXOs in descending value until `sum >= amount + est_fee`, where
 * the fee estimate grows with each input added. Returns the final fee
 * (computed with the chosen input count and 1 or 2 outputs depending on
 * whether change exceeds the dust threshold) and the resulting change.
 *
 * Throws if the UTXO set can't cover `amount + fee`.
 */
export function selectBtcUtxos(
  utxos: readonly BtcUtxo[],
  amount: bigint,
  feeRate: number,
): SelectedCoins {
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));

  let sum = 0n;
  const selected: BtcUtxo[] = [];

  for (const utxo of sorted) {
    selected.push(utxo);
    sum += utxo.value;
    const estVsize = Math.ceil(OVERHEAD_VBYTES + INPUT_VBYTES * selected.length + OUTPUT_VBYTES * 2);
    const estFee = BigInt(Math.ceil(estVsize * feeRate));
    if (sum >= amount + estFee) break;
  }

  const tentativeChange = sum - amount;
  const hasChange = tentativeChange > 0n;
  const numOutputs = hasChange ? 2 : 1;
  const vsize = Math.ceil(OVERHEAD_VBYTES + INPUT_VBYTES * selected.length + OUTPUT_VBYTES * numOutputs);
  const fee = BigInt(Math.ceil(vsize * feeRate));

  if (sum < amount + fee) {
    throw new Error(`Insufficient funds: ${sum} available, ${amount + fee} needed`);
  }

  const changeRaw = sum - amount - fee;
  const change = changeRaw > DUST_THRESHOLD_SATS ? changeRaw : 0n;

  return { selected, fee, change };
}

export async function prepareBtcTx(inputs: PrepareBtcInputs): Promise<PrepareBtcResult> {
  const { to, amount, feeRate, network: networkName, frostP2tr, frostUntweakedPubKey } = inputs;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Amount must be a positive integer (satoshis)');
  }
  if (typeof feeRate !== 'number' || feeRate <= 0) {
    throw new Error('Fee rate must be a positive number (sat/vB)');
  }

  const network = getNetwork(networkName);
  const internalXOnly = toXOnly(Buffer.from(frostUntweakedPubKey) as never);

  // Throws on invalid address — surface directly to the caller.
  btcAddress.toOutputScript(to, network);

  const provider = getProvider(networkName);
  const utxos = (await provider.utxoManager.getUTXOs({ address: frostP2tr })) as readonly BtcUtxo[];

  const { selected, fee, change } = selectBtcUtxos(utxos, BigInt(amount), feeRate);

  const p2trOutput = payments.p2tr({ internalPubkey: internalXOnly as never, network }).output!;

  const tx = new Transaction();
  tx.version = 2;

  for (const utxo of selected) {
    // addInput expects hash in internal byte order (reversed txid).
    const txidBuf = Buffer.from(utxo.transactionId.replace(/^0x/, ''), 'hex').reverse();
    tx.addInput(txidBuf as never, utxo.outputIndex);
  }

  tx.addOutput(btcAddress.toOutputScript(to, network) as never, BigInt(amount) as never);
  if (change > 0n) {
    tx.addOutput(btcAddress.toOutputScript(frostP2tr, network) as never, change as never);
  }

  // Taproot key-path sighashes — SIGHASH_DEFAULT (0x00), commits to all prevouts.
  const prevoutScripts = selected.map(() => p2trOutput);
  const prevoutValues = selected.map(u => u.value as never);

  const sighashes: BtcSighashEntry[] = [];
  for (let i = 0; i < selected.length; i++) {
    const hash = tx.hashForWitnessV1(i, prevoutScripts, prevoutValues, 0x00);
    sighashes.push({ index: i, hash: Buffer.from(hash).toString('hex') });
  }

  const captureContext: BtcCaptureContext = {
    txHex: tx.toHex(),
    numInputs: selected.length,
    sighashes,
    token: randomBytes(16).toString('hex'),
  };

  return {
    sighashes: sighashes.map(s => ({ ...s, type: 'key-path' as const })),
    captureContext,
    estimatedFee: Number(fee),
    changeAmount: Number(change),
  };
}

export async function broadcastBtcTx(inputs: BroadcastBtcInputs): Promise<BroadcastBtcResult> {
  const { captureContext, frostSignatures, frostTweakedPubKey, network: networkName } = inputs;

  if (frostSignatures.length !== captureContext.numInputs) {
    throw new Error(`Expected ${captureContext.numInputs} signatures, got ${frostSignatures.length}`);
  }

  for (const fs of frostSignatures) {
    if (typeof fs.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(fs.signature)) {
      throw new Error(`Invalid signature at index ${fs.index}: must be 128 hex chars (64 bytes)`);
    }
  }

  const xOnly = toXOnly(Buffer.from(frostTweakedPubKey) as never);

  for (const fs of frostSignatures) {
    const sighash = captureContext.sighashes.find(s => s.index === fs.index);
    if (!sighash) {
      throw new Error(`No sighash for input index ${fs.index}`);
    }
    const sigBytes = Buffer.from(fs.signature, 'hex');
    const msgBytes = Buffer.from(sighash.hash, 'hex');
    if (!schnorr.verify(sigBytes, msgBytes, xOnly)) {
      throw new Error(`BIP340 verification failed for input ${fs.index} — FROST ceremony may need to be repeated`);
    }
  }

  const tx = Transaction.fromHex(captureContext.txHex);
  for (const fs of frostSignatures) {
    tx.setWitness(fs.index, [Buffer.from(fs.signature, 'hex')]);
  }
  const rawTx = tx.toHex();

  if (networkName === 'testnet') {
    // Signet fork — broadcast via the OPNet provider that sourced the UTXOs.
    const provider = getProvider(networkName);
    const result = await provider.sendRawTransaction(rawTx, false);
    if (!result.success) {
      throw new Error(`Broadcast failed: ${result.error ?? 'unknown'}`);
    }
    return { txid: result.result ?? tx.getId() };
  }

  // Mainnet — mempool.space accepts raw-hex POST.
  const resp = await fetch(MEMPOOL_TX_MAINNET, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: rawTx,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Broadcast failed: ${errText}`);
  }
  const txid = (await resp.text()).trim();
  return { txid };
}
