/**
 * Writes the operator-facing vault metadata cache.
 *
 * `/var/lib/otzi/vault-pubkey.json` chmod 644 — values are public (BTC
 * address, OPNet address, ML-DSA pubkey, FROST aggregate pubkeys). Cache
 * exists so the CLI can answer "what's our vault address?" without ever
 * touching the encrypted share file.
 *
 * Network handling: mainnet/testnet route through `deriveVaultP2tr` (which
 * uses the OPNet-aware network resolver). Regtest is handled inline because
 * the OPNet client's `getNetwork` is intentionally narrow (mainnet/testnet
 * only — regtest skips key-link). For regtest we use bitcoin's regtest
 * network directly and run the same BIP-341 P2TR derivation. The CLI
 * commands that consume this file already early-out on regtest for chain
 * RPCs, but the OPNet address (sha256 of ML-DSA pubkey) and the FROST
 * pubkeys are still meaningful on regtest, so write the file unconditionally.
 */

import { networks, payments, toXOnly } from '@btc-vision/bitcoin';
import { sha256 } from '@noble/hashes/sha2.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deriveVaultP2tr } from '../broadcast/opnet-params-reconstruct';
import type { NetworkName } from '../config/types';
import { toHex } from '../wire/hex';

export const DEFAULT_VAULT_PUBKEY_PATH = '/var/lib/otzi/vault-pubkey.json';

export interface VaultPubkeyFileInputs {
  network: NetworkName;
  frostUntweakedPubKey: Uint8Array;
  frostTweakedPubKey: Uint8Array;
  mldsaPubKey: Uint8Array;
  /** Defaults to `/var/lib/otzi/vault-pubkey.json`. */
  outputPath?: string;
}

export async function writeVaultPubkeyFile(input: VaultPubkeyFileInputs): Promise<void> {
  const path = input.outputPath ?? DEFAULT_VAULT_PUBKEY_PATH;

  const btcAddress = deriveBtcAddress(input.frostUntweakedPubKey, input.network);
  const opnetAddress = '0x' + toHex(sha256(input.mldsaPubKey));

  const payload = {
    network: input.network,
    btcAddress,
    opnetAddress,
    frostUntweakedPubKey: toHex(input.frostUntweakedPubKey),
    frostTweakedPubKey: toHex(input.frostTweakedPubKey),
    mldsaPubKeyHex: toHex(input.mldsaPubKey),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o644 });
}

function deriveBtcAddress(untweakedPubKey: Uint8Array, network: NetworkName): string {
  if (network === 'regtest') {
    const internalXOnly = toXOnly(Buffer.from(untweakedPubKey) as never);
    const addr = payments.p2tr({
      internalPubkey: internalXOnly as never,
      network: networks.regtest,
    }).address;
    if (!addr) throw new Error('writeVaultPubkeyFile: p2tr() returned no regtest address');
    return addr;
  }
  return deriveVaultP2tr(untweakedPubKey, network);
}
