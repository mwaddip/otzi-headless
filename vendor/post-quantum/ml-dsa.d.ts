import { MLDSAPrimitives, type PrimitivesOpts } from './ml-dsa-primitives.ts';
import { type CryptoKeys, type Signer, type SigOpts, type VerOpts } from './utils.ts';
/** Options for internal sign/verify that accept an external mu digest. */
export type DSAInternalOpts = {
    externalMu?: boolean;
};
/** Signer API containing internal methods (accept externalMu for threshold signing). */
export type DSAInternal = CryptoKeys & {
    lengths: Signer['lengths'];
    sign: (msg: Uint8Array, secretKey: Uint8Array, opts?: SigOpts & DSAInternalOpts) => Uint8Array;
    verify: (sig: Uint8Array, msg: Uint8Array, pubKey: Uint8Array, opts?: VerOpts & DSAInternalOpts) => boolean;
};
/** Full ML-DSA instance: public API + internal methods + primitives access. */
export type DSA = Signer & {
    internal: DSAInternal;
    primitives: MLDSAPrimitives;
};
/** Various lattice params. */
export type DSAParam = {
    K: number;
    L: number;
    D: number;
    GAMMA1: number;
    GAMMA2: number;
    TAU: number;
    ETA: number;
    OMEGA: number;
};
/** Internal params for different versions of ML-DSA. */
export declare const PARAMS: Record<string, DSAParam>;
type DilithiumOpts = PrimitivesOpts & {
    securityLevel: number;
};
/**
 * Create an ML-DSA instance for the given parameters.
 * @deprecated Use the pre-built `ml_dsa44/65/87` constants.
 */
export declare function getDilithium(opts: DilithiumOpts): DSA;
/** ML-DSA-44 for 128-bit security level. Not recommended after 2030, as per ASD. */
export declare const ml_dsa44: DSA;
/** ML-DSA-65 for 192-bit security level. Not recommended after 2030, as per ASD. */
export declare const ml_dsa65: DSA;
/** ML-DSA-87 for 256-bit security level. OK after 2030, as per ASD. */
export declare const ml_dsa87: DSA;
export {};
