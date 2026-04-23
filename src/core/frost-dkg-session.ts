/**
 * FROST DKG session wrapper around `@mwaddip/frots`.
 *
 * Three-step symmetric protocol:
 *   Round 1: broadcast commitment + proof of knowledge (1 blob per party).
 *   Round 2: targeted signing shares (N-1 blobs per party, one per other party).
 *   Finalize (local): VSS-verify received shares, derive own `KeyPackage`
 *     and group `PublicKeyPackage` (with BIP341 post-DKG tap tweak applied).
 *
 * Party identifiers: the daemon uses 0-indexed `PartyId`; FROST uses
 * 1-indexed `bigint`. Conversion lives in `src/wire/dkg.ts`
 * (`partyIdToFrostId` / `frostIdToPartyId`).
 */

import {
  dkgRound1 as libDkgRound1,
  dkgRound2 as libDkgRound2,
  dkgFinalize as libDkgFinalize,
  type KeyPackage,
  type PublicKeyPackage,
  type Rng,
  type Round1SecretPackage,
  type Round1Package,
  type Round2SecretPackage,
  type Round2Package,
} from '@mwaddip/frots';
import {
  encodeFrostRound1,
  decodeFrostRound1,
  encodeFrostRound2,
  decodeFrostRound2,
  partyIdToFrostId,
  frostIdToPartyId,
} from '../wire/dkg';
import type { PartyId } from './types';

export interface FrostDkgSession {
  readonly partyId: PartyId;
  readonly sessionId: Uint8Array;
  readonly threshold: number;
  readonly parties: number;
  readonly rng: Rng;

  r1Secret: Round1SecretPackage | null;
  myR1Package: Round1Package | null;
  collectedR1: Map<PartyId, Round1Package>;

  r2Secret: Round2SecretPackage | null;
  myR2PackagesByRecipient: Map<PartyId, Round2Package> | null;
  collectedR2: Map<PartyId, Round2Package>; // keyed by sender

  result: { keyPackage: KeyPackage; publicKeyPackage: PublicKeyPackage } | null;
  destroyed: boolean;
}

export interface CreateFrostDkgSessionInput {
  partyId: PartyId;
  sessionId: Uint8Array;
  threshold: number;
  parties: number;
  rng: Rng;
}

export function createSession(input: CreateFrostDkgSessionInput): FrostDkgSession {
  if (input.partyId < 0 || input.partyId >= input.parties) {
    throw new Error(`partyId ${input.partyId} out of range [0, ${input.parties})`);
  }
  if (input.threshold <= 0 || input.threshold > input.parties) {
    throw new Error(`threshold ${input.threshold} invalid for parties ${input.parties}`);
  }
  if (input.sessionId.length !== 32) {
    throw new Error(`sessionId must be 32 bytes; got ${input.sessionId.length}`);
  }
  return {
    partyId: input.partyId,
    sessionId: input.sessionId,
    threshold: input.threshold,
    parties: input.parties,
    rng: input.rng,
    r1Secret: null,
    myR1Package: null,
    collectedR1: new Map(),
    r2Secret: null,
    myR2PackagesByRecipient: null,
    collectedR2: new Map(),
    result: null,
    destroyed: false,
  };
}

/** Round 1: own polynomial commitments + proof of knowledge, broadcast. */
export function round1(session: FrostDkgSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.myR1Package) throw new Error('round1 already run');
  const identifier = partyIdToFrostId(session.partyId);
  const out = libDkgRound1(identifier, session.parties, session.threshold, session.rng);
  session.r1Secret = out.secretPackage;
  session.myR1Package = out.package;
  session.collectedR1.set(session.partyId, out.package);
  return encodeFrostRound1(out.package, session.sessionId);
}

/**
 * Round 2 (local): verify received R1 proofs, compute per-recipient signing
 * shares. The targeted blobs are emitted by `round2ForTarget`.
 */
export function round2(session: FrostDkgSession): void {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.r1Secret) throw new Error('round1 not run');
  if (session.r2Secret) throw new Error('round2 already run');
  if (session.collectedR1.size !== session.parties) {
    throw new Error(`round2 needs ${session.parties} R1 packages; have ${session.collectedR1.size}`);
  }

  const received = new Map<bigint, Round1Package>();
  for (const [partyId, pkg] of session.collectedR1) {
    if (partyId === session.partyId) continue;
    received.set(partyIdToFrostId(partyId), pkg);
  }
  const out = libDkgRound2(session.r1Secret, received);
  session.r2Secret = out.secretPackage;

  const byRecipient = new Map<PartyId, Round2Package>();
  for (const [frostId, pkg] of out.packages) {
    byRecipient.set(frostIdToPartyId(frostId), pkg);
  }
  session.myR2PackagesByRecipient = byRecipient;
}

/** Encoded R2 blob for `toPartyId`, or null if the library produced none (self or undeliverable). */
export function round2ForTarget(session: FrostDkgSession, toPartyId: PartyId): string | null {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.myR2PackagesByRecipient) throw new Error('round2 not run');
  const pkg = session.myR2PackagesByRecipient.get(toPartyId);
  if (!pkg) return null;
  return encodeFrostRound2(pkg, session.sessionId);
}

/** Recipients for my R2 targeted blobs (every other party). */
export function round2Recipients(session: FrostDkgSession): PartyId[] {
  if (!session.myR2PackagesByRecipient) throw new Error('round2 not run');
  return Array.from(session.myR2PackagesByRecipient.keys())
    .filter(id => id !== session.partyId)
    .sort((a, b) => a - b);
}

/** Finalize: VSS-verify received shares, derive own KeyPackage + group PublicKeyPackage. */
export function finalize(session: FrostDkgSession): {
  keyPackage: KeyPackage;
  publicKeyPackage: PublicKeyPackage;
} {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.result) return session.result;
  if (!session.r2Secret) throw new Error('round2 not run');
  if (session.collectedR2.size !== session.parties - 1) {
    throw new Error(
      `finalize needs ${session.parties - 1} R2 packages; have ${session.collectedR2.size}`,
    );
  }

  const receivedR1 = new Map<bigint, Round1Package>();
  for (const [partyId, pkg] of session.collectedR1) {
    if (partyId === session.partyId) continue;
    receivedR1.set(partyIdToFrostId(partyId), pkg);
  }
  const receivedR2 = new Map<bigint, Round2Package>();
  for (const [senderPartyId, pkg] of session.collectedR2) {
    receivedR2.set(partyIdToFrostId(senderPartyId), pkg);
  }

  session.result = libDkgFinalize(session.r2Secret, receivedR1, receivedR2);
  return session.result;
}

export type FrostDkgRound = 'r1' | 'r2';

export function addBlob(
  session: FrostDkgSession,
  blob: string,
  round: FrostDkgRound,
): { ok: true } | { ok: false; error: string } {
  if (session.destroyed) return { ok: false, error: 'session destroyed' };

  if (round === 'r1') {
    const decoded = decodeFrostRound1(blob);
    if (!decoded) return { ok: false, error: 'invalid frost-dkg-r1 blob' };
    const senderPartyId = frostIdToPartyId(decoded.identifier);
    if (senderPartyId === session.partyId) return { ok: false, error: 'cannot add own r1 blob' };
    if (senderPartyId < 0 || senderPartyId >= session.parties) {
      return { ok: false, error: `partyId ${senderPartyId} out of range` };
    }
    if (session.collectedR1.has(senderPartyId)) {
      return { ok: false, error: `already have r1 from party ${senderPartyId}` };
    }
    session.collectedR1.set(senderPartyId, decoded);
    return { ok: true };
  }

  // r2
  const decoded = decodeFrostRound2(blob);
  if (!decoded) return { ok: false, error: 'invalid frost-dkg-r2 blob' };
  const senderPartyId = frostIdToPartyId(decoded.sender);
  const recipientPartyId = frostIdToPartyId(decoded.recipient);
  if (senderPartyId === session.partyId) return { ok: false, error: 'cannot add own r2 blob' };
  if (recipientPartyId !== session.partyId) {
    return { ok: false, error: `r2 blob is addressed to party ${recipientPartyId}, not ${session.partyId}` };
  }
  if (senderPartyId < 0 || senderPartyId >= session.parties) {
    return { ok: false, error: `sender partyId ${senderPartyId} out of range` };
  }
  if (session.collectedR2.has(senderPartyId)) {
    return { ok: false, error: `already have r2 from party ${senderPartyId}` };
  }
  session.collectedR2.set(senderPartyId, decoded);
  return { ok: true };
}

export function destroySession(session: FrostDkgSession): void {
  session.destroyed = true;
  session.r1Secret = null;
  session.myR1Package = null;
  session.r2Secret = null;
  session.myR2PackagesByRecipient = null;
  session.result = null;
  session.collectedR1.clear();
  session.collectedR2.clear();
}
