/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
import { shake256 } from "@noble/hashes/sha3.js";
import { XOF128, XOF256 } from "./_crystals.js";
import { MLDSAPrimitives, N, Q } from "./ml-dsa-primitives.js";
import { PARAMS } from "./ml-dsa.js";
import { abytes, cleanBytes, equalBytes, getMessage, randomBytes } from "./utils.js";
class Round1State {
  #stws;
  #commitment;
  #destroyed;
  /** @internal */
  constructor(stws, commitment) {
    this.#stws = stws;
    this.#commitment = commitment;
    this.#destroyed = false;
  }
  /** @internal */
  get _stws() {
    if (this.#destroyed) throw new Error("Round1State has been destroyed");
    return this.#stws;
  }
  /** @internal */
  get _commitment() {
    if (this.#destroyed) throw new Error("Round1State has been destroyed");
    return this.#commitment;
  }
  /** Zero out all sensitive data in this state. */
  destroy() {
    if (!this.#destroyed) {
      for (const stw of this.#stws) stw.fill(0);
      this.#destroyed = true;
    }
  }
}
class Round2State {
  #hashes;
  #mu;
  #act;
  #activePartyIds;
  #destroyed;
  /** @internal */
  constructor(hashes, mu, act, activePartyIds) {
    this.#hashes = hashes;
    this.#mu = mu;
    this.#act = act;
    this.#activePartyIds = activePartyIds;
    this.#destroyed = false;
  }
  /** @internal */
  get _hashes() {
    if (this.#destroyed) throw new Error("Round2State has been destroyed");
    return this.#hashes;
  }
  /** @internal */
  get _mu() {
    if (this.#destroyed) throw new Error("Round2State has been destroyed");
    return this.#mu;
  }
  /** @internal */
  get _act() {
    if (this.#destroyed) throw new Error("Round2State has been destroyed");
    return this.#act;
  }
  /** @internal */
  get _activePartyIds() {
    if (this.#destroyed) throw new Error("Round2State has been destroyed");
    return this.#activePartyIds;
  }
  /** Zero out message digest. */
  destroy() {
    if (!this.#destroyed) {
      this.#mu.fill(0);
      this.#destroyed = true;
    }
  }
}
class ThresholdMLDSA {
  static #DKG_RHO_COMMIT = /* @__PURE__ */ new TextEncoder().encode("DKG-RHO-COMMIT");
  static #DKG_BSEED_COMMIT = /* @__PURE__ */ new TextEncoder().encode(
    "DKG-BSEED-COMMIT"
  );
  static #DKG_RHO_AGG = /* @__PURE__ */ new TextEncoder().encode("DKG-RHO-AGG");
  static #DKG_GEN_ASSIGN = /* @__PURE__ */ new TextEncoder().encode("DKG-GEN-ASSIGN");
  static #DKG_BSEED = /* @__PURE__ */ new TextEncoder().encode("DKG-BSEED");
  /** ML-DSA-44 threshold parameters: [K_iter, r, rPrime] indexed by [T-2][N-2]. */
  // prettier-ignore
  static #PARAMS_44 = {
    "2": [[2, 252778, 252833]],
    "3": [[3, 310060, 310138], [4, 246490, 246546]],
    "4": [[3, 305919, 305997], [7, 279235, 279314], [8, 243463, 243519]],
    "5": [[3, 285363, 285459], [14, 282800, 282912], [30, 259427, 259526], [16, 239924, 239981]],
    "6": [[4, 300265, 300362], [19, 277014, 277139], [74, 268705, 268831], [100, 250590, 250686], [37, 219245, 219301]]
  };
  /** ML-DSA-65 threshold parameters. Derived from same formulas, scaled for K=6,L=5. */
  // prettier-ignore
  static #PARAMS_65 = {
    "2": [[2, 344e3, 344080]],
    "3": [[3, 421700, 421810], [4, 335200, 335290]],
    "4": [[3, 416e3, 416110], [7, 379600, 379710], [8, 331e3, 331090]],
    "5": [[3, 388e3, 388130], [14, 384600, 384750], [30, 352800, 352940], [16, 326200, 326280]],
    "6": [[4, 408300, 408430], [19, 376700, 376870], [74, 365400, 365570], [100, 340700, 340830], [37, 298e3, 298080]]
  };
  /** ML-DSA-87 threshold parameters. Derived from same formulas, scaled for K=8,L=7. */
  // prettier-ignore
  static #PARAMS_87 = {
    "2": [[2, 442e3, 442100]],
    "3": [[3, 541600, 541740], [4, 430600, 430710]],
    "4": [[3, 534200, 534340], [7, 487500, 487640], [8, 425100, 425210]],
    "5": [[3, 498200, 498370], [14, 494200, 494400], [30, 453300, 453470], [16, 419100, 419210]],
    "6": [[4, 524300, 524470], [19, 483600, 483820], [74, 469200, 469420], [100, 437400, 437570], [37, 382800, 382910]]
  };
  static #ALL_PARAMS = {
    44: ThresholdMLDSA.#PARAMS_44,
    65: ThresholdMLDSA.#PARAMS_65,
    87: ThresholdMLDSA.#PARAMS_87
  };
  /** Size in bytes of one 23-bit-packed polynomial. */
  static #POLY_Q_SIZE = N * 23 / 8;
  // 736
  static MAX_PARTIES = 6;
  #primitives;
  params;
  constructor(primitives, params) {
    this.#primitives = primitives;
    this.params = params;
  }
  /**
   * Create a ThresholdMLDSA instance for the given security level and threshold parameters.
   * @param securityLevel - 44, 65, or 87 (or 128, 192, 256)
   * @param T - Minimum number of parties needed to sign
   * @param N_ - Total number of parties
   */
  static create(securityLevel, T, N_) {
    const params = ThresholdMLDSA.getParams(T, N_, securityLevel);
    const opts = ThresholdMLDSA.#getDSAOpts(securityLevel);
    const primitives = new MLDSAPrimitives(opts);
    return new ThresholdMLDSA(primitives, params);
  }
  /** Get threshold parameters for given (T, N, securityLevel). */
  static getParams(T, N_, securityLevel) {
    const level = ThresholdMLDSA.#normalizeSecurityLevel(securityLevel);
    const table = ThresholdMLDSA.#ALL_PARAMS[level];
    if (!table) throw new Error(`Unsupported security level: ${securityLevel}`);
    if (T < 2) throw new Error("Threshold T must be >= 2");
    if (T > N_) throw new Error("Threshold T must be <= N");
    if (N_ > ThresholdMLDSA.MAX_PARTIES)
      throw new Error(`N must be <= ${ThresholdMLDSA.MAX_PARTIES}`);
    if (N_ < 2) throw new Error("N must be >= 2");
    const entries = table[String(N_)];
    if (!entries) throw new Error(`No parameters for N=${N_}`);
    const idx = T - 2;
    if (idx < 0 || idx >= entries.length) throw new Error(`No parameters for T=${T}, N=${N_}`);
    const [K_iter, r, rPrime] = entries[idx];
    return { T, N: N_, K_iter, nu: 3, r, rPrime };
  }
  static #getDSAOpts(securityLevel) {
    let paramKey;
    let cTildeBytes;
    if (securityLevel === 44 || securityLevel === 128) {
      paramKey = "2";
      cTildeBytes = 32;
    } else if (securityLevel === 65 || securityLevel === 192) {
      paramKey = "3";
      cTildeBytes = 48;
    } else if (securityLevel === 87 || securityLevel === 256) {
      paramKey = "5";
      cTildeBytes = 64;
    } else {
      throw new Error(`Unsupported security level: ${securityLevel}`);
    }
    const p = PARAMS[paramKey];
    return {
      ...p,
      CRH_BYTES: 64,
      TR_BYTES: 64,
      C_TILDE_BYTES: cTildeBytes,
      XOF128,
      XOF256
    };
  }
  static #normalizeSecurityLevel(level) {
    if (level === 128) return 44;
    if (level === 192) return 65;
    if (level === 256) return 87;
    return level;
  }
  static #encodeU8(v) {
    return new Uint8Array([v & 255]);
  }
  static #encodeU16LE(v) {
    return new Uint8Array([v & 255, v >> 8 & 255]);
  }
  /** Fill polynomial with uniform random values in [0, Q). */
  static #fillUniformModQ(poly) {
    let filled = 0;
    while (filled < N) {
      const needed = N - filled;
      const bytes = randomBytes(needed * 3);
      for (let i = 0; i + 2 < bytes.length && filled < N; i += 3) {
        const val = (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16) & 8388607;
        if (val < Q) poly[filled++] = val;
      }
    }
  }
  /**
   * Additively split a vector of K polynomials into N shares
   * such that sum of all shares equals the input (mod Q).
   * N-1 shares are uniform random; the residual goes to `residualIdx`.
   */
  static #splitVectorK(wb, nParties, residualIdx) {
    const K = wb.length;
    const result = new Array(nParties);
    for (let j = 0; j < nParties; j++) {
      if (j === residualIdx) continue;
      const mask = [];
      for (let k = 0; k < K; k++) {
        const poly = new Int32Array(N);
        ThresholdMLDSA.#fillUniformModQ(poly);
        mask.push(poly);
      }
      result[j] = mask;
    }
    const residual = [];
    for (let k = 0; k < K; k++) {
      const poly = new Int32Array(N);
      for (let c = 0; c < N; c++) {
        let val = wb[k][c];
        for (let j = 0; j < nParties; j++) {
          if (j === residualIdx) continue;
          val -= result[j][k][c];
        }
        poly[c] = (val % Q + Q) % Q;
      }
      residual.push(poly);
    }
    result[residualIdx] = residual;
    return result;
  }
  static #getSharingPattern(T, N_) {
    if (T === 2 && N_ === 3) return [[3, 5], [6]];
    if (T === 2 && N_ === 4)
      return [
        [11, 13],
        [7, 14]
      ];
    if (T === 3 && N_ === 4)
      return [
        [3, 9],
        [6, 10],
        [12, 5]
      ];
    if (T === 2 && N_ === 5)
      return [
        [27, 29, 23],
        [30, 15]
      ];
    if (T === 3 && N_ === 5)
      return [
        [25, 11, 19, 13],
        [7, 14, 22, 26],
        [28, 21]
      ];
    if (T === 4 && N_ === 5) return [[3, 9, 17], [6, 10, 18], [12, 5, 20], [24]];
    if (T === 2 && N_ === 6)
      return [
        [61, 47, 55],
        [62, 31, 59]
      ];
    if (T === 3 && N_ === 6) return [[27, 23, 43, 57, 39], [51, 58, 46, 30, 54], [45, 53, 29, 15, 60]];
    if (T === 4 && N_ === 6) return [[19, 13, 35, 7, 49], [42, 26, 38, 50, 22], [52, 21, 44, 28, 37], [25, 11, 14, 56, 41]];
    if (T === 5 && N_ === 6) return [[3, 5, 33], [6, 10, 34], [12, 20, 36], [9, 24, 40], [48, 17, 18]];
    return null;
  }
  /** 23-bit per coefficient polynomial packing (for full Zq elements). */
  static #polyPackW(p, buf, offset) {
    let v = 0;
    let j = 0;
    let k = 0;
    for (let i = 0; i < N; i++) {
      v = v | (p[i] & 8388607) << j;
      j += 23;
      while (j >= 8) {
        buf[offset + k] = v & 255;
        v >>>= 8;
        j -= 8;
        k++;
      }
    }
  }
  static #polyUnpackW(p, buf, offset) {
    let v = 0;
    let j = 0;
    let k = 0;
    for (let i = 0; i < N; i++) {
      while (j < 23) {
        v = v + ((buf[offset + k] & 255) << j);
        j += 8;
        k++;
      }
      const coeff = v & (1 << 23) - 1;
      if (coeff >= Q) throw new Error(`Invalid polynomial coefficient: ${coeff} >= Q`);
      p[i] = coeff;
      v >>>= 23;
      j -= 23;
    }
  }
  /** Pack K_iter arrays of dim polynomials into bytes (23-bit per coefficient). */
  static #packPolys(polys, dim, K_iter) {
    const buf = new Uint8Array(K_iter * dim * ThresholdMLDSA.#POLY_Q_SIZE);
    for (let iter = 0; iter < K_iter; iter++) {
      for (let j = 0; j < dim; j++) {
        ThresholdMLDSA.#polyPackW(
          polys[iter][j],
          buf,
          (iter * dim + j) * ThresholdMLDSA.#POLY_Q_SIZE
        );
      }
    }
    return buf;
  }
  /** Unpack bytes into K_iter arrays of dim polynomials. */
  static #unpackPolys(buf, dim, K_iter) {
    const expected = K_iter * dim * ThresholdMLDSA.#POLY_Q_SIZE;
    if (buf.length !== expected) {
      throw new Error(`Invalid buffer length: expected ${expected}, got ${buf.length}`);
    }
    const result = [];
    for (let iter = 0; iter < K_iter; iter++) {
      const polys = [];
      for (let j = 0; j < dim; j++) {
        const p = new Int32Array(N);
        ThresholdMLDSA.#polyUnpackW(p, buf, (iter * dim + j) * ThresholdMLDSA.#POLY_Q_SIZE);
        polys.push(p);
      }
      result.push(polys);
    }
    return result;
  }
  /** Sample from hyperball using Box-Muller transform over SHAKE256. */
  static #sampleHyperball(rPrime, nu, K, L, rhop, nonce) {
    const dim = N * (K + L);
    const numSamples = dim + 2;
    const samples = new Float64Array(numSamples);
    const h = shake256.create({});
    h.update(new Uint8Array([72]));
    h.update(rhop);
    const iv = new Uint8Array(2);
    iv[0] = nonce & 255;
    iv[1] = nonce >> 8 & 255;
    h.update(iv);
    const byteBuf = new Uint8Array(numSamples * 8);
    h.xofInto(byteBuf);
    let sq = 0;
    const dv = new DataView(byteBuf.buffer, byteBuf.byteOffset, byteBuf.byteLength);
    for (let i = 0; i < numSamples; i += 2) {
      const u1 = dv.getBigUint64(i * 8, true);
      const u2 = dv.getBigUint64((i + 1) * 8, true);
      const TWO_NEG_53 = 11102230246251565e-32;
      const f1Raw = Number(u1 >> 11n) * TWO_NEG_53;
      const f2 = Number(u2 >> 11n) * TWO_NEG_53;
      const f1 = f1Raw === 0 ? Number.MIN_VALUE : f1Raw;
      const r = Math.sqrt(-2 * Math.log(f1));
      const theta = 2 * Math.PI * f2;
      const z1 = r * Math.cos(theta);
      const z2 = r * Math.sin(theta);
      samples[i] = z1;
      sq += z1 * z1;
      samples[i + 1] = z2;
      sq += z2 * z2;
      if (i < N * L) {
        samples[i] *= nu;
        if (i + 1 < N * L) samples[i + 1] *= nu;
      }
    }
    const result = new Float64Array(dim);
    const factor = rPrime / Math.sqrt(sq);
    for (let i = 0; i < dim; i++) {
      result[i] = samples[i] * factor;
    }
    return result;
  }
  /** Add two FVecs. */
  static #fvecAdd(a, b) {
    const r = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) r[i] = a[i] + b[i];
    return r;
  }
  /** Check if weighted L2 norm exceeds bound r. */
  static #fvecExcess(v, r, nu, K, L) {
    let sq = 0;
    for (let i = 0; i < L + K; i++) {
      for (let j = 0; j < N; j++) {
        const val = v[i * N + j];
        if (i < L) {
          sq += val * val / (nu * nu);
        } else {
          sq += val * val;
        }
      }
    }
    return sq > r * r;
  }
  /** Convert integer vectors (s1,s2) to FVec with centered mod Q. */
  static #fvecFrom(s1, s2, K, L) {
    const result = new Float64Array(N * (K + L));
    for (let i = 0; i < L + K; i++) {
      for (let j = 0; j < N; j++) {
        let u;
        if (i < L) {
          u = s1[i][j] | 0;
        } else {
          u = s2[i - L][j] | 0;
        }
        u = (u + (Q - 1) / 2 | 0) % Q;
        if (u < 0) u += Q;
        u = u - (Q - 1) / 2;
        result[i * N + j] = u;
      }
    }
    return result;
  }
  /** Round FVec back to integer vectors. */
  static #fvecRound(v, K, L) {
    const z = [];
    const e = [];
    for (let i = 0; i < L; i++) z.push(new Int32Array(N));
    for (let i = 0; i < K; i++) e.push(new Int32Array(N));
    for (let i = 0; i < L + K; i++) {
      for (let j = 0; j < N; j++) {
        let u = Math.round(v[i * N + j]) | 0;
        if (u < 0) u += Q;
        if (i < L) {
          z[i][j] = u;
        } else {
          e[i - L][j] = u;
        }
      }
    }
    return { z, e };
  }
  /**
   * Generate threshold keys from a seed (trusted dealer model).
   *
   * A single trusted dealer generates all N key shares and the public key.
   * After distributing shares to parties over secure channels, the dealer
   * MUST securely erase the seed and all share data.
   *
   * @param seed - 32-byte seed. Default: random.
   */
  keygen(seed) {
    const p = this.#primitives;
    const { K, L, TR_BYTES } = p;
    const params = this.params;
    if (seed === void 0) seed = randomBytes(32);
    abytes(seed, 32, "seed");
    const h = shake256.create({});
    h.update(seed);
    h.update(new Uint8Array([K, L]));
    const rho = new Uint8Array(32);
    h.xofInto(rho);
    const xof = p.XOF128(rho);
    const A = [];
    for (let i = 0; i < K; i++) {
      const row = [];
      for (let j = 0; j < L; j++) row.push(p.RejNTTPoly(xof.get(j, i)));
      A.push(row);
    }
    xof.clean();
    const sks = [];
    for (let i = 0; i < params.N; i++) {
      const key = new Uint8Array(32);
      h.xofInto(key);
      sks.push({
        id: i,
        rho: rho.slice(),
        key,
        shares: /* @__PURE__ */ new Map()
      });
    }
    const totalS1 = [];
    const totalS2 = [];
    const totalS1Hat = [];
    const totalS2Hat = [];
    for (let i = 0; i < L; i++) {
      totalS1.push(new Int32Array(N));
      totalS1Hat.push(new Int32Array(N));
    }
    for (let i = 0; i < K; i++) {
      totalS2.push(new Int32Array(N));
      totalS2Hat.push(new Int32Array(N));
    }
    let honestSigners = (1 << params.N - params.T + 1) - 1;
    while (honestSigners < 1 << params.N) {
      const sSeed = new Uint8Array(64);
      h.xofInto(sSeed);
      const shareS1 = [];
      const shareS2 = [];
      for (let j = 0; j < L; j++) {
        shareS1.push(this.#deriveUniformLeqEta(sSeed, j));
      }
      for (let j = 0; j < K; j++) {
        shareS2.push(this.#deriveUniformLeqEta(sSeed, j + L));
      }
      const shareS1Hat = shareS1.map((s) => p.NTT.encode(s.slice()));
      const shareS2Hat = shareS2.map((s) => p.NTT.encode(s.slice()));
      const share = {
        s1: shareS1,
        s2: shareS2,
        s1Hat: shareS1Hat,
        s2Hat: shareS2Hat
      };
      for (let i = 0; i < params.N; i++) {
        if ((honestSigners & 1 << i) !== 0) {
          sks[i].shares.set(honestSigners, share);
        }
      }
      for (let j = 0; j < L; j++) {
        p.polyAdd(totalS1[j], shareS1[j]);
        p.polyAdd(totalS1Hat[j], shareS1Hat[j]);
      }
      for (let j = 0; j < K; j++) {
        p.polyAdd(totalS2[j], shareS2[j]);
        p.polyAdd(totalS2Hat[j], shareS2Hat[j]);
      }
      const c = honestSigners & -honestSigners;
      const r = honestSigners + c;
      honestSigners = ((r ^ honestSigners) >> 2) / c | r;
    }
    for (let j = 0; j < L; j++) {
      for (let i = 0; i < N; i++) totalS1[j][i] = p.mod(totalS1[j][i]);
      for (let i = 0; i < N; i++) totalS1Hat[j][i] = p.mod(totalS1Hat[j][i]);
    }
    for (let j = 0; j < K; j++) {
      for (let i = 0; i < N; i++) totalS2[j][i] = p.mod(totalS2[j][i]);
      for (let i = 0; i < N; i++) totalS2Hat[j][i] = p.mod(totalS2Hat[j][i]);
    }
    const t1 = [];
    for (let i = 0; i < K; i++) {
      const t = p.newPoly(N);
      for (let j = 0; j < L; j++) {
        p.polyAdd(t, p.MultiplyNTTs(A[i][j], totalS1Hat[j]));
      }
      p.NTT.decode(t);
      p.polyAdd(t, totalS2[i]);
      for (let c = 0; c < N; c++) t[c] = p.mod(t[c]);
      const { r1 } = p.polyPowerRound(t);
      t1.push(r1);
    }
    const publicKey = p.publicCoder.encode([rho, t1]);
    const tr = shake256(publicKey, { dkLen: TR_BYTES });
    const shares = sks.map((sk) => ({
      id: sk.id,
      rho: sk.rho,
      key: sk.key,
      tr: tr.slice(),
      shares: sk.shares
    }));
    return { publicKey, shares };
  }
  /**
   * Full threshold signing protocol (local convenience method).
   *
   * Runs all 3 rounds of the distributed protocol locally. Useful for
   * testing and single-machine deployments. For network-distributed signing,
   * use the round1() -> round2() -> round3() -> combine() methods instead.
   *
   * @param msg - Message to sign
   * @param publicKey - The threshold public key
   * @param shares - At least T threshold key shares
   * @param opts - Optional context
   */
  sign(msg, publicKey, shares, opts) {
    const p = this.#primitives;
    const params = this.params;
    const ctx = opts?.context ?? new Uint8Array(0);
    if (shares.length < params.T) {
      throw new Error(`Need at least ${params.T} shares, got ${shares.length}`);
    }
    abytes(publicKey, p.publicCoder.bytesLen, "publicKey");
    abytes(msg);
    const activeShares = shares.slice(0, params.T);
    let act = 0;
    for (const share of activeShares) {
      const bit = 1 << share.id;
      if (act & bit) throw new Error(`Duplicate share ID: ${share.id}`);
      act |= bit;
    }
    const M = getMessage(msg, ctx);
    const mu = shake256.create({ dkLen: p.CRH_BYTES }).update(activeShares[0].tr).update(M).digest();
    for (let attempt = 0; attempt < 500; attempt++) {
      const rhops = activeShares.map(() => randomBytes(64));
      const allWs = [];
      const allStws = [];
      for (let pi = 0; pi < activeShares.length; pi++) {
        const { ws, stws } = this.#genCommitment(
          activeShares[pi],
          rhops[pi],
          attempt,
          params
        );
        allWs.push(ws);
        allStws.push(stws);
      }
      const wfinals = this.#aggregateCommitments(allWs, params);
      const allZs = [];
      for (let pi = 0; pi < activeShares.length; pi++) {
        const zs = this.#computeResponses(
          activeShares[pi],
          act,
          mu,
          wfinals,
          allStws[pi],
          params
        );
        allZs.push(zs);
      }
      const zfinals = this.#aggregateResponses(allZs, params);
      const sig = this.#combine(publicKey, mu, wfinals, zfinals, params);
      if (sig !== null) {
        for (const stws of allStws) for (const stw of stws) stw.fill(0);
        for (const zs of allZs) for (const z of zs) cleanBytes(z);
        mu.fill(0);
        return sig;
      }
    }
    mu.fill(0);
    throw new Error("Failed to produce valid threshold signature after 500 attempts");
  }
  /**
   * Round 1: Generate commitment for distributed threshold signing.
   *
   * Each party calls this independently with fresh randomness.
   * The returned commitmentHash (32 bytes) should be broadcast to all parties.
   *
   * @param share - This party's key share
   * @param opts - Optional: nonce (default 0), rhop (default random 64 bytes)
   */
  round1(share, opts) {
    const p = this.#primitives;
    const params = this.params;
    const nonce = opts?.nonce ?? 0;
    let rhop = opts?.rhop;
    if (!rhop) rhop = randomBytes(64);
    abytes(rhop, 64, "rhop");
    const { ws, stws } = this.#genCommitment(share, rhop, nonce, params);
    const commitment = ThresholdMLDSA.#packPolys(ws, p.K, params.K_iter);
    const commitmentHash = this.#hashCommitment(share.tr, share.id, commitment);
    return {
      commitmentHash,
      state: new Round1State(stws, commitment)
    };
  }
  /**
   * Round 2: Receive all commitment hashes, reveal own commitment.
   *
   * After receiving commitment hashes from all active parties, each party
   * stores the hashes (for verification in round 3), computes the message
   * digest mu, and reveals their own packed commitment data.
   *
   * @param share - This party's key share
   * @param activePartyIds - IDs of all participating parties (including this one)
   * @param msg - Message to sign
   * @param round1Hashes - Commitment hashes from all active parties
   * @param round1State - This party's state from round1()
   * @param opts - Optional context
   */
  round2(share, activePartyIds, msg, round1Hashes, round1State, opts) {
    const p = this.#primitives;
    const params = this.params;
    const ctx = opts?.context ?? new Uint8Array(0);
    if (activePartyIds.length < params.T) {
      throw new Error(`Need at least ${params.T} parties, got ${activePartyIds.length}`);
    }
    if (round1Hashes.length !== activePartyIds.length) {
      throw new Error(`Expected ${activePartyIds.length} hashes, got ${round1Hashes.length}`);
    }
    let act = 0;
    for (const id of activePartyIds) {
      const bit = 1 << id;
      if (act & bit) throw new Error(`Duplicate party ID: ${id}`);
      act |= bit;
    }
    const hashes = round1Hashes.map((h) => h.slice());
    const M = getMessage(msg, ctx);
    const mu = shake256.create({ dkLen: p.CRH_BYTES }).update(share.tr).update(M).digest();
    return {
      commitment: round1State._commitment.slice(),
      state: new Round2State(hashes, mu, act, [...activePartyIds])
    };
  }
  /**
   * Round 3: Receive all commitments, verify against hashes, compute partial response.
   *
   * After receiving all parties' commitment reveals, each party:
   * 1. Verifies each commitment matches the hash broadcast in round 1
   * 2. Aggregates all commitments
   * 3. Computes their partial response (z vectors)
   *
   * @param share - This party's key share
   * @param commitments - Packed commitments from all active parties
   * @param round1State - This party's state from round1()
   * @param round2State - This party's state from round2()
   * @returns Packed partial response to broadcast
   */
  round3(share, commitments, round1State, round2State) {
    const p = this.#primitives;
    const params = this.params;
    const { K, L } = p;
    const activePartyIds = round2State._activePartyIds;
    const hashes = round2State._hashes;
    const mu = round2State._mu;
    const act = round2State._act;
    if (commitments.length !== activePartyIds.length) {
      throw new Error(
        `Expected ${activePartyIds.length} commitments, got ${commitments.length}`
      );
    }
    for (let i = 0; i < commitments.length; i++) {
      const expected = this.#hashCommitment(share.tr, activePartyIds[i], commitments[i]);
      let diff = 0;
      for (let j = 0; j < expected.length; j++) diff |= expected[j] ^ hashes[i][j];
      if (diff !== 0) {
        throw new Error(`Commitment hash mismatch for party ${activePartyIds[i]}`);
      }
    }
    const allWs = commitments.map((c) => ThresholdMLDSA.#unpackPolys(c, K, params.K_iter));
    const wfinals = this.#aggregateCommitments(allWs, params);
    const stws = round1State._stws;
    const zs = this.#computeResponses(share, act, mu, wfinals, stws, params);
    return ThresholdMLDSA.#packPolys(zs, L, params.K_iter);
  }
  /**
   * Combine: Aggregate all parties' data and produce a standard FIPS 204 signature.
   *
   * Anyone with the public key can perform this step — it does not require
   * secret key material.
   *
   * @param publicKey - The threshold public key
   * @param msg - Message that was signed
   * @param commitments - Packed commitments from all active parties
   * @param responses - Packed responses from all active parties
   * @param opts - Optional context (must match what was used in round2)
   * @returns Standard FIPS 204 signature, or null if this attempt failed
   */
  combine(publicKey, msg, commitments, responses, opts) {
    const p = this.#primitives;
    const { K, L } = p;
    const params = this.params;
    const ctx = opts?.context ?? new Uint8Array(0);
    abytes(publicKey, p.publicCoder.bytesLen, "publicKey");
    const M = getMessage(msg, ctx);
    const tr = shake256(publicKey, { dkLen: p.TR_BYTES });
    const mu = shake256.create({ dkLen: p.CRH_BYTES }).update(tr).update(M).digest();
    const allWs = commitments.map((c) => ThresholdMLDSA.#unpackPolys(c, K, params.K_iter));
    const wfinals = this.#aggregateCommitments(allWs, params);
    const allZs = responses.map((r) => ThresholdMLDSA.#unpackPolys(r, L, params.K_iter));
    const zfinals = this.#aggregateResponses(allZs, params);
    const result = this.#combine(publicKey, mu, wfinals, zfinals, params);
    mu.fill(0);
    return result;
  }
  /**
   * Phase 0: Deterministic DKG setup.
   * Enumerates all bitmasks and their holders for the given (T, N).
   */
  dkgSetup(sessionId) {
    abytes(sessionId, 32, "sessionId");
    const params = this.params;
    const bitmasks = [];
    const holdersOf = /* @__PURE__ */ new Map();
    const bitsSet = params.N - params.T + 1;
    let mask = (1 << bitsSet) - 1;
    while (mask < 1 << params.N) {
      bitmasks.push(mask);
      const holders = [];
      for (let i = 0; i < params.N; i++) {
        if (mask & 1 << i) holders.push(i);
      }
      holdersOf.set(mask, holders);
      const c = mask & -mask;
      const r = mask + c;
      mask = ((r ^ mask) >> 2) / c | r;
    }
    return { bitmasks, holdersOf };
  }
  /**
   * Phase 1: Generate commitments for all entropy.
   *
   * Each party samples rho_i and per-bitmask r_{i,b}, commits via SHAKE256,
   * and broadcasts the commitments. State is kept private.
   *
   * @param partyId - This party's index (0-based)
   * @param sessionId - 32-byte unique session identifier
   * @param opts - Optional: provide deterministic entropy for testing
   */
  dkgPhase1(partyId, sessionId, opts) {
    abytes(sessionId, 32, "sessionId");
    if (partyId < 0 || partyId >= this.params.N) throw new Error(`Invalid partyId: ${partyId}`);
    const { bitmasks } = this.dkgSetup(sessionId);
    const rho = opts?.rho?.slice() ?? randomBytes(32);
    const rhoCommitment = shake256.create({ dkLen: 32 }).update(ThresholdMLDSA.#DKG_RHO_COMMIT).update(sessionId).update(ThresholdMLDSA.#encodeU8(partyId)).update(rho).digest();
    const bitmaskEntropy = /* @__PURE__ */ new Map();
    const bitmaskCommitments = /* @__PURE__ */ new Map();
    for (const b of bitmasks) {
      if (!(b & 1 << partyId)) continue;
      const r_ib = opts?.bitmaskEntropy?.get(b)?.slice() ?? randomBytes(32);
      bitmaskEntropy.set(b, r_ib);
      const commitment = shake256.create({ dkLen: 32 }).update(ThresholdMLDSA.#DKG_BSEED_COMMIT).update(sessionId).update(ThresholdMLDSA.#encodeU16LE(b)).update(ThresholdMLDSA.#encodeU8(partyId)).update(r_ib).digest();
      bitmaskCommitments.set(b, commitment);
    }
    return {
      broadcast: { partyId, rhoCommitment, bitmaskCommitments },
      state: { rho, bitmaskEntropy }
    };
  }
  /**
   * Phase 2: Reveal entropy and prepare private messages for fellow holders.
   *
   * After collecting all Phase 1 broadcasts, each party reveals their rho_i
   * (broadcast) and sends r_{i,b} values to fellow holders (private).
   */
  dkgPhase2(partyId, sessionId, state, allPhase1) {
    abytes(sessionId, 32, "sessionId");
    const params = this.params;
    if (allPhase1.length !== params.N) {
      throw new Error(`Expected ${params.N} Phase 1 broadcasts, got ${allPhase1.length}`);
    }
    const { bitmasks, holdersOf } = this.dkgSetup(sessionId);
    const broadcast = { partyId, rho: state.rho };
    const privateToHolders = /* @__PURE__ */ new Map();
    for (const b of bitmasks) {
      if (!(b & 1 << partyId)) continue;
      const holders = holdersOf.get(b);
      const r_ib = state.bitmaskEntropy.get(b);
      for (const j of holders) {
        if (j === partyId) continue;
        let msg = privateToHolders.get(j);
        if (!msg) {
          msg = {
            fromPartyId: partyId,
            bitmaskReveals: /* @__PURE__ */ new Map()
          };
          privateToHolders.set(j, msg);
        }
        msg.bitmaskReveals.set(b, r_ib);
      }
    }
    return { broadcast, privateToHolders };
  }
  /**
   * Phase 2 Finalize + Phase 3: Verify reveals, derive seeds/shares, generate masks.
   *
   * After receiving all Phase 2 broadcasts and private reveals:
   * 1. Verifies all rho commitments
   * 2. Verifies all bitmask seed commitments
   * 3. Derives joint rho, A, and generator assignments
   * 4. Derives bitmask seeds and shares
   * 5. For bitmasks where this party is generator: computes w^b, splits into masks
   */
  dkgPhase2Finalize(partyId, sessionId, state, allPhase1, allPhase2Broadcasts, receivedReveals) {
    const p = this.#primitives;
    const { K, L } = p;
    const params = this.params;
    abytes(sessionId, 32, "sessionId");
    const { bitmasks, holdersOf } = this.dkgSetup(sessionId);
    for (const ph2 of allPhase2Broadcasts) {
      const ph1 = allPhase1.find((x) => x.partyId === ph2.partyId);
      if (!ph1) throw new Error(`Missing Phase 1 broadcast for party ${ph2.partyId}`);
      const expected = shake256.create({ dkLen: 32 }).update(ThresholdMLDSA.#DKG_RHO_COMMIT).update(sessionId).update(ThresholdMLDSA.#encodeU8(ph2.partyId)).update(ph2.rho).digest();
      if (!equalBytes(expected, ph1.rhoCommitment)) {
        throw new Error(`Rho commitment mismatch for party ${ph2.partyId}`);
      }
    }
    const revealsByParty = /* @__PURE__ */ new Map();
    for (const reveal of receivedReveals) {
      revealsByParty.set(reveal.fromPartyId, reveal.bitmaskReveals);
    }
    for (const [fromId, reveals] of revealsByParty) {
      const ph1 = allPhase1.find((x) => x.partyId === fromId);
      if (!ph1) throw new Error(`Missing Phase 1 broadcast for party ${fromId}`);
      for (const [b, r_ib] of reveals) {
        const expected = shake256.create({ dkLen: 32 }).update(ThresholdMLDSA.#DKG_BSEED_COMMIT).update(sessionId).update(ThresholdMLDSA.#encodeU16LE(b)).update(ThresholdMLDSA.#encodeU8(fromId)).update(r_ib).digest();
        const committed = ph1.bitmaskCommitments.get(b);
        if (!committed || !equalBytes(expected, committed)) {
          throw new Error(
            `Bitmask seed commitment mismatch for party ${fromId}, bitmask ${b}`
          );
        }
      }
    }
    const sortedBroadcasts = [...allPhase2Broadcasts].sort((a, b) => a.partyId - b.partyId);
    const rhoHasher = shake256.create({ dkLen: 32 }).update(ThresholdMLDSA.#DKG_RHO_AGG).update(sessionId);
    for (const ph2 of sortedBroadcasts) rhoHasher.update(ph2.rho);
    const rho = rhoHasher.digest();
    const xof = p.XOF128(rho);
    const A = [];
    for (let i = 0; i < K; i++) {
      const row = [];
      for (let j = 0; j < L; j++) row.push(p.RejNTTPoly(xof.get(j, i)));
      A.push(row);
    }
    xof.clean();
    const generatorAssignment = /* @__PURE__ */ new Map();
    for (const b of bitmasks) {
      const holders = holdersOf.get(b);
      const gRaw = shake256.create({ dkLen: 1 }).update(ThresholdMLDSA.#DKG_GEN_ASSIGN).update(sessionId).update(rho).update(ThresholdMLDSA.#encodeU16LE(b)).digest();
      generatorAssignment.set(b, holders[gRaw[0] % holders.length]);
    }
    const shares = /* @__PURE__ */ new Map();
    for (const b of bitmasks) {
      if (!(b & 1 << partyId)) continue;
      const holders = holdersOf.get(b);
      const seedHasher = shake256.create({ dkLen: 64 }).update(ThresholdMLDSA.#DKG_BSEED).update(sessionId).update(ThresholdMLDSA.#encodeU16LE(b));
      for (const h of holders) {
        if (h === partyId) {
          seedHasher.update(state.bitmaskEntropy.get(b));
        } else {
          const rvls = revealsByParty.get(h);
          if (!rvls) throw new Error(`Missing reveals from party ${h}`);
          const r_hb = rvls.get(b);
          if (!r_hb) throw new Error(`Missing reveal for bitmask ${b} from party ${h}`);
          seedHasher.update(r_hb);
        }
      }
      const seedB = seedHasher.digest();
      const s1 = [];
      const s2 = [];
      for (let j = 0; j < L; j++) s1.push(this.#deriveUniformLeqEta(seedB, j));
      for (let j = 0; j < K; j++) s2.push(this.#deriveUniformLeqEta(seedB, j + L));
      const s1Hat = s1.map((s) => p.NTT.encode(s.slice()));
      const s2Hat = s2.map((s) => p.NTT.encode(s.slice()));
      shares.set(b, { s1, s2, s1Hat, s2Hat });
      cleanBytes(seedB);
    }
    const privateToAll = /* @__PURE__ */ new Map();
    const ownMaskPieces = /* @__PURE__ */ new Map();
    for (const b of bitmasks) {
      if (generatorAssignment.get(b) !== partyId) continue;
      const share = shares.get(b);
      if (!share)
        throw new Error(
          `Party ${partyId} is generator for bitmask ${b} but doesn't hold it`
        );
      const wb = [];
      for (let i = 0; i < K; i++) {
        const wi = p.newPoly(N);
        for (let j = 0; j < L; j++) {
          p.polyAdd(wi, p.MultiplyNTTs(A[i][j], share.s1Hat[j]));
        }
        p.NTT.decode(wi);
        p.polyAdd(wi, share.s2[i]);
        for (let c = 0; c < N; c++) wi[c] = (wi[c] % Q + Q) % Q;
        wb.push(wi);
      }
      const masks = ThresholdMLDSA.#splitVectorK(wb, params.N, partyId);
      for (let j = 0; j < params.N; j++) {
        if (j === partyId) {
          ownMaskPieces.set(b, masks[j]);
          continue;
        }
        let msg = privateToAll.get(j);
        if (!msg) {
          msg = {
            fromGeneratorId: partyId,
            maskPieces: /* @__PURE__ */ new Map()
          };
          privateToAll.set(j, msg);
        }
        msg.maskPieces.set(b, masks[j]);
      }
    }
    return { shares, generatorAssignment, rho, privateToAll, ownMaskPieces };
  }
  /**
   * Phase 4: Aggregate received mask pieces and broadcast R_j.
   *
   * R_j = sum over all bitmasks b of r_{b,j} (mod q)
   */
  dkgPhase4(partyId, bitmasks, generatorAssignment, receivedMasks, ownMaskPieces) {
    const p = this.#primitives;
    const { K } = p;
    const masksByGenerator = /* @__PURE__ */ new Map();
    for (const rm of receivedMasks) {
      const existing = masksByGenerator.get(rm.fromGeneratorId);
      if (existing) {
        const merged = new Map(existing);
        for (const [b, piece] of rm.maskPieces) merged.set(b, piece);
        masksByGenerator.set(rm.fromGeneratorId, merged);
      } else {
        masksByGenerator.set(rm.fromGeneratorId, rm.maskPieces);
      }
    }
    const aggregate = [];
    for (let k = 0; k < K; k++) aggregate.push(new Int32Array(N));
    for (const b of bitmasks) {
      const gen = generatorAssignment.get(b);
      let maskPiece;
      if (gen === partyId) {
        const own = ownMaskPieces.get(b);
        if (!own) throw new Error(`Missing own mask piece for bitmask ${b}`);
        maskPiece = own;
      } else {
        const genMasks = masksByGenerator.get(gen);
        if (!genMasks) throw new Error(`Missing mask pieces from generator ${gen}`);
        const piece = genMasks.get(b);
        if (!piece)
          throw new Error(`Missing mask piece for bitmask ${b} from generator ${gen}`);
        maskPiece = piece;
      }
      for (let k = 0; k < K; k++) p.polyAdd(aggregate[k], maskPiece[k]);
    }
    for (let k = 0; k < K; k++) {
      for (let c = 0; c < N; c++) aggregate[k][c] = p.mod(aggregate[k][c]);
    }
    return { partyId, aggregate };
  }
  /**
   * Finalize: Aggregate all parties' R_j to compute t, derive public key and ThresholdKeyShare.
   *
   * t = sum_j R_j (mod q), then Power2Round, encode public key.
   */
  dkgFinalize(partyId, rho, allPhase4, shares) {
    const p = this.#primitives;
    const { K, TR_BYTES } = p;
    const params = this.params;
    if (allPhase4.length !== params.N) {
      throw new Error(`Expected ${params.N} Phase 4 broadcasts, got ${allPhase4.length}`);
    }
    const t = [];
    for (let k = 0; k < K; k++) t.push(new Int32Array(N));
    for (const ph4 of allPhase4) {
      for (let k = 0; k < K; k++) p.polyAdd(t[k], ph4.aggregate[k]);
    }
    for (let k = 0; k < K; k++) {
      for (let c = 0; c < N; c++) t[k][c] = p.mod(t[k][c]);
    }
    const t1 = [];
    for (let k = 0; k < K; k++) {
      const { r1 } = p.polyPowerRound(t[k]);
      t1.push(r1);
    }
    const publicKey = p.publicCoder.encode([rho, t1]);
    const tr = shake256(publicKey, { dkLen: TR_BYTES });
    const share = {
      id: partyId,
      rho: rho.slice(),
      key: randomBytes(32),
      tr,
      shares
    };
    return { publicKey, share };
  }
  /** Get the byte size of a packed commitment from round1. */
  get commitmentByteLength() {
    return this.params.K_iter * this.#primitives.K * ThresholdMLDSA.#POLY_Q_SIZE;
  }
  /** Get the byte size of a packed response from round3. */
  get responseByteLength() {
    return this.params.K_iter * this.#primitives.L * ThresholdMLDSA.#POLY_Q_SIZE;
  }
  /** Derive a polynomial with coefficients in [-eta, eta] from seed and nonce. */
  #deriveUniformLeqEta(seed, nonce) {
    const p = this.#primitives;
    const iv = new Uint8Array(66);
    iv.set(seed.subarray(0, 64));
    iv[64] = nonce & 255;
    iv[65] = nonce >> 8 & 255;
    const h = shake256.create({}).update(iv);
    const buf = new Uint8Array(136);
    const poly = p.newPoly(N);
    let j = 0;
    while (j < N) {
      h.xofInto(buf);
      for (let i = 0; j < N && i < 136; i++) {
        const t1 = buf[i] & 15;
        const t2 = buf[i] >> 4;
        if (p.ETA === 2) {
          if (t1 <= 14) {
            poly[j++] = p.mod(Q + p.ETA - (t1 - Math.floor(205 * t1 >> 10) * 5));
          }
          if (j < N && t2 <= 14) {
            poly[j++] = p.mod(Q + p.ETA - (t2 - Math.floor(205 * t2 >> 10) * 5));
          }
        } else if (p.ETA === 4) {
          if (t1 <= 2 * p.ETA) {
            poly[j++] = p.mod(Q + p.ETA - t1);
          }
          if (j < N && t2 <= 2 * p.ETA) {
            poly[j++] = p.mod(Q + p.ETA - t2);
          }
        }
      }
    }
    return poly;
  }
  /** Recover the combined share for a given active set bitmask. */
  #recoverShare(share, act) {
    const p = this.#primitives;
    const params = this.params;
    const { K, L } = p;
    if (params.T === params.N) {
      for (const [, s] of share.shares) {
        return {
          s1Hat: s.s1Hat.map((x) => x.slice()),
          s2Hat: s.s2Hat.map((x) => x.slice())
        };
      }
      throw new Error("No shares available");
    }
    const sharing = ThresholdMLDSA.#getSharingPattern(params.T, params.N);
    if (!sharing) throw new Error(`No sharing pattern for T=${params.T}, N=${params.N}`);
    const perm = new Uint8Array(params.N);
    let i1 = 0;
    let i2 = params.T;
    let currenti = 0;
    for (let j = 0; j < params.N; j++) {
      if (j === share.id) currenti = i1;
      if ((act & 1 << j) !== 0) {
        perm[i1++] = j;
      } else {
        perm[i2++] = j;
      }
    }
    const s1Hat = [];
    const s2Hat = [];
    for (let i = 0; i < L; i++) s1Hat.push(new Int32Array(N));
    for (let i = 0; i < K; i++) s2Hat.push(new Int32Array(N));
    for (const u of sharing[currenti]) {
      let u_ = 0;
      for (let i = 0; i < params.N; i++) {
        if ((u & 1 << i) !== 0) {
          u_ |= 1 << perm[i];
        }
      }
      const s = share.shares.get(u_);
      if (!s) throw new Error(`Missing share for bitmask ${u_}`);
      for (let j = 0; j < L; j++) p.polyAdd(s1Hat[j], s.s1Hat[j]);
      for (let j = 0; j < K; j++) p.polyAdd(s2Hat[j], s.s2Hat[j]);
    }
    for (let j = 0; j < L; j++) for (let i = 0; i < N; i++) s1Hat[j][i] = p.mod(s1Hat[j][i]);
    for (let j = 0; j < K; j++) for (let i = 0; i < N; i++) s2Hat[j][i] = p.mod(s2Hat[j][i]);
    return { s1Hat, s2Hat };
  }
  /** Generate K_iter commitments for a party. */
  #genCommitment(share, rhop, nonce, params) {
    const p = this.#primitives;
    const { K, L } = p;
    const xof = p.XOF128(share.rho);
    const A = [];
    for (let i = 0; i < K; i++) {
      const row = [];
      for (let j = 0; j < L; j++) row.push(p.RejNTTPoly(xof.get(j, i)));
      A.push(row);
    }
    xof.clean();
    const ws = [];
    const stws = [];
    for (let iter = 0; iter < params.K_iter; iter++) {
      const stw = ThresholdMLDSA.#sampleHyperball(
        params.rPrime,
        params.nu,
        K,
        L,
        rhop,
        nonce * params.K_iter + iter
      );
      stws.push(stw);
      const { z: y, e } = ThresholdMLDSA.#fvecRound(stw, K, L);
      const yHat = y.map((s) => p.NTT.encode(s.slice()));
      const w = [];
      for (let i = 0; i < K; i++) {
        const wi = p.newPoly(N);
        for (let j = 0; j < L; j++) {
          p.polyAdd(wi, p.MultiplyNTTs(A[i][j], yHat[j]));
        }
        for (let c = 0; c < N; c++) wi[c] = p.mod(wi[c]);
        p.NTT.decode(wi);
        p.polyAdd(wi, e[i]);
        for (let c = 0; c < N; c++) wi[c] = p.mod(wi[c]);
        w.push(wi);
      }
      ws.push(w);
    }
    return { ws, stws };
  }
  /** Aggregate commitments from all parties. */
  #aggregateCommitments(allWs, params) {
    const p = this.#primitives;
    const { K } = p;
    const wfinals = [];
    for (let iter = 0; iter < params.K_iter; iter++) {
      const wf = [];
      for (let j = 0; j < K; j++) {
        const w = p.newPoly(N);
        for (let pi = 0; pi < allWs.length; pi++) {
          p.polyAdd(w, allWs[pi][iter][j]);
        }
        for (let c = 0; c < N; c++) w[c] = p.mod(w[c]);
        wf.push(w);
      }
      wfinals.push(wf);
    }
    return wfinals;
  }
  /** Compute commitment hash: SHAKE256(tr || partyId || commitment). */
  #hashCommitment(tr, partyId, commitment) {
    return shake256.create({ dkLen: 32 }).update(tr).update(new Uint8Array([partyId])).update(commitment).digest();
  }
  /** Compute responses for a party. */
  #computeResponses(share, act, mu, wfinals, stws, params) {
    const p = this.#primitives;
    const { K, L } = p;
    const { s1Hat, s2Hat } = this.#recoverShare(share, act);
    const zs = [];
    for (let iter = 0; iter < params.K_iter; iter++) {
      const w1 = [];
      for (let j = 0; j < K; j++) {
        w1.push(Int32Array.from(wfinals[iter][j].map((x) => p.HighBits(x))));
      }
      const cTilde = shake256.create({ dkLen: p.C_TILDE_BYTES }).update(mu).update(p.W1Vec.encode(w1)).digest();
      const cHat = p.NTT.encode(p.SampleInBall(cTilde));
      const cs1 = [];
      for (let j = 0; j < L; j++) {
        const t = p.MultiplyNTTs(cHat, s1Hat[j]);
        p.NTT.decode(t);
        for (let c = 0; c < N; c++) t[c] = p.mod(t[c]);
        cs1.push(t);
      }
      const cs2 = [];
      for (let j = 0; j < K; j++) {
        const t = p.MultiplyNTTs(cHat, s2Hat[j]);
        p.NTT.decode(t);
        for (let c = 0; c < N; c++) t[c] = p.mod(t[c]);
        cs2.push(t);
      }
      const csVec = ThresholdMLDSA.#fvecFrom(cs1, cs2, K, L);
      const zf = ThresholdMLDSA.#fvecAdd(csVec, stws[iter]);
      const excess = ThresholdMLDSA.#fvecExcess(zf, params.r, params.nu, K, L);
      const { z } = ThresholdMLDSA.#fvecRound(zf, K, L);
      if (excess) {
        const zeroZ = [];
        for (let j = 0; j < L; j++) zeroZ.push(new Int32Array(N));
        zs.push(zeroZ);
      } else {
        zs.push(z);
      }
      csVec.fill(0);
      zf.fill(0);
      cleanBytes(cs1, cs2);
    }
    cleanBytes(s1Hat, s2Hat);
    return zs;
  }
  /** Aggregate responses from all parties. */
  #aggregateResponses(allZs, params) {
    const p = this.#primitives;
    const { L } = p;
    const zfinals = [];
    for (let iter = 0; iter < params.K_iter; iter++) {
      const zf = [];
      for (let j = 0; j < L; j++) {
        const z = p.newPoly(N);
        for (let pi = 0; pi < allZs.length; pi++) {
          p.polyAdd(z, allZs[pi][iter][j]);
        }
        for (let c = 0; c < N; c++) z[c] = p.mod(z[c]);
        zf.push(z);
      }
      zfinals.push(zf);
    }
    return zfinals;
  }
  /** Combine aggregated commitments and responses into a standard FIPS 204 signature. */
  #combine(publicKey, mu, wfinals, zfinals, params) {
    const p = this.#primitives;
    const { K, L, GAMMA1, GAMMA2, BETA, OMEGA } = p;
    const [rho, t1] = p.publicCoder.decode(publicKey);
    const xof = p.XOF128(rho);
    const A = [];
    for (let i = 0; i < K; i++) {
      const row = [];
      for (let j = 0; j < L; j++) row.push(p.RejNTTPoly(xof.get(j, i)));
      A.push(row);
    }
    xof.clean();
    for (let iter = 0; iter < params.K_iter; iter++) {
      const z = zfinals[iter];
      let exceeds = false;
      for (let j = 0; j < L; j++) {
        if (p.polyChknorm(z[j], GAMMA1 - BETA)) {
          exceeds = true;
          break;
        }
      }
      if (exceeds) continue;
      const w0 = [];
      const w1 = [];
      for (let j = 0; j < K; j++) {
        const w0j = p.newPoly(N);
        const w1j = p.newPoly(N);
        for (let c = 0; c < N; c++) {
          const d = p.decompose(wfinals[iter][j][c]);
          w0j[c] = d.r0;
          w1j[c] = d.r1;
        }
        w0.push(w0j);
        w1.push(w1j);
      }
      const cTilde = shake256.create({ dkLen: p.C_TILDE_BYTES }).update(mu).update(p.W1Vec.encode(w1)).digest();
      const cHat = p.NTT.encode(p.SampleInBall(cTilde));
      const zNtt = z.map((s) => p.NTT.encode(s.slice()));
      const Az = [];
      for (let i = 0; i < K; i++) {
        const azi = p.newPoly(N);
        for (let j = 0; j < L; j++) {
          p.polyAdd(azi, p.MultiplyNTTs(A[i][j], zNtt[j]));
        }
        Az.push(azi);
      }
      const result = [];
      for (let i = 0; i < K; i++) {
        const ct12d = p.MultiplyNTTs(
          p.NTT.encode(p.polyShiftl(t1[i].slice())),
          cHat
        );
        result.push(p.NTT.decode(p.polySub(Az[i], ct12d)));
      }
      for (let i = 0; i < K; i++) {
        for (let c = 0; c < N; c++) result[i][c] = p.mod(result[i][c]);
      }
      const f = [];
      for (let j = 0; j < K; j++) {
        const fj = p.newPoly(N);
        for (let c = 0; c < N; c++) {
          fj[c] = p.mod(result[j][c] - wfinals[iter][j][c]);
        }
        f.push(fj);
      }
      let fExceeds = false;
      for (let j = 0; j < K; j++) {
        if (p.polyChknorm(f[j], GAMMA2)) {
          fExceeds = true;
          break;
        }
      }
      if (fExceeds) continue;
      const w0pf = [];
      for (let j = 0; j < K; j++) {
        const w0pfj = p.newPoly(N);
        for (let c = 0; c < N; c++) {
          w0pfj[c] = p.mod(w0[j][c] + f[j][c]);
        }
        w0pf.push(w0pfj);
      }
      let hintPop = 0;
      const h = [];
      for (let j = 0; j < K; j++) {
        const { v, cnt } = p.polyMakeHint(w0pf[j], w1[j]);
        h.push(v);
        hintPop += cnt;
      }
      if (hintPop > OMEGA) continue;
      return p.sigCoder.encode([cTilde, z, h]);
    }
    return null;
  }
}
export {
  Round1State,
  Round2State,
  ThresholdMLDSA
};
