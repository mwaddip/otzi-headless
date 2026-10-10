/**
 * FROST (Schnorr) signing session wrapper around `@mwaddip/frots`.
 *
 * One ceremony signs N sighashes at once (a Bitcoin transaction has one
 * sighash per input). Each round produces/consumes a single blob per party
 * that packs all N items (codecs in `src/otzi/lib/frost-sign.ts`).
 *
 * Security rules enforced here (the Ötzi sign decoders only check envelope
 * and type):
 *   - `addBlob` binds every blob to the authenticated peer it was pulled from
 *     (`from`): the party inside the blob and every FROST identifier in it
 *     must be that peer.
 *   - Round 2 runs at most once per session; its guard is set before any
 *     computation, it uses a commitment set frozen at that moment, and the
 *     nonces are dropped as soon as it returns (or throws).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
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
} from '../otzi/lib/frost-sign';
import { partyIdToFrostId } from '../otzi/lib/dkg';

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
  readonly sessionId: Uint8Array; // 32 bytes; wire-envelope `sid` is its first 16 hex chars (tag, not a secret)

  myNonces: SigningNonces[] | null;
  myCommitments: SigningCommitment[] | null;
  collectedR1: Map<PartyId, readonly SigningCommitment[]>;

  myShares: SignatureShare[] | null;
  collectedR2: Map<PartyId, readonly SignatureShare[]>;

  /** Set before round 2 computes anything; round 2 never runs twice. */
  round2Started: boolean;

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
  /** 32 bytes, identical on every peer; tags the wire envelopes. Not a secret. */
  sessionId: Uint8Array;
}

export function createSession(input: CreateFrostSessionInput): FrostSigningSession {
  if (input.sighashes.length === 0) throw new Error('FROST session requires at least one sighash');
  if (!input.activeSigners.includes(input.partyId)) {
    throw new Error(`partyId ${input.partyId} must be in activeSigners`);
  }
  if (input.sessionId.length !== 32) {
    throw new Error(`sessionId must be 32 bytes; got ${input.sessionId.length}`);
  }
  return {
    partyId: input.partyId,
    keyPackage: input.keyPackage,
    publicKeyPackage: input.publicKeyPackage,
    sighashes: input.sighashes,
    activeSigners: input.activeSigners,
    rng: input.rng,
    sessionId: new Uint8Array(input.sessionId),
    myNonces: null,
    myCommitments: null,
    collectedR1: new Map(),
    myShares: null,
    collectedR2: new Map(),
    round2Started: false,
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

/**
 * Round 2: produce N signature shares using all signers' R1 commitments.
 *
 * Runs at most once. The guard is set before any work, the commitment sets are
 * frozen before the first `signRound2`, and the nonces are dropped on every
 * exit, so a nonce can never sign two different commitment sets.
 */
export function round2(session: FrostSigningSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.round2Started) throw new Error('round2 already run');
  if (!session.myNonces || !session.myCommitments) throw new Error('round1 not run');
  session.round2Started = true;
  const nonces = session.myNonces;

  try {
    const n = session.sighashes.length;
    const sortedSigners = [...session.activeSigners].sort((a, b) => a - b);
    const frozen = sortedSigners.map(id => {
      const list = session.collectedR1.get(id);
      if (!list) throw new Error(`Missing r1 commitments from party ${id}`);
      return { id, list: [...list] };
    });
    const shares: SignatureShare[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const commitmentsForSighash: SigningCommitment[] = frozen.map(({ id, list }) => {
        const c = list[i];
        if (!c) throw new Error(`Missing r1 commitment[${i}] from party ${id}`);
        return c;
      });
      shares[i] = signRound2(
        session.keyPackage,
        nonces[i]!,
        session.sighashes[i]!.hash,
        commitmentsForSighash,
        { tweaked: session.sighashes[i]!.tweaked },
      );
    }
    session.myShares = shares;
    session.collectedR2.set(session.partyId, shares);
    return encodeFrostSignR2(session.partyId, shares, session.sessionId);
  } finally {
    session.myNonces = null;
  }
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
    try {
      sigs[i] = signAggregate(
        shares,
        session.sighashes[i]!.hash,
        commitments,
        session.publicKeyPackage,
        { tweaked: session.sighashes[i]!.tweaked },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`signature aggregation for input ${i} failed: ${namePartiesInFrostMessage(reason)}`, {
        cause: err,
      });
    }
  }
  session.signatures = sigs;
  return sigs;
}

/**
 * frots names signers by FROST identifier (`party + 1`); every other message
 * names parties. `signer(s): 2, 3` → `party(ies) 1, 2`; `signer 3` → `party 2`.
 */
function namePartiesInFrostMessage(message: string): string {
  const party = (id: string) => String(Number(id) - 1);
  return message
    .replace(/signer\(s\): (\d+(?:, \d+)*)/g, (_m, ids: string) => `party(ies) ${ids.split(', ').map(party).join(', ')}`)
    .replace(/signer (\d+)/g, (_m, id: string) => `party ${party(id)}`);
}

export type FrostSignRound = 1 | 2;

type AddBlobResult = { ok: true } | { ok: false; error: string };

/** True for a 33-byte compressed secp256k1 point that lies on the curve. */
function isCompressedPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 33) return false;
  try {
    secp256k1.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The sign decoders can throw on a truncated payload; a malformed blob is a rejection, never a throw. */
function tryDecode<T>(decode: (blob: string) => T | null, blob: string): T | null {
  try {
    return decode(blob);
  } catch {
    return null;
  }
}

/**
 * Store a pulled blob. `from` is the authenticated peer the blob was pulled
 * from. The party inside the blob and every FROST identifier in it must be
 * `from` (identifier `from + 1`), so a peer cannot contribute commitments or
 * shares in another party's name.
 */
export function addBlob(
  session: FrostSigningSession,
  blob: string,
  expectedRound: FrostSignRound,
  from: PartyId,
): AddBlobResult {
  if (session.destroyed) return { ok: false, error: 'session destroyed' };
  if (from === session.partyId) {
    return { ok: false, error: `r${expectedRound} blob from party ${from}: cannot add own blob` };
  }
  if (!session.activeSigners.includes(from)) {
    return { ok: false, error: `party ${from} not in active signer set` };
  }
  const n = session.sighashes.length;
  const expectedId = Number(partyIdToFrostId(from));

  if (expectedRound === 1) {
    if (session.round2Started) {
      return { ok: false, error: `r1 blob from party ${from} after round 2 started` };
    }
    const decoded = tryDecode(decodeFrostSignR1, blob);
    if (!decoded) return { ok: false, error: `invalid frost-sign-r1 blob from party ${from}` };
    if (decoded.partyId !== from) {
      return { ok: false, error: `r1 blob from party ${from} claims party ${decoded.partyId}` };
    }
    if (decoded.commitments.length !== n) {
      return { ok: false, error: `expected ${n} commitments, got ${decoded.commitments.length}` };
    }
    const wrong = decoded.commitments.find(c => c.identifier !== expectedId);
    if (wrong) {
      return {
        ok: false,
        error: `r1 blob from party ${from} claims party ${wrong.identifier - 1} (identifier ${wrong.identifier}, expected ${expectedId})`,
      };
    }
    if (session.collectedR1.has(from)) {
      return { ok: false, error: `already have r1 from party ${from}` };
    }
    // The decoder does not check lengths; a truncated or off-curve point would
    // otherwise only fail later, anonymously, inside round 2.
    if (!decoded.commitments.every(c => isCompressedPoint(c.hiding) && isCompressedPoint(c.binding))) {
      return { ok: false, error: `r1 blob from party ${from} carries an invalid commitment point` };
    }
    session.collectedR1.set(from, decoded.commitments);
    return { ok: true };
  }

  const decoded = tryDecode(decodeFrostSignR2, blob);
  if (!decoded) return { ok: false, error: `invalid frost-sign-r2 blob from party ${from}` };
  if (decoded.partyId !== from) {
    return { ok: false, error: `r2 blob from party ${from} claims party ${decoded.partyId}` };
  }
  if (decoded.shares.length !== n) {
    return { ok: false, error: `expected ${n} shares, got ${decoded.shares.length}` };
  }
  const wrong = decoded.shares.find(s => s.identifier !== expectedId);
  if (wrong) {
    return {
      ok: false,
      error: `r2 blob from party ${from} claims party ${wrong.identifier - 1} (identifier ${wrong.identifier}, expected ${expectedId})`,
    };
  }
  if (session.collectedR2.has(from)) {
    return { ok: false, error: `already have r2 from party ${from}` };
  }
  session.collectedR2.set(from, decoded.shares);
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
