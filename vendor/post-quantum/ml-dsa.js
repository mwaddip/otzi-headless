/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
import { abool } from "@noble/curves/utils.js";
import { shake256 } from "@noble/hashes/sha3.js";
import { XOF128, XOF256 } from "./_crystals.js";
import {
  MLDSAPrimitives,
  D,
  GAMMA2_1,
  GAMMA2_2,
  N
} from "./ml-dsa-primitives.js";
import {
  abytes,
  checkHash,
  cleanBytes,
  equalBytes,
  getMessage,
  getMessagePrehash,
  randomBytes,
  splitCoder,
  validateOpts,
  validateSigOpts,
  validateVerOpts
} from "./utils.js";
function validateInternalOpts(opts) {
  validateOpts(opts);
  if (opts.externalMu !== void 0) abool(opts.externalMu, "opts.externalMu");
}
const PARAMS = {
  2: { K: 4, L: 4, D, GAMMA1: 2 ** 17, GAMMA2: GAMMA2_1, TAU: 39, ETA: 2, OMEGA: 80 },
  3: { K: 6, L: 5, D, GAMMA1: 2 ** 19, GAMMA2: GAMMA2_2, TAU: 49, ETA: 4, OMEGA: 55 },
  5: { K: 8, L: 7, D, GAMMA1: 2 ** 19, GAMMA2: GAMMA2_2, TAU: 60, ETA: 2, OMEGA: 75 }
};
class MLDSAInstance {
  info = { type: "ml-dsa" };
  internal;
  lengths;
  securityLevel;
  #primitives;
  /** Access to the underlying ring arithmetic primitives. */
  get primitives() {
    return this.#primitives;
  }
  constructor(opts) {
    const p = new MLDSAPrimitives(opts);
    this.#primitives = p;
    this.securityLevel = opts.securityLevel;
    const { K, L, GAMMA1, GAMMA2, BETA, OMEGA } = p;
    const { CRH_BYTES, TR_BYTES, C_TILDE_BYTES, XOF128: XOF1282, XOF256: XOF2562 } = p;
    const {
      newPoly,
      NTT,
      polyAdd,
      polySub,
      polyShiftl,
      polyChknorm,
      MultiplyNTTs,
      RejNTTPoly,
      W1Vec,
      ZCoder,
      publicCoder,
      secretCoder,
      sigCoder
    } = p;
    const signRandBytes = 32;
    const seedCoder = splitCoder("seed", 32, 64, 32);
    this.lengths = {
      secretKey: secretCoder.bytesLen,
      publicKey: publicCoder.bytesLen,
      seed: 32,
      signature: sigCoder.bytesLen,
      signRand: signRandBytes
    };
    this.internal = {
      info: { type: "internal-ml-dsa" },
      lengths: this.lengths,
      keygen: (seed) => {
        const seedDst = new Uint8Array(32 + 2);
        const randSeed = seed === void 0;
        if (randSeed) seed = randomBytes(32);
        abytes(seed, 32, "seed");
        seedDst.set(seed);
        if (randSeed) cleanBytes(seed);
        seedDst[32] = K;
        seedDst[33] = L;
        const [rho, rhoPrime, K_] = seedCoder.decode(
          shake256(seedDst, { dkLen: seedCoder.bytesLen })
        );
        const xofPrime = XOF2562(rhoPrime);
        const s1 = [];
        for (let i = 0; i < L; i++)
          s1.push(p.RejBoundedPoly(xofPrime.get(i & 255, i >> 8 & 255)));
        const s2 = [];
        for (let i = L; i < L + K; i++)
          s2.push(p.RejBoundedPoly(xofPrime.get(i & 255, i >> 8 & 255)));
        const s1Hat = s1.map((i) => NTT.encode(i.slice()));
        const t0 = [];
        const t1 = [];
        const xof = XOF1282(rho);
        const t = newPoly(N);
        for (let i = 0; i < K; i++) {
          cleanBytes(t);
          for (let j = 0; j < L; j++) {
            const aij = RejNTTPoly(xof.get(j, i));
            polyAdd(t, MultiplyNTTs(aij, s1Hat[j]));
          }
          NTT.decode(t);
          const { r0, r1 } = p.polyPowerRound(polyAdd(t, s2[i]));
          t0.push(r0);
          t1.push(r1);
        }
        const publicKey = publicCoder.encode([rho, t1]);
        const tr = shake256(publicKey, { dkLen: TR_BYTES });
        const secretKey = secretCoder.encode([rho, K_, tr, s1, s2, t0]);
        xof.clean();
        xofPrime.clean();
        cleanBytes(rho, rhoPrime, K_, s1, s2, s1Hat, t, t0, t1, tr, seedDst);
        return { publicKey, secretKey };
      },
      getPublicKey: (secretKey) => {
        const [rho, _K, _tr, s1, s2, _t0] = secretCoder.decode(secretKey);
        const xof = XOF1282(rho);
        const s1Hat = s1.map((pp) => NTT.encode(pp.slice()));
        const t1r = [];
        const tmp = newPoly(N);
        for (let i = 0; i < K; i++) {
          tmp.fill(0);
          for (let j = 0; j < L; j++) {
            const aij = RejNTTPoly(xof.get(j, i));
            polyAdd(tmp, MultiplyNTTs(aij, s1Hat[j]));
          }
          NTT.decode(tmp);
          polyAdd(tmp, s2[i]);
          const { r1 } = p.polyPowerRound(tmp);
          t1r.push(r1);
        }
        xof.clean();
        cleanBytes(tmp, s1Hat, _t0, s1, s2);
        return publicCoder.encode([rho, t1r]);
      },
      sign: (msg, secretKey, signOpts = {}) => {
        validateSigOpts(signOpts);
        validateInternalOpts(signOpts);
        let { extraEntropy: random, externalMu = false } = signOpts;
        const [rho, _K, tr, s1, s2, t0] = secretCoder.decode(secretKey);
        const A = [];
        const xof = XOF1282(rho);
        for (let i = 0; i < K; i++) {
          const pv = [];
          for (let j = 0; j < L; j++) pv.push(RejNTTPoly(xof.get(j, i)));
          A.push(pv);
        }
        xof.clean();
        for (let i = 0; i < L; i++) NTT.encode(s1[i]);
        for (let i = 0; i < K; i++) {
          NTT.encode(s2[i]);
          NTT.encode(t0[i]);
        }
        const mu = externalMu ? msg : shake256.create({ dkLen: CRH_BYTES }).update(tr).update(msg).digest();
        const rnd = random === false ? new Uint8Array(32) : random === void 0 ? randomBytes(signRandBytes) : random;
        abytes(rnd, 32, "extraEntropy");
        const rhoprime = shake256.create({ dkLen: CRH_BYTES }).update(_K).update(rnd).update(mu).digest();
        abytes(rhoprime, CRH_BYTES);
        const x256 = XOF2562(rhoprime, ZCoder.bytesLen);
        main_loop: for (let kappa = 0; ; ) {
          const y = [];
          for (let i = 0; i < L; i++, kappa++)
            y.push(ZCoder.decode(x256.get(kappa & 255, kappa >> 8)()));
          const z = y.map((i) => NTT.encode(i.slice()));
          const w = [];
          for (let i = 0; i < K; i++) {
            const wi = newPoly(N);
            for (let j = 0; j < L; j++) polyAdd(wi, MultiplyNTTs(A[i][j], z[j]));
            NTT.decode(wi);
            w.push(wi);
          }
          const w1 = w.map((j) => j.map((x) => p.HighBits(x)));
          const cTilde = shake256.create({ dkLen: C_TILDE_BYTES }).update(mu).update(W1Vec.encode(w1)).digest();
          const cHat = NTT.encode(p.SampleInBall(cTilde));
          const cs1 = s1.map((i) => MultiplyNTTs(i, cHat));
          for (let i = 0; i < L; i++) {
            polyAdd(NTT.decode(cs1[i]), y[i]);
            if (polyChknorm(cs1[i], GAMMA1 - BETA)) continue main_loop;
          }
          let cnt = 0;
          const h = [];
          for (let i = 0; i < K; i++) {
            const cs2 = NTT.decode(MultiplyNTTs(s2[i], cHat));
            const r0 = polySub(w[i], cs2).map((x) => p.LowBits(x));
            if (polyChknorm(r0, GAMMA2 - BETA)) continue main_loop;
            const ct0 = NTT.decode(MultiplyNTTs(t0[i], cHat));
            if (polyChknorm(ct0, GAMMA2)) continue main_loop;
            polyAdd(r0, ct0);
            const hint = p.polyMakeHint(r0, w1[i]);
            h.push(hint.v);
            cnt += hint.cnt;
          }
          if (cnt > OMEGA) continue;
          x256.clean();
          const res = sigCoder.encode([cTilde, cs1, h]);
          cleanBytes(cTilde, cs1, h, cHat, w1, w, z, y, rhoprime, mu, s1, s2, t0, ...A);
          return res;
        }
      },
      verify: (sig, msg, publicKey, verOpts = {}) => {
        validateInternalOpts(verOpts);
        const { externalMu = false } = verOpts;
        const [rho, t1] = publicCoder.decode(publicKey);
        const tr = shake256(publicKey, { dkLen: TR_BYTES });
        if (sig.length !== sigCoder.bytesLen) return false;
        const [cTilde, z, h] = sigCoder.decode(sig);
        if (h === false) return false;
        for (let i = 0; i < L; i++) if (polyChknorm(z[i], GAMMA1 - BETA)) return false;
        const mu = externalMu ? msg : shake256.create({ dkLen: CRH_BYTES }).update(tr).update(msg).digest();
        const c = NTT.encode(p.SampleInBall(cTilde));
        const zNtt = z.map((i) => i.slice());
        for (let i = 0; i < L; i++) NTT.encode(zNtt[i]);
        const wTick1 = [];
        const xof = XOF1282(rho);
        for (let i = 0; i < K; i++) {
          const ct12d = MultiplyNTTs(NTT.encode(polyShiftl(t1[i])), c);
          const Az = newPoly(N);
          for (let j = 0; j < L; j++) {
            const aij = RejNTTPoly(xof.get(j, i));
            polyAdd(Az, MultiplyNTTs(aij, zNtt[j]));
          }
          const wApprox = NTT.decode(polySub(Az, ct12d));
          wTick1.push(p.polyUseHint(wApprox, h[i]));
        }
        xof.clean();
        const c2 = shake256.create({ dkLen: C_TILDE_BYTES }).update(mu).update(W1Vec.encode(wTick1)).digest();
        for (const t of h) {
          const sum = t.reduce((acc, i) => acc + i, 0);
          if (!(sum <= OMEGA)) return false;
        }
        for (const t of z) if (polyChknorm(t, GAMMA1 - BETA)) return false;
        return equalBytes(cTilde, c2);
      }
    };
  }
  /** Generate a new ML-DSA key pair. */
  keygen(seed) {
    return this.internal.keygen(seed);
  }
  /** Derive the public key from a secret key. */
  getPublicKey(secretKey) {
    return this.internal.getPublicKey(secretKey);
  }
  /** Sign a message with FIPS 204 domain separation. */
  sign(msg, secretKey, opts = {}) {
    validateSigOpts(opts);
    const M = getMessage(msg, opts.context);
    const res = this.internal.sign(M, secretKey, opts);
    cleanBytes(M);
    return res;
  }
  /** Verify a signature with FIPS 204 domain separation. */
  verify(sig, msg, publicKey, opts = {}) {
    validateVerOpts(opts);
    return this.internal.verify(sig, getMessage(msg, opts.context), publicKey);
  }
  /** Create a prehash variant using the given hash function. */
  prehash(hash) {
    checkHash(hash, this.securityLevel);
    const internal = this.internal;
    return {
      info: { type: "hashml-dsa" },
      securityLevel: this.securityLevel,
      lengths: internal.lengths,
      keygen: internal.keygen,
      getPublicKey: internal.getPublicKey,
      sign: (msg, secretKey, opts = {}) => {
        validateSigOpts(opts);
        const M = getMessagePrehash(hash, msg, opts.context);
        const res = internal.sign(M, secretKey, opts);
        cleanBytes(M);
        return res;
      },
      verify: (sig, msg, publicKey, opts = {}) => {
        validateVerOpts(opts);
        return internal.verify(sig, getMessagePrehash(hash, msg, opts.context), publicKey);
      }
    };
  }
}
function getDilithium(opts) {
  return new MLDSAInstance(opts);
}
const ml_dsa44 = /* @__PURE__ */ new MLDSAInstance({
  ...PARAMS[2],
  CRH_BYTES: 64,
  TR_BYTES: 64,
  C_TILDE_BYTES: 32,
  XOF128,
  XOF256,
  securityLevel: 128
});
const ml_dsa65 = /* @__PURE__ */ new MLDSAInstance({
  ...PARAMS[3],
  CRH_BYTES: 64,
  TR_BYTES: 64,
  C_TILDE_BYTES: 48,
  XOF128,
  XOF256,
  securityLevel: 192
});
const ml_dsa87 = /* @__PURE__ */ new MLDSAInstance({
  ...PARAMS[5],
  CRH_BYTES: 64,
  TR_BYTES: 64,
  C_TILDE_BYTES: 64,
  XOF128,
  XOF256,
  securityLevel: 256
});
export {
  PARAMS,
  getDilithium,
  ml_dsa44,
  ml_dsa65,
  ml_dsa87
};
