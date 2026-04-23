/**
 * Threshold ML-DSA signing protocol.
 *
 * Wraps ThresholdMLDSA from @btc-vision/post-quantum with a blob-exchange
 * layer for copy-paste coordination between parties.
 *
 * Flow: round1() → round2() → round3() → combine()
 * All blobs are broadcast (no private messages).
 */

import {
  ThresholdMLDSA,
  type Round1State,
  type Round2State,
  type ThresholdKeyShare,
} from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { DecryptedShare } from './share-crypto';
import { toHex, fromHex } from './hex';

// ---------------------------------------------------------------------------
// Blob envelope
// ---------------------------------------------------------------------------

interface SigningBlob {
  v: 1;
  round: number;
  partyId: number;
  msgPrefix: string;  // first 16 hex chars of message (for validation)
  data: string;       // hex-encoded payload
}

function encodeBlob(round: number, partyId: number, msgPrefix: string, data: Uint8Array): string {
  const blob: SigningBlob = {
    v: 1,
    round,
    partyId,
    msgPrefix,
    data: toHex(data),
  };
  return btoa(JSON.stringify(blob));
}

function decodeEnvelope(blob: string): SigningBlob | null {
  try {
    const json = JSON.parse(atob(blob.trim())) as SigningBlob;
    if (json.v !== 1 || typeof json.round !== 'number' || typeof json.partyId !== 'number') {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Signing session state held in memory. */
export interface SigningSession {
  instance: ThresholdMLDSA;
  message: Uint8Array;
  msgPrefix: string;
  share: DecryptedShare;
  activePartyIds: number[];

  // Round 1
  round1State: Round1State | null;
  myRound1Hash: Uint8Array | null;
  collectedRound1Hashes: Map<number, Uint8Array>;

  // Round 2
  round2State: Round2State | null;
  myRound2Commitment: Uint8Array | null;
  collectedRound2Commitments: Map<number, Uint8Array>;

  // Round 3
  myRound3Response: Uint8Array | null;
  collectedRound3Responses: Map<number, Uint8Array>;

  // Encoded blobs for display (stored so we don't re-encode)
  myRound1Blob: string | null;
  myRound2Blob: string | null;
  myRound3Blob: string | null;

  // Final
  signature: Uint8Array | null;
}

function getSecurityLevel(level: number): number {
  if (level === 44 || level === 128) return 44;
  if (level === 65 || level === 192) return 65;
  if (level === 87 || level === 256) return 87;
  return 44; // default
}

/**
 * Create a new signing session.
 */
export function createSession(
  message: Uint8Array,
  share: DecryptedShare,
  activePartyIds: number[],
): SigningSession {
  const secLevel = getSecurityLevel(share.level);
  const instance = ThresholdMLDSA.create(secLevel, share.threshold, share.parties);
  return {
    instance,
    message,
    msgPrefix: toHex(message).slice(0, 16),
    share,
    activePartyIds,
    round1State: null,
    myRound1Hash: null,
    collectedRound1Hashes: new Map(),
    round2State: null,
    myRound2Commitment: null,
    collectedRound2Commitments: new Map(),
    myRound3Response: null,
    collectedRound3Responses: new Map(),
    myRound1Blob: null,
    myRound2Blob: null,
    myRound3Blob: null,
    signature: null,
  };
}

/**
 * Round 1: Generate commitment hash.
 * Returns a base64 blob to share with co-signers.
 */
export function round1(session: SigningSession): string {
  const result = session.instance.round1(session.share.keyShare);
  session.round1State = result.state;
  session.myRound1Hash = result.commitmentHash;

  // Add own hash to collection
  session.collectedRound1Hashes.set(session.share.partyId, result.commitmentHash);

  const blob = encodeBlob(1, session.share.partyId, session.msgPrefix, result.commitmentHash);
  session.myRound1Blob = blob;
  return blob;
}

/**
 * Round 2: After collecting T round1 hashes, reveal commitment.
 * Returns a base64 blob to share with co-signers.
 */
export function round2(session: SigningSession): string {
  if (!session.round1State) throw new Error('round1 not completed');

  // Canonically sort party IDs — noble protocol requires consistent ordering
  const sortedPartyIds = [...session.activePartyIds].sort((a, b) => a - b);

  const orderedHashes: Uint8Array[] = sortedPartyIds.map(id => {
    const hash = session.collectedRound1Hashes.get(id);
    if (!hash) throw new Error(`Missing round1 hash from party ${id}`);
    return hash;
  });

  const result = session.instance.round2(
    session.share.keyShare,
    sortedPartyIds,
    session.message,
    orderedHashes,
    session.round1State,
  );

  session.round2State = result.state;
  session.myRound2Commitment = result.commitment;

  // Add own commitment to collection
  session.collectedRound2Commitments.set(session.share.partyId, result.commitment);

  const blob = encodeBlob(2, session.share.partyId, session.msgPrefix, result.commitment);
  session.myRound2Blob = blob;
  return blob;
}

/**
 * Round 3: After collecting T round2 commitments, compute partial response.
 * Returns a base64 blob to share with co-signers.
 */
export function round3(session: SigningSession): string {
  if (!session.round1State) throw new Error('round1 not completed');
  if (!session.round2State) throw new Error('round2 not completed');

  // Canonically sort party IDs — must match round2 ordering
  const sortedPartyIds = [...session.activePartyIds].sort((a, b) => a - b);

  const orderedCommitments: Uint8Array[] = sortedPartyIds.map(id => {
    const c = session.collectedRound2Commitments.get(id);
    if (!c) throw new Error(`Missing round2 commitment from party ${id}`);
    return c;
  });

  const response = session.instance.round3(
    session.share.keyShare,
    orderedCommitments,
    session.round1State,
    session.round2State,
  );

  session.myRound3Response = response;

  // Add own response to collection
  session.collectedRound3Responses.set(session.share.partyId, response);

  const blob = encodeBlob(3, session.share.partyId, session.msgPrefix, response);
  session.myRound3Blob = blob;
  return blob;
}

/**
 * Combine T partial responses into a standard FIPS 204 ML-DSA signature.
 * Returns the signature, or null if this attempt failed (retry from round1).
 */
export function combine(session: SigningSession): Uint8Array | null {
  // Canonically sort party IDs — must match round2/round3 ordering
  const sortedPartyIds = [...session.activePartyIds].sort((a, b) => a - b);

  const orderedCommitments: Uint8Array[] = sortedPartyIds.map(id => {
    const c = session.collectedRound2Commitments.get(id);
    if (!c) throw new Error(`Missing commitment from party ${id}`);
    return c;
  });

  const orderedResponses: Uint8Array[] = sortedPartyIds.map(id => {
    const r = session.collectedRound3Responses.get(id);
    if (!r) throw new Error(`Missing response from party ${id}`);
    return r;
  });

  const publicKey = fromHex(session.share.publicKey);

  const sig = session.instance.combine(
    publicKey,
    session.message,
    orderedCommitments,
    orderedResponses,
  );

  if (sig) {
    session.signature = sig;
  }

  return sig;
}

/**
 * Decode a signing blob received from another party.
 * Returns round and partyId for display, or null if invalid.
 */
export function decodeBlob(blob: string): { round: number; partyId: number } | null {
  const env = decodeEnvelope(blob);
  if (!env) return null;
  return { round: env.round, partyId: env.partyId };
}

/**
 * Add a received blob to the session.
 * Validates round, message prefix, and rejects duplicates/self-blobs.
 * Returns true if the blob was accepted.
 */
export function addBlob(session: SigningSession, blob: string, expectedRound?: number): { ok: boolean; error?: string } {
  const env = decodeEnvelope(blob);
  if (!env) return { ok: false, error: 'Invalid blob format' };

  if (expectedRound !== undefined && env.round !== expectedRound) {
    return { ok: false, error: `Expected round ${expectedRound} blob, got round ${env.round}` };
  }

  if (env.msgPrefix !== session.msgPrefix) {
    return { ok: false, error: 'Blob is for a different message' };
  }

  if (env.partyId === session.share.partyId) {
    return { ok: false, error: 'Cannot add your own blob' };
  }

  if (!session.activePartyIds.includes(env.partyId)) {
    return { ok: false, error: `Party ${env.partyId} is not in the active signer set` };
  }

  const data = fromHex(env.data);

  switch (env.round) {
    case 1:
      if (session.collectedRound1Hashes.has(env.partyId)) {
        return { ok: false, error: `Already have round 1 from party ${env.partyId}` };
      }
      session.collectedRound1Hashes.set(env.partyId, data);
      return { ok: true };

    case 2:
      if (session.collectedRound2Commitments.has(env.partyId)) {
        return { ok: false, error: `Already have round 2 from party ${env.partyId}` };
      }
      session.collectedRound2Commitments.set(env.partyId, data);
      return { ok: true };

    case 3:
      if (session.collectedRound3Responses.has(env.partyId)) {
        return { ok: false, error: `Already have round 3 from party ${env.partyId}` };
      }
      session.collectedRound3Responses.set(env.partyId, data);
      return { ok: true };

    default:
      return { ok: false, error: `Unknown round: ${env.round}` };
  }
}

/**
 * Destroy sensitive state. Call when done or on cancel.
 */
export function destroySession(session: SigningSession): void {
  session.round1State?.destroy();
  session.round2State?.destroy();
  session.round1State = null;
  session.round2State = null;
}

export { toHex, fromHex } from './hex';
export type { ThresholdKeyShare };
