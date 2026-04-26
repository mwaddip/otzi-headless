/**
 * `otzi op20 balance <ticker|ID>` — read OP20/OP20S balance for the vault.
 *
 * Manifest-resolved: contract identifier names a contract listed in the
 * installed manifest (by 1-based index or name). Type must be OP20 or
 * OP20S. The CLI calls balanceOf directly via the OPNet provider — read
 * paths don't go through the daemon. Output respects the manifest's
 * declared decimals.
 */

import { readFile } from 'node:fs/promises';
import { resolveContract } from '../manifest-resolver';
import { validateManifest } from '../manifest-validate';
import type { VaultPubkey } from './vault';
import { DEFAULT_VAULT_PUBKEY_PATH } from '../../daemon/vault-pubkey';
import { DEFAULT_MANIFEST_PATH } from './install';

export interface Op20BalanceOptions {
  manifestPath?: string;
  vaultPath?: string;
  identifier: string;
}

export async function op20Balance(opts: Op20BalanceOptions): Promise<string> {
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const vaultPath = opts.vaultPath ?? DEFAULT_VAULT_PUBKEY_PATH;

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const validation = validateManifest(manifest);
  if (!validation.ok)
    throw new Error('manifest invalid:\n  ' + validation.errors.join('\n  '));

  const { contract } = resolveContract(validation.manifest, opts.identifier);
  if (contract.type !== 'OP20' && contract.type !== 'OP20S')
    throw new Error(
      `balance only available for OP20/OP20S contracts (contract '${contract.name}' is type '${contract.type}')`,
    );

  const vault = JSON.parse(await readFile(vaultPath, 'utf8')) as VaultPubkey;
  if (vault.network !== 'mainnet' && vault.network !== 'testnet') {
    throw new Error(
      `network=${vault.network} not supported for OPNet RPC (only mainnet/testnet)`,
    );
  }

  const { Address } = await import('@btc-vision/transaction');
  const { getContract, OP_20_ABI } = await import('opnet');
  const { getProvider, getNetwork } = await import('../../node/opnet-client');

  const provider = getProvider(vault.network);
  const network = getNetwork(vault.network);
  const vaultAddr = Address.fromString(vault.mldsaPubKeyHex, vault.frostTweakedPubKey);

  const tokenContract = getContract(
    contract.address,
    OP_20_ABI,
    provider,
    network,
    vaultAddr,
  ) as unknown as {
    balanceOf: (owner: typeof vaultAddr) => Promise<{ balance: bigint }>;
  };

  const result = await tokenContract.balanceOf(vaultAddr);
  return formatTokenAmount(result.balance, contract.decimals ?? 0);
}

export function formatTokenAmount(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const scale = 10n ** BigInt(decimals);
  const intPart = atomic / scale;
  const fracPart = atomic % scale;
  const fracStr = fracPart.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : `${intPart}`;
}
