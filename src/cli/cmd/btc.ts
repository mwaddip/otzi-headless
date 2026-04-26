/**
 * `otzi btc send <address> <amount>[unit]` — sign + broadcast a BTC vault transfer.
 * `otzi btc balance [--unit sats|btc|mbtc|ubtc]` — read vault BTC balance.
 *
 * Both commands read the vault address from /var/lib/otzi/vault-pubkey.json.
 * Send goes through the daemon UDS for the FROST sig; balance is read-only
 * via the OPNet provider's UTXO manager. Regtest is rejected for both
 * (provider doesn't expose mainnet/testnet on regtest).
 */

import { readFile } from 'node:fs/promises';
import { fetchBtcFees } from '../../broadcast/btc-fees';
import {
  broadcastBtcTx,
  buildBtcTxFromParams,
  type BtcCaptureContext,
  type BtcUtxo,
} from '../../broadcast/btc-vault';
import { DEFAULT_VAULT_PUBKEY_PATH } from '../../daemon/vault-pubkey';
import type { NetworkName } from '../../node/types';
import { fromHex, toHex } from '../../wire/hex';
import { DaemonClient } from '../daemon-client';
import { parseBtcAmount, formatSats, type BtcUnit } from '../units';
import type { VaultPubkey } from './vault';

async function readVault(path: string = DEFAULT_VAULT_PUBKEY_PATH): Promise<VaultPubkey> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `no vault metadata at ${path}; run \`otzi generate\` to complete DKG first.`,
      );
    throw err;
  }
  return JSON.parse(raw) as VaultPubkey;
}

function assertChainNetwork(vault: VaultPubkey): NetworkName {
  if (vault.network === 'mainnet' || vault.network === 'testnet') {
    return vault.network;
  }
  throw new Error(
    `network=${vault.network} not supported for BTC chain RPCs (only mainnet/testnet)`,
  );
}

interface BtcUtxoFromProvider {
  transactionId: string;
  outputIndex: number;
  value: bigint;
}

async function fetchVaultUtxos(
  vault: VaultPubkey,
): Promise<{ utxos: BtcUtxo[]; network: NetworkName }> {
  const network = assertChainNetwork(vault);
  const { getProvider } = await import('../../node/opnet-client');
  const provider = getProvider(network);
  const raw = (await provider.utxoManager.getUTXOs({ address: vault.btcAddress })) as readonly BtcUtxoFromProvider[];
  const utxos: BtcUtxo[] = raw.map((u) => ({
    transactionId: u.transactionId,
    outputIndex: u.outputIndex,
    value: BigInt(u.value),
  }));
  return { utxos, network };
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi btc send <addr> <amount>[unit]`
// ─────────────────────────────────────────────────────────────────────────

export interface BtcSendOptions {
  configPath: string;
  vaultPath?: string;
  toAddress: string;
  amount: string;
  feeRate?: number;
}

export async function btcSend(opts: BtcSendOptions): Promise<{ transactionId: string }> {
  const vault = await readVault(opts.vaultPath);
  const network = assertChainNetwork(vault);

  const { sats } = parseBtcAmount(opts.amount);
  if (sats <= 0n) throw new Error('amount must be > 0 sats');

  const { utxos } = await fetchVaultUtxos(vault);
  if (utxos.length === 0)
    throw new Error(`vault ${vault.btcAddress} has no UTXOs to spend`);

  const feeRate = opts.feeRate ?? (await fetchBtcFees(network)).high;

  // Build the unsigned tx + sighashes locally so we can broadcast after the
  // daemon returns sigs. The daemon also rebuilds it inside its own ceremony
  // (deterministic from the same construction params + UTXOs), so the sigs
  // it produces will commit to the same sighashes we hold here.
  const built = buildBtcTxFromParams({
    to: opts.toAddress,
    amountSat: sats,
    feeRate,
    network,
    frostP2tr: vault.btcAddress,
    frostUntweakedPubKey: fromHex(vault.frostUntweakedPubKey),
    utxos,
  });

  const client = await DaemonClient.fromConfig(opts.configPath);
  const info = await client.vaultInfo();

  const signResp = await client.request<{ signaturesHex: string[] }>({
    op: 'sign',
    scheme: 'frost',
    protocol: 'btc',
    signers: info.partyIds,
    btc: {
      to: opts.toAddress,
      amountSat: sats.toString(),
      feeRate,
      network,
      frostP2tr: vault.btcAddress,
      frostUntweakedPubKeyHex: vault.frostUntweakedPubKey,
      utxos: utxos.map((u) => ({
        transactionId: u.transactionId,
        outputIndex: u.outputIndex,
        valueSat: u.value.toString(),
      })),
    },
  });

  if (!Array.isArray(signResp.signaturesHex) || signResp.signaturesHex.length !== built.sighashes.length) {
    throw new Error(
      `daemon returned ${signResp.signaturesHex?.length ?? 0} signatures, expected ${built.sighashes.length}`,
    );
  }

  const captureContext: BtcCaptureContext = {
    txHex: built.txHex,
    numInputs: built.sighashes.length,
    sighashes: built.sighashes.map((s) => ({ index: s.index, hash: toHex(s.hash) })),
    token: 'cli',
  };
  const frostSignatures = signResp.signaturesHex.map((sigHex, index) => ({
    index,
    signature: sigHex,
  }));

  const result = await broadcastBtcTx({
    captureContext,
    frostSignatures,
    frostTweakedPubKey: fromHex(vault.frostTweakedPubKey),
    network,
  });
  return { transactionId: result.txid };
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi btc balance [--unit ...]`
// ─────────────────────────────────────────────────────────────────────────

export interface BtcBalanceOptions {
  vaultPath?: string;
  unit?: BtcUnit;
}

export async function btcBalance(opts: BtcBalanceOptions = {}): Promise<string> {
  const vault = await readVault(opts.vaultPath);
  assertChainNetwork(vault);
  const { utxos } = await fetchVaultUtxos(vault);
  const total = utxos.reduce((acc, u) => acc + u.value, 0n);
  return formatSats(total, opts.unit ?? 'sats');
}
