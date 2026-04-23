/**
 * PERMAFROST share file encryption + V3 serialization.
 *
 * Inverse of `decryptShareFile` in `share-crypto.ts`. Byte-compat with Ötzi's
 * `encryptShareV3` in `~/projects/otzi/src/lib/keygen.ts` — produces a JSON
 * envelope that Ötzi can read and vice versa.
 *
 * Lives here (not in `share-crypto.ts`) because `share-crypto.ts` is one of
 * the verbatim Ötzi-byte-compat files we don't edit (CLAUDE.md / SESSION_CONTEXT
 * § Extraction philosophy). The two halves of the share lifecycle live in
 * sibling files instead.
 */

import type { ThresholdKeyShare } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { KeyPackage as FrostKeyPackage } from '@mwaddip/frots';
import { encrypt } from './crypto';
import { serializeCombinedV3 } from './serialize';
import type { ShareFile } from './share-crypto';

/** V3 share file (combined ML-DSA + FROST), as written to disk. */
export type ShareFileV3 = ShareFile & { frostPublicKey: string };

/**
 * Encrypt a combined ML-DSA + FROST DKG output into an Ötzi-compatible V3
 * `ShareFile` JSON. Caller is responsible for writing the result to disk
 * with appropriate file mode (0o600 for daemon-owned shares).
 *
 * Argument order mirrors Ötzi's `encryptShareV3` for source-level parity.
 */
export async function encryptShareV3(
  mldsaShare: ThresholdKeyShare,
  frostKeyPackage: FrostKeyPackage,
  publicKeyHex: string,
  frostPublicKeyHex: string,
  threshold: number,
  parties: number,
  level: number,
  K: number,
  L: number,
  password: string,
): Promise<ShareFileV3> {
  const serialized = serializeCombinedV3(mldsaShare, frostKeyPackage, K, L);
  const encrypted = await encrypt(serialized, password);
  return {
    version: 3,
    publicKey: publicKeyHex,
    frostPublicKey: frostPublicKeyHex,
    partyId: mldsaShare.id,
    threshold,
    parties,
    level,
    encrypted,
  };
}
