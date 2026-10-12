/**
 * `otzi btc balance|send|sign` (facts/daemon.md, `btc.ts`).
 *
 * The CLI is the only component that talks to the chain: it reads coins and
 * fee rates from Esplora, builds the transaction proposal, asks the local
 * daemon to sign it, and posts the signed transaction back to Esplora. The
 * daemon never touches the chain.
 */

import { readFile } from 'node:fs/promises';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { DEFAULT_ADDRESS_BOOK_PATH, readAddressBook, resolveRecipient } from '../../address-book/store';
import { loadDaemonConfig } from '../../config/load';
import type { DaemonConfig, NetworkName } from '../../config/types';
import { MAX_INPUTS } from '../../core/messages';
import { parseProposal } from '../../daemon/api';
import { DEFAULT_VAULT_PUBKEY_PATH, readVaultPubkeyFile, type VaultPubkeyFile } from '../../daemon/vault-pubkey';
import { buildSend, InsufficientFundsError, MIN_SEND_SATS, type PreparedSend } from '../../otzi/backend/bitcoin';
import { broadcastTx, chainApiUrl, getBalance, getFeeRates, getUtxos } from '../../otzi/backend/esplora';
import { labelFor } from '../../otzi/lib/address-book';
import { analyzeProposal, explorerTxUrl, formatBtc, type ProposalAnalysis } from '../../otzi/lib/bitcoin';
import type { AddressBookEntry, SendProposal } from '../../otzi/lib/vault-types';
import { displayText, errorReason } from '../../util/text';
import { DaemonClient, DaemonClientError, type RequestOptions } from '../daemon-client';
import { formatSats, parseBtcAmount, type BtcUnit } from '../units';
import { NO_VAULT_NOTE, askDaemon, infoFromRequest, notVerifiedNote, vaultMismatch } from '../vault-check';

/** The most the CLI accepts as a fee rate, from Esplora or from `--fee-rate`: sat/vB. */
export const MAX_FEE_RATE = 10_000;

/** Test seams: the CLI's connection to the daemon and its writers. */
export interface CliDeps {
  /** Default: `DaemonClient` from the config. */
  client?: { request<T>(body: unknown, options?: RequestOptions): Promise<T> };
  /** Receives the analysis summary before the daemon is asked to sign. Default: stderr. */
  summary?: (text: string) => void;
  /** Receives non-fatal warnings. Default: stderr. */
  warn?: (text: string) => void;
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
  /** Where `vault` was read from. */
  vaultPath: string;
  /** Esplora base URL: `[network].esplora_url`, else the network's default. */
  base: string;
}

async function loadContext(configPath: string, vaultPath?: string): Promise<Context> {
  const vault = await readVaultPubkeyFile(vaultPath);
  const config = await loadDaemonConfig(configPath);
  const path = vaultPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  if (config.network.name !== vault.network) {
    throw new Error(`${path} is for ${vault.network} but ${configPath} configures ${config.network.name}`);
  }
  return { config, vault, vaultPath: path, base: chainApiUrl({ network: vault.network, esploraUrl: config.network.esploraUrl }) };
}

// ─── The vault metadata against the daemon ─────────────────────────────────

type VaultSource = Parameters<typeof askDaemon>[0];

/**
 * `send` and `sign` take their change address, keys and network from
 * `vault-pubkey.json` and then ask the daemon to sign, so the file must be the
 * vault the daemon has loaded: a file the daemon does not vouch for (it differs,
 * the daemon holds no vault, or it cannot be asked) is an error, before anything
 * is built, summarised or signed.
 */
async function requireDaemonVault(path: string, file: VaultPubkeyFile, source: VaultSource): Promise<void> {
  const answer = await askDaemon(source);
  if (answer.kind === 'unreachable') throw new Error(`cannot check ${path} against the daemon: ${answer.reason}`);
  if (answer.kind === 'no-vault') throw new Error('the daemon has not loaded a vault — restart it to load the share');
  const mismatch = vaultMismatch(path, file, answer.info);
  if (mismatch) throw mismatch;
}

// ─── Esplora errors ─────────────────────────────────────────────────────────

/** The Esplora response body is untrusted: shown without control characters, on one line. */
function esploraError(base: string, err: unknown): Error {
  return new Error(`Esplora ${base}: ${displayText(errorReason(err))}`, { cause: err });
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

/** Appended to the daemon's 503 (facts/daemon.md, `btc.ts`): nothing happened, so the same command can simply run again. */
const RETRY_HINT = 'Nothing was announced or signed. This is temporary: run the same command again to retry.';

/**
 * Asks the daemon to sign `proposal` and checks the reply against it. The
 * reply must be the proposal's own transaction with a signature on every
 * input: nothing else is ever handed to the caller, so nothing else is
 * broadcast. `proposalTxid` is the txid `analyzeProposal` computed for it.
 */
async function signProposal(
  client: NonNullable<CliDeps['client']>,
  proposal: SendProposal,
  proposalTxid: string,
): Promise<{ txid: string; signedTxHex: string }> {
  let reply: { txid?: unknown; signedTxHex?: unknown };
  try {
    reply = await client.request<{ txid?: unknown; signedTxHex?: unknown }>({ op: 'sign', proposal });
  } catch (err) {
    // The leader refused before its gate (a signer not connected, or its cap): retryable.
    if (err instanceof DaemonClientError && err.status === 503) throw new DaemonClientError(503, `${err.message}\n${RETRY_HINT}`);
    throw err;
  }
  if (
    typeof reply?.txid !== 'string' ||
    typeof reply.signedTxHex !== 'string' ||
    !/^[0-9a-f]+$/.test(reply.signedTxHex)
  ) {
    throw new Error("daemon reply to 'sign' has no signed transaction (txid, signedTxHex)");
  }
  const { txid, signedTxHex } = reply;

  let signed: btc.Transaction;
  try {
    signed = btc.Transaction.fromRaw(hex.decode(signedTxHex), { allowUnknownOutputs: true });
  } catch (err) {
    throw new Error(`the signed transaction in the daemon's reply cannot be decoded: ${errorReason(err)}`, { cause: err });
  }
  if (signed.id !== txid) {
    throw new Error(`daemon reply is inconsistent: it names txid ${txid} but its signed transaction is ${signed.id}`);
  }
  if (signed.id !== proposalTxid || hex.encode(signed.unsignedTx) !== proposal.tx) {
    throw new Error(
      `daemon signed a different transaction than the proposal (proposal ${proposalTxid}, signed ${signed.id}); not broadcasting it`,
    );
  }
  for (let i = 0; i < signed.inputsLength; i++) {
    if (!signed.getInput(i).finalScriptWitness?.length) {
      throw new Error(`the daemon's signed transaction has no signature for input ${i}; not broadcasting it`);
    }
  }
  return { txid, signedTxHex };
}

/** Posts a signed transaction; a failure carries the transaction out in a `BroadcastFailedError`. */
async function broadcast(
  base: string,
  signed: { txid: string; signedTxHex: string },
  warn: NonNullable<CliDeps['warn']>,
): Promise<void> {
  let reported: string;
  try {
    reported = await broadcastTx(base, signed.signedTxHex);
  } catch (err) {
    throw new BroadcastFailedError(
      `broadcast failed — ${esploraError(base, err).message}`,
      signed.txid,
      signed.signedTxHex,
    );
  }
  // The txid the daemon returned is the one the caller gets; Esplora's answer only cross-checks it.
  if (reported !== signed.txid) {
    warn(`warning: Esplora ${base} answered txid '${reported}' for the broadcast, but the signed transaction is ${signed.txid}`);
  }
}

// ─── otzi btc balance ───────────────────────────────────────────────────────

/**
 * Reading a balance needs no daemon, so it is checked against the daemon when
 * there is one to ask: a file that differs is an error (it would show the balance
 * of the wrong address), and a daemon that cannot be reached or holds no vault
 * leaves the balance with a note that it was not verified.
 */
export async function btcBalance(
  opts: { configPath: string; vaultPath?: string; unit?: BtcUnit },
  deps: CliDeps = {},
): Promise<string> {
  const { config, vault, vaultPath, base } = await loadContext(opts.configPath, opts.vaultPath);
  const warn = deps.warn ?? console.error;
  const answer = await askDaemon(() => infoFromRequest(deps.client ?? DaemonClient.fromParsed(config)));
  if (answer.kind === 'unreachable') warn(notVerifiedNote(answer.reason));
  else if (answer.kind === 'no-vault') warn(NO_VAULT_NOTE);
  else {
    const mismatch = vaultMismatch(vaultPath, vault, answer.info);
    if (mismatch) throw mismatch;
  }
  const balance = await viaEsplora(base, getBalance(base, vault.address));
  const unit = opts.unit ?? 'sats';
  return [
    `confirmed: ${formatSats(BigInt(balance.confirmed), unit)}`,
    `unconfirmed: ${formatSats(BigInt(balance.unconfirmed), unit)}`,
  ].join('\n');
}

// ─── otzi btc send ──────────────────────────────────────────────────────────

const usableFeeRate = (rate: unknown): rate is number =>
  typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= MAX_FEE_RATE;

/** Esplora's `normal` estimate, or an error naming Esplora when it is not a usable rate. */
function esploraFeeRate(base: string, rate: unknown): number {
  if (usableFeeRate(rate)) return rate;
  throw new Error(
    `Esplora ${base} returned an unusable fee rate (${String(rate)} sat/vB; expected more than 0 and at most ${MAX_FEE_RATE}); pass --fee-rate to choose one`,
  );
}

function insufficientFunds(err: InsufficientFundsError, feeRate: number, unconfirmed: number): Error {
  let message =
    `insufficient funds: ${money(err.available)} confirmed, ${money(err.needed)} needed at ${feeRate} sat/vB`;
  if (unconfirmed > 0) {
    message += `; a further ${money(unconfirmed)} is unconfirmed and is not spent until it confirms`;
  }
  return new Error(message);
}

export async function btcSend(
  opts: { configPath: string; vaultPath?: string; bookPath?: string; to: string; amount: string; feeRate?: number },
  deps: CliDeps = {},
): Promise<{ txid: string; explorerUrl: string }> {
  const { config, vault, vaultPath, base } = await loadContext(opts.configPath, opts.vaultPath);
  const network: NetworkName = vault.network;

  // Everything that can be checked locally is checked before Esplora or the daemon is touched.
  const book = await readAddressBook(opts.bookPath ?? DEFAULT_ADDRESS_BOOK_PATH, network);
  const to = resolveRecipient(book, opts.to, network);
  const amount = opts.amount.trim().toLowerCase() === 'max' ? ('max' as const) : parseBtcAmount(opts.amount).sats;
  if (amount !== 'max' && amount < MIN_SEND_SATS) {
    throw new Error(`amount ${amount} sats is below the minimum send of ${MIN_SEND_SATS} sats`);
  }
  if (opts.feeRate !== undefined && !usableFeeRate(opts.feeRate)) {
    throw new Error(`fee rate must be more than 0 and at most ${MAX_FEE_RATE} sat/vB (got ${opts.feeRate})`);
  }
  const client = deps.client ?? DaemonClient.fromParsed(config);
  // The file's key builds the change output: it must be the vault the daemon will sign for.
  await requireDaemonVault(vaultPath, vault, () => infoFromRequest(client));

  const coins = await viaEsplora(base, getUtxos(base, vault.address));
  const confirmed = coins.filter(c => c.confirmed);
  const unconfirmed = coins.filter(c => !c.confirmed).reduce((sum, c) => sum + c.value, 0);
  const feeRate = opts.feeRate ?? esploraFeeRate(base, (await viaEsplora(base, getFeeRates(base))).normal);

  let built: PreparedSend;
  try {
    built = buildSend({
      utxos: confirmed.map(({ txid, vout, value }) => ({ txid, vout, value })),
      vault: vault.vaultKey,
      network,
      to,
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

  const proposal: SendProposal = { network, tx: built.tx, prevouts: built.prevouts };
  const analysis = analyzeProposal(proposal, vault.vaultKey, network);
  (deps.summary ?? console.error)(summarize(analysis, network, book));

  const signed = await signProposal(client, proposal, analysis.txid);
  await broadcast(base, signed, deps.warn ?? console.error);
  return { txid: signed.txid, explorerUrl: explorerTxUrl(base, signed.txid) };
}

// ─── otzi btc sign ──────────────────────────────────────────────────────────

async function readProposal(path: string): Promise<SendProposal> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read proposal file ${path}: ${errorReason(err)}`, { cause: err });
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
    throw new Error(`proposal file ${path}: ${errorReason(err)}`, { cause: err });
  }
}

/** The analysis as text; an output whose address is in `book` is followed by its label. */
function summarize(analysis: ProposalAnalysis, network: NetworkName, book: AddressBookEntry[]): string {
  const output = (o: ProposalAnalysis['outputs'][number]): string => {
    const label = labelFor(book, o.address);
    return `  ${o.address}  ${money(o.amount)}${o.isChange ? '  change' : ''}${label !== undefined ? `  "${displayText(label)}"` : ''}`;
  };
  return [
    `network: ${network}`,
    `inputs: ${analysis.inputs.length}, ${money(analysis.totalIn)}`,
    'outputs:',
    ...analysis.outputs.map(output),
    `fee: ${money(analysis.fee)}, ${analysis.feeRate.toFixed(1)} sat/vB`,
  ].join('\n');
}

export async function btcSign(
  opts: { configPath: string; vaultPath?: string; bookPath?: string; proposalPath: string; broadcast: boolean },
  deps: CliDeps = {},
): Promise<{ txid: string; signedTxHex: string; summary: string; explorerUrl?: string }> {
  const { config, vault, vaultPath, base } = await loadContext(opts.configPath, opts.vaultPath);
  const client = deps.client ?? DaemonClient.fromParsed(config);
  const warn = deps.warn ?? console.error;

  const proposal = await readProposal(opts.proposalPath);
  // Before the file's key analyses the proposal and the summary is shown.
  await requireDaemonVault(vaultPath, vault, () => infoFromRequest(client));
  let analysis: ProposalAnalysis;
  try {
    analysis = analyzeProposal(proposal, vault.vaultKey, vault.network);
  } catch (err) {
    throw new Error(`proposal refused: ${errorReason(err)}`, { cause: err });
  }
  // The book only labels the summary here, as it labels the daemon's specs: an unreadable one means no labels.
  let book: AddressBookEntry[] = [];
  try {
    book = await readAddressBook(opts.bookPath ?? DEFAULT_ADDRESS_BOOK_PATH, vault.network);
  } catch (err) {
    warn(`warning: outputs are shown without labels: ${errorReason(err)}`);
  }
  const summary = summarize(analysis, vault.network, book);
  (deps.summary ?? console.error)(summary);

  const signed = await signProposal(client, proposal, analysis.txid);
  if (!opts.broadcast) return { ...signed, summary };
  await broadcast(base, signed, warn);
  return { ...signed, summary, explorerUrl: explorerTxUrl(base, signed.txid) };
}
