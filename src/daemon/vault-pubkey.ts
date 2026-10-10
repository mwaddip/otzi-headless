/**
 * The public vault metadata file `/var/lib/otzi/vault-pubkey.json`
 * (facts/daemon.md, `vault-pubkey.ts`).
 *
 * Every value is public (address, group keys, per-party verifying shares), so
 * the file is mode 0644: members of the `otzi` group and other users can run
 * the read-only CLI verbs (`otzi vault`, `otzi btc balance|send|sign`) without
 * decrypting the share. `vaultKey` is Ötzi's public `VaultKey`, which the CLI
 * needs for `buildSend`.
 */

import type { PublicKeyPackage } from '@mwaddip/frots';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NetworkName } from '../config/types';
import { NETWORK_NAMES } from '../config/types';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { toHex } from '../otzi/lib/hex';
import type { VaultKey } from '../otzi/lib/vault-types';

export const DEFAULT_VAULT_PUBKEY_PATH = '/var/lib/otzi/vault-pubkey.json';

export interface VaultPubkeyFile {
  network: NetworkName;
  /** Bech32m P2TR address (`bc1p…` / `tb1p…`). */
  address: string;
  /** 33-byte SEC1 hex: the untweaked group key (`vaultKey.untweakedVerifyingKey`). */
  internalKey: string;
  /** 32-byte x-only hex: the P2TR output key. */
  outputKey: string;
  threshold: number;
  parties: number;
  vaultKey: VaultKey;
}

/** The public metadata of a vault, derived from its FROST public key package. */
export function vaultPubkeyFromPackage(
  publicKeyPackage: PublicKeyPackage,
  network: NetworkName,
): VaultPubkeyFile {
  const vaultKey = toVaultKey(publicKeyPackage);
  const payment = vaultPayment(vaultKey, network);
  return {
    network,
    address: payment.address,
    internalKey: vaultKey.untweakedVerifyingKey,
    outputKey: toHex(payment.outputKey),
    threshold: vaultKey.minSigners,
    parties: Object.keys(vaultKey.verifyingShares).length,
    vaultKey,
  };
}

export async function writeVaultPubkeyFile(
  file: VaultPubkeyFile,
  outputPath: string = DEFAULT_VAULT_PUBKEY_PATH,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(file, null, 2), { mode: 0o644 });
  // Explicit chmod: the file may already exist with other permissions, and the
  // umask may have narrowed the creation mode.
  await chmod(outputPath, 0o644);
}

export async function readVaultPubkeyFile(
  path: string = DEFAULT_VAULT_PUBKEY_PATH,
): Promise<VaultPubkeyFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err))
      throw new Error(
        `vault metadata ${path} not found — run 'otzi generate' to create the vault, or restart the daemon if a share exists`,
        { cause: err },
      );
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`vault metadata ${path} is not valid JSON`, { cause: err });
  }
  return validate(raw, path);
}

function validate(raw: unknown, path: string): VaultPubkeyFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error(`vault metadata ${path} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  const bad = (field: string, expected: string): never => {
    throw new Error(`vault metadata ${path}: '${field}' must be ${expected}`);
  };
  if (typeof o.network !== 'string' || !(NETWORK_NAMES as readonly string[]).includes(o.network))
    bad('network', `one of ${NETWORK_NAMES.join(' | ')}`);
  for (const field of ['address', 'internalKey', 'outputKey'] as const) {
    if (typeof o[field] !== 'string' || o[field] === '') bad(field, 'a non-empty string');
  }
  for (const field of ['threshold', 'parties'] as const) {
    const v = o[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) bad(field, 'a positive integer');
  }
  if (!isVaultKey(o.vaultKey)) bad('vaultKey', 'a VaultKey object');
  return o as unknown as VaultPubkeyFile;
}

function isVaultKey(v: unknown): v is VaultKey {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Record<string, unknown>;
  const isShareMap = (m: unknown): boolean =>
    typeof m === 'object' &&
    m !== null &&
    !Array.isArray(m) &&
    Object.values(m).every((x) => typeof x === 'string');
  return (
    typeof k.minSigners === 'number' &&
    typeof k.verifyingKey === 'string' &&
    typeof k.untweakedVerifyingKey === 'string' &&
    isShareMap(k.verifyingShares) &&
    isShareMap(k.untweakedVerifyingShares)
  );
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
