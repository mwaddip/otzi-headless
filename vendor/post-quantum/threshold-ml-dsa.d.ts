import { MLDSAPrimitives } from './ml-dsa-primitives.ts';
/** Parameters for threshold ML-DSA signing. */
export interface ThresholdParams {
    /** Threshold — minimum parties needed to sign. */
    readonly T: number;
    /** Total number of parties. */
    readonly N: number;
    /** Number of parallel signing iterations. */
    readonly K_iter: number;
    /** Scaling factor for hyperball sampling (always 3.0). */
    readonly nu: number;
    /** Primary L2 radius bound. */
    readonly r: number;
    /** Secondary L2 radius bound. */
    readonly rPrime: number;
}
/** A single secret share (s1, s2 vectors over Rq). */
export interface SecretShare {
    readonly s1: readonly Int32Array[];
    readonly s2: readonly Int32Array[];
    readonly s1Hat: readonly Int32Array[];
    readonly s2Hat: readonly Int32Array[];
}
/** A party's threshold key share. */
export interface ThresholdKeyShare {
    /** Party index (0-based). */
    readonly id: number;
    /** Shared randomness seed (rho). */
    readonly rho: Uint8Array;
    /** Per-party key material. */
    readonly key: Uint8Array;
    /** Public key hash (tr). */
    readonly tr: Uint8Array;
    /** Secret share components indexed by party-subset bitmask. */
    readonly shares: ReadonlyMap<number, SecretShare>;
}
/** Output of threshold key generation. */
export interface ThresholdKeygenResult {
    /** Standard FIPS 204 public key. */
    readonly publicKey: Uint8Array;
    /** Per-party key shares. */
    readonly shares: readonly ThresholdKeyShare[];
}
export type SessionId = Uint8Array;
export interface DKGSetupResult {
    readonly bitmasks: readonly number[];
    readonly holdersOf: ReadonlyMap<number, readonly number[]>;
}
export interface DKGPhase1Broadcast {
    readonly partyId: number;
    readonly rhoCommitment: Uint8Array;
    readonly bitmaskCommitments: ReadonlyMap<number, Uint8Array>;
}
export interface DKGPhase1State {
    readonly rho: Uint8Array;
    readonly bitmaskEntropy: ReadonlyMap<number, Uint8Array>;
}
export interface DKGPhase2Broadcast {
    readonly partyId: number;
    readonly rho: Uint8Array;
}
export interface DKGPhase2Private {
    readonly fromPartyId: number;
    readonly bitmaskReveals: ReadonlyMap<number, Uint8Array>;
}
export interface DKGPhase3Private {
    readonly fromGeneratorId: number;
    readonly maskPieces: ReadonlyMap<number, Int32Array[]>;
}
export interface DKGPhase4Broadcast {
    readonly partyId: number;
    readonly aggregate: readonly Int32Array[];
}
export interface DKGResult {
    readonly publicKey: Uint8Array;
    readonly share: ThresholdKeyShare;
}
export interface DKGPhase2FinalizeResult {
    readonly shares: ReadonlyMap<number, SecretShare>;
    readonly generatorAssignment: ReadonlyMap<number, number>;
    readonly rho: Uint8Array;
    readonly privateToAll: ReadonlyMap<number, DKGPhase3Private>;
    readonly ownMaskPieces: ReadonlyMap<number, readonly Int32Array[]>;
}
/** Result from round 1 of the distributed signing protocol. */
export interface Round1Result {
    /** 32-byte commitment hash. Broadcast to all parties immediately. */
    readonly commitmentHash: Uint8Array;
    /** Private state — carries to round2() and round3(). Call destroy() when done. */
    readonly state: Round1State;
}
/** Private state from round 1. Contains sensitive key material — DO NOT share. */
export declare class Round1State {
    #private;
    /** @internal */
    constructor(stws: Float64Array[], commitment: Uint8Array);
    /** @internal */
    get _stws(): readonly Float64Array[];
    /** @internal */
    get _commitment(): Uint8Array;
    /** Zero out all sensitive data in this state. */
    destroy(): void;
}
/** Result from round 2 of the distributed signing protocol. */
export interface Round2Result {
    /** Packed commitment data. Broadcast to all parties. */
    readonly commitment: Uint8Array;
    /** Private state — carries to round3(). Call destroy() when done. */
    readonly state: Round2State;
}
/** Private state from round 2. Contains message digest. */
export declare class Round2State {
    #private;
    /** @internal */
    constructor(hashes: Uint8Array[], mu: Uint8Array, act: number, activePartyIds: number[]);
    /** @internal */
    get _hashes(): readonly Uint8Array[];
    /** @internal */
    get _mu(): Uint8Array;
    /** @internal */
    get _act(): number;
    /** @internal */
    get _activePartyIds(): readonly number[];
    /** Zero out message digest. */
    destroy(): void;
}
/**
 * Threshold ML-DSA signing protocol.
 *
 * Implements FIPS 204 compliant t-of-n threshold signing
 * producing standard ML-DSA signatures. Based on the
 * "Threshold Signatures Reloaded" construction.
 */
export declare class ThresholdMLDSA {
    #private;
    static readonly MAX_PARTIES = 6;
    readonly params: ThresholdParams;
    constructor(primitives: MLDSAPrimitives, params: ThresholdParams);
    /**
     * Create a ThresholdMLDSA instance for the given security level and threshold parameters.
     * @param securityLevel - 44, 65, or 87 (or 128, 192, 256)
     * @param T - Minimum number of parties needed to sign
     * @param N_ - Total number of parties
     */
    static create(securityLevel: number, T: number, N_: number): ThresholdMLDSA;
    /** Get threshold parameters for given (T, N, securityLevel). */
    static getParams(T: number, N_: number, securityLevel: number): ThresholdParams;
    /**
     * Generate threshold keys from a seed (trusted dealer model).
     *
     * A single trusted dealer generates all N key shares and the public key.
     * After distributing shares to parties over secure channels, the dealer
     * MUST securely erase the seed and all share data.
     *
     * @param seed - 32-byte seed. Default: random.
     */
    keygen(seed?: Uint8Array): ThresholdKeygenResult;
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
    sign(msg: Uint8Array, publicKey: Uint8Array, shares: readonly ThresholdKeyShare[], opts?: {
        readonly context?: Uint8Array;
    }): Uint8Array;
    /**
     * Round 1: Generate commitment for distributed threshold signing.
     *
     * Each party calls this independently with fresh randomness.
     * The returned commitmentHash (32 bytes) should be broadcast to all parties.
     *
     * @param share - This party's key share
     * @param opts - Optional: nonce (default 0), rhop (default random 64 bytes)
     */
    round1(share: ThresholdKeyShare, opts?: {
        readonly nonce?: number;
        readonly rhop?: Uint8Array;
    }): Round1Result;
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
    round2(share: ThresholdKeyShare, activePartyIds: readonly number[], msg: Uint8Array, round1Hashes: readonly Uint8Array[], round1State: Round1State, opts?: {
        readonly context?: Uint8Array;
    }): Round2Result;
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
    round3(share: ThresholdKeyShare, commitments: readonly Uint8Array[], round1State: Round1State, round2State: Round2State): Uint8Array;
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
    combine(publicKey: Uint8Array, msg: Uint8Array, commitments: readonly Uint8Array[], responses: readonly Uint8Array[], opts?: {
        readonly context?: Uint8Array;
    }): Uint8Array | null;
    /**
     * Phase 0: Deterministic DKG setup.
     * Enumerates all bitmasks and their holders for the given (T, N).
     */
    dkgSetup(sessionId: SessionId): DKGSetupResult;
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
    dkgPhase1(partyId: number, sessionId: SessionId, opts?: {
        readonly rho?: Uint8Array;
        readonly bitmaskEntropy?: ReadonlyMap<number, Uint8Array>;
    }): {
        broadcast: DKGPhase1Broadcast;
        state: DKGPhase1State;
    };
    /**
     * Phase 2: Reveal entropy and prepare private messages for fellow holders.
     *
     * After collecting all Phase 1 broadcasts, each party reveals their rho_i
     * (broadcast) and sends r_{i,b} values to fellow holders (private).
     */
    dkgPhase2(partyId: number, sessionId: SessionId, state: DKGPhase1State, allPhase1: readonly DKGPhase1Broadcast[]): {
        broadcast: DKGPhase2Broadcast;
        privateToHolders: Map<number, DKGPhase2Private>;
    };
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
    dkgPhase2Finalize(partyId: number, sessionId: SessionId, state: DKGPhase1State, allPhase1: readonly DKGPhase1Broadcast[], allPhase2Broadcasts: readonly DKGPhase2Broadcast[], receivedReveals: readonly DKGPhase2Private[]): DKGPhase2FinalizeResult;
    /**
     * Phase 4: Aggregate received mask pieces and broadcast R_j.
     *
     * R_j = sum over all bitmasks b of r_{b,j} (mod q)
     */
    dkgPhase4(partyId: number, bitmasks: readonly number[], generatorAssignment: ReadonlyMap<number, number>, receivedMasks: readonly DKGPhase3Private[], ownMaskPieces: ReadonlyMap<number, readonly Int32Array[]>): DKGPhase4Broadcast;
    /**
     * Finalize: Aggregate all parties' R_j to compute t, derive public key and ThresholdKeyShare.
     *
     * t = sum_j R_j (mod q), then Power2Round, encode public key.
     */
    dkgFinalize(partyId: number, rho: Uint8Array, allPhase4: readonly DKGPhase4Broadcast[], shares: ReadonlyMap<number, SecretShare>): DKGResult;
    /** Get the byte size of a packed commitment from round1. */
    get commitmentByteLength(): number;
    /** Get the byte size of a packed response from round3. */
    get responseByteLength(): number;
}
