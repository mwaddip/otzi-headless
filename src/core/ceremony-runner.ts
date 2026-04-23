import {
  createSession,
  round1,
  round2,
  round3,
  combine,
  addBlob,
  destroySession,
  type SigningSession,
} from '../wire/threshold';
import type { DecryptedShare } from '../wire/share-crypto';
import type { KeyPackage, PublicKeyPackage, Rng } from '@mwaddip/frots';
import type { DKGResult } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { BlobKey, PartyId } from './types';
import type { Transport } from './transport';
import type { BlobStore } from './blob-store';
import type { BlobPuller, PullOpts } from './blob-puller';
import {
  announceMessage,
  announceFrostMessage,
  announceDkgMessage,
  announceFrostDkgMessage,
  announceCombinedDkgMessage,
  encodeCeremonyMessage,
  signoffAbortedMessage,
  signoffDoneMessage,
  signoffFrostDoneMessage,
} from './ceremony-messages';
import {
  createSession as createFrostSession,
  round1 as frostRound1,
  round2 as frostRound2,
  aggregate as frostAggregate,
  addBlob as frostAddBlob,
  destroySession as destroyFrostSession,
  type FrostSighash,
  type FrostSigningSession,
  type FrostSignRound,
} from './frost-sign-session';
import {
  createSession as createMldsaDkgSession,
  phase1 as mldsaDkgPhase1,
  phase2 as mldsaDkgPhase2,
  phase2PrivateForTarget as mldsaDkgPhase2PrivateForTarget,
  phase2Recipients as mldsaDkgPhase2Recipients,
  phase2ExpectedSenders as mldsaDkgPhase2ExpectedSenders,
  phase2Finalize as mldsaDkgPhase2Finalize,
  phase3PrivateForTarget as mldsaDkgPhase3PrivateForTarget,
  phase3Recipients as mldsaDkgPhase3Recipients,
  phase3ExpectedSenders as mldsaDkgPhase3ExpectedSenders,
  phase4 as mldsaDkgPhase4,
  finalize as mldsaDkgFinalize,
  addBlob as mldsaDkgAddBlob,
  destroySession as destroyMldsaDkgSession,
  type MldsaDkgSession,
} from './dkg-session';
import {
  createSession as createFrostDkgSession,
  round1 as frostDkgRound1,
  round2 as frostDkgRound2,
  round2ForTarget as frostDkgRound2ForTarget,
  round2Recipients as frostDkgRound2Recipients,
  finalize as frostDkgFinalize,
  addBlob as frostDkgAddBlob,
  destroySession as destroyFrostDkgSession,
  type FrostDkgSession,
} from './frost-dkg-session';

const ROUND_MLDSA_R1 = 'mldsa-r1';
const ROUND_MLDSA_R2 = 'mldsa-r2';
const ROUND_MLDSA_R3 = 'mldsa-r3';

const ROUND_FROST_R1 = 'frost-sign-r1';
const ROUND_FROST_R2 = 'frost-sign-r2';

const ROUND_MLDSA_DKG_P1 = 'mldsa-dkg-p1';
const ROUND_MLDSA_DKG_P2_PUB = 'mldsa-dkg-p2-pub';
const ROUND_MLDSA_DKG_P2_PRIV = 'mldsa-dkg-p2-priv';
const ROUND_MLDSA_DKG_P3 = 'mldsa-dkg-p3';
const ROUND_MLDSA_DKG_P4 = 'mldsa-dkg-p4';

const ROUND_FROST_DKG_R1 = 'frost-dkg-r1';
const ROUND_FROST_DKG_R2 = 'frost-dkg-r2';

function randomSessionId(): Uint8Array {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return buf;
}

function partiesOtherThan(parties: number, me: PartyId): PartyId[] {
  const out: PartyId[] = [];
  for (let i = 0; i < parties; i++) if (i !== me) out.push(i);
  return out;
}

export interface SigningSpec {
  /** Unique identifier for this ceremony (may include a `#N` retry suffix internally). */
  ceremonyId: string;
  /** Message bytes to sign. */
  message: Uint8Array;
  /** Active signer set (size = threshold). MUST include this daemon's own partyId. */
  signers: PartyId[];
  /** This daemon's own decrypted key share. */
  share: DecryptedShare;
}

export interface FrostSigningSpec {
  /** Unique identifier for this ceremony (stable — FROST has no retries). */
  ceremonyId: string;
  /** Sighashes to sign, in canonical input order. Each carries its own key-path/script-path flag. */
  sighashes: readonly FrostSighash[];
  /** Active signer set (size = minSigners). MUST include this daemon's own partyId. */
  signers: PartyId[];
  /** This daemon's own FROST key package (from DKG or dealer `finalizeKeygen`). */
  keyPackage: KeyPackage;
  /** Group public material — must be identical across all participants. */
  publicKeyPackage: PublicKeyPackage;
  /** Randomness source for nonce generation. Pass a CSPRNG in production. */
  rng: Rng;
}

export interface MldsaDkgSpec {
  /** Unique identifier for this ceremony (stable — DKG has no retries). */
  ceremonyId: string;
  /** T: minimum parties needed to sign after DKG completes. */
  threshold: number;
  /** N: total parties in the ring. This daemon's partyId must be in [0, N). */
  parties: number;
  /** ML-DSA security level (44 for OPNet). */
  level: number;
}

export interface FrostDkgSpec {
  /** Unique identifier for this ceremony (stable — DKG has no retries). */
  ceremonyId: string;
  /** T (minSigners). */
  threshold: number;
  /** N (maxSigners). */
  parties: number;
  /** Randomness source for polynomial + proof-of-knowledge generation. */
  rng: Rng;
}

export interface CombinedDkgSpec {
  /** Unique identifier for this ceremony (stable — DKG has no retries). */
  ceremonyId: string;
  /** T: threshold for both ML-DSA and FROST outputs. */
  threshold: number;
  /** N: total parties. */
  parties: number;
  /** ML-DSA security level (44 for OPNet). FROST is fixed secp256k1. */
  level: number;
  /** Randomness source for FROST DKG. */
  rng: Rng;
}

export interface CombinedDkgResult {
  mldsa: DKGResult;
  frost: { keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage };
}

/**
 * Drives pull-based ML-DSA threshold signing ceremonies using the extracted
 * wire codec (`src/wire/threshold.ts`) unmodified.
 *
 * Roles (asymmetric for signing — the trigger assigns a natural leader):
 *
 * - `signAsLeader(spec, opts)` — the initiator. Broadcasts an announcement
 *   per attempt, drives all three rounds, runs `combine`, retries on null,
 *   and broadcasts `signoff-aborted` on exhaustion. Returns the signature
 *   on success; caller broadcasts the transaction and then calls
 *   `sendSigningDoneSignoff` to release participants.
 *
 * - `participateInSigning(spec, opts)` — every non-leader active signer runs
 *   this once per announcement. Produces own r1/r2/r3 blobs, pulling r1 and
 *   r2 from other active signers so `round2` / `round3` have their inputs.
 *   Does NOT pull r3 from others and does NOT run `combine` — those are the
 *   leader's job. Session is destroyed on return.
 *
 * Higher-level orchestration (listening for announcements, looping
 * participate calls per attempt, cleaning up on signoff) lives outside this
 * class (phase 5 trigger layer; meanwhile, tests wire it manually).
 *
 * Pull-handler lifecycle: the Runner does not own `transport.servePulls`.
 * A long-lived `BlobServer` must bridge the transport to the same BlobStore.
 */
export class CeremonyRunner {
  constructor(
    private readonly transport: Transport,
    private readonly store: BlobStore,
    private readonly puller: BlobPuller,
  ) {}

  /** Leader entry point — drives the ceremony end-to-end and returns the FIPS 204 signature. */
  async signAsLeader(
    spec: SigningSpec,
    opts: PullOpts,
    maxCombineAttempts = 50,
  ): Promise<Uint8Array> {
    const me = this.transport.partyId;
    if (!spec.signers.includes(me)) {
      throw new Error(`Party ${me} is not in the active signer set [${spec.signers.join(',')}]`);
    }

    let reason: string;
    try {
      for (let attempt = 1; attempt <= maxCombineAttempts; attempt++) {
        const ceremonyId = attempt === 1 ? spec.ceremonyId : `${spec.ceremonyId}#${attempt}`;
        const attemptSpec: SigningSpec = { ...spec, ceremonyId };

        await this.transport.broadcast(
          encodeCeremonyMessage(
            announceMessage(ceremonyId, spec.ceremonyId, spec.message, spec.signers),
          ),
        );

        const sig = await this.tryLeaderAttempt(attemptSpec, opts);
        if (sig) return sig;
      }
      reason = `combine exhausted after ${maxCombineAttempts} attempts`;
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }

    // Any path that didn't return a sig gets an abort signoff so participants release state.
    // Swallow broadcast errors — we're already in a failure path.
    await this.transport
      .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
      .catch(() => {});
    throw new Error(`Signing aborted: ${reason}`);
  }

  /**
   * Broadcast a signoff announcing successful completion. The caller should
   * call this AFTER broadcasting the signed transaction upstream; it
   * releases participant state immediately (TTL is the safety net, not the
   * happy path).
   */
  async sendSigningDoneSignoff(baseCeremonyId: string, signature: Uint8Array): Promise<void> {
    await this.transport.broadcast(
      encodeCeremonyMessage(signoffDoneMessage(baseCeremonyId, signature)),
    );
  }

  /** Participant entry point — runs one signing attempt's production phase (no combine). */
  async participateInSigning(spec: SigningSpec, opts: PullOpts): Promise<void> {
    const me = this.transport.partyId;
    if (!spec.signers.includes(me)) {
      throw new Error(`Party ${me} is not in the active signer set [${spec.signers.join(',')}]`);
    }

    const session = createSession(spec.message, spec.share, spec.signers);
    try {
      this.produceOwn(session, round1, ROUND_MLDSA_R1, spec);
      await this.pullAndAddFromOthers(session, ROUND_MLDSA_R1, spec, opts, 1);
      this.produceOwn(session, round2, ROUND_MLDSA_R2, spec);
      await this.pullAndAddFromOthers(session, ROUND_MLDSA_R2, spec, opts, 2);
      this.produceOwn(session, round3, ROUND_MLDSA_R3, spec);
      // Participant stops here: does not pull r3 from others, does not combine.
    } finally {
      destroySession(session);
    }
  }

  // -- FROST signing (asymmetric; leader + participants; no retry) --

  /**
   * FROST leader entry point — drives R1+R2, aggregates N BIP340 signatures.
   *
   * Unlike ML-DSA signing, FROST combine is deterministic, so there is no
   * rejection-sampling retry loop and no `#N` ceremonyId suffix. A single
   * announce → R1 → R2 → aggregate → signoff cycle.
   */
  async signFrostAsLeader(
    spec: FrostSigningSpec,
    opts: PullOpts,
  ): Promise<Uint8Array[]> {
    const me = this.transport.partyId;
    if (!spec.signers.includes(me)) {
      throw new Error(`Party ${me} is not in the active signer set [${spec.signers.join(',')}]`);
    }

    let reason: string;
    try {
      await this.transport.broadcast(
        encodeCeremonyMessage(
          announceFrostMessage(spec.ceremonyId, spec.ceremonyId, spec.sighashes, spec.signers),
        ),
      );

      const session = createFrostSession({
        partyId: me,
        keyPackage: spec.keyPackage,
        publicKeyPackage: spec.publicKeyPackage,
        sighashes: spec.sighashes,
        activeSigners: spec.signers,
        rng: spec.rng,
        ceremonyId: spec.ceremonyId,
      });
      try {
        this.produceOwnFrost(session, frostRound1, ROUND_FROST_R1, spec);
        await this.pullAndAddFromOthersFrost(session, ROUND_FROST_R1, spec, opts, 1);
        this.produceOwnFrost(session, frostRound2, ROUND_FROST_R2, spec);
        await this.pullAndAddFromOthersFrost(session, ROUND_FROST_R2, spec, opts, 2);
        return frostAggregate(session);
      } finally {
        destroyFrostSession(session);
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }

    await this.transport
      .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
      .catch(() => {});
    throw new Error(`FROST signing aborted: ${reason}`);
  }

  /** Participant entry point for FROST — produces R1+R2; does not aggregate. */
  async participateInFrostSigning(spec: FrostSigningSpec, opts: PullOpts): Promise<void> {
    const me = this.transport.partyId;
    if (!spec.signers.includes(me)) {
      throw new Error(`Party ${me} is not in the active signer set [${spec.signers.join(',')}]`);
    }

    const session = createFrostSession({
      partyId: me,
      keyPackage: spec.keyPackage,
      publicKeyPackage: spec.publicKeyPackage,
      sighashes: spec.sighashes,
      activeSigners: spec.signers,
      rng: spec.rng,
      ceremonyId: spec.ceremonyId,
    });
    try {
      this.produceOwnFrost(session, frostRound1, ROUND_FROST_R1, spec);
      await this.pullAndAddFromOthersFrost(session, ROUND_FROST_R1, spec, opts, 1);
      this.produceOwnFrost(session, frostRound2, ROUND_FROST_R2, spec);
      await this.pullAndAddFromOthersFrost(session, ROUND_FROST_R2, spec, opts, 2);
      // Participant stops here: leader runs aggregate.
    } finally {
      destroyFrostSession(session);
    }
  }

  /** FROST signoff carrying the aggregated signatures for audit / participant release. */
  async sendFrostSigningDoneSignoff(
    baseCeremonyId: string,
    signatures: ReadonlyArray<Uint8Array>,
  ): Promise<void> {
    await this.transport.broadcast(
      encodeCeremonyMessage(signoffFrostDoneMessage(baseCeremonyId, signatures)),
    );
  }

  // -- ML-DSA DKG (symmetric; no leader; single attempt) --

  /**
   * Initiator entry point: generate a fresh 32-byte sessionId, broadcast the
   * DKG announcement carrying it, then run the symmetric protocol locally.
   * Returns this party's `DKGResult` (own share + aggregate public key).
   *
   * Other peers discover the sessionId via the announce and call
   * `participateInMldsaDkg`. DKG is symmetric — "initiator" only names the
   * peer whose trigger fired and who generated the randomness, not a
   * mid-ceremony coordinator.
   */
  async runMldsaDkg(spec: MldsaDkgSpec, opts: PullOpts): Promise<DKGResult> {
    const sessionId = randomSessionId();
    try {
      await this.transport.broadcast(
        encodeCeremonyMessage(
          announceDkgMessage(
            spec.ceremonyId,
            spec.ceremonyId,
            sessionId,
            spec.threshold,
            spec.parties,
            spec.level,
          ),
        ),
      );
      return await this.runMldsaDkgProtocol(spec, sessionId, opts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.transport
        .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
        .catch(() => {});
      throw new Error(`MLDSA DKG aborted: ${reason}`);
    }
  }

  /**
   * Participant entry point: join an in-progress DKG using the sessionId
   * extracted from a received `announce-dkg` message.
   */
  async participateInMldsaDkg(
    spec: MldsaDkgSpec,
    sessionId: Uint8Array,
    opts: PullOpts,
  ): Promise<DKGResult> {
    try {
      return await this.runMldsaDkgProtocol(spec, sessionId, opts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.transport
        .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
        .catch(() => {});
      throw new Error(`MLDSA DKG aborted: ${reason}`);
    }
  }

  // -- FROST DKG (symmetric; no leader; single attempt) --

  /** FROST DKG initiator: generate sessionId, broadcast announce, run protocol. */
  async runFrostDkg(
    spec: FrostDkgSpec,
    opts: PullOpts,
  ): Promise<{ keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage }> {
    const sessionId = randomSessionId();
    try {
      await this.transport.broadcast(
        encodeCeremonyMessage(
          announceFrostDkgMessage(
            spec.ceremonyId,
            spec.ceremonyId,
            sessionId,
            spec.threshold,
            spec.parties,
          ),
        ),
      );
      return await this.runFrostDkgProtocol(spec, sessionId, opts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.transport
        .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
        .catch(() => {});
      throw new Error(`FROST DKG aborted: ${reason}`);
    }
  }

  /** FROST DKG participant: join using sessionId from a received announce. */
  async participateInFrostDkg(
    spec: FrostDkgSpec,
    sessionId: Uint8Array,
    opts: PullOpts,
  ): Promise<{ keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage }> {
    try {
      return await this.runFrostDkgProtocol(spec, sessionId, opts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.transport
        .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
        .catch(() => {});
      throw new Error(`FROST DKG aborted: ${reason}`);
    }
  }

  // -- Combined ML-DSA + FROST DKG (one sessionId; matches Ötzi `DKGWizard.tsx`) --

  /**
   * Combined-DKG initiator: one sessionId, one announce, then ML-DSA DKG
   * followed by FROST DKG. Produces both key materials required for OPNet
   * operation (ML-DSA for auth / transaction signing, FROST for Taproot).
   *
   * Key-link signing (pubkey-bind sig that Ötzi's `frost-link.ts` injects at
   * broadcast time) is deferred to phase 2.5c — it's a separate ceremony
   * consuming the FROST key material produced here.
   */
  async runCombinedDkg(spec: CombinedDkgSpec, opts: PullOpts): Promise<CombinedDkgResult> {
    const sessionId = randomSessionId();
    try {
      await this.transport.broadcast(
        encodeCeremonyMessage(
          announceCombinedDkgMessage(
            spec.ceremonyId,
            spec.ceremonyId,
            sessionId,
            spec.threshold,
            spec.parties,
            spec.level,
          ),
        ),
      );
      return await this.runCombinedDkgProtocol(spec, sessionId, opts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.transport
        .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
        .catch(() => {});
      throw new Error(`Combined DKG aborted: ${reason}`);
    }
  }

  /** Combined-DKG participant: join using sessionId from a received announce. */
  async participateInCombinedDkg(
    spec: CombinedDkgSpec,
    sessionId: Uint8Array,
    opts: PullOpts,
  ): Promise<CombinedDkgResult> {
    try {
      return await this.runCombinedDkgProtocol(spec, sessionId, opts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.transport
        .broadcast(encodeCeremonyMessage(signoffAbortedMessage(spec.ceremonyId, reason)))
        .catch(() => {});
      throw new Error(`Combined DKG aborted: ${reason}`);
    }
  }

  // -- private helpers --

  private async tryLeaderAttempt(spec: SigningSpec, opts: PullOpts): Promise<Uint8Array | null> {
    const session = createSession(spec.message, spec.share, spec.signers);
    try {
      this.produceOwn(session, round1, ROUND_MLDSA_R1, spec);
      await this.pullAndAddFromOthers(session, ROUND_MLDSA_R1, spec, opts, 1);
      this.produceOwn(session, round2, ROUND_MLDSA_R2, spec);
      await this.pullAndAddFromOthers(session, ROUND_MLDSA_R2, spec, opts, 2);
      this.produceOwn(session, round3, ROUND_MLDSA_R3, spec);
      await this.pullAndAddFromOthers(session, ROUND_MLDSA_R3, spec, opts, 3);
      return combine(session);
    } finally {
      destroySession(session);
    }
  }

  private produceOwn(
    session: SigningSession,
    produce: (s: SigningSession) => string,
    roundName: string,
    spec: SigningSpec,
  ): void {
    const me = this.transport.partyId;
    const blob = produce(session);
    const key: BlobKey = { ceremonyId: spec.ceremonyId, round: roundName, from: me };
    this.store.put(key, new TextEncoder().encode(blob));
  }

  private async pullAndAddFromOthers(
    session: SigningSession,
    roundName: string,
    spec: SigningSpec,
    opts: PullOpts,
    addBlobRound: number,
  ): Promise<void> {
    const me = this.transport.partyId;
    const expected = spec.signers
      .filter(id => id !== me)
      .map(id => ({ ceremonyId: spec.ceremonyId, round: roundName, from: id }));
    await this.puller.pullAll(expected, opts);
    for (const key of expected) {
      const bytes = this.store.get(key);
      if (!bytes) throw new Error(`Missing ${roundName} blob from party ${key.from}`);
      const blobStr = new TextDecoder().decode(bytes);
      const result = addBlob(session, blobStr, addBlobRound);
      if (!result.ok) {
        throw new Error(`Rejected ${roundName} blob from party ${key.from}: ${result.error}`);
      }
    }
  }

  private produceOwnFrost(
    session: FrostSigningSession,
    produce: (s: FrostSigningSession) => string,
    roundName: string,
    spec: FrostSigningSpec,
  ): void {
    const me = this.transport.partyId;
    const blob = produce(session);
    const key: BlobKey = { ceremonyId: spec.ceremonyId, round: roundName, from: me };
    this.store.put(key, new TextEncoder().encode(blob));
  }

  private async pullAndAddFromOthersFrost(
    session: FrostSigningSession,
    roundName: string,
    spec: FrostSigningSpec,
    opts: PullOpts,
    addBlobRound: FrostSignRound,
  ): Promise<void> {
    const me = this.transport.partyId;
    const expected = spec.signers
      .filter(id => id !== me)
      .map(id => ({ ceremonyId: spec.ceremonyId, round: roundName, from: id }));
    await this.puller.pullAll(expected, opts);
    for (const key of expected) {
      const bytes = this.store.get(key);
      if (!bytes) throw new Error(`Missing ${roundName} blob from party ${key.from}`);
      const blobStr = new TextDecoder().decode(bytes);
      const result = frostAddBlob(session, blobStr, addBlobRound);
      if (!result.ok) {
        throw new Error(`Rejected ${roundName} blob from party ${key.from}: ${result.error}`);
      }
    }
  }

  // -- ML-DSA DKG helpers --

  private async runMldsaDkgProtocol(
    spec: MldsaDkgSpec,
    sessionId: Uint8Array,
    opts: PullOpts,
  ): Promise<DKGResult> {
    const me = this.transport.partyId;
    const session = createMldsaDkgSession({
      partyId: me,
      sessionId,
      threshold: spec.threshold,
      parties: spec.parties,
      level: spec.level,
    });
    try {
      // Phase 1 — broadcast commitment.
      this.produceDkgBroadcast(session, mldsaDkgPhase1, ROUND_MLDSA_DKG_P1, spec.ceremonyId);
      await this.pullDkgBroadcast(ROUND_MLDSA_DKG_P1, spec, opts, blob =>
        mldsaDkgAddBlob(session, blob, 'p1'),
      );

      // Phase 2 — public reveal broadcast + targeted private reveals to holder-mates.
      this.produceDkgBroadcast(session, mldsaDkgPhase2, ROUND_MLDSA_DKG_P2_PUB, spec.ceremonyId);
      for (const to of mldsaDkgPhase2Recipients(session)) {
        const blob = mldsaDkgPhase2PrivateForTarget(session, to);
        if (!blob) continue;
        this.store.put(
          { ceremonyId: spec.ceremonyId, round: ROUND_MLDSA_DKG_P2_PRIV, from: me, to },
          new TextEncoder().encode(blob),
        );
      }
      await this.pullDkgBroadcast(ROUND_MLDSA_DKG_P2_PUB, spec, opts, blob =>
        mldsaDkgAddBlob(session, blob, 'p2-pub'),
      );
      await this.pullDkgTargetedToMe(
        ROUND_MLDSA_DKG_P2_PRIV,
        spec.ceremonyId,
        mldsaDkgPhase2ExpectedSenders(session),
        opts,
        blob => mldsaDkgAddBlob(session, blob, 'p2-priv'),
      );

      // Phase 2 finalize (local); then Phase 3 targeted masks to every other party.
      mldsaDkgPhase2Finalize(session);
      for (const to of mldsaDkgPhase3Recipients(session)) {
        const blob = mldsaDkgPhase3PrivateForTarget(session, to);
        if (!blob) continue;
        this.store.put(
          { ceremonyId: spec.ceremonyId, round: ROUND_MLDSA_DKG_P3, from: me, to },
          new TextEncoder().encode(blob),
        );
      }
      await this.pullDkgTargetedToMe(
        ROUND_MLDSA_DKG_P3,
        spec.ceremonyId,
        mldsaDkgPhase3ExpectedSenders(session),
        opts,
        blob => mldsaDkgAddBlob(session, blob, 'p3'),
      );

      // Phase 4 — aggregate broadcast.
      this.produceDkgBroadcast(session, mldsaDkgPhase4, ROUND_MLDSA_DKG_P4, spec.ceremonyId);
      await this.pullDkgBroadcast(ROUND_MLDSA_DKG_P4, spec, opts, blob =>
        mldsaDkgAddBlob(session, blob, 'p4'),
      );

      return mldsaDkgFinalize(session);
    } finally {
      destroyMldsaDkgSession(session);
    }
  }

  private produceDkgBroadcast(
    session: MldsaDkgSession,
    produce: (s: MldsaDkgSession) => string,
    roundName: string,
    ceremonyId: string,
  ): void {
    const me = this.transport.partyId;
    const blob = produce(session);
    const key: BlobKey = { ceremonyId, round: roundName, from: me };
    this.store.put(key, new TextEncoder().encode(blob));
  }

  private async pullDkgBroadcast(
    roundName: string,
    spec: MldsaDkgSpec,
    opts: PullOpts,
    addBlob: (blob: string) => { ok: boolean; error?: string },
  ): Promise<void> {
    const me = this.transport.partyId;
    const expected = partiesOtherThan(spec.parties, me).map(from => ({
      ceremonyId: spec.ceremonyId,
      round: roundName,
      from,
    }));
    await this.puller.pullAll(expected, opts);
    for (const key of expected) {
      const bytes = this.store.get(key);
      if (!bytes) throw new Error(`Missing ${roundName} blob from party ${key.from}`);
      const blobStr = new TextDecoder().decode(bytes);
      const result = addBlob(blobStr);
      if (!result.ok) {
        throw new Error(`Rejected ${roundName} blob from party ${key.from}: ${result.error}`);
      }
    }
  }

  private async pullDkgTargetedToMe(
    roundName: string,
    ceremonyId: string,
    expectedSenders: readonly PartyId[],
    opts: PullOpts,
    addBlob: (blob: string) => { ok: boolean; error?: string },
  ): Promise<void> {
    const me = this.transport.partyId;
    const expected: BlobKey[] = expectedSenders.map(from => ({
      ceremonyId,
      round: roundName,
      from,
      to: me,
    }));
    await this.puller.pullAll(expected, opts);
    for (const key of expected) {
      const bytes = this.store.get(key);
      if (!bytes) throw new Error(`Missing ${roundName} blob from party ${key.from}`);
      const blobStr = new TextDecoder().decode(bytes);
      const result = addBlob(blobStr);
      if (!result.ok) {
        throw new Error(`Rejected ${roundName} blob from party ${key.from}: ${result.error}`);
      }
    }
  }

  // -- FROST DKG helpers --

  private async runFrostDkgProtocol(
    spec: FrostDkgSpec,
    sessionId: Uint8Array,
    opts: PullOpts,
  ): Promise<{ keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage }> {
    const me = this.transport.partyId;
    const session = createFrostDkgSession({
      partyId: me,
      sessionId,
      threshold: spec.threshold,
      parties: spec.parties,
      rng: spec.rng,
    });
    try {
      // Round 1 — broadcast commitment + proof of knowledge.
      this.produceFrostDkgBroadcast(session, frostDkgRound1, ROUND_FROST_DKG_R1, spec.ceremonyId);
      await this.pullFrostDkgBroadcast(ROUND_FROST_DKG_R1, spec, opts, blob =>
        frostDkgAddBlob(session, blob, 'r1'),
      );

      // Round 2 — local compute, then targeted share per other party.
      frostDkgRound2(session);
      for (const to of frostDkgRound2Recipients(session)) {
        const blob = frostDkgRound2ForTarget(session, to);
        if (!blob) continue;
        this.store.put(
          { ceremonyId: spec.ceremonyId, round: ROUND_FROST_DKG_R2, from: me, to },
          new TextEncoder().encode(blob),
        );
      }
      await this.pullDkgTargetedToMe(
        ROUND_FROST_DKG_R2,
        spec.ceremonyId,
        partiesOtherThan(spec.parties, me),
        opts,
        blob => frostDkgAddBlob(session, blob, 'r2'),
      );

      return frostDkgFinalize(session);
    } finally {
      destroyFrostDkgSession(session);
    }
  }

  private produceFrostDkgBroadcast(
    session: FrostDkgSession,
    produce: (s: FrostDkgSession) => string,
    roundName: string,
    ceremonyId: string,
  ): void {
    const me = this.transport.partyId;
    const blob = produce(session);
    const key: BlobKey = { ceremonyId, round: roundName, from: me };
    this.store.put(key, new TextEncoder().encode(blob));
  }

  private async pullFrostDkgBroadcast(
    roundName: string,
    spec: FrostDkgSpec,
    opts: PullOpts,
    addBlob: (blob: string) => { ok: boolean; error?: string },
  ): Promise<void> {
    const me = this.transport.partyId;
    const expected = partiesOtherThan(spec.parties, me).map(from => ({
      ceremonyId: spec.ceremonyId,
      round: roundName,
      from,
    }));
    await this.puller.pullAll(expected, opts);
    for (const key of expected) {
      const bytes = this.store.get(key);
      if (!bytes) throw new Error(`Missing ${roundName} blob from party ${key.from}`);
      const blobStr = new TextDecoder().decode(bytes);
      const result = addBlob(blobStr);
      if (!result.ok) {
        throw new Error(`Rejected ${roundName} blob from party ${key.from}: ${result.error}`);
      }
    }
  }

  // -- Combined DKG helper: runs ML-DSA DKG then FROST DKG under one sessionId --

  private async runCombinedDkgProtocol(
    spec: CombinedDkgSpec,
    sessionId: Uint8Array,
    opts: PullOpts,
  ): Promise<CombinedDkgResult> {
    const mldsa = await this.runMldsaDkgProtocol(
      {
        ceremonyId: spec.ceremonyId,
        threshold: spec.threshold,
        parties: spec.parties,
        level: spec.level,
      },
      sessionId,
      opts,
    );
    const frost = await this.runFrostDkgProtocol(
      {
        ceremonyId: spec.ceremonyId,
        threshold: spec.threshold,
        parties: spec.parties,
        rng: spec.rng,
      },
      sessionId,
      opts,
    );
    return { mldsa, frost };
  }
}
