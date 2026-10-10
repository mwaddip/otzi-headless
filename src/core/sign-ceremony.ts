/**
 * The proposal signing protocol, leader and participant halves
 * (facts/core.md, `sign-ceremony.ts`; spec §5.4 leader steps 4–6).
 *
 * Signing is leader-driven. The leader announces the proposal, then both
 * roles run FROST round 1 over `sign-r1` blobs and round 2 over `sign-r2`
 * blobs, pulled from the other signers only:
 *
 *   - the leader pulls `sign-r1` and `sign-r2`, aggregates with the full
 *     `publicKeyPackage` (so frots names a cheating signer) and checks every
 *     signature against the vault key;
 *   - a participant pulls `sign-r1`, produces `sign-r2` and stops: it pulls no
 *     `sign-r2` and never aggregates.
 *
 * Analysis, the gate, finalizing and the signoff belong to the callers
 * (`Orchestrator`, `LeaderDispatcher`). The envelope sid is `sighashes[0]`.
 */

import { verifySignature, type KeyPackage, type PublicKeyPackage, type Rng } from '@mwaddip/frots';
import type { SendProposal } from '../otzi/lib/vault-types';
import type { CeremonyIo } from './ceremony-io';
import * as signSession from './frost-sign-session';
import { encodeMessage, MAX_INPUTS } from './messages';
import type { BlobKey, PartyId } from './types';

export const SIGN_ROUNDS = { r1: 'sign-r1', r2: 'sign-r2' } as const;

export interface SignCeremonySpec {
  ceremonyId: string;
  /** The parties that sign, this node included. */
  signers: readonly PartyId[];
  /** One 32-byte sighash per input, as this node computed them. */
  sighashes: readonly Uint8Array[];
  keyPackage: KeyPackage;
  publicKeyPackage: PublicKeyPackage;
  rng: Rng;
}

const SIGHASH_LENGTH = 32;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Leader: announce, run both rounds, aggregate and verify. Broadcasts no signoff. */
export async function leadSigning(
  io: CeremonyIo,
  spec: SignCeremonySpec,
  proposal: SendProposal,
): Promise<Uint8Array[]> {
  const ceremony = open(io, spec);
  const { session } = ceremony;
  try {
    await io.transport.broadcast(
      encodeMessage({
        v: 2,
        kind: 'announce-sign',
        ceremonyId: spec.ceremonyId,
        signers: [...spec.signers],
        proposal,
      }),
    );

    ceremony.put(SIGN_ROUNDS.r1, signSession.round1(session));
    await ceremony.pullAndAdd(SIGN_ROUNDS.r1, 1);
    ceremony.put(SIGN_ROUNDS.r2, signSession.round2(session));
    await ceremony.pullAndAdd(SIGN_ROUNDS.r2, 2);

    const sigs = signSession.aggregate(session);
    const { verifyingKey } = spec.publicKeyPackage;
    sigs.forEach((sig, i) => {
      if (!verifySignature(sig, spec.sighashes[i]!, verifyingKey)) {
        throw new Error(`signature for input ${i} does not verify`);
      }
    });
    return sigs;
  } finally {
    signSession.destroySession(session);
  }
}

/** Participant: round 1 with every co-signer, then produce `sign-r2` and stop. */
export async function participateInSigning(
  io: CeremonyIo,
  spec: SignCeremonySpec,
  signal?: AbortSignal,
): Promise<void> {
  const ceremony = open(io, spec, signal);
  const { session } = ceremony;
  try {
    throwIfAborted(signal);
    ceremony.put(SIGN_ROUNDS.r1, signSession.round1(session));
    await ceremony.pullAndAdd(SIGN_ROUNDS.r1, 1);

    throwIfAborted(signal);
    ceremony.put(SIGN_ROUNDS.r2, signSession.round2(session));
  } finally {
    signSession.destroySession(session);
  }
}

/** Validate the inputs and create this node's signing session. */
function open(io: CeremonyIo, spec: SignCeremonySpec, signal?: AbortSignal) {
  const me = io.transport.partyId;
  const { ceremonyId, signers, sighashes, publicKeyPackage } = spec;

  if (sighashes.length < 1 || sighashes.length > MAX_INPUTS) {
    throw new Error(`sighashes must have 1 to ${MAX_INPUTS} entries, got ${sighashes.length}`);
  }
  sighashes.forEach((h, i) => {
    if (h.length !== SIGHASH_LENGTH) throw new Error(`sighash ${i} is ${h.length} bytes, expected ${SIGHASH_LENGTH}`);
  });
  if (signers.length === 0) throw new Error('signers must not be empty');
  if (new Set(signers).size !== signers.length) throw new Error('signers must be unique');
  if (!signers.includes(me)) throw new Error(`party ${me} is not in signers`);
  const stranger = signers.find(p => !io.transport.peers.includes(p));
  if (stranger !== undefined) throw new Error(`signer ${stranger} is not in the ring`);
  if (signers.length < publicKeyPackage.minSigners) {
    throw new Error(`signers needs at least ${publicKeyPackage.minSigners} entries, got ${signers.length}`);
  }

  const session = signSession.createSession({
    partyId: me,
    keyPackage: spec.keyPackage,
    publicKeyPackage,
    sighashes: sighashes.map(hash => ({ hash, tweaked: true })),
    activeSigners: signers,
    rng: spec.rng,
    sessionId: sighashes[0]!,
  });
  const others = signers.filter(p => p !== me);

  const put = (round: string, blob: string) => io.store.put({ ceremonyId, round, from: me }, utf8.encode(blob));

  /** Pull `round` from every other signer and hand each blob, as text, to the session with its authenticated producer. */
  const pullAndAdd = async (round: string, expectedRound: signSession.FrostSignRound) => {
    const keys: BlobKey[] = others.map(from => ({ ceremonyId, round, from }));
    await io.puller.pullAll(keys, io.pullOpts, signal);
    for (const key of keys) {
      const bytes = io.store.get(key);
      if (!bytes) throw new Error(`Missing ${key.round} blob from party ${key.from}`);
      const result = signSession.addBlob(session, fromUtf8.decode(bytes), expectedRound, key.from);
      if (!result.ok) throw new Error(`Rejected ${key.round} blob from party ${key.from}: ${result.error}`);
    }
  };

  return { session, put, pullAndAdd };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('aborted');
}
