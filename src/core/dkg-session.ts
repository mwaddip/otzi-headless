/**
 * ML-DSA DKG session wrapper around `ThresholdMLDSA` from
 * `@btc-vision/post-quantum`. Symmetric protocol: every party runs the full
 * sequence (Phase 1 → 2 → 2-finalize → 3 → 4 → finalize) and ends with its
 * own unique `ThresholdKeyShare` plus the common aggregate public key.
 *
 * Blob mix per phase (BlobKey.round / targeting):
 *   - p1:     broadcast (1 blob per party)
 *   - p2-pub: broadcast
 *   - p2-priv: targeted — holder-mates only (parties sharing ≥1 bitmask)
 *   - p3:     targeted — every other party
 *   - p4:     broadcast
 *
 * No retries, no leader. If any party rejects a received blob or drops,
 * DKG aborts for all (threshold = N).
 */

import {
  ThresholdMLDSA,
  type DKGSetupResult,
  type DKGPhase1Broadcast,
  type DKGPhase1State,
  type DKGPhase2Broadcast,
  type DKGPhase2Private,
  type DKGPhase2FinalizeResult,
  type DKGPhase3Private,
  type DKGPhase4Broadcast,
  type DKGResult,
} from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import {
  encodePhase1Broadcast,
  decodePhase1Broadcast,
  encodePhase2Broadcast,
  decodePhase2Broadcast,
  encodePhase2Private,
  decodePhase2Private,
  encodePhase3Private,
  decodePhase3Private,
  encodePhase4Broadcast,
  decodePhase4Broadcast,
} from '../wire/dkg';
import type { PartyId } from './types';

export interface MldsaDkgSession {
  readonly partyId: PartyId;
  readonly sessionId: Uint8Array; // 32 bytes
  readonly threshold: number;
  readonly parties: number;
  readonly level: number;
  readonly instance: ThresholdMLDSA;
  readonly setup: DKGSetupResult;

  phase1State: DKGPhase1State | null;
  myPhase1Broadcast: DKGPhase1Broadcast | null;
  collectedPhase1: Map<PartyId, DKGPhase1Broadcast>;

  myPhase2Broadcast: DKGPhase2Broadcast | null;
  myPhase2PrivateToHolders: Map<PartyId, DKGPhase2Private> | null;
  collectedPhase2Pub: Map<PartyId, DKGPhase2Broadcast>;
  collectedPhase2Priv: Map<PartyId, DKGPhase2Private>; // keyed by sender

  phase2FinalResult: DKGPhase2FinalizeResult | null;
  collectedPhase3: Map<PartyId, DKGPhase3Private>; // keyed by sender

  myPhase4Broadcast: DKGPhase4Broadcast | null;
  collectedPhase4: Map<PartyId, DKGPhase4Broadcast>;

  result: DKGResult | null;
  destroyed: boolean;
}

export interface CreateMldsaDkgSessionInput {
  partyId: PartyId;
  sessionId: Uint8Array;
  threshold: number;
  parties: number;
  level: number;
}

export function createSession(input: CreateMldsaDkgSessionInput): MldsaDkgSession {
  if (input.partyId < 0 || input.partyId >= input.parties) {
    throw new Error(`partyId ${input.partyId} out of range [0, ${input.parties})`);
  }
  if (input.threshold <= 0 || input.threshold > input.parties) {
    throw new Error(`threshold ${input.threshold} invalid for parties ${input.parties}`);
  }
  if (input.sessionId.length !== 32) {
    throw new Error(`sessionId must be 32 bytes; got ${input.sessionId.length}`);
  }
  const instance = ThresholdMLDSA.create(input.level, input.threshold, input.parties);
  const setup = instance.dkgSetup(input.sessionId);
  return {
    partyId: input.partyId,
    sessionId: input.sessionId,
    threshold: input.threshold,
    parties: input.parties,
    level: input.level,
    instance,
    setup,
    phase1State: null,
    myPhase1Broadcast: null,
    collectedPhase1: new Map(),
    myPhase2Broadcast: null,
    myPhase2PrivateToHolders: null,
    collectedPhase2Pub: new Map(),
    collectedPhase2Priv: new Map(),
    phase2FinalResult: null,
    collectedPhase3: new Map(),
    myPhase4Broadcast: null,
    collectedPhase4: new Map(),
    result: null,
    destroyed: false,
  };
}

/** Phase 1: own commitment broadcast. */
export function phase1(session: MldsaDkgSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.myPhase1Broadcast) throw new Error('phase1 already run');
  const result = session.instance.dkgPhase1(session.partyId, session.sessionId);
  session.phase1State = result.state;
  session.myPhase1Broadcast = result.broadcast;
  session.collectedPhase1.set(session.partyId, result.broadcast);
  return encodePhase1Broadcast(result.broadcast, session.sessionId);
}

/** Phase 2: own public reveal broadcast. Requires all N Phase 1 broadcasts in-store. */
export function phase2(session: MldsaDkgSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.phase1State) throw new Error('phase1 not run');
  if (session.myPhase2Broadcast) throw new Error('phase2 already run');
  if (session.collectedPhase1.size !== session.parties) {
    throw new Error(
      `phase2 needs ${session.parties} phase1 broadcasts; have ${session.collectedPhase1.size}`,
    );
  }
  const sortedP1: DKGPhase1Broadcast[] = [];
  for (let i = 0; i < session.parties; i++) {
    const b = session.collectedPhase1.get(i);
    if (!b) throw new Error(`missing phase1 broadcast from party ${i}`);
    sortedP1.push(b);
  }
  const result = session.instance.dkgPhase2(
    session.partyId,
    session.sessionId,
    session.phase1State,
    sortedP1,
  );
  session.myPhase2Broadcast = result.broadcast;
  session.myPhase2PrivateToHolders = new Map(result.privateToHolders);
  session.collectedPhase2Pub.set(session.partyId, result.broadcast);
  return encodePhase2Broadcast(result.broadcast, session.sessionId);
}

/** Encoded Phase 2 private reveal for `toPartyId`, or null if `toPartyId` isn't a holder-mate. */
export function phase2PrivateForTarget(session: MldsaDkgSession, toPartyId: PartyId): string | null {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.myPhase2PrivateToHolders) throw new Error('phase2 not run');
  const priv = session.myPhase2PrivateToHolders.get(toPartyId);
  if (!priv) return null;
  return encodePhase2Private(priv, toPartyId, session.sessionId);
}

/** Recipients for my Phase 2 private reveals (holder-mates, excluding self). */
export function phase2Recipients(session: MldsaDkgSession): PartyId[] {
  if (!session.myPhase2PrivateToHolders) throw new Error('phase2 not run');
  return Array.from(session.myPhase2PrivateToHolders.keys())
    .filter(id => id !== session.partyId)
    .sort((a, b) => a - b);
}

/**
 * Parties I expect Phase 2 private reveals FROM.
 *
 * Symmetric: j sends me a reveal iff j and I share ≥1 bitmask, computable
 * from `dkgSetup`'s `holdersOf` without pulling any blobs.
 */
export function phase2ExpectedSenders(session: MldsaDkgSession): PartyId[] {
  const myBitmasks: number[] = [];
  for (const [bitmask, holders] of session.setup.holdersOf) {
    if (holders.includes(session.partyId)) myBitmasks.push(bitmask);
  }
  const senders = new Set<PartyId>();
  for (const bitmask of myBitmasks) {
    const holders = session.setup.holdersOf.get(bitmask);
    if (!holders) continue;
    for (const h of holders) {
      if (h !== session.partyId) senders.add(h);
    }
  }
  return Array.from(senders).sort((a, b) => a - b);
}

/** Run dkgPhase2Finalize locally; after this, Phase 3 targeted blobs are producible. */
export function phase2Finalize(session: MldsaDkgSession): void {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.phase1State) throw new Error('phase1 not run');
  if (session.phase2FinalResult) throw new Error('phase2Finalize already run');
  if (session.collectedPhase2Pub.size !== session.parties) {
    throw new Error(
      `phase2Finalize needs ${session.parties} phase2-pub; have ${session.collectedPhase2Pub.size}`,
    );
  }
  const sortedP1: DKGPhase1Broadcast[] = [];
  const sortedP2Pub: DKGPhase2Broadcast[] = [];
  for (let i = 0; i < session.parties; i++) {
    const p1 = session.collectedPhase1.get(i);
    const p2 = session.collectedPhase2Pub.get(i);
    if (!p1) throw new Error(`missing phase1 broadcast from party ${i}`);
    if (!p2) throw new Error(`missing phase2-pub from party ${i}`);
    sortedP1.push(p1);
    sortedP2Pub.push(p2);
  }
  const receivedReveals: DKGPhase2Private[] = Array.from(session.collectedPhase2Priv.values());
  session.phase2FinalResult = session.instance.dkgPhase2Finalize(
    session.partyId,
    session.sessionId,
    session.phase1State,
    sortedP1,
    sortedP2Pub,
    receivedReveals,
  );
}

/** Encoded Phase 3 private blob for `toPartyId`, or null if none assigned. */
export function phase3PrivateForTarget(session: MldsaDkgSession, toPartyId: PartyId): string | null {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.phase2FinalResult) throw new Error('phase2Finalize not run');
  const priv = session.phase2FinalResult.privateToAll.get(toPartyId);
  if (!priv) return null;
  return encodePhase3Private(priv, toPartyId, session.sessionId);
}

export function phase3Recipients(session: MldsaDkgSession): PartyId[] {
  if (!session.phase2FinalResult) throw new Error('phase2Finalize not run');
  return Array.from(session.phase2FinalResult.privateToAll.keys())
    .filter(id => id !== session.partyId)
    .sort((a, b) => a - b);
}

/**
 * Parties I expect Phase 3 private masks FROM: every distinct generator other
 * than self, matching Ötzi's `getExpectedPhase3PrivCount` convention. The
 * Phase 4 library call looks up `receivedMasks` by generator id and errors
 * if any expected generator is missing, so we must pull from every one.
 */
export function phase3ExpectedSenders(session: MldsaDkgSession): PartyId[] {
  if (!session.phase2FinalResult) throw new Error('phase2Finalize not run');
  const generators = new Set<PartyId>();
  for (const gen of session.phase2FinalResult.generatorAssignment.values()) {
    if (gen !== session.partyId) generators.add(gen);
  }
  return Array.from(generators).sort((a, b) => a - b);
}

/** Phase 4: aggregate broadcast. Requires all Phase 3 privates addressed to me. */
export function phase4(session: MldsaDkgSession): string {
  if (session.destroyed) throw new Error('session destroyed');
  if (!session.phase2FinalResult) throw new Error('phase2Finalize not run');
  if (session.myPhase4Broadcast) throw new Error('phase4 already run');
  const receivedMasks: DKGPhase3Private[] = Array.from(session.collectedPhase3.values());
  const broadcast = session.instance.dkgPhase4(
    session.partyId,
    session.setup.bitmasks,
    session.phase2FinalResult.generatorAssignment,
    receivedMasks,
    session.phase2FinalResult.ownMaskPieces,
  );
  session.myPhase4Broadcast = broadcast;
  session.collectedPhase4.set(session.partyId, broadcast);
  return encodePhase4Broadcast(broadcast, session.sessionId);
}

/** Local finalize: derive own `ThresholdKeyShare` + aggregate public key. */
export function finalize(session: MldsaDkgSession): DKGResult {
  if (session.destroyed) throw new Error('session destroyed');
  if (session.result) return session.result;
  if (!session.phase2FinalResult) throw new Error('phase2Finalize not run');
  if (session.collectedPhase4.size !== session.parties) {
    throw new Error(
      `finalize needs ${session.parties} phase4 broadcasts; have ${session.collectedPhase4.size}`,
    );
  }
  const sortedP4: DKGPhase4Broadcast[] = [];
  for (let i = 0; i < session.parties; i++) {
    const b = session.collectedPhase4.get(i);
    if (!b) throw new Error(`missing phase4 broadcast from party ${i}`);
    sortedP4.push(b);
  }
  session.result = session.instance.dkgFinalize(
    session.partyId,
    session.phase2FinalResult.rho,
    sortedP4,
    session.phase2FinalResult.shares,
  );
  return session.result;
}

export type DkgRound = 'p1' | 'p2-pub' | 'p2-priv' | 'p3' | 'p4';

export function addBlob(
  session: MldsaDkgSession,
  blob: string,
  round: DkgRound,
): { ok: true } | { ok: false; error: string } {
  if (session.destroyed) return { ok: false, error: 'session destroyed' };

  if (round === 'p1') {
    const decoded = decodePhase1Broadcast(blob);
    if (!decoded) return { ok: false, error: 'invalid p1 blob' };
    if (decoded.partyId === session.partyId) return { ok: false, error: 'cannot add own p1 blob' };
    if (decoded.partyId < 0 || decoded.partyId >= session.parties) {
      return { ok: false, error: `partyId ${decoded.partyId} out of range` };
    }
    if (session.collectedPhase1.has(decoded.partyId)) {
      return { ok: false, error: `already have p1 from party ${decoded.partyId}` };
    }
    session.collectedPhase1.set(decoded.partyId, decoded);
    return { ok: true };
  }

  if (round === 'p2-pub') {
    const decoded = decodePhase2Broadcast(blob);
    if (!decoded) return { ok: false, error: 'invalid p2-pub blob' };
    if (decoded.partyId === session.partyId) return { ok: false, error: 'cannot add own p2-pub blob' };
    if (decoded.partyId < 0 || decoded.partyId >= session.parties) {
      return { ok: false, error: `partyId ${decoded.partyId} out of range` };
    }
    if (session.collectedPhase2Pub.has(decoded.partyId)) {
      return { ok: false, error: `already have p2-pub from party ${decoded.partyId}` };
    }
    session.collectedPhase2Pub.set(decoded.partyId, decoded);
    return { ok: true };
  }

  if (round === 'p2-priv') {
    const decoded = decodePhase2Private(blob);
    if (!decoded) return { ok: false, error: 'invalid p2-priv blob' };
    if (decoded.fromPartyId === session.partyId) return { ok: false, error: 'cannot add own p2-priv blob' };
    if (decoded.fromPartyId < 0 || decoded.fromPartyId >= session.parties) {
      return { ok: false, error: `fromPartyId ${decoded.fromPartyId} out of range` };
    }
    if (session.collectedPhase2Priv.has(decoded.fromPartyId)) {
      return { ok: false, error: `already have p2-priv from party ${decoded.fromPartyId}` };
    }
    session.collectedPhase2Priv.set(decoded.fromPartyId, decoded);
    return { ok: true };
  }

  if (round === 'p3') {
    const decoded = decodePhase3Private(blob);
    if (!decoded) return { ok: false, error: 'invalid p3 blob' };
    if (decoded.fromGeneratorId === session.partyId) return { ok: false, error: 'cannot add own p3 blob' };
    if (decoded.fromGeneratorId < 0 || decoded.fromGeneratorId >= session.parties) {
      return { ok: false, error: `fromGeneratorId ${decoded.fromGeneratorId} out of range` };
    }
    if (session.collectedPhase3.has(decoded.fromGeneratorId)) {
      return { ok: false, error: `already have p3 from party ${decoded.fromGeneratorId}` };
    }
    session.collectedPhase3.set(decoded.fromGeneratorId, decoded);
    return { ok: true };
  }

  if (round === 'p4') {
    const decoded = decodePhase4Broadcast(blob);
    if (!decoded) return { ok: false, error: 'invalid p4 blob' };
    if (decoded.partyId === session.partyId) return { ok: false, error: 'cannot add own p4 blob' };
    if (decoded.partyId < 0 || decoded.partyId >= session.parties) {
      return { ok: false, error: `partyId ${decoded.partyId} out of range` };
    }
    if (session.collectedPhase4.has(decoded.partyId)) {
      return { ok: false, error: `already have p4 from party ${decoded.partyId}` };
    }
    session.collectedPhase4.set(decoded.partyId, decoded);
    return { ok: true };
  }

  return { ok: false, error: `unknown round ${round}` };
}

export function destroySession(session: MldsaDkgSession): void {
  session.destroyed = true;
  session.phase1State = null;
  session.myPhase1Broadcast = null;
  session.myPhase2Broadcast = null;
  session.myPhase2PrivateToHolders = null;
  session.phase2FinalResult = null;
  session.myPhase4Broadcast = null;
  session.result = null;
  session.collectedPhase1.clear();
  session.collectedPhase2Pub.clear();
  session.collectedPhase2Priv.clear();
  session.collectedPhase3.clear();
  session.collectedPhase4.clear();
}
