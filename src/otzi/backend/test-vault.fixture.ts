/** Test helper: a dealer-generated vault key whose group secret is known. Not used at runtime. */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { taprootTweakPrivKey } from '@scure/btc-signer/utils.js';
import type { VaultKey } from './types.js';

const n = secp256k1.Point.CURVE().n;
const G = secp256k1.Point.BASE;

function randomScalar(): bigint {
  const bytes = secp256k1.utils.randomSecretKey();
  return BigInt('0x' + Buffer.from(bytes).toString('hex')) % n;
}

function scalarBytes(x: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'));
}

export function makeTestVault(threshold: number, parties: number): { vault: VaultKey; tweakedSecret: Uint8Array } {
  const coeffs = Array.from({ length: threshold }, randomScalar);
  const f = (x: bigint) => coeffs.reduceRight((acc, c) => (acc * x + c) % n, 0n);

  const shares: Record<string, string> = {};
  for (let i = 1; i <= parties; i++) shares[String(i)] = G.multiply(f(BigInt(i))).toHex(true);

  const tweakedSecret = taprootTweakPrivKey(scalarBytes(coeffs[0]!));
  return {
    vault: {
      minSigners: threshold,
      verifyingKey: secp256k1.getPublicKey(tweakedSecret, true).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
      untweakedVerifyingKey: G.multiply(coeffs[0]!).toHex(true),
      verifyingShares: { ...shares },
      untweakedVerifyingShares: shares,
    },
    tweakedSecret,
  };
}
