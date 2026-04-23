/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
import { sha3_256, sha3_512, shake256 } from "@noble/hashes/sha3.js";
import { u32 } from "@noble/hashes/utils.js";
import { genCrystals, XOF128 } from "./_crystals.js";
import {
  abytes,
  cleanBytes,
  copyBytes,
  equalBytes,
  randomBytes,
  splitCoder,
  vecCoder
} from "./utils.js";
const N = 256;
const Q = 3329;
const F = 3303;
const ROOT_OF_UNITY = 17;
const { mod, nttZetas, NTT, bitsCoder } = genCrystals({
  N,
  Q,
  F,
  ROOT_OF_UNITY,
  newPoly: (n) => new Uint16Array(n),
  brvBits: 7,
  isKyber: true
});
const PARAMS = {
  512: { N, Q, K: 2, ETA1: 3, ETA2: 2, du: 10, dv: 4, RBGstrength: 128 },
  768: { N, Q, K: 3, ETA1: 2, ETA2: 2, du: 10, dv: 4, RBGstrength: 192 },
  1024: { N, Q, K: 4, ETA1: 2, ETA2: 2, du: 11, dv: 5, RBGstrength: 256 }
};
const compress = (d) => {
  if (d >= 12) return { encode: (i) => i, decode: (i) => i };
  const a = 2 ** (d - 1);
  return {
    // const compress = (i: number) => round((2 ** d / Q) * i) % 2 ** d;
    encode: (i) => ((i << d) + Q / 2) / Q,
    // const decompress = (i: number) => round((Q / 2 ** d) * i);
    decode: (i) => i * Q + a >>> d
  };
};
const polyCoder = (d) => bitsCoder(d, compress(d));
function polyAdd(a, b) {
  for (let i = 0; i < N; i++) a[i] = mod(a[i] + b[i]);
}
function polySub(a, b) {
  for (let i = 0; i < N; i++) a[i] = mod(a[i] - b[i]);
}
function BaseCaseMultiply(a0, a1, b0, b1, zeta) {
  const c0 = mod(a1 * b1 * zeta + a0 * b0);
  const c1 = mod(a0 * b1 + a1 * b0);
  return { c0, c1 };
}
function MultiplyNTTs(f, g) {
  for (let i = 0; i < N / 2; i++) {
    let z = nttZetas[64 + (i >> 1)];
    if (i & 1) z = -z;
    const { c0, c1 } = BaseCaseMultiply(
      f[2 * i + 0],
      f[2 * i + 1],
      g[2 * i + 0],
      g[2 * i + 1],
      z
    );
    f[2 * i + 0] = c0;
    f[2 * i + 1] = c1;
  }
  return f;
}
function SampleNTT(xof) {
  const r = new Uint16Array(N);
  for (let j = 0; j < N; ) {
    const b = xof();
    if (b.length % 3) throw new Error("SampleNTT: unaligned block");
    for (let i = 0; j < N && i + 3 <= b.length; i += 3) {
      const d1 = (b[i + 0] >> 0 | b[i + 1] << 8) & 4095;
      const d2 = (b[i + 1] >> 4 | b[i + 2] << 4) & 4095;
      if (d1 < Q) r[j++] = d1;
      if (j < N && d2 < Q) r[j++] = d2;
    }
  }
  return r;
}
function sampleCBD(PRF, seed, nonce, eta) {
  const buf = PRF(eta * N / 4, seed, nonce);
  const r = new Uint16Array(N);
  const b32 = u32(buf);
  let len = 0;
  for (let i = 0, p = 0, bb = 0, t0 = 0; i < b32.length; i++) {
    let b = b32[i];
    for (let j = 0; j < 32; j++) {
      bb += b & 1;
      b >>= 1;
      len += 1;
      if (len === eta) {
        t0 = bb;
        bb = 0;
      } else if (len === 2 * eta) {
        r[p++] = mod(t0 - bb);
        bb = 0;
        len = 0;
      }
    }
  }
  if (len) throw new Error(`sampleCBD: leftover bits: ${len}`);
  return r;
}
const genKPKE = (opts2) => {
  const { K, PRF, XOF, HASH512, ETA1, ETA2, du, dv } = opts2;
  const poly1 = polyCoder(1);
  const polyV = polyCoder(dv);
  const polyU = polyCoder(du);
  const publicCoder = splitCoder("publicKey", vecCoder(polyCoder(12), K), 32);
  const secretCoder = vecCoder(polyCoder(12), K);
  const cipherCoder = splitCoder("ciphertext", vecCoder(polyU, K), polyV);
  const seedCoder = splitCoder("seed", 32, 32);
  return {
    secretCoder,
    lengths: {
      secretKey: secretCoder.bytesLen,
      publicKey: publicCoder.bytesLen,
      cipherText: cipherCoder.bytesLen
    },
    keygen: (seed) => {
      abytes(seed, 32, "seed");
      const seedDst = new Uint8Array(33);
      seedDst.set(seed);
      seedDst[32] = K;
      const seedHash = HASH512(seedDst);
      const [rho, sigma] = seedCoder.decode(seedHash);
      const sHat = [];
      const tHat = [];
      for (let i = 0; i < K; i++) sHat.push(NTT.encode(sampleCBD(PRF, sigma, i, ETA1)));
      const x = XOF(rho);
      for (let i = 0; i < K; i++) {
        const e = NTT.encode(sampleCBD(PRF, sigma, K + i, ETA1));
        for (let j = 0; j < K; j++) {
          const aji = SampleNTT(x.get(j, i));
          polyAdd(e, MultiplyNTTs(aji, sHat[j]));
        }
        tHat.push(e);
      }
      x.clean();
      const res = {
        publicKey: publicCoder.encode([tHat, rho]),
        secretKey: secretCoder.encode(sHat)
      };
      cleanBytes(rho, sigma, sHat, tHat, seedDst, seedHash);
      return res;
    },
    encrypt: (publicKey, msg, seed) => {
      const [tHat, rho] = publicCoder.decode(publicKey);
      const rHat = [];
      for (let i = 0; i < K; i++) rHat.push(NTT.encode(sampleCBD(PRF, seed, i, ETA1)));
      const x = XOF(rho);
      const tmp2 = new Uint16Array(N);
      const u = [];
      for (let i = 0; i < K; i++) {
        const e1 = sampleCBD(PRF, seed, K + i, ETA2);
        const tmp = new Uint16Array(N);
        for (let j = 0; j < K; j++) {
          const aij = SampleNTT(x.get(i, j));
          polyAdd(tmp, MultiplyNTTs(aij, rHat[j]));
        }
        polyAdd(e1, NTT.decode(tmp));
        u.push(e1);
        polyAdd(tmp2, MultiplyNTTs(tHat[i], rHat[i]));
        cleanBytes(tmp);
      }
      x.clean();
      const e2 = sampleCBD(PRF, seed, 2 * K, ETA2);
      polyAdd(e2, NTT.decode(tmp2));
      const v = poly1.decode(msg);
      polyAdd(v, e2);
      cleanBytes(tHat, rHat, tmp2, e2);
      return cipherCoder.encode([u, v]);
    },
    decrypt: (cipherText, privateKey) => {
      const [u, v] = cipherCoder.decode(cipherText);
      const sk = secretCoder.decode(privateKey);
      const tmp = new Uint16Array(N);
      for (let i = 0; i < K; i++) polyAdd(tmp, MultiplyNTTs(sk[i], NTT.encode(u[i])));
      polySub(v, NTT.decode(tmp));
      cleanBytes(tmp, sk, u);
      return poly1.encode(v);
    }
  };
};
function createKyber(opts2) {
  const KPKE = genKPKE(opts2);
  const { HASH256, HASH512, KDF } = opts2;
  const { secretCoder: KPKESecretCoder, lengths } = KPKE;
  const secretCoder = splitCoder("secretKey", lengths.secretKey, lengths.publicKey, 32, 32);
  const msgLen = 32;
  const seedLen = 64;
  return {
    info: { type: "ml-kem" },
    lengths: {
      ...lengths,
      seed: 64,
      msg: msgLen,
      msgRand: msgLen,
      secretKey: secretCoder.bytesLen
    },
    keygen: (seed = randomBytes(seedLen)) => {
      abytes(seed, seedLen, "seed");
      const { publicKey, secretKey: sk } = KPKE.keygen(seed.subarray(0, 32));
      const publicKeyHash = HASH256(publicKey);
      const secretKey = secretCoder.encode([sk, publicKey, publicKeyHash, seed.subarray(32)]);
      cleanBytes(sk, publicKeyHash);
      return { publicKey, secretKey };
    },
    getPublicKey: (secretKey) => {
      const [_sk, publicKey, _publicKeyHash, _z] = secretCoder.decode(secretKey);
      return Uint8Array.from(publicKey);
    },
    encapsulate: (publicKey, msg = randomBytes(msgLen)) => {
      abytes(publicKey, lengths.publicKey, "publicKey");
      abytes(msg, msgLen, "message");
      const eke = publicKey.subarray(0, 384 * opts2.K);
      const ek = KPKESecretCoder.encode(KPKESecretCoder.decode(copyBytes(eke)));
      if (!equalBytes(ek, eke)) {
        cleanBytes(ek);
        throw new Error("ML-KEM.encapsulate: wrong publicKey modulus");
      }
      cleanBytes(ek);
      const kr = HASH512.create().update(msg).update(HASH256(publicKey)).digest();
      const cipherText = KPKE.encrypt(publicKey, msg, kr.subarray(32, 64));
      cleanBytes(kr.subarray(32));
      return { cipherText, sharedSecret: kr.subarray(0, 32) };
    },
    decapsulate: (cipherText, secretKey) => {
      abytes(secretKey, secretCoder.bytesLen, "secretKey");
      abytes(cipherText, lengths.cipherText, "cipherText");
      const k768 = secretCoder.bytesLen - 96;
      const start = k768 + 32;
      const test = HASH256(secretKey.subarray(k768 / 2, start));
      if (!equalBytes(test, secretKey.subarray(start, start + 32)))
        throw new Error("invalid secretKey: hash check failed");
      const [sk, publicKey, publicKeyHash, z] = secretCoder.decode(secretKey);
      const msg = KPKE.decrypt(cipherText, sk);
      const kr = HASH512.create().update(msg).update(publicKeyHash).digest();
      const Khat = kr.subarray(0, 32);
      const cipherText2 = KPKE.encrypt(publicKey, msg, kr.subarray(32, 64));
      const isValid = equalBytes(cipherText, cipherText2);
      const Kbar = KDF.create({ dkLen: 32 }).update(z).update(cipherText).digest();
      cleanBytes(msg, cipherText2, !isValid ? Khat : Kbar);
      return isValid ? Khat : Kbar;
    }
  };
}
function shakePRF(dkLen, key, nonce) {
  return shake256.create({ dkLen }).update(key).update(new Uint8Array([nonce])).digest();
}
const opts = {
  HASH256: sha3_256,
  HASH512: sha3_512,
  KDF: shake256,
  XOF: XOF128,
  PRF: shakePRF
};
const ml_kem512 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[512]
});
const ml_kem768 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[768]
});
const ml_kem1024 = /* @__PURE__ */ createKyber({
  ...opts,
  ...PARAMS[1024]
});
export {
  PARAMS,
  ml_kem1024,
  ml_kem512,
  ml_kem768
};
