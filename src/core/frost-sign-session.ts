/**
 * FROST (Schnorr) signing session wrapper around `@mwaddip/frots`.
 *
 * Mirrors the shape of `src/wire/threshold.ts`'s SigningSession so the
 * CeremonyRunner can drive it with the same produce/pull/addBlob pattern.
 *
 * One ceremony signs N sighashes at once (typical OPNet / BIP341 transaction
 * has multiple inputs, each with its own sighash, optionally key-path vs
 * script-path). Each round produces/consumes a single blob per party that
 * packs all N items (see `src/wire/frost-sign.ts`).
 */

import { createHash } from 'node:crypto';
import {
  signRound1,
  signRound2,
  signAggregate,
  type KeyPackage,
  type PublicKeyPackage,
  type Rng,
  type SigningCommitment,
  type SigningNonces,
  type SignatureShare,
} from '@mwaddip/frots';
import type { PartyId } from './types';
import {
  encodeFrostSignR1,
  decodeFrostSignR1,
  encodeFrostSignR2,
  decodeFrostSignR2,
} from '../wire/frost-sign';

/** One sighash to sign in a FROST ceremony. */
export interface FrostSighash {
  hash: Uint8Array; // 32 bytes
  tweaked: boolean; // true = key-path (BIP341 tap-tweak); false = script-path
}

export interface FrostSigningSession {
  readonly partyId: PartyId;
  readonly keyPackage: KeyPackage;
  readonly publicKeyPackage: PublicKeyPackage;
  readonly sighashes: readonly FrostSighash[];
  readonly activeSigners: readonly PartyId[]; // 0-indexed daemon ids; includes self
  readonly rng: Rng;
  readonly sessionId: Uint8Array; // 32 bytes; wire-envelope `sid` (tag, not a secret)

  myNonces: SigningNonces[] | null;
  myCommitments: SigningCommitment[] | null;
  collectedR1: Map<PartyId, readonly SigningCommitment[]>;

  myShares: SignatureShare[] | null;
  collectedR2: Map<PartyId, readonly SignatureShare[]>;

  signatures: Uint8Array[] | null;
  destroyed: boolean;
}

export interface CreateFrostSessionInput {
  partyId: PartyId;
  keyPackage: KeyPackage;
  publicKeyPackage: PublicKeyPackage;
  sighashes: readonly FrostSighash[];
  activeSigners: readonly PartyId[];
  rng: Rng;
  /** Used to derive the wire-envelope session tag deterministically across peers. */
  ceremonyId: string;
}

export function createSession(input: CreateFrostSessionInput): FrostSigningSession {
  if (input.sighashes.length === 0) throw new Error('FROST session requires at least one sighash');
  if (!input.activeSigners.includes(input.partyId)) {
    throw new Error(`partyId ${input.partyId} must be in activeSigners`);
  }
  const sessionId = createHash('sha256').update(input.ceremonyId, 'utf8').digest();
  return {
    partyId: input.partyId,
    keyPackage: input.keyPackage,
    publicKeyPackage: input.publicKeyPackage,
    sighashes: input.sighashes,
    activeSigners: input.activeSigners,
    rng: input.rng,
    sessionId: new Uint8Array(sessionId),
    myNonces: null,
    myCommitments: null,
    collectedR1: new Map(),
    myShares: null,
    collectedR2: new Map(),
    signatures: null,
    destroyed: false,
  };
}

/** Round 1: produce N (nonces, commitments) pairs; broadcast the commitments. */
export function round1(session: FrostSigningSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.myCommitments) throw new Error('round1 already run');

  const n = session.sighashes.length;
  const nonces: SigningNonces[] = new Array(n);
  const commitments: SigningCommitment[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const out = signRound1(session.keyPackage, session.rng);
    nonces[i] = out.nonces;
    commitments[i] = out.commitments;
  }
  session.myNonces = nonces;
  session.myCommitments = commitments;
  session.collectedR1.set(session.partyId, commitments);
  return encodeFrostSignR1(session.partyId, commitments, session.sessionId);
}

/** Round 2: produce N signature shares using all signers' R1 commitments. */
export function round2(session: FrostSigningSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.myNonces || !session.myCommitments) throw new Error('round1 not run');
  if (session.myShares) throw new Error('round2 already run');

  const n = session.sighashes.length;
  const sortedSigners = [...session.activeSigners].sort((a, b) => a - b);
  const shares: SignatureShare[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const commitmentsForSighash: SigningCommitment[] = sortedSigners.map(id => {
      const list = session.collectedR1.get(id);
      if (!list) throw new Error(`Missing r1 commitments from party ${id}`);
      const c = list[i];
      if (!c) throw new Error(`Missing r1 commitment[${i}] from party ${id}`);
      return c;
    });
    shares[i] = signRound2(
      session.keyPackage,
      session.myNonces[i]!,
      session.sighashes[i]!.hash,
      commitmentsForSighash,
      { tweaked: session.sighashes[i]!.tweaked },
    );
  }
  session.myShares = shares;
  session.collectedR2.set(session.partyId, shares);
  return encodeFrostSignR2(session.partyId, shares, session.sessionId);
}

/** Leader-only: aggregate t shares per sighash into N BIP340 Schnorr signatures. */
export function aggregate(session: FrostSigningSession): Uint8Array[] {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.signatures) return session.signatures;

  const n = session.sighashes.length;
  const sortedSigners = [...session.activeSigners].sort((a, b) => a - b);
  const sigs: Uint8Array[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const shares: SignatureShare[] = sortedSigners.map(id => {
      const list = session.collectedR2.get(id);
      if (!list) throw new Error(`Missing r2 shares from party ${id}`);
      const s = list[i];
      if (!s) throw new Error(`Missing r2 share[${i}] from party ${id}`);
      return s;
    });
    const commitments: SigningCommitment[] = sortedSigners.map(id => {
      const list = session.collectedR1.get(id);
      if (!list) throw new Error(`Missing r1 commitments from party ${id}`);
      const c = list[i];
      if (!c) throw new Error(`Missing r1 commitment[${i}] from party ${id}`);
      return c;
    });
    sigs[i] = signAggregate(
      shares,
      session.sighashes[i]!.hash,
      commitments,
      session.publicKeyPackage,
      { tweaked: session.sighashes[i]!.tweaked },
    );
  }
  session.signatures = sigs;
  return sigs;
}

export type FrostSignRound = 1 | 2;

export function addBlob(
  session: FrostSigningSession,
  blob: string,
  expectedRound: FrostSignRound,
): { ok: true } | { ok: false; error: string } {
  if (session.destroyed) return { ok: false, error: 'session destroyed' };
  const n = session.sighashes.length;

  if (expectedRound === 1) {
    const decoded = decodeFrostSignR1(blob);
    if (!decoded) return { ok: false, error: 'invalid frost-sign-r1 blob' };
    if (decoded.partyId === session.partyId) return { ok: false, error: 'cannot add own blob' };
    if (!session.activeSigners.includes(decoded.partyId)) {
      return { ok: false, error: `party ${decoded.partyId} not in active signer set` };
    }
    if (decoded.commitments.length !== n) {
      return { ok: false, error: `expected ${n} commitments, got ${decoded.commitments.length}` };
    }
    if (session.collectedR1.has(decoded.partyId)) {
      return { ok: false, error: `already have r1 from party ${decoded.partyId}` };
    }
    session.collectedR1.set(decoded.partyId, decoded.commitments);
    return { ok: true };
  }

  // expectedRound === 2
  const decoded = decodeFrostSignR2(blob);
  if (!decoded) return { ok: false, error: 'invalid frost-sign-r2 blob' };
  if (decoded.partyId === session.partyId) return { ok: false, error: 'cannot add own blob' };
  if (!session.activeSigners.includes(decoded.partyId)) {
    return { ok: false, error: `party ${decoded.partyId} not in active signer set` };
  }
  if (decoded.shares.length !== n) {
    return { ok: false, error: `expected ${n} shares, got ${decoded.shares.length}` };
  }
  if (session.collectedR2.has(decoded.partyId)) {
    return { ok: false, error: `already have r2 from party ${decoded.partyId}` };
  }
  session.collectedR2.set(decoded.partyId, decoded.shares);
  return { ok: true };
}

export function destroySession(session: FrostSigningSession): void {
  session.destroyed = true;
  session.myNonces = null;
  session.myCommitments = null;
  session.myShares = null;
  session.collectedR1.clear();
  session.collectedR2.clear();
}
