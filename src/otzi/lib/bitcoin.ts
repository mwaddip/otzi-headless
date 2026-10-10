/**
 * Bitcoin helpers: addresses, the vault address, and analysis of send
 * proposals. Every signer runs analyzeProposal() on the transaction it is
 * asked to sign and signs only the sighashes computed here.
 */

import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { NetworkName, VaultKey, SendProposal } from './vault-types';
import type { SighashInfo } from './frost-sign';

export const RBF_SEQUENCE = 0xfffffffd;

export function btcNetwork(network: NetworkName): typeof btc.NETWORK {
  return network === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK;
}

export function isValidAddress(address: string, network: NetworkName): boolean {
  try {
    btc.Address(btcNetwork(network)).decode(address);
    return true;
  } catch {
    return false;
  }
}

/** Address of an output script, or null for non-standard scripts. */
export function scriptAddress(script: Uint8Array, network: NetworkName): string | null {
  try {
    return btc.Address(btcNetwork(network)).encode(btc.OutScript.decode(script));
  } catch {
    return null;
  }
}

export interface VaultPayment {
  address: string;
  script: Uint8Array;
  outputKey: Uint8Array;
}

/** Key-path-only P2TR payment for the vault internal key (33-byte SEC1 hex). */
export function vaultPaymentFromInternalKey(internalKey: string, network: NetworkName): VaultPayment {
  const pay = btc.p2tr(hex.decode(internalKey).slice(1), undefined, btcNetwork(network));
  return { address: pay.address!, script: pay.script, outputKey: pay.tweakedPubkey };
}

export function vaultPayment(vault: VaultKey, network: NetworkName): VaultPayment {
  return vaultPaymentFromInternalKey(vault.untweakedVerifyingKey, network);
}

export function vaultParties(vault: VaultKey): number {
  return Object.keys(vault.verifyingShares).length;
}

// ── Proposal analysis ──

export interface ProposalOutput {
  address: string;
  amount: number;
  isChange: boolean;
}

export interface ProposalAnalysis {
  txid: string;
  inputs: Array<{ txid: string; vout: number; amount: number }>;
  outputs: ProposalOutput[];
  totalIn: number;
  totalOut: number;
  fee: number;
  vsize: number;
  feeRate: number;
  sighashes: SighashInfo[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Decode, check and compute sighashes for a send proposal. Throws on anything the vault must not sign. */
export function analyzeProposal(proposal: SendProposal, vault: VaultKey, network: NetworkName): ProposalAnalysis {
  if (proposal.network !== network) throw new Error(`Proposal is for ${proposal.network}, this vault is on ${network}`);
  if (typeof proposal.tx !== 'string' || !Array.isArray(proposal.prevouts)) throw new Error('Malformed proposal');

  const tx = btc.Transaction.fromRaw(hex.decode(proposal.tx), { allowUnknownOutputs: true });
  const vaultScript = vaultPayment(vault, network).script;
  const vaultScriptHex = hex.encode(vaultScript);

  if (tx.inputsLength === 0) throw new Error('Transaction has no inputs');
  if (tx.inputsLength !== proposal.prevouts.length) throw new Error('Input count does not match the spent coins');
  if (tx.lockTime !== 0) throw new Error('Transaction has a lock time');

  const inputs = proposal.prevouts.map((p, i) => {
    if (!HEX64.test(p.txid) || !Number.isSafeInteger(p.vout) || p.vout < 0 || !Number.isSafeInteger(p.amount) || p.amount < 0) {
      throw new Error(`Malformed coin data for input ${i}`);
    }
    const input = tx.getInput(i);
    if (hex.encode(input.txid!) !== p.txid || input.index !== p.vout) throw new Error(`Input ${i} does not spend the listed coin`);
    if (input.sequence !== RBF_SEQUENCE) throw new Error(`Input ${i} has an unexpected sequence number`);
    if (p.script !== vaultScriptHex) throw new Error(`Input ${i} does not spend a coin of this vault`);
    return { txid: p.txid, vout: p.vout, amount: p.amount };
  });

  const outputs: ProposalOutput[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const address = scriptAddress(out.script!, network);
    if (!address) throw new Error(`Output ${i} is not a standard address`);
    outputs.push({ address, amount: Number(out.amount!), isChange: hex.encode(out.script!) === vaultScriptHex });
  }
  if (outputs.length === 0) throw new Error('Transaction has no outputs');

  const totalIn = inputs.reduce((s, x) => s + x.amount, 0);
  const totalOut = outputs.reduce((s, x) => s + x.amount, 0);
  const fee = totalIn - totalOut;
  if (fee < 0) throw new Error('Outputs exceed inputs');

  // One 64-byte key-path signature per input: marker/flag 2 WU + (1 + 1 + 64) WU per input
  const vsize = Math.ceil((tx.unsignedTx.length * 4 + 2 + inputs.length * 66) / 4);

  const scripts = inputs.map(() => vaultScript);
  const amounts = inputs.map(x => BigInt(x.amount));
  const sighashes: SighashInfo[] = inputs.map((_, i) => ({
    index: i,
    hash: hex.encode(tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts)),
    type: 'key-path',
  }));

  return { txid: tx.id, inputs, outputs, totalIn, totalOut, fee, vsize, feeRate: fee / vsize, sighashes };
}

// ── Amounts and formatting ──

export type AmountUnit = 'btc' | 'mbtc' | 'ubtc' | 'sats';
const UNIT_DECIMALS: Record<AmountUnit, number> = { btc: 8, mbtc: 5, ubtc: 2, sats: 0 };

/** Parse a decimal amount in `unit` to integer satoshis without floating point. NaN if invalid. */
export function parseAmountSats(input: string, unit: AmountUnit): number {
  const s = input.trim();
  const decimals = UNIT_DECIMALS[unit];
  const m = s.match(/^(\d*)(?:\.(\d*))?$/);
  if (!s || !m || (m[1] === '' && !m[2])) return NaN;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return NaN;
  const sats = Number(BigInt((m[1] || '0') + frac.padEnd(decimals, '0')));
  return Number.isSafeInteger(sats) ? sats : NaN;
}

/** Satoshis as a BTC decimal string with 8 places. */
export function formatBtc(sats: number): string {
  const neg = sats < 0;
  const abs = Math.abs(Math.trunc(sats));
  const whole = Math.floor(abs / 1e8);
  const frac = String(abs % 1e8).padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Block explorer base for a chain API URL (mempool-style: strip the trailing /api). */
export function explorerBase(chainApiUrl: string): string {
  return chainApiUrl.replace(/\/api\/?$/, '');
}

export function explorerTxUrl(chainApiUrl: string, txid: string): string {
  return `${explorerBase(chainApiUrl)}/tx/${txid}`;
}

export function explorerAddressUrl(chainApiUrl: string, address: string): string {
  return `${explorerBase(chainApiUrl)}/address/${address}`;
}
