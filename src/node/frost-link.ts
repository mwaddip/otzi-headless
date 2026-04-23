import { createHash } from 'node:crypto';
import { getEccLib, toXOnly } from '@btc-vision/bitcoin';
import { BinaryWriter } from '@btc-vision/transaction';
import type { NetworkName } from './types.js';

// sha256("OP_NET") — must match OPNetConsensus.consensus.PROTOCOL_ID
const BITCOIN_PROTOCOL_ID = new Uint8Array([
  0xe7, 0x84, 0x99, 0x5a, 0x41, 0x2d, 0x77, 0x39, 0x88, 0xc4, 0xb8, 0xe3, 0x33, 0xd7, 0xb3, 0x9d,
  0xfb, 0x3c, 0xab, 0xf1, 0x18, 0xd0, 0xd6, 0x45, 0x41, 0x1a, 0x91, 0x6c, 0xa2, 0x40, 0x79, 0x39,
]);

// Chain IDs must match getChainId(getNetwork(name)) from @btc-vision/transaction.
// 'testnet' maps to networks.opnetTestnet (bech32: "opt"), NOT networks.testnet (bech32: "tb").
const CHAIN_IDS: Record<string, Uint8Array> = {
  mainnet: new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x19, 0xd6, 0x68, 0x9c, 0x08, 0x5a, 0xe1, 0x65, 0x83,
    0x1e, 0x93, 0x4f, 0xf7, 0x63, 0xae, 0x46, 0xa2, 0xa6, 0xc1, 0x72, 0xb3, 0xf1, 0xb6,
    0x0a, 0x8c, 0xe2, 0x6f,
  ]),
  testnet: new Uint8Array([
    0x00, 0x00, 0x01, 0x7f, 0x85, 0x10, 0x6b, 0x1f, 0xee, 0xaf, 0x2f, 0x70, 0xf1, 0xe2,
    0xb8, 0x05, 0x98, 0x5b, 0xb5, 0x75, 0xf8, 0x8f, 0x9b, 0x0b, 0xa5, 0x75, 0x3d, 0x2f,
    0x3c, 0xf1, 0x32, 0x73,
  ]),
};

/**
 * Compute the static key-link message hash that the OPNet SDK uses for
 * `generateLegacySignature()`. All values are fixed after DKG.
 *
 * Returns the SHA-256 hash — this is what the FROST ceremony must sign.
 */
export function computeKeyLinkHash(
  mldsaPubKey: Uint8Array,
  frostAggregateKey: Uint8Array,      // 33 bytes SEC1 compressed (tweaked)
  frostUntweakedKey: Uint8Array,      // 33 bytes SEC1 compressed
  networkName: NetworkName,
): Uint8Array {
  const chainId = CHAIN_IDS[networkName];
  if (!chainId) throw new Error(`No chain ID for network: ${networkName}`);

  const hashedPubKey = createHash('sha256').update(mldsaPubKey).digest();
  const tweakedXOnly = toXOnly(frostAggregateKey as never);

  const writer = new BinaryWriter();
  writer.writeU8(0x2C); // MLDSASecurityLevel.LEVEL2 = 44
  writer.writeBytes(hashedPubKey);
  writer.writeBytes(tweakedXOnly);
  writer.writeBytes(frostUntweakedKey);
  writer.writeBytes(BITCOIN_PROTOCOL_ID);
  writer.writeBytes(chainId);

  const message = writer.getBuffer();
  return createHash('sha256').update(message).digest();
}

/**
 * Wraps an async callback so that during its execution, the shared ECC
 * backend's `signSchnorr` is intercepted: if the hash matches the
 * pre-computed key-link hash, the stored FROST legacy signature is
 * returned instead of signing with the (wrong) wallet private key.
 *
 * Also patches `TweakedSigner.tweakSigner` so the SDK's tweaked signer gets
 * the correct FROST public key (not derived from the wallet's private key).
 */
export async function withFrostLegacySig<T>(
  keyLinkHash: Uint8Array,
  frostLegacySig: Uint8Array,
  frostTweakedKey: Uint8Array,   // 33 bytes SEC1
  fn: () => T | Promise<T>,
): Promise<T> {
  const ecc = getEccLib();
  const origSignSchnorr = ecc.signSchnorr!;

  // 1. Override signSchnorr to return FROST sig for the key-link hash
  (ecc as unknown as Record<string, unknown>).signSchnorr = (hash: Uint8Array, privateKey: Uint8Array): Uint8Array => {
    if (hash.length === keyLinkHash.length && hash.every((b, i) => b === keyLinkHash[i]!)) {
      return frostLegacySig;
    }
    return origSignSchnorr(hash as never, privateKey as never);
  };

  // 2. Override TweakedSigner.tweakSigner so the SDK's getTweakedSigner()
  //    produces a signer with the correct FROST public key.
  //    The SDK calls the static method directly (not signer.tweak()), so
  //    patching the instance method has no effect.
  const { TweakedSigner } = await import('@btc-vision/transaction');
  const origTweakSigner = TweakedSigner.tweakSigner;
  (TweakedSigner as unknown as Record<string, unknown>).tweakSigner = (signer: unknown, opts?: unknown): unknown => {
    const result = origTweakSigner(signer as never, opts as never);
    Object.defineProperty(result, 'publicKey', {
      value: frostTweakedKey,
      configurable: true,
    });
    return result;
  };

  try {
    return await fn();
  } finally {
    (ecc as unknown as Record<string, unknown>).signSchnorr = origSignSchnorr;
    TweakedSigner.tweakSigner = origTweakSigner;
  }
}
