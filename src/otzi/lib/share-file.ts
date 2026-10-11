/**
 * Share file v4: one party's FROST key package plus the vault's public key
 * package, encrypted in the browser with the party's password.
 */

import type { KeyPackage, PublicKeyPackage } from '@mwaddip/frots';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { encrypt, decrypt } from './crypto';
import { toHex, fromHex } from './hex';
import { bigintTo32BE, bigintFrom32BE, toVaultKey, fromVaultKey, partyIdToFrostId } from './dkg';
import { vaultPaymentFromInternalKey } from './bitcoin';
import type { NetworkName, VaultKey } from './vault-types';

export interface ShareFile {
  version: 4;
  network: NetworkName;
  internalKey: string;
  partyId: number;
  threshold: number;
  parties: number;
  encrypted: string;
}

interface SharePayload {
  keyPackage: {
    identifier: string;
    signingShare: string;
    verifyingShare: string;
    verifyingKey: string;
    minSigners: number;
    untweakedVerifyingKey: string;
    untweakedSigningShare: string;
    untweakedVerifyingShare: string;
  };
  publicKeyPackage: VaultKey;
  network: NetworkName;
}

export interface DecryptedShare {
  network: NetworkName;
  internalKey: string;
  partyId: number;
  threshold: number;
  parties: number;
  keyPackage: KeyPackage;
  publicKeyPackage: PublicKeyPackage;
}

export async function encryptShareFile(
  keyPackage: KeyPackage,
  publicKeyPackage: PublicKeyPackage,
  network: NetworkName,
  partyId: number,
  password: string,
): Promise<ShareFile> {
  if (keyPackage.identifier !== partyIdToFrostId(partyId)) throw new Error('Key package does not belong to this party');
  const payload: SharePayload = {
    keyPackage: {
      identifier: keyPackage.identifier.toString(),
      signingShare: toHex(bigintTo32BE(keyPackage.signingShare)),
      verifyingShare: toHex(keyPackage.verifyingShare),
      verifyingKey: toHex(keyPackage.verifyingKey),
      minSigners: keyPackage.minSigners,
      untweakedVerifyingKey: toHex(keyPackage.untweakedVerifyingKey),
      untweakedSigningShare: toHex(bigintTo32BE(keyPackage.untweakedSigningShare)),
      untweakedVerifyingShare: toHex(keyPackage.untweakedVerifyingShare),
    },
    publicKeyPackage: toVaultKey(publicKeyPackage),
    network,
  };
  return {
    version: 4,
    network,
    internalKey: toHex(publicKeyPackage.untweakedVerifyingKey),
    partyId,
    threshold: publicKeyPackage.minSigners,
    parties: publicKeyPackage.verifyingShares.size,
    encrypted: await encrypt(new TextEncoder().encode(JSON.stringify(payload)), password),
  };
}

export function shareFileName(file: ShareFile): string {
  const address = vaultPaymentFromInternalKey(file.internalKey, file.network).address;
  return `otzi-share-${file.network}-p${file.partyId + 1}-${address.slice(-8)}.json`;
}

export function downloadShareFile(file: ShareFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = shareFileName(file);
  a.click();
  URL.revokeObjectURL(url);
}

function corrupted(): never {
  throw new Error('Share file is corrupted');
}

function pointMatches(scalar: bigint, pointHex: string): boolean {
  try {
    return secp256k1.Point.BASE.multiply(scalar).toHex(true) === pointHex;
  } catch {
    return false;
  }
}

/** Parse and decrypt a share file. Throws on wrong password or any inconsistency. */
export async function decryptShareFile(raw: unknown, password: string): Promise<DecryptedShare> {
  const file = raw as Partial<ShareFile>;
  if (!file || typeof file !== 'object' || file.version !== 4) throw new Error('Unsupported share file version');
  if (typeof file.encrypted !== 'string' || typeof file.internalKey !== 'string' || typeof file.partyId !== 'number'
    || typeof file.threshold !== 'number' || typeof file.parties !== 'number' || typeof file.network !== 'string') {
    corrupted();
  }

  const plaintext = await decrypt(file.encrypted!, password); // throws on wrong password

  let payload: SharePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    corrupted();
  }

  const kp = payload.keyPackage;
  const pub = payload.publicKeyPackage;
  const id = partyIdToFrostId(file.partyId!).toString();
  try {
    if (payload.network !== file.network) corrupted();
    if (kp.identifier !== id) corrupted();
    if (kp.untweakedVerifyingKey !== file.internalKey || pub.untweakedVerifyingKey !== file.internalKey) corrupted();
    if (kp.verifyingKey !== pub.verifyingKey) corrupted();
    if (pub.verifyingShares[id] !== kp.verifyingShare || pub.untweakedVerifyingShares[id] !== kp.untweakedVerifyingShare) corrupted();
    if (kp.minSigners !== file.threshold || pub.minSigners !== file.threshold) corrupted();
    if (Object.keys(pub.verifyingShares).length !== file.parties) corrupted();

    const signingShare = bigintFrom32BE(fromHex(kp.signingShare));
    const untweakedSigningShare = bigintFrom32BE(fromHex(kp.untweakedSigningShare));
    if (!pointMatches(signingShare, kp.verifyingShare) || !pointMatches(untweakedSigningShare, kp.untweakedVerifyingShare)) corrupted();

    return {
      network: file.network as NetworkName,
      internalKey: file.internalKey!,
      partyId: file.partyId!,
      threshold: file.threshold!,
      parties: file.parties!,
      keyPackage: {
        identifier: BigInt(kp.identifier),
        signingShare,
        verifyingShare: fromHex(kp.verifyingShare),
        verifyingKey: fromHex(kp.verifyingKey),
        minSigners: kp.minSigners,
        untweakedVerifyingKey: fromHex(kp.untweakedVerifyingKey),
        untweakedSigningShare,
        untweakedVerifyingShare: fromHex(kp.untweakedVerifyingShare),
      },
      publicKeyPackage: fromVaultKey(pub),
    };
  } catch (e) {
    if ((e as Error).message === 'Share file is corrupted') throw e;
    corrupted();
  }
}

/** Throws if a decrypted share does not belong to the instance vault. */
export function assertShareMatchesVault(share: DecryptedShare, network: NetworkName, vault?: VaultKey): void {
  if (share.network !== network || (vault && vault.untweakedVerifyingKey !== share.internalKey)) {
    throw new Error('This share file belongs to a different vault');
  }
}
