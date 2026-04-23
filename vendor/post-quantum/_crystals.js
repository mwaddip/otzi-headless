/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
import { FFTCore, reverseBits } from "@noble/curves/abstract/fft.js";
import { shake128, shake256 } from "@noble/hashes/sha3.js";
import { cleanBytes, getMask } from "./utils.js";
const genCrystals = (opts) => {
  const { newPoly, N, Q, F, ROOT_OF_UNITY, brvBits, isKyber } = opts;
  const mod = (a, modulo = Q) => {
    const result = a % modulo | 0;
    return (result >= 0 ? result | 0 : modulo + result | 0) | 0;
  };
  const smod = (a, modulo = Q) => {
    const r = mod(a, modulo) | 0;
    return (r > modulo >> 1 ? r - modulo | 0 : r) | 0;
  };
  function getZettas() {
    const out = newPoly(N);
    for (let i = 0; i < N; i++) {
      const b = reverseBits(i, brvBits);
      const p = BigInt(ROOT_OF_UNITY) ** BigInt(b) % BigInt(Q);
      out[i] = Number(p) | 0;
    }
    return out;
  }
  const nttZetas = getZettas();
  const field = {
    add: (a, b) => mod((a | 0) + (b | 0)) | 0,
    sub: (a, b) => mod((a | 0) - (b | 0)) | 0,
    mul: (a, b) => mod((a | 0) * (b | 0)) | 0,
    inv: (_a) => {
      throw new Error("not implemented");
    }
  };
  const nttOpts = {
    N,
    roots: nttZetas,
    invertButterflies: true,
    skipStages: isKyber ? 1 : 0,
    brp: false
  };
  const dif = FFTCore(field, { dit: false, ...nttOpts });
  const dit = FFTCore(field, { dit: true, ...nttOpts });
  const NTT = {
    encode: (r) => {
      return dif(r);
    },
    decode: (r) => {
      dit(r);
      for (let i = 0; i < r.length; i++) r[i] = mod(F * r[i]);
      return r;
    }
  };
  const bitsCoder = (d, c) => {
    const mask = getMask(d);
    const bytesLen = d * (N / 8);
    return {
      bytesLen,
      encode: (poly) => {
        const r = new Uint8Array(bytesLen);
        for (let i = 0, buf = 0, bufLen = 0, pos = 0; i < poly.length; i++) {
          buf |= (c.encode(poly[i]) & mask) << bufLen;
          bufLen += d;
          for (; bufLen >= 8; bufLen -= 8, buf >>= 8) r[pos++] = buf & getMask(bufLen);
        }
        return r;
      },
      decode: (bytes) => {
        const r = newPoly(N);
        for (let i = 0, buf = 0, bufLen = 0, pos = 0; i < bytes.length; i++) {
          buf |= bytes[i] << bufLen;
          bufLen += 8;
          for (; bufLen >= d; bufLen -= d, buf >>= d) r[pos++] = c.decode(buf & mask);
        }
        return r;
      }
    };
  };
  return { mod, smod, nttZetas, NTT, bitsCoder };
};
const createXofShake = (shake) => (seed, blockLen) => {
  if (!blockLen) blockLen = shake.blockLen;
  const _seed = new Uint8Array(seed.length + 2);
  _seed.set(seed);
  const seedLen = seed.length;
  const buf = new Uint8Array(blockLen);
  let h = shake.create({});
  let calls = 0;
  let xofs = 0;
  return {
    stats: () => ({ calls, xofs }),
    get: (x, y) => {
      _seed[seedLen + 0] = x;
      _seed[seedLen + 1] = y;
      h.destroy();
      h = shake.create({}).update(_seed);
      calls++;
      return () => {
        xofs++;
        return h.xofInto(buf);
      };
    },
    clean: () => {
      h.destroy();
      cleanBytes(buf, _seed);
    }
  };
};
const XOF128 = /* @__PURE__ */ createXofShake(shake128);
const XOF256 = /* @__PURE__ */ createXofShake(shake256);
export {
  XOF128,
  XOF256,
  genCrystals
};
