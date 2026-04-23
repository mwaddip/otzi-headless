import { type XOF } from './_crystals.ts';
import { type BytesCoderLen, cleanBytes } from './utils.ts';
/** Number of coefficients per polynomial ring element. */
export declare const N = 256;
/**
 * The prime modulus for ML-DSA ring arithmetic.
 * 2^23 - 2^13 + 1 = 8380417 (23 bits). Multiplication stays within 46 bits,
 * safely inside JS number precision (53 bits).
 */
export declare const Q = 8380417;
/** Number of dropped bits in Power2Round. */
export declare const D = 13;
/** GAMMA2 variant 1: floor((Q-1)/88). */
export declare const GAMMA2_1: number;
/** GAMMA2 variant 2: floor((Q-1)/32). */
export declare const GAMMA2_2: number;
type Poly = Int32Array;
type XofGet = ReturnType<ReturnType<XOF>['get']>;
/** Constructor options for {@link MLDSAPrimitives}. */
export type PrimitivesOpts = {
    K: number;
    L: number;
    GAMMA1: number;
    GAMMA2: number;
    TAU: number;
    ETA: number;
    OMEGA: number;
    C_TILDE_BYTES: number;
    CRH_BYTES: number;
    TR_BYTES: number;
    XOF128: XOF;
    XOF256: XOF;
};
/**
 * ML-DSA ring arithmetic, encoding, and sampling primitives.
 *
 * Parameter-independent pure functions (polyAdd, polySub, etc.) are exposed
 * as public readonly properties so they can be destructured. Parameter-dependent
 * operations (decompose, HighBits, etc.) are proper class methods.
 */
export declare class MLDSAPrimitives {
    #private;
    readonly K: number;
    readonly L: number;
    readonly N: number;
    readonly Q: number;
    readonly D: number;
    readonly GAMMA1: number;
    readonly GAMMA2: number;
    readonly TAU: number;
    readonly ETA: number;
    readonly OMEGA: number;
    readonly BETA: number;
    readonly C_TILDE_BYTES: number;
    readonly CRH_BYTES: number;
    readonly TR_BYTES: number;
    readonly GAMMA2_1: number;
    readonly GAMMA2_2: number;
    readonly mod: (a: number, modulo?: number) => number;
    readonly smod: (a: number, modulo?: number) => number;
    readonly newPoly: (n: number) => Int32Array;
    readonly polyAdd: (a: Int32Array, b: Int32Array) => Int32Array;
    readonly polySub: (a: Int32Array, b: Int32Array) => Int32Array;
    readonly polyShiftl: (p: Int32Array) => Int32Array;
    readonly polyChknorm: (p: Int32Array, B: number) => boolean;
    readonly MultiplyNTTs: (a: Int32Array, b: Int32Array) => Int32Array;
    readonly NTT: {
        readonly encode: (r: Int32Array) => Int32Array;
        readonly decode: (r: Int32Array) => Int32Array;
    };
    readonly RejNTTPoly: (xof: () => Uint8Array) => Int32Array;
    readonly XOF128: XOF;
    readonly XOF256: XOF;
    readonly cleanBytes: typeof cleanBytes;
    readonly ETACoder: BytesCoderLen<Int32Array>;
    readonly T0Coder: BytesCoderLen<Int32Array>;
    readonly T1Coder: BytesCoderLen<Int32Array>;
    readonly ZCoder: BytesCoderLen<Int32Array>;
    readonly W1Coder: BytesCoderLen<Int32Array>;
    readonly W1Vec: BytesCoderLen<Int32Array[]>;
    readonly hintCoder: BytesCoderLen<Int32Array[] | false>;
    readonly sigCoder: BytesCoderLen<[Uint8Array, Int32Array[], Int32Array[] | false]>;
    readonly publicCoder: BytesCoderLen<[Uint8Array, Int32Array[]]>;
    readonly secretCoder: BytesCoderLen<[
        Uint8Array,
        Uint8Array,
        Uint8Array,
        Int32Array[],
        Int32Array[],
        Int32Array[]
    ]>;
    constructor(opts: PrimitivesOpts);
    /** Decompose r into (r1, r0) such that r = r1*(2*GAMMA2) + r0 mod q (FIPS 204 Algorithm 17). */
    decompose(r: number): {
        r1: number;
        r0: number;
    };
    /** Extract high bits of r. */
    HighBits(r: number): number;
    /** Extract low bits of r. */
    LowBits(r: number): number;
    /** Compute hint bit indicating whether adding z to r alters the high bits. */
    MakeHint(z: number, r: number): number;
    /** Return the high bits of r adjusted according to hint h. */
    UseHint(h: number, r: number): number;
    /** Decompose r into (r1, r0) such that r = r1*(2^d) + r0 mod q. */
    Power2Round(r: number): {
        r1: number;
        r0: number;
    };
    /** Apply Power2Round to each coefficient of a polynomial. */
    polyPowerRound(p: Poly): {
        r0: Int32Array;
        r1: Int32Array;
    };
    /** Apply UseHint element-wise. **Mutates `u` in place.** */
    polyUseHint(u: Poly, h: Poly): Poly;
    /** Apply MakeHint element-wise, returning the hint vector and popcount. */
    polyMakeHint(a: Poly, b: Poly): {
        v: Int32Array;
        cnt: number;
    };
    /** Sample a polynomial with coefficients in [-ETA, ETA] via rejection (FIPS 204 Algorithm 15). */
    RejBoundedPoly(xof: XofGet): Int32Array;
    /** Sample a polynomial c in R_q with coefficients from {-1, 0, 1} and Hamming weight TAU (FIPS 204 Algorithm 16). */
    SampleInBall(seed: Uint8Array): Int32Array;
}
/**
 * Create an MLDSAPrimitives instance.
 * @deprecated Use `new MLDSAPrimitives(opts)` directly.
 */
export declare function createMLDSAPrimitives(opts: PrimitivesOpts): MLDSAPrimitives;
export {};
