/**
 * Binary serialization for ThresholdKeyShare objects.
 *
 * Layout:
 *   1B  version (0x02)
 *   1B  partyId
 *   1B  K (key polynomial count)
 *   1B  L (signature polynomial count)
 *   32B rho
 *   32B key
 *   64B tr
 *   2B  numShares (little-endian)
 *   per share:
 *     2B          bitmask (little-endian)
 *     L×736B      s1       (23-bit packed coefficients)
 *     K×736B      s2
 *     L×736B      s1Hat
 *     K×736B      s2Hat
 *
 * Polynomial packing: 256 coefficients in [0, Q), 23 bits each → 736 bytes.
 * Q = 8380417, so max value fits in 23 bits (2^23 = 8388608 > Q).
 */

import type { ThresholdKeyShare, SecretShare } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { KeyPackage as FrostKeyPackage } from '@mwaddip/frots';

const SERIALIZE_VERSION = 0x02;
const COMBINED_VERSION = 0x03;
const N_COEFFS = 256;
const Q = 8380417;
const BITS_PER_COEFF = 23;
const POLY_BYTES = Math.ceil((N_COEFFS * BITS_PER_COEFF) / 8); // 736

/** Pack a single polynomial (256 coefficients mod Q) into 736 bytes using 23-bit packing. */
function packPoly(coeffs: Int32Array): Uint8Array {
  const out = new Uint8Array(POLY_BYTES);
  let bitPos = 0;
  for (let i = 0; i < N_COEFFS; i++) {
    // Ensure coefficient is in [0, Q)
    let c = coeffs[i]!;
    if (c < 0) c += Q;
    // Write 23 bits at current bitPos
    const byteIdx = bitPos >>> 3;
    const bitOff = bitPos & 7;
    // Spread across up to 4 bytes
    out[byteIdx]! |= (c << bitOff) & 0xff;
    out[byteIdx + 1]! |= ((c << bitOff) >>> 8) & 0xff;
    out[byteIdx + 2]! |= ((c << bitOff) >>> 16) & 0xff;
    if (bitOff + BITS_PER_COEFF > 24) {
      out[byteIdx + 3]! |= ((c << bitOff) >>> 24) & 0xff;
    }
    bitPos += BITS_PER_COEFF;
  }
  return out;
}

/** Unpack 736 bytes into a polynomial of 256 coefficients mod Q. */
function unpackPoly(data: Uint8Array, offset: number): Int32Array {
  const coeffs = new Int32Array(N_COEFFS);
  const mask = (1 << BITS_PER_COEFF) - 1; // 0x7FFFFF
  let bitPos = 0;
  for (let i = 0; i < N_COEFFS; i++) {
    const byteIdx = (bitPos >>> 3) + offset;
    const bitOff = bitPos & 7;
    // Read up to 4 bytes; guard against reading past buffer end
    const b0 = data[byteIdx] ?? 0;
    const b1 = data[byteIdx + 1] ?? 0;
    const b2 = data[byteIdx + 2] ?? 0;
    const b3 = data[byteIdx + 3] ?? 0;
    let val = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> bitOff;
    val &= mask;
    coeffs[i] = val;
    bitPos += BITS_PER_COEFF;
  }
  return coeffs;
}

/** Serialize a ThresholdKeyShare into a binary blob for encryption. */
export function serializeKeyShare(
  share: ThresholdKeyShare,
  K: number,
  L: number,
): Uint8Array {
  const numShares = share.shares.size;
  const perShareSize = (2 * L + 2 * K) * POLY_BYTES + 2; // 2B bitmask + polys
  const totalSize = 1 + 1 + 1 + 1 + 32 + 32 + 64 + 2 + numShares * perShareSize;
  const buf = new Uint8Array(totalSize);
  let pos = 0;

  // Header
  buf[pos++] = SERIALIZE_VERSION;
  buf[pos++] = share.id;
  buf[pos++] = K;
  buf[pos++] = L;

  // rho (32B), key (32B), tr (64B)
  buf.set(share.rho, pos); pos += 32;
  buf.set(share.key, pos); pos += 32;
  buf.set(share.tr, pos); pos += 64;

  // numShares (2B LE)
  buf[pos++] = numShares & 0xff;
  buf[pos++] = (numShares >>> 8) & 0xff;

  // Each share entry
  for (const [bitmask, secret] of share.shares) {
    // bitmask (2B LE)
    buf[pos++] = bitmask & 0xff;
    buf[pos++] = (bitmask >>> 8) & 0xff;

    // s1: L polynomials
    for (let i = 0; i < L; i++) {
      buf.set(packPoly(secret.s1[i]!), pos);
      pos += POLY_BYTES;
    }
    // s2: K polynomials
    for (let i = 0; i < K; i++) {
      buf.set(packPoly(secret.s2[i]!), pos);
      pos += POLY_BYTES;
    }
    // s1Hat: L polynomials
    for (let i = 0; i < L; i++) {
      buf.set(packPoly(secret.s1Hat[i]!), pos);
      pos += POLY_BYTES;
    }
    // s2Hat: K polynomials
    for (let i = 0; i < K; i++) {
      buf.set(packPoly(secret.s2Hat[i]!), pos);
      pos += POLY_BYTES;
    }
  }

  return buf;
}

/** Deserialize a binary blob back into a ThresholdKeyShare. */
export function deserializeKeyShare(bytes: Uint8Array): {
  share: ThresholdKeyShare;
  K: number;
  L: number;
} {
  let pos = 0;

  const version = bytes[pos++]!;
  if (version !== SERIALIZE_VERSION) {
    throw new Error(`Unknown share version: ${version}`);
  }

  const id = bytes[pos++]!;
  const K = bytes[pos++]!;
  const L = bytes[pos++]!;

  const rho = bytes.slice(pos, pos + 32); pos += 32;
  const key = bytes.slice(pos, pos + 32); pos += 32;
  const tr = bytes.slice(pos, pos + 64); pos += 64;

  const numShares = bytes[pos]! | (bytes[pos + 1]! << 8);
  pos += 2;

  const shares = new Map<number, SecretShare>();

  for (let n = 0; n < numShares; n++) {
    const bitmask = bytes[pos]! | (bytes[pos + 1]! << 8);
    pos += 2;

    const s1: Int32Array[] = [];
    for (let i = 0; i < L; i++) {
      s1.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    const s2: Int32Array[] = [];
    for (let i = 0; i < K; i++) {
      s2.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    const s1Hat: Int32Array[] = [];
    for (let i = 0; i < L; i++) {
      s1Hat.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    const s2Hat: Int32Array[] = [];
    for (let i = 0; i < K; i++) {
      s2Hat.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    shares.set(bitmask, { s1, s2, s1Hat, s2Hat });
  }

  return {
    share: { id, rho, key, tr, shares },
    K,
    L,
  };
}

// ── FROST key package serialization ──
// Layout:
//   32B signingShare (bigint BE)
//   33B verifyingShare (SEC1)
//   33B verifyingKey (SEC1, post-tweak)
//   1B  minSigners
//   33B untweakedVerifyingKey (SEC1)
//   32B untweakedSigningShare (bigint BE)
//   33B untweakedVerifyingShare (SEC1)
// Total: 197 bytes

const FROST_KP_SIZE = 32 + 33 + 33 + 1 + 33 + 32 + 33; // 197

function bigintTo32BE(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

function bigintFrom32BE(buf: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < 32; i++) val = (val << 8n) | BigInt(buf[i]!);
  return val;
}

export function serializeFrostKeyPackage(kp: FrostKeyPackage): Uint8Array {
  const buf = new Uint8Array(FROST_KP_SIZE);
  let pos = 0;
  buf.set(bigintTo32BE(kp.signingShare), pos); pos += 32;
  buf.set(kp.verifyingShare, pos); pos += 33;
  buf.set(kp.verifyingKey, pos); pos += 33;
  buf[pos++] = kp.minSigners;
  buf.set(kp.untweakedVerifyingKey, pos); pos += 33;
  buf.set(bigintTo32BE(kp.untweakedSigningShare), pos); pos += 32;
  buf.set(kp.untweakedVerifyingShare, pos);
  return buf;
}

export function deserializeFrostKeyPackage(data: Uint8Array, identifier: bigint): FrostKeyPackage {
  let pos = 0;
  const signingShare = bigintFrom32BE(data.slice(pos, pos + 32)); pos += 32;
  const verifyingShare = data.slice(pos, pos + 33); pos += 33;
  const verifyingKey = data.slice(pos, pos + 33); pos += 33;
  const minSigners = data[pos++]!;
  const untweakedVerifyingKey = data.slice(pos, pos + 33); pos += 33;
  const untweakedSigningShare = bigintFrom32BE(data.slice(pos, pos + 32)); pos += 32;
  const untweakedVerifyingShare = data.slice(pos, pos + 33);
  return {
    identifier,
    signingShare,
    verifyingShare,
    verifyingKey,
    minSigners,
    untweakedVerifyingKey,
    untweakedSigningShare,
    untweakedVerifyingShare,
  };
}

// ── V3 combined format: ML-DSA + FROST in one blob ──
// Layout: 1B version(0x03) + 4B mldsaLen(LE) + [mldsa bytes] + [frost bytes]

export function serializeCombinedV3(
  mldsaShare: ThresholdKeyShare,
  frostKP: FrostKeyPackage,
  K: number,
  L: number,
): Uint8Array {
  const mldsa = serializeKeyShare(mldsaShare, K, L);
  const frost = serializeFrostKeyPackage(frostKP);
  const buf = new Uint8Array(1 + 4 + mldsa.length + frost.length);
  buf[0] = COMBINED_VERSION;
  const dv = new DataView(buf.buffer, 1, 4);
  dv.setUint32(0, mldsa.length, true);
  buf.set(mldsa, 5);
  buf.set(frost, 5 + mldsa.length);
  return buf;
}

export function deserializeCombinedV3(data: Uint8Array, frostIdentifier: bigint): {
  mldsaShare: ThresholdKeyShare;
  frostKeyPackage: FrostKeyPackage;
  K: number;
  L: number;
} {
  if (data[0] !== COMBINED_VERSION) throw new Error(`Expected V3 combined format, got version ${data[0]}`);
  const dv = new DataView(data.buffer, data.byteOffset + 1, 4);
  const mldsaLen = dv.getUint32(0, true);
  const mldsaBytes = data.slice(5, 5 + mldsaLen);
  const frostBytes = data.slice(5 + mldsaLen);
  const { share, K, L } = deserializeKeyShare(mldsaBytes);
  const frostKeyPackage = deserializeFrostKeyPackage(frostBytes, frostIdentifier);
  return { mldsaShare: share, frostKeyPackage, K, L };
}
