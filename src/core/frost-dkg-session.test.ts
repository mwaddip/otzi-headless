import { beforeEach, describe, expect, it } from 'vitest';
import { dkgRound1 } from '@mwaddip/frots';
import { decodeEnvelope, encodeFrostRound1 } from '../otzi/lib/dkg';
import { rng } from '../otzi/lib/dkg.fixture';
import { toHex } from '../otzi/lib/hex';
import {
  addBlob,
  createSession,
  destroySession,
  finalize,
  round1,
  round2,
  round2ForTarget,
  type FrostDkgSession,
} from './frost-dkg-session';

const THRESHOLD = 2;
const PARTIES = 3;
const sessionId = crypto.getRandomValues(new Uint8Array(32));

describe('frost-dkg-session', () => {
  let dkgSessions: FrostDkgSession[];

  beforeEach(() => {
    dkgSessions = Array.from({ length: PARTIES }, (_, partyId) =>
      createSession({ partyId, sessionId, threshold: THRESHOLD, parties: PARTIES, rng }),
    );
  });

  /** Every session pulls round 1 from every other party. */
  function exchangeR1(): string[] {
    const blobs = dkgSessions.map(round1);
    for (const s of dkgSessions) {
      for (let from = 0; from < PARTIES; from++) {
        if (from === s.partyId) continue;
        expect(addBlob(s, blobs[from]!, 'r1', from)).toEqual({ ok: true });
      }
    }
    return blobs;
  }

  it('tags blobs with the given session id', () => {
    expect(decodeEnvelope(round1(dkgSessions[0]!))!.sid).toBe(toHex(sessionId).slice(0, 16));
  });

  it('rejects a session id that is not 32 bytes', () => {
    expect(() =>
      createSession({ partyId: 0, sessionId: new Uint8Array(16), threshold: 2, parties: 3, rng }),
    ).toThrow(/sessionId must be 32 bytes/);
  });

  it('runs a full DKG when every blob is bound to its sender', () => {
    exchangeR1();
    for (const s of dkgSessions) round2(s);
    for (const s of dkgSessions) {
      for (let from = 0; from < PARTIES; from++) {
        if (from === s.partyId) continue;
        const blob = round2ForTarget(dkgSessions[from]!, s.partyId)!;
        expect(addBlob(s, blob, 'r2', from)).toEqual({ ok: true });
      }
    }
    const results = dkgSessions.map(finalize);
    const key = toHex(results[0]!.publicKeyPackage.verifyingKey);
    for (const r of results) expect(toHex(r.publicKeyPackage.verifyingKey)).toBe(key);
  });

  describe('round 1', () => {
    it('rejects a round-1 package with the wrong number of commitments', () => {
      const { package: pkg } = dkgRound1(2n, 3, 3, rng); // session threshold is 2
      expect(addBlob(dkgSessions[0]!, encodeFrostRound1(pkg, sessionId), 'r1', 1)).toEqual({
        ok: false,
        error: expect.stringMatching(/expected 2 commitments, got 3/),
      });
      expect(dkgSessions[0]!.collectedR1.has(1)).toBe(false);
    });

    it('rejects a round-1 package from a party other than the sender', () => {
      const blob = round1(dkgSessions[1]!);
      expect(addBlob(dkgSessions[0]!, blob, 'r1', 2)).toEqual({
        ok: false,
        error: expect.stringMatching(/claims party 1/),
      });
      expect(dkgSessions[0]!.collectedR1.has(2)).toBe(false);
      expect(dkgSessions[0]!.collectedR1.has(1)).toBe(false);
    });

    it('rejects a blob from this node, from out of range and one that does not decode', () => {
      const blob = round1(dkgSessions[1]!);
      expect(addBlob(dkgSessions[1]!, blob, 'r1', 1).ok).toBe(false);
      expect(addBlob(dkgSessions[0]!, blob, 'r1', PARTIES).ok).toBe(false);
      expect(addBlob(dkgSessions[0]!, 'not a blob', 'r1', 1)).toEqual({
        ok: false,
        error: expect.stringContaining('party 1'),
      });
    });

    it('rejects a second package from the same sender', () => {
      const blob = round1(dkgSessions[1]!);
      expect(addBlob(dkgSessions[0]!, blob, 'r1', 1)).toEqual({ ok: true });
      expect(addBlob(dkgSessions[0]!, blob, 'r1', 1).ok).toBe(false);
    });

    it('rejects blobs on a destroyed session', () => {
      const blob = round1(dkgSessions[1]!);
      destroySession(dkgSessions[0]!);
      expect(addBlob(dkgSessions[0]!, blob, 'r1', 1)).toEqual({ ok: false, error: 'session destroyed' });
    });
  });

  describe('round 2', () => {
    beforeEach(() => {
      exchangeR1();
      for (const s of dkgSessions) round2(s);
    });

    it('rejects a round-2 package from a party other than the sender', () => {
      const blob = round2ForTarget(dkgSessions[1]!, 0)!;
      expect(addBlob(dkgSessions[0]!, blob, 'r2', 2)).toEqual({
        ok: false,
        error: expect.stringMatching(/claims party 1/),
      });
      expect(dkgSessions[0]!.collectedR2.size).toBe(0);
    });

    it('rejects a round-2 package addressed to another party', () => {
      const blobFor0 = round2ForTarget(dkgSessions[1]!, 0)!;
      expect(addBlob(dkgSessions[2]!, blobFor0, 'r2', 1).ok).toBe(false);
      expect(dkgSessions[2]!.collectedR2.size).toBe(0);
    });

    it('rejects a round-2 package whose recipient differs from the envelope', () => {
      // sender = 1, recipient = 2 inside the payload, envelope claims to = 0: the codec refuses it.
      const blob = round2ForTarget(dkgSessions[1]!, 2)!;
      const env = decodeEnvelope(blob)!;
      const forged = btoa(JSON.stringify({ ...env, to: 0 }));
      expect(addBlob(dkgSessions[0]!, forged, 'r2', 1).ok).toBe(false);
    });

    it('rejects a blob from this node, from out of range and a second package from the same sender', () => {
      const blob = round2ForTarget(dkgSessions[1]!, 0)!;
      expect(addBlob(dkgSessions[1]!, blob, 'r2', 1).ok).toBe(false);
      expect(addBlob(dkgSessions[0]!, blob, 'r2', PARTIES).ok).toBe(false);
      expect(addBlob(dkgSessions[0]!, blob, 'r2', 1)).toEqual({ ok: true });
      expect(addBlob(dkgSessions[0]!, blob, 'r2', 1).ok).toBe(false);
    });
  });
});
