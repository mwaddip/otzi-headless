/**
 * PERMAFROST share file decryption + V2 deserialization.
 */

import type { ThresholdKeyShare } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { KeyPackage as FrostKeyPackage } from '@mwaddip/frots';
import { decrypt } from './crypto';
import { deserializeKeyShare, deserializeCombinedV3 } from './serialize';
import { partyIdToFrostId } from './dkg';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Parsed share file (JSON on disk). */
export interface ShareFile {
  version: number;
  publicKey: string;
  partyId: number;
  threshold: number;
  parties: number;
  level: number;
  encrypted: string;
}

/** Decrypted share ready for signing. */
export interface DecryptedShare {
  publicKey: string;
  partyId: number;
  threshold: number;
  parties: number;
  level: number;
  shareBytes: Uint8Array;
  keyShare: ThresholdKeyShare;
  K: number;
  L: number;
  frostKeyPackage?: FrostKeyPackage;
  frostPublicKey?: string;
}

/** Parse and decrypt a share file. Throws on wrong password. */
export async function decryptShareFile(
  file: ShareFile & { frostPublicKey?: string },
  password: string,
): Promise<DecryptedShare> {
  const shareBytes = await decrypt(file.encrypted, password);

  if (file.version === 3) {
    const frostId = partyIdToFrostId(file.partyId);
    const { mldsaShare, frostKeyPackage, K, L } = deserializeCombinedV3(shareBytes, frostId);
    return {
      publicKey: file.publicKey,
      partyId: file.partyId,
      threshold: file.threshold,
      parties: file.parties,
      level: file.level,
      shareBytes,
      keyShare: mldsaShare,
      K,
      L,
      frostKeyPackage,
      frostPublicKey: file.frostPublicKey,
    };
  }

  const { share: keyShare, K, L } = deserializeKeyShare(shareBytes);
  return {
    publicKey: file.publicKey,
    partyId: file.partyId,
    threshold: file.threshold,
    parties: file.parties,
    level: file.level,
    shareBytes,
    keyShare,
    K,
    L,
  };
}
