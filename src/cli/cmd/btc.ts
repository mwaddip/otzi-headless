/**
 * `otzi btc balance|send|sign` (facts/daemon.md, `btc.ts`).
 *
 * The CLI is the only component that talks to the chain: it reads coins and
 * fee rates from Esplora, builds the transaction proposal, asks the local
 * daemon to sign it, and posts the signed transaction back to Esplora. The
 * daemon never touches the chain.
 */

import { readFile } from 'node:fs/promises';
import { loadDaemonConfig } from '../../config/load';
import type { DaemonConfig, NetworkName } from '../../config/types';
import { MAX_INPUTS } from '../../core/messages';
import { parseProposal } from '../../daemon/api';
import { DEFAULT_VAULT_PUBKEY_PATH, readVaultPubkeyFile, type VaultPubkeyFile } from '../../daemon/vault-pubkey';
import { buildSend, InsufficientFundsError, MIN_SEND_SATS, type PreparedSend } from '../../otzi/backend/bitcoin';
import { broadcastTx, chainApiUrl, getBalance, getFeeRates, getUtxos } from '../../otzi/backend/esplora';
import {
  analyzeProposal,
  explorerTxUrl,
  formatBtc,
  isValidAddress,
  type ProposalAnalysis,
} from '../../otzi/lib/bitcoin';
import type { SendProposal } from '../../otzi/lib/vault-types';
import { DaemonClient } from '../daemon-client';
import { formatSats, parseBtcAmount, type BtcUnit } from '../units';

/** Test seam: the CLI's connection to the daemon (default: `DaemonClient` from the config). */
export interface CliDeps {
  client?: { request<T>(body: unknown): Promise<T> };
}

/**
 * The daemon signed the transaction but it could not be posted. The signed
 * transaction is never lost: the entrypoint prints `signedTxHex` so the
 * operator can broadcast it by other means.
 */
export class BroadcastFailedError extends Error {
  constructor(
    message: string,
    readonly txid: string,
    readonly signedTxHex: string,
  ) {
    super(message);
    this.name = 'BroadcastFailedError';
  }
}

interface Context {
  config: DaemonConfig;
  vault: VaultPubkeyFile;
  /** Esplora base URL: `[network].esplora_url`, else the network's default. */
  base: string;
}

async function loadContext(configPath: string, vaultPath?: string): Promise<Context> {
  const vault = await readVaultPubkeyFile(vaultPath);
  const config = await loadDaemonConfig(configPath);
  if (config.network.name !== vault.network) {
    throw new Error(
      `${vaultPath ?? DEFAULT_VAULT_PUBKEY_PATH} is for ${vault.network} but ${configPath} configures ${config.network.name}`,
    );
  }
  return { config, vault, base: chainApiUrl({ network: vault.network, esploraUrl: config.network.esploraUrl }) };
}

// ─── Esplora errors ─────────────────────────────────────────────────────────

/** The reason behind a failed Esplora call; `fetch` hides connection errors in `cause`. */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { message?: string; code?: string } | undefined;
  if (err.message === 'fetch failed' && cause) return cause.message || cause.code || err.message;
  return err.message;
}

function esploraError(base: string, err: unknown): Error {
  return new Error(`Esplora ${base}: ${reason(err)}`, { cause: err });
}

async function viaEsplora<T>(base: string, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw esploraError(base, err);
  }
}

// ─── Shared steps ───────────────────────────────────────────────────────────

const money = (sats: bigint | number): string => `${sats} sats (${formatBtc(Number(sats))} BTC)`;

/** Asks the daemon to sign `proposal`. */
async function signProposal(
  client: NonNullable<CliDeps['client']>,
  proposal: SendProposal,
): Promise<{ txid: string; signedTxHex: string }> {
  const reply = await client.request<{ txid?: unknown; signedTxHex?: unknown }>({ op: 'sign', proposal });
  if (
    typeof reply?.txid !== 'string' ||
    typeof reply.signedTxHex !== 'string' ||
    !/^[0-9a-f]+$/.test(reply.signedTxHex)
  ) {
    throw new Error("daemon reply to 'sign' has no signed transaction (txid, signedTxHex)");
  }
  return { txid: reply.txid, signedTxHex: reply.signedTxHex };
}

/** Posts a signed transaction; a failure carries the transaction out in a `BroadcastFailedError`. */
async function broadcast(base: string, signed: { txid: string; signedTxHex: string }): Promise<void> {
  try {
    await broadcastTx(base, signed.signedTxHex);
  } catch (err) {
    throw new BroadcastFailedError(
      `broadcast failed — ${esploraError(base, err).message}`,
      signed.txid,
      signed.signedTxHex,
    );
  }
}

// ─── otzi btc balance ───────────────────────────────────────────────────────

export async function btcBalance(opts: { configPath: string; vaultPath?: string; unit?: BtcUnit }): Promise<string> {
  const { vault, base } = await loadContext(opts.configPath, opts.vaultPath);
  const balance = await viaEsplora(base, getBalance(base, vault.address));
  const unit = opts.unit ?? 'sats';
  return [
    `confirmed: ${formatSats(BigInt(balance.confirmed), unit)}`,
    `unconfirmed: ${formatSats(BigInt(balance.unconfirmed), unit)}`,
  ].join('\n');
}

// ─── otzi btc send ──────────────────────────────────────────────────────────

function insufficientFunds(err: InsufficientFundsError, feeRate: number, unconfirmed: number): Error {
  let message =
    `insufficient funds: ${money(err.available)} confirmed, ${money(err.needed)} needed at ${feeRate} sat/vB`;
  if (unconfirmed > 0) {
    message += `; a further ${money(unconfirmed)} is unconfirmed and is not spent until it confirms`;
  }
  return new Error(message);
}

export async function btcSend(
  opts: { configPath: string; vaultPath?: string; to: string; amount: string; feeRate?: number },
  deps: CliDeps = {},
): Promise<{ txid: string; explorerUrl: string }> {
  const { config, vault, base } = await loadContext(opts.configPath, opts.vaultPath);
  const network: NetworkName = vault.network;

  // Everything that can be checked locally is checked before Esplora or the daemon is touched.
  if (!isValidAddress(opts.to, network)) throw new Error(`'${opts.to}' is not a valid ${network} address`);
  const amount = opts.amount.trim().toLowerCase() === 'max' ? ('max' as const) : parseBtcAmount(opts.amount).sats;
  if (amount !== 'max' && amount < MIN_SEND_SATS) {
    throw new Error(`amount ${amount} sats is below the minimum send of ${MIN_SEND_SATS} sats`);
  }
  if (opts.feeRate !== undefined && !(Number.isFinite(opts.feeRate) && opts.feeRate > 0)) {
    throw new Error(`fee rate must be a positive number of sat/vB (got ${opts.feeRate})`);
  }
  const client = deps.client ?? DaemonClient.fromParsed(config);

  const coins = await viaEsplora(base, getUtxos(base, vault.address));
  const confirmed = coins.filter(c => c.confirmed);
  const unconfirmed = coins.filter(c => !c.confirmed).reduce((sum, c) => sum + c.value, 0);
  const feeRate = opts.feeRate ?? (await viaEsplora(base, getFeeRates(base))).normal;

  let built: PreparedSend;
  try {
    built = buildSend({
      utxos: confirmed.map(({ txid, vout, value }) => ({ txid, vout, value })),
      vault: vault.vaultKey,
      network,
      to: opts.to,
      amount,
      feeRate,
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw insufficientFunds(err, feeRate, unconfirmed);
    throw err;
  }
  if (built.prevouts.length > MAX_INPUTS) {
    throw new Error(
      `this send needs ${built.prevouts.length} inputs; at most ${MAX_INPUTS} fit in one transaction — consolidate first`,
    );
  }

  const signed = await signProposal(client, { network, tx: built.tx, prevouts: built.prevouts });
  await broadcast(base, signed);
  return { txid: signed.txid, explorerUrl: explorerTxUrl(base, signed.txid) };
}

// ─── otzi btc sign ──────────────────────────────────────────────────────────

async function readProposal(path: string): Promise<SendProposal> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read proposal file ${path}: ${reason(err)}`, { cause: err });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`proposal file ${path} is not valid JSON`);
  }
  try {
    return parseProposal(raw);
  } catch (err) {
    throw new Error(`proposal file ${path}: ${reason(err)}`, { cause: err });
  }
}

function summarize(analysis: ProposalAnalysis, network: NetworkName): string {
  return [
    `network: ${network}`,
    `inputs: ${analysis.inputs.length}, ${money(analysis.totalIn)}`,
    'outputs:',
    ...analysis.outputs.map(o => `  ${o.address}  ${money(o.amount)}${o.isChange ? '  change' : ''}`),
    `fee: ${money(analysis.fee)}, ${analysis.feeRate.toFixed(1)} sat/vB`,
  ].join('\n');
}

export async function btcSign(
  opts: { configPath: string; vaultPath?: string; proposalPath: string; broadcast: boolean },
  deps: CliDeps = {},
): Promise<{ txid: string; signedTxHex: string; summary: string; explorerUrl?: string }> {
  const { config, vault, base } = await loadContext(opts.configPath, opts.vaultPath);
  const client = deps.client ?? DaemonClient.fromParsed(config);

  const proposal = await readProposal(opts.proposalPath);
  let analysis: ProposalAnalysis;
  try {
    analysis = analyzeProposal(proposal, vault.vaultKey, vault.network);
  } catch (err) {
    throw new Error(`proposal refused: ${reason(err)}`, { cause: err });
  }
  const summary = summarize(analysis, vault.network);

  const signed = await signProposal(client, proposal);
  if (!opts.broadcast) return { ...signed, summary };
  await broadcast(base, signed);
  return { ...signed, summary, explorerUrl: explorerTxUrl(base, signed.txid) };
}
