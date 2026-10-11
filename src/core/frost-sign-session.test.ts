import { beforeEach, describe, expect, it } from 'vitest';
import { verifySignature } from '@mwaddip/frots';
import { decodeEnvelope, encodeEnvelope } from '../otzi/lib/dkg';
import { rng, runDkg } from '../otzi/lib/dkg.fixture';
import { encodeFrostSignR1, encodeFrostSignR2 } from '../otzi/lib/frost-sign';
import { fromHex, toHex } from '../otzi/lib/hex';
import {
  addBlob,
  aggregate,
  createSession,
  destroySession,
  round1,
  round2,
  type FrostSigningSession,
} from './frost-sign-session';

const N = 3;
const sid = new Uint8Array(32).fill(0x5a);

function newSessions(sighashes: Uint8Array[]): FrostSigningSession[] {
  const { keyPackages, publicKeyPackages } = runDkg(N, N);
  return keyPackages.map((keyPackage, partyId) =>
    createSession({
      partyId,
      keyPackage,
      publicKeyPackage: publicKeyPackages[partyId]!,
      sighashes: sighashes.map(hash => ({ hash, tweaked: true })),
      activeSigners: [0, 1, 2],
      rng,
      sessionId: sid,
    }),
  );
}

function randomHash(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Every session pulls r1 from both other signers. */
function exchangeR1(sessions: FrostSigningSession[], blobs: string[]): void {
  for (const s of sessions) {
    for (let from = 0; from < N; from++) {
      if (from === s.partyId) continue;
      expect(addBlob(s, blobs[from]!, 1, from)).toEqual({ ok: true });
    }
  }
}

describe('frost-sign-session', () => {
  let sessions: FrostSigningSession[];

  beforeEach(() => {
    sessions = newSessions([randomHash()]);
  });

  describe('createSession', () => {
    it('tags the envelope with the given session id', () => {
      const blob = round1(sessions[0]!);
      expect(decodeEnvelope(blob)!.sid).toBe(toHex(sid).slice(0, 16));
    });

    it('rejects a session id that is not 32 bytes', () => {
      const { keyPackages, publicKeyPackages } = runDkg(2, 2);
      expect(() =>
        createSession({
          partyId: 0,
          keyPackage: keyPackages[0]!,
          publicKeyPackage: publicKeyPackages[0]!,
          sighashes: [{ hash: randomHash(), tweaked: true }],
          activeSigners: [0, 1],
          rng,
          sessionId: new Uint8Array(31),
        }),
      ).toThrow(/sessionId must be 32 bytes/);
    });
  });

  describe('addBlob round 1', () => {
    it('rejects an r1 blob whose party differs from the sender', () => {
      const blob = round1(sessions[1]!);
      expect(addBlob(sessions[0]!, blob, 1, 2)).toEqual({
        ok: false,
        error: expect.stringMatching(/claims party 1/),
      });
      expect(sessions[0]!.collectedR1.size).toBe(0);
    });

    it('rejects commitments whose identifiers are not the sender', () => {
      const s1 = sessions[1]!;
      round1(s1);
      const forged = encodeFrostSignR1(
        1,
        s1.myCommitments!.map(c => ({ ...c, identifier: 3 })),
        sid,
      );
      expect(addBlob(sessions[0]!, forged, 1, 1).ok).toBe(false);
      expect(sessions[0]!.collectedR1.size).toBe(0);
    });

    it('rejects commitments carrying the identifier of a different party than the sender', () => {
      // Party 1 relays party 2's commitments under its own party id.
      const s2 = sessions[2]!;
      round1(s2);
      const forged = encodeFrostSignR1(1, s2.myCommitments!, sid);
      expect(addBlob(sessions[0]!, forged, 1, 1).ok).toBe(false);
    });

    it('rejects a blob from this node and from a party outside the signer set', () => {
      const blob = round1(sessions[1]!);
      expect(addBlob(sessions[1]!, blob, 1, 1).ok).toBe(false);
      expect(addBlob(sessions[0]!, blob, 1, 7).ok).toBe(false);
    });

    it('rejects a blob that does not decode', () => {
      expect(addBlob(sessions[0]!, 'not a blob', 1, 1)).toEqual({
        ok: false,
        error: expect.stringContaining('party 1'),
      });
    });

    it('rejects an r1 payload truncated inside the last point, naming the sender', () => {
      const env = decodeEnvelope(round1(sessions[1]!))!;
      const full = fromHex(env.data);
      const truncated = encodeEnvelope('frost-sign-r1', 1, -1, sid, full.slice(0, full.length - 13));
      expect(addBlob(sessions[0]!, truncated, 1, 1)).toEqual({
        ok: false,
        error: expect.stringMatching(/party 1 carries an invalid commitment point/),
      });
      expect(sessions[0]!.collectedR1.has(1)).toBe(false);
    });

    it.each(['hiding', 'binding'] as const)('rejects an r1 with a 33-byte off-curve %s point', field => {
      const s1 = sessions[1]!;
      round1(s1);
      const offCurve = new Uint8Array(33); // x = 5 has no y on secp256k1
      offCurve[0] = 0x02;
      offCurve[32] = 5;
      const forged = encodeFrostSignR1(
        1,
        s1.myCommitments!.map(c => ({ ...c, [field]: offCurve })),
        sid,
      );
      expect(addBlob(sessions[0]!, forged, 1, 1)).toEqual({
        ok: false,
        error: expect.stringMatching(/party 1 carries an invalid commitment point/),
      });
      expect(sessions[0]!.collectedR1.has(1)).toBe(false);
    });

    it('rejects the wrong entry count', () => {
      const s1 = sessions[1]!;
      round1(s1);
      const two = [...s1.myCommitments!, ...s1.myCommitments!];
      expect(addBlob(sessions[0]!, encodeFrostSignR1(1, two, sid), 1, 1)).toEqual({
        ok: false,
        error: expect.stringMatching(/expected 1 commitments, got 2/),
      });
    });

    it('rejects a second set from the same sender', () => {
      const blob = round1(sessions[1]!);
      expect(addBlob(sessions[0]!, blob, 1, 1)).toEqual({ ok: true });
      expect(addBlob(sessions[0]!, blob, 1, 1).ok).toBe(false);
    });

    it('rejects round 1 blobs once round 2 has started', () => {
      round1(sessions[0]!);
      // Round 2 cannot complete without the co-signers' commitments, but it has started.
      expect(() => round2(sessions[0]!)).toThrow();
      const late = round1(sessions[1]!);
      expect(addBlob(sessions[0]!, late, 1, 1)).toEqual({
        ok: false,
        error: expect.stringMatching(/round 2 started/),
      });
      expect(sessions[0]!.collectedR1.has(1)).toBe(false);
    });

    it('rejects blobs on a destroyed session', () => {
      const blob = round1(sessions[1]!);
      destroySession(sessions[0]!);
      expect(addBlob(sessions[0]!, blob, 1, 1)).toEqual({ ok: false, error: 'session destroyed' });
    });
  });

  describe('addBlob round 2', () => {
    function reachRound2(): string[] {
      const r1 = sessions.map(round1);
      exchangeR1(sessions, r1);
      return sessions.map(round2);
    }

    it('accepts shares from every co-signer and aggregates a valid signature', () => {
      const r2 = reachRound2();
      for (const s of sessions) {
        for (let from = 0; from < N; from++) {
          if (from === s.partyId) continue;
          expect(addBlob(s, r2[from]!, 2, from)).toEqual({ ok: true });
        }
      }
      const [sig] = aggregate(sessions[0]!);
      expect(sig!.length).toBe(64);
      expect(
        verifySignature(sig!, sessions[0]!.sighashes[0]!.hash, sessions[0]!.publicKeyPackage.verifyingKey),
      ).toBe(true);
    });

    it('rejects an r2 blob whose party differs from the sender', () => {
      const r2 = reachRound2();
      expect(addBlob(sessions[0]!, r2[1]!, 2, 2)).toEqual({
        ok: false,
        error: expect.stringMatching(/claims party 1/),
      });
    });

    it('rejects shares whose identifiers are not the sender', () => {
      reachRound2();
      const forged = encodeFrostSignR2(
        1,
        sessions[1]!.myShares!.map(s => ({ ...s, identifier: 3 })),
        sid,
      );
      expect(addBlob(sessions[0]!, forged, 2, 1).ok).toBe(false);
      expect(sessions[0]!.collectedR2.has(1)).toBe(false);
    });

    it('rejects a truncated payload without throwing', () => {
      const r2 = reachRound2();
      const env = decodeEnvelope(r2[1]!)!;
      const truncated = encodeEnvelope('frost-sign-r2', 1, -1, sid, fromHex(env.data).slice(0, 20));
      expect(addBlob(sessions[0]!, truncated, 2, 1)).toEqual({
        ok: false,
        error: expect.stringContaining('party 1'),
      });
    });

    it('rejects the wrong entry count and a second set from the same sender', () => {
      const r2 = reachRound2();
      const s1 = sessions[1]!;
      const two = encodeFrostSignR2(1, [...s1.myShares!, ...s1.myShares!], sid);
      expect(addBlob(sessions[0]!, two, 2, 1)).toEqual({
        ok: false,
        error: expect.stringMatching(/expected 1 shares, got 2/),
      });
      expect(addBlob(sessions[0]!, r2[1]!, 2, 1)).toEqual({ ok: true });
      expect(addBlob(sessions[0]!, r2[1]!, 2, 1).ok).toBe(false);
    });
  });

  describe('nonce rules', () => {
    it('drops nonces after round 2 and refuses a second round 2', () => {
      const r1 = sessions.map(round1);
      exchangeR1(sessions, r1);
      expect(sessions[0]!.round2Started).toBe(false);
      round2(sessions[0]!);
      expect(sessions[0]!.round2Started).toBe(true);
      expect(sessions[0]!.myNonces).toBeNull();
      expect(() => round2(sessions[0]!)).toThrow('round2 already run');
    });

    it('sets the guard before computing, so a failed round 2 cannot be retried', () => {
      round1(sessions[0]!);
      // Commitments from parties 1 and 2 are missing.
      expect(() => round2(sessions[0]!)).toThrow(/Missing r1 commitments from party 1/);
      expect(sessions[0]!.round2Started).toBe(true);
      expect(sessions[0]!.myNonces).toBeNull();
      expect(() => round2(sessions[0]!)).toThrow('round2 already run');
    });

    it('requires round 1 before round 2', () => {
      expect(() => round2(sessions[0]!)).toThrow('round1 not run');
      expect(sessions[0]!.round2Started).toBe(false);
    });
  });
});
