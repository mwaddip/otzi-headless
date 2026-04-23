/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
import { shake256 } from "@noble/hashes/sha3.js";
import { genCrystals } from "./_crystals.js";
import { cleanBytes, splitCoder, vecCoder } from "./utils.js";
const N = 256;
const Q = 8380417;
const ROOT_OF_UNITY = 1753;
const F = 8347681;
const D = 13;
const GAMMA2_1 = Math.floor((Q - 1) / 88) | 0;
const GAMMA2_2 = Math.floor((Q - 1) / 32) | 0;
const newPoly = (n) => new Int32Array(n);
const { mod, smod, NTT, bitsCoder } = genCrystals({
  N,
  Q,
  F,
  ROOT_OF_UNITY,
  newPoly,
  isKyber: false,
  brvBits: 8
});
const polyAdd = (a, b) => {
  for (let i = 0; i < a.length; i++) a[i] = mod(a[i] + b[i]);
  return a;
};
const polySub = (a, b) => {
  for (let i = 0; i < a.length; i++) a[i] = mod(a[i] - b[i]);
  return a;
};
const polyShiftl = (p) => {
  for (let i = 0; i < N; i++) p[i] <<= D;
  return p;
};
const polyChknorm = (p, B) => {
  for (let i = 0; i < N; i++) if (Math.abs(smod(p[i])) >= B) return true;
  return false;
};
const MultiplyNTTs = (a, b) => {
  const c = newPoly(N);
  for (let i = 0; i < a.length; i++) c[i] = mod(a[i] * b[i]);
  return c;
};
function RejNTTPoly(xof) {
  const r = newPoly(N);
  for (let j = 0; j < N; ) {
    const b = xof();
    if (b.length % 3) throw new Error("RejNTTPoly: unaligned block");
    for (let i = 0; j < N && i <= b.length - 3; i += 3) {
      const t = (b[i + 0] | b[i + 1] << 8 | b[i + 2] << 16) & 8388607;
      if (t < Q) r[j++] = t;
    }
  }
  return r;
}
const id = (n) => n;
const polyCoder = (d, compress = id, verify = id) => bitsCoder(d, {
  encode: (i) => compress(verify(i)),
  decode: (i) => verify(compress(i))
});
class MLDSAPrimitives {
  // --- Private fields ---
  #coefFromHalfByte;
  // --- Public readonly constants ---
  K;
  L;
  N = N;
  Q = Q;
  D = D;
  GAMMA1;
  GAMMA2;
  TAU;
  ETA;
  OMEGA;
  BETA;
  C_TILDE_BYTES;
  CRH_BYTES;
  TR_BYTES;
  GAMMA2_1 = GAMMA2_1;
  GAMMA2_2 = GAMMA2_2;
  // --- Public readonly utilities (pure, parameter-independent) ---
  mod = mod;
  smod = smod;
  newPoly = newPoly;
  polyAdd = polyAdd;
  polySub = polySub;
  polyShiftl = polyShiftl;
  polyChknorm = polyChknorm;
  MultiplyNTTs = MultiplyNTTs;
  NTT = NTT;
  RejNTTPoly = RejNTTPoly;
  XOF128;
  XOF256;
  cleanBytes = cleanBytes;
  // --- Public readonly coders (parameter-dependent, created in constructor) ---
  ETACoder;
  T0Coder;
  T1Coder;
  ZCoder;
  W1Coder;
  W1Vec;
  hintCoder;
  sigCoder;
  publicCoder;
  secretCoder;
  constructor(opts) {
    const { K, L, GAMMA1, GAMMA2, TAU, ETA, OMEGA } = opts;
    const { CRH_BYTES, TR_BYTES, C_TILDE_BYTES, XOF128: _XOF128, XOF256: _XOF256 } = opts;
    if (![2, 4].includes(ETA)) throw new Error("Wrong ETA");
    if (![1 << 17, 1 << 19].includes(GAMMA1)) throw new Error("Wrong GAMMA1");
    if (![GAMMA2_1, GAMMA2_2].includes(GAMMA2)) throw new Error("Wrong GAMMA2");
    this.K = K;
    this.L = L;
    this.GAMMA1 = GAMMA1;
    this.GAMMA2 = GAMMA2;
    this.TAU = TAU;
    this.ETA = ETA;
    this.OMEGA = OMEGA;
    this.BETA = TAU * ETA;
    this.C_TILDE_BYTES = C_TILDE_BYTES;
    this.CRH_BYTES = CRH_BYTES;
    this.TR_BYTES = TR_BYTES;
    this.XOF128 = _XOF128;
    this.XOF256 = _XOF256;
    this.#coefFromHalfByte = ETA === 2 ? (n) => n < 15 ? 2 - n % 5 : false : (n) => n < 9 ? 4 - n : false;
    this.hintCoder = {
      bytesLen: OMEGA + K,
      encode: (h) => {
        if (h === false) throw new Error("hint.encode: hint is false");
        const res = new Uint8Array(OMEGA + K);
        for (let i = 0, k = 0; i < K; i++) {
          for (let j = 0; j < N; j++) if (h[i][j] !== 0) res[k++] = j;
          res[OMEGA + i] = k;
        }
        return res;
      },
      decode: (buf) => {
        const h = [];
        let k = 0;
        for (let i = 0; i < K; i++) {
          const hi = newPoly(N);
          if (buf[OMEGA + i] < k || buf[OMEGA + i] > OMEGA) return false;
          for (let j = k; j < buf[OMEGA + i]; j++) {
            if (j > k && buf[j] <= buf[j - 1]) return false;
            hi[buf[j]] = 1;
          }
          k = buf[OMEGA + i];
          h.push(hi);
        }
        for (let j = k; j < OMEGA; j++) if (buf[j] !== 0) return false;
        return h;
      }
    };
    this.ETACoder = polyCoder(
      ETA === 2 ? 3 : 4,
      (i) => ETA - i,
      (i) => {
        if (!(-ETA <= i && i <= ETA))
          throw new Error(
            `malformed key s1/s3 ${i} outside of ETA range [${-ETA}, ${ETA}]`
          );
        return i;
      }
    );
    this.T0Coder = polyCoder(13, (i) => (1 << D - 1) - i);
    this.T1Coder = polyCoder(10);
    this.ZCoder = polyCoder(GAMMA1 === 1 << 17 ? 18 : 20, (i) => smod(GAMMA1 - i));
    this.W1Coder = polyCoder(GAMMA2 === GAMMA2_1 ? 6 : 4);
    this.W1Vec = vecCoder(this.W1Coder, K);
    this.publicCoder = splitCoder("publicKey", 32, vecCoder(this.T1Coder, K));
    this.secretCoder = splitCoder(
      "secretKey",
      32,
      32,
      TR_BYTES,
      vecCoder(this.ETACoder, L),
      vecCoder(this.ETACoder, K),
      vecCoder(this.T0Coder, K)
    );
    this.sigCoder = splitCoder(
      "signature",
      C_TILDE_BYTES,
      vecCoder(this.ZCoder, L),
      this.hintCoder
    );
  }
  /** Decompose r into (r1, r0) such that r = r1*(2*GAMMA2) + r0 mod q (FIPS 204 Algorithm 17). */
  decompose(r) {
    const rPlus = mod(r);
    const r0 = smod(rPlus, 2 * this.GAMMA2) | 0;
    if (rPlus - r0 === Q - 1) return { r1: 0 | 0, r0: r0 - 1 | 0 };
    const r1 = Math.floor((rPlus - r0) / (2 * this.GAMMA2)) | 0;
    return { r1, r0 };
  }
  /** Extract high bits of r. */
  HighBits(r) {
    return this.decompose(r).r1;
  }
  /** Extract low bits of r. */
  LowBits(r) {
    return this.decompose(r).r0;
  }
  /** Compute hint bit indicating whether adding z to r alters the high bits. */
  MakeHint(z, r) {
    const g2 = this.GAMMA2;
    return z <= g2 || z > Q - g2 || z === Q - g2 && r === 0 ? 0 : 1;
  }
  /** Return the high bits of r adjusted according to hint h. */
  UseHint(h, r) {
    const m = Math.floor((Q - 1) / (2 * this.GAMMA2));
    const { r1, r0 } = this.decompose(r);
    if (h === 1) return r0 > 0 ? mod(r1 + 1, m) | 0 : mod(r1 - 1, m) | 0;
    return r1 | 0;
  }
  /** Decompose r into (r1, r0) such that r = r1*(2^d) + r0 mod q. */
  Power2Round(r) {
    const rPlus = mod(r);
    const r0 = smod(rPlus, 2 ** D) | 0;
    return { r1: Math.floor((rPlus - r0) / 2 ** D) | 0, r0 };
  }
  /** Apply Power2Round to each coefficient of a polynomial. */
  polyPowerRound(p) {
    const res0 = newPoly(N);
    const res1 = newPoly(N);
    for (let i = 0; i < p.length; i++) {
      const { r0, r1 } = this.Power2Round(p[i]);
      res0[i] = r0;
      res1[i] = r1;
    }
    return { r0: res0, r1: res1 };
  }
  /** Apply UseHint element-wise. **Mutates `u` in place.** */
  polyUseHint(u, h) {
    for (let i = 0; i < N; i++) u[i] = this.UseHint(h[i], u[i]);
    return u;
  }
  /** Apply MakeHint element-wise, returning the hint vector and popcount. */
  polyMakeHint(a, b) {
    const v = newPoly(N);
    let cnt = 0;
    for (let i = 0; i < N; i++) {
      const h = this.MakeHint(a[i], b[i]);
      v[i] = h;
      cnt += h;
    }
    return { v, cnt };
  }
  /** Sample a polynomial with coefficients in [-ETA, ETA] via rejection (FIPS 204 Algorithm 15). */
  RejBoundedPoly(xof) {
    const r = newPoly(N);
    for (let j = 0; j < N; ) {
      const b = xof();
      for (let i = 0; j < N && i < b.length; i += 1) {
        const d1 = this.#coefFromHalfByte(b[i] & 15);
        const d2 = this.#coefFromHalfByte(b[i] >> 4 & 15);
        if (d1 !== false) r[j++] = d1;
        if (j < N && d2 !== false) r[j++] = d2;
      }
    }
    return r;
  }
  /** Sample a polynomial c in R_q with coefficients from {-1, 0, 1} and Hamming weight TAU (FIPS 204 Algorithm 16). */
  SampleInBall(seed) {
    const pre = newPoly(N);
    const s = shake256.create({}).update(seed);
    const buf = new Uint8Array(shake256.blockLen);
    s.xofInto(buf);
    const masks = buf.slice(0, 8);
    for (let i = N - this.TAU, pos = 8, maskPos = 0, maskBit = 0; i < N; i++) {
      let b = i + 1;
      for (; b > i; ) {
        b = buf[pos++];
        if (pos < shake256.blockLen) continue;
        s.xofInto(buf);
        pos = 0;
      }
      pre[i] = pre[b];
      pre[b] = 1 - ((masks[maskPos] >> maskBit++ & 1) << 1);
      if (maskBit >= 8) {
        maskPos++;
        maskBit = 0;
      }
    }
    return pre;
  }
}
function createMLDSAPrimitives(opts) {
  return new MLDSAPrimitives(opts);
}
export {
  D,
  GAMMA2_1,
  GAMMA2_2,
  MLDSAPrimitives,
  N,
  Q,
  createMLDSAPrimitives
};
