import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type { NetworkName, VaultKey } from './types.js';

export const RBF_SEQUENCE = 0xfffffffd;
/** Minimum destination amount — covers the dust limit of every standard output type. */
export const MIN_SEND_SATS = 546n;
/** Dust limit of a P2TR output; smaller change is added to the fee. */
export const MIN_CHANGE_SATS = 330n;

export function btcNetwork(name: NetworkName): typeof btc.NETWORK {
  return name === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK;
}

export function outputScript(address: string, network: NetworkName): Uint8Array {
  return btc.OutScript.encode(btc.Address(btcNetwork(network)).decode(address));
}

export function isValidAddress(address: string, network: NetworkName): boolean {
  try {
    outputScript(address, network);
    return true;
  } catch {
    return false;
  }
}

/** Address for an output script, or null for non-standard scripts. */
export function scriptAddress(script: Uint8Array, network: NetworkName): string | null {
  try {
    return btc.Address(btcNetwork(network)).encode(btc.OutScript.decode(script));
  } catch {
    return null;
  }
}

export function xOnly(sec1: Uint8Array): Uint8Array {
  return sec1.length === 33 ? sec1.slice(1) : sec1;
}

export interface VaultPayment {
  address: string;
  script: Uint8Array;
  outputKey: Uint8Array; // 32-byte x-only BIP341 output key
}

/** Key-path-only Taproot payment of the vault's internal key. */
export function vaultPayment(vault: VaultKey, network: NetworkName): VaultPayment {
  const pay = btc.p2tr(xOnly(hex.decode(vault.untweakedVerifyingKey)), undefined, btcNetwork(network));
  return { address: pay.address!, script: pay.script, outputKey: pay.tweakedPubkey };
}

export function vaultParties(vault: VaultKey): number {
  return Object.keys(vault.verifyingShares).length;
}

// ── Vault key validation ──

const HEX33 = /^0[23][0-9a-fA-F]{64}$/;

function parsePoint(value: unknown, what: string) {
  if (typeof value !== 'string' || !HEX33.test(value)) throw new Error(`${what} must be a 33-byte compressed point`);
  try {
    return secp256k1.Point.fromHex(value.toLowerCase());
  } catch {
    throw new Error(`${what} is not a valid secp256k1 point`);
  }
}

/** Lagrange coefficient at x=0 for identifier i over the given identifier set. */
function lagrangeAtZero(i: bigint, ids: bigint[]): bigint {
  const n = secp256k1.Point.CURVE().n;
  const mod = (a: bigint) => ((a % n) + n) % n;
  let num = 1n;
  let den = 1n;
  for (const j of ids) {
    if (j === i) continue;
    num = mod(num * j);
    den = mod(den * (j - i));
  }
  // modular inverse via Fermat (n is prime)
  let inv = 1n;
  let base = den;
  let e = n - 2n;
  while (e > 0n) {
    if (e & 1n) inv = mod(inv * base);
    base = mod(base * base);
    e >>= 1n;
  }
  return mod(num * inv);
}

/**
 * Validate a VaultKey received from a client. Returns a normalized copy
 * (lowercase hex) or throws with a reason.
 */
export function validateVaultKey(input: unknown): VaultKey {
  if (!input || typeof input !== 'object') throw new Error('vault must be an object');
  const v = input as Record<string, unknown>;

  const minSigners = v.minSigners;
  if (typeof minSigners !== 'number' || !Number.isInteger(minSigners) || minSigners < 2) {
    throw new Error('minSigners must be an integer >= 2');
  }
  const groupKey = parsePoint(v.verifyingKey, 'verifyingKey');
  const internalKey = parsePoint(v.untweakedVerifyingKey, 'untweakedVerifyingKey');

  const shares = v.verifyingShares;
  const untweakedShares = v.untweakedVerifyingShares;
  if (!shares || typeof shares !== 'object' || !untweakedShares || typeof untweakedShares !== 'object') {
    throw new Error('verifyingShares and untweakedVerifyingShares must be objects');
  }
  const ids = Object.keys(shares as object);
  const parties = ids.length;
  if (parties < minSigners || parties > 255) throw new Error('party count must be between minSigners and 255');
  const expected = Array.from({ length: parties }, (_, k) => String(k + 1));
  const sameIds = (keys: string[]) => keys.length === parties && expected.every(id => keys.includes(id));
  if (!sameIds(ids) || !sameIds(Object.keys(untweakedShares as object))) {
    throw new Error(`share identifiers must be exactly "1".."${parties}"`);
  }

  const outShares: Record<string, string> = {};
  const outUntweaked: Record<string, string> = {};
  const untweakedPoints = new Map<bigint, ReturnType<typeof parsePoint>>();
  for (const id of expected) {
    outShares[id] = parsePoint((shares as Record<string, unknown>)[id], `verifyingShares[${id}]`).toHex(true);
    const p = parsePoint((untweakedShares as Record<string, unknown>)[id], `untweakedVerifyingShares[${id}]`);
    outUntweaked[id] = p.toHex(true);
    untweakedPoints.set(BigInt(id), p);
  }

  // The output key must be the BIP341 key-path tweak of the internal key
  const tweaked = btc.p2tr(internalKey.toBytes(true).slice(1)).tweakedPubkey;
  if (hex.encode(tweaked) !== hex.encode(groupKey.toBytes(true).slice(1))) {
    throw new Error('verifyingKey is not the Taproot tweak of untweakedVerifyingKey');
  }

  // Any T public shares must interpolate to the internal key (checked for the first and last T)
  const all = [...untweakedPoints.keys()];
  for (const subset of [all.slice(0, minSigners), all.slice(-minSigners)]) {
    let acc = secp256k1.Point.ZERO;
    for (const id of subset) acc = acc.add(untweakedPoints.get(id)!.multiply(lagrangeAtZero(id, subset)));
    if (!acc.equals(internalKey)) throw new Error('public shares do not match the group key');
  }

  return {
    minSigners,
    verifyingKey: groupKey.toHex(true),
    untweakedVerifyingKey: internalKey.toHex(true),
    verifyingShares: outShares,
    untweakedVerifyingShares: outUntweaked,
  };
}

export function sameVaultKey(a: VaultKey, b: VaultKey): boolean {
  return JSON.stringify(normalizeOrder(a)) === JSON.stringify(normalizeOrder(b));
}

function normalizeOrder(v: VaultKey): unknown {
  const sortObj = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => Number(x) - Number(y)));
  return [v.minSigners, v.verifyingKey, v.untweakedVerifyingKey, sortObj(v.verifyingShares), sortObj(v.untweakedVerifyingShares)];
}

// ── Transaction building ──

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
}

export interface Prevout {
  txid: string;
  vout: number;
  amount: number;
  script: string; // hex
}

export interface PreparedSend {
  tx: string;          // unsigned tx hex (no witness)
  prevouts: Prevout[];
  amount: bigint;
  fee: bigint;
  change: bigint;
  vsize: number;
}

export class InsufficientFundsError extends Error {
  constructor(readonly available: bigint, readonly needed: bigint) {
    super('Insufficient funds');
  }
}

function varintSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

/** vsize of a transaction with `inputs` key-path Taproot inputs and the given output scripts. */
export function estimateVsize(inputs: number, outputScripts: Uint8Array[]): number {
  const outputsSize = outputScripts.reduce((s, sc) => s + 8 + varintSize(sc.length) + sc.length, 0);
  const base = 4 + varintSize(inputs) + inputs * 41 + varintSize(outputScripts.length) + outputsSize + 4;
  // witness: marker+flag (2 WU) + per input: item count (1) + length (1) + 64-byte signature
  return Math.ceil((base * 4 + 2 + inputs * 66) / 4);
}

function feeFor(vsize: number, feeRate: number): bigint {
  return BigInt(Math.ceil(vsize * feeRate));
}

export function buildSend(params: {
  utxos: Utxo[];
  vault: VaultKey;
  network: NetworkName;
  to: string;
  amount: bigint | 'max';
  feeRate: number;
}): PreparedSend {
  const { utxos, vault, network, to, amount, feeRate } = params;
  const vaultScript = vaultPayment(vault, network).script;
  const destScript = outputScript(to, network);
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, u) => s + BigInt(u.value), 0n);

  let selected: Utxo[];
  let sendAmount: bigint;
  let fee: bigint;
  let change = 0n;

  if (amount === 'max') {
    selected = sorted;
    fee = feeFor(estimateVsize(selected.length, [destScript]), feeRate);
    sendAmount = total - fee;
    if (selected.length === 0 || sendAmount < MIN_SEND_SATS) {
      throw new InsufficientFundsError(total, fee + MIN_SEND_SATS);
    }
  } else {
    selected = [];
    let sum = 0n;
    let done = false;
    sendAmount = amount;
    fee = 0n;
    for (const u of sorted) {
      selected.push(u);
      sum += BigInt(u.value);
      const feeNoChange = feeFor(estimateVsize(selected.length, [destScript]), feeRate);
      if (sum < amount + feeNoChange) continue;
      const feeWithChange = feeFor(estimateVsize(selected.length, [destScript, vaultScript]), feeRate);
      const leftover = sum - amount - feeWithChange;
      if (leftover >= MIN_CHANGE_SATS) {
        fee = feeWithChange;
        change = leftover;
      } else {
        fee = sum - amount;
      }
      done = true;
      break;
    }
    if (!done) {
      const needed = amount + feeFor(estimateVsize(Math.max(sorted.length, 1), [destScript]), feeRate);
      throw new InsufficientFundsError(total, needed);
    }
  }

  const tx = new btc.Transaction({ version: 2, lockTime: 0 });
  for (const u of selected) tx.addInput({ txid: u.txid, index: u.vout, sequence: RBF_SEQUENCE });
  tx.addOutput({ script: destScript, amount: sendAmount });
  if (change > 0n) tx.addOutput({ script: vaultScript, amount: change });

  const outputs = change > 0n ? [destScript, vaultScript] : [destScript];
  return {
    tx: hex.encode(tx.unsignedTx),
    prevouts: selected.map(u => ({ txid: u.txid, vout: u.vout, amount: u.value, script: hex.encode(vaultScript) })),
    amount: sendAmount,
    fee,
    change,
    vsize: estimateVsize(selected.length, outputs),
  };
}

/** BIP341 SIGHASH_DEFAULT key-path sighashes for every input. */
export function computeSighashes(txHex: string, prevouts: Prevout[]): Uint8Array[] {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
  const scripts = prevouts.map(p => hex.decode(p.script));
  const amounts = prevouts.map(p => BigInt(p.amount));
  return prevouts.map((_, i) => tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts));
}

/** Verify BIP340 signatures against the sighashes and return the signed raw tx hex. */
export function finalizeSend(
  txHex: string,
  prevouts: Prevout[],
  signatures: Array<{ index: number; signature: string }>,
  outputKey: Uint8Array,
): { hex: string; txid: string } {
  const sighashes = computeSighashes(txHex, prevouts);
  if (signatures.length !== sighashes.length) {
    throw new Error(`Expected ${sighashes.length} signatures, got ${signatures.length}`);
  }
  const byIndex = new Map<number, Uint8Array>();
  for (const s of signatures) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= sighashes.length || byIndex.has(s.index)) {
      throw new Error(`Invalid signature index ${s.index}`);
    }
    if (typeof s.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(s.signature)) {
      throw new Error(`Invalid signature at index ${s.index}: must be 128 hex chars`);
    }
    const sig = hex.decode(s.signature.toLowerCase());
    if (!schnorr.verify(sig, sighashes[s.index]!, outputKey)) {
      throw new Error(`BIP340 verification failed for input ${s.index}`);
    }
    byIndex.set(s.index, sig);
  }

  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
  for (const [i, sig] of byIndex) tx.updateInput(i, { finalScriptWitness: [sig] }, true);
  return { hex: hex.encode(tx.toBytes(true, true)), txid: tx.id };
}
