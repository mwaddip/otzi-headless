import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifySignature } from '@mwaddip/frots';
import { analyzeProposal, vaultPayment } from '../otzi/lib/bitcoin';
import { decodeEnvelope } from '../otzi/lib/dkg';
import { rng } from '../otzi/lib/dkg.fixture';
import { decodeFrostSignR2, encodeFrostSignR2 } from '../otzi/lib/frost-sign';
import { fromHex, toHex } from '../otzi/lib/hex';
import type { SendProposal } from '../otzi/lib/vault-types';
import { finalizeSend } from '../otzi/backend/bitcoin';
import { makeProposal, testVault } from '../testing/proposal';
import { makeRing, type RingNode } from '../testing/ring';
import { parseMessage, type AnnounceSign } from './messages';
import {
  SIGN_ROUNDS,
  leadSigning,
  participateInSigning,
  type SignCeremonySpec,
} from './sign-ceremony';
import { blobKeyToString, type BlobKey, type PartyId } from './types';

// Lets one test make the leader's final signature check fail; null passes through to frots.
const frots = vi.hoisted(() => ({ forcedVerify: null as boolean | null }));
vi.mock('@mwaddip/frots', async importOriginal => {
  const actual = await importOriginal<typeof import('@mwaddip/frots')>();
  return {
    ...actual,
    verifySignature: (...args: Parameters<typeof actual.verifySignature>) =>
      frots.forcedVerify ?? actual.verifySignature(...args),
  };
});

// Records every session the ceremony destroys.
const destroyed = vi.hoisted(() => ({ sessions: [] as Array<{ destroyed: boolean }> }));
vi.mock('./frost-sign-session', async importOriginal => {
  const actual = await importOriginal<typeof import('./frost-sign-session')>();
  return {
    ...actual,
    destroySession: (session: Parameters<typeof actual.destroySession>[0]) => {
      actual.destroySession(session);
      destroyed.sessions.push(session);
    },
  };
});

const NET = 'testnet4' as const;
const ceremonyId = 'sign-test.1';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const key = (round: string, from: PartyId): BlobKey => ({ ceremonyId, round, from });

function reasonOf(o: PromiseSettledResult<unknown> | undefined): string {
  if (!o || o.status !== 'rejected') throw new Error('expected a rejected promise');
  return (o.reason as Error).message;
}

describe('proposal signing ceremony', () => {
  let vault: ReturnType<typeof testVault>;
  let ring: RingNode[];

  beforeAll(() => {
    vault = testVault(2, 3);
  });

  beforeEach(() => {
    ring = makeRing(3, { deadlineMs: 750 });
    destroyed.sessions.length = 0;
  });

  afterEach(() => {
    frots.forcedVerify = null;
  });

  const spec = (i: PartyId, sighashes: Uint8Array[], signers: PartyId[] = [0, 1, 2]): SignCeremonySpec => ({
    ceremonyId,
    signers,
    sighashes,
    keyPackage: vault.keyPackages[i]!,
    publicKeyPackage: vault.publicKeyPackage,
    rng,
  });

  function analyse(proposal: SendProposal) {
    const analysis = analyzeProposal(proposal, vault.vaultKey, NET);
    return { analysis, sighashes: analysis.sighashes.map(s => fromHex(s.hash)) };
  }

  /** Replaces node `p`'s BlobServer with `handler` (the node misbehaves). */
  function serveFrom(p: PartyId, handler: (from: PartyId, key: BlobKey) => Uint8Array | null) {
    ring[p]!.server.close();
    ring[p]!.io.transport.servePulls(handler);
  }

  it('signers produce signatures that finalize into a valid transaction', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { analysis, sighashes } = analyse(proposal);

    const [sigs] = await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    const out = finalizeSend(
      proposal.tx,
      proposal.prevouts,
      sigs.map((s, index) => ({ index, signature: toHex(s) })),
      vaultPayment(vault.vaultKey, NET).outputKey,
    );
    expect(out.txid).toBe(analysis.txid);
  });

  it('signs every input and returns the signatures in input order', async () => {
    const proposal = makeProposal(vault.vaultKey, NET, {
      inputs: [{ amount: 60_000 }, { amount: 30_000 }, { amount: 10_000 }],
    });
    const { analysis, sighashes } = analyse(proposal);
    expect(sighashes).toHaveLength(3);

    const [sigs] = await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    expect(sigs).toHaveLength(3);
    sigs.forEach((sig, i) => {
      expect(sig).toHaveLength(64);
      expect(verifySignature(sig, sighashes[i]!, vault.publicKeyPackage.verifyingKey)).toBe(true);
    });
    const out = finalizeSend(
      proposal.tx,
      proposal.prevouts,
      sigs.map((s, index) => ({ index, signature: toHex(s) })),
      vaultPayment(vault.vaultKey, NET).outputKey,
    );
    expect(out.txid).toBe(analysis.txid);
  });

  it('tags every blob envelope with the first sighash', async () => {
    const proposal = makeProposal(vault.vaultKey, NET, { inputs: [{ amount: 60_000 }, { amount: 40_000 }] });
    const { sighashes } = analyse(proposal);

    await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    const sid = toHex(sighashes[0]!).slice(0, 16);
    const blobs = ring[0]!.io.store.list(ceremonyId);
    expect(blobs).toHaveLength(6);
    for (const { blob } of blobs) expect(decodeEnvelope(dec(blob))?.sid).toBe(sid);
  });

  it('announce-sign carries the proposal and no sighashes', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    const heard: Uint8Array[] = [];
    ring[1]!.io.transport.onBroadcast((_from, bytes) => heard.push(bytes));

    await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    expect(heard).toHaveLength(1);
    const msg = parseMessage(heard[0]!) as AnnounceSign;
    expect(msg.kind).toBe('announce-sign');
    expect(msg.ceremonyId).toBe(ceremonyId);
    expect(msg.signers).toEqual([0, 1, 2]);
    expect(msg.proposal).toEqual(proposal);
    expect('sighashes' in msg).toBe(false);
    expect(dec(heard[0]!)).not.toContain(toHex(sighashes[0]!));
  });

  it('the leader announces before it produces round 1', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    let leaderHadR1WhenAnnounced: boolean | null = null;
    ring[1]!.io.transport.onBroadcast(() => {
      leaderHadR1WhenAnnounced = ring[0]!.io.store.has(key(SIGN_ROUNDS.r1, 0));
    });

    await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    expect(leaderHadR1WhenAnnounced).toBe(false);
    expect(ring[0]!.io.store.has(key(SIGN_ROUNDS.r1, 0))).toBe(true);
  });

  it('participants stop after sign-r2: they pull no sign-r2 and the leader pulls both', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);

    await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    const froms = (node: RingNode, round: string) =>
      node.io.store.list(ceremonyId, round).map(e => e.key.from).sort();
    expect(froms(ring[0]!, SIGN_ROUNDS.r1)).toEqual([0, 1, 2]);
    expect(froms(ring[0]!, SIGN_ROUNDS.r2)).toEqual([0, 1, 2]);
    for (const i of [1, 2]) {
      expect(froms(ring[i]!, SIGN_ROUNDS.r1)).toEqual([0, 1, 2]);
      expect(froms(ring[i]!, SIGN_ROUNDS.r2)).toEqual([i]);
    }
  });

  it('a signer whose blob claims another party makes the leader abort naming it', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    // Node 2 shows the leader party 1's round-1 blob in its own place.
    const store2 = ring[2]!.io.store;
    serveFrom(2, (from, k) => {
      if (k.round === SIGN_ROUNDS.r1 && from === 0) return ring[1]!.io.store.get(key(SIGN_ROUNDS.r1, 1)) ?? null;
      return store2.get(k) ?? null;
    });

    const out = await Promise.allSettled([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    expect(reasonOf(out[0])).toBe('Rejected sign-r1 blob from party 2: r1 blob from party 2 claims party 1');
  });

  it('a signer that serves a corrupted share makes the leader abort naming it', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    // Node 2's round-2 share is valid-looking but wrong; the sender binding passes.
    const store2 = ring[2]!.io.store;
    serveFrom(2, (_from, k) => {
      const blob = store2.get(k);
      if (!blob || k.round !== SIGN_ROUNDS.r2) return blob ?? null;
      const pkg = decodeFrostSignR2(dec(blob))!;
      const shares = pkg.shares.map(s => ({ ...s, share: s.share + 1n }));
      return enc(encodeFrostSignR2(pkg.partyId, shares, sighashes[0]!));
    });

    const out = await Promise.allSettled([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    // frots names the FROST identifier: 3 is party 2.
    expect(reasonOf(out[0])).toMatch(/invalid share\(s\) from signer\(s\): 3$/);
  });

  it('a signer that signed a different sighash makes the leader abort', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    const other = sighashes.map(h => h.map(b => b ^ 0xff));

    const out = await Promise.allSettled([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, other)),
    ]);

    expect(reasonOf(out[0])).toMatch(/invalid share\(s\) from signer\(s\): 3$/);
  });

  it('a signature that does not verify against the vault key makes the leader throw', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    frots.forcedVerify = false;

    const out = await Promise.allSettled([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);

    expect(reasonOf(out[0])).toBe('signature for input 0 does not verify');
    // Participants never verify or aggregate.
    expect(out[1]!.status).toBe('fulfilled');
    expect(out[2]!.status).toBe('fulfilled');
  });

  it('a signer that never shows up makes the leader fail naming its missing blob', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    ring = makeRing(3, { deadlineMs: 150 });

    // Node 2 never runs, so its sign-r1 never appears.
    const out = await Promise.allSettled([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
    ]);

    expect(reasonOf(out[0])).toBe(`Deadline exceeded while pulling ${blobKeyToString(key(SIGN_ROUNDS.r1, 2))}`);
    expect(reasonOf(out[1])).toContain(blobKeyToString(key(SIGN_ROUNDS.r1, 2)));
  });

  it('destroys the session on every exit path', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);

    await Promise.all([
      leadSigning(ring[0]!.io, spec(0, sighashes), proposal),
      participateInSigning(ring[1]!.io, spec(1, sighashes)),
      participateInSigning(ring[2]!.io, spec(2, sighashes)),
    ]);
    expect(destroyed.sessions).toHaveLength(3);

    // A failing ceremony destroys its session too.
    ring = makeRing(3, { deadlineMs: 100 });
    await expect(participateInSigning(ring[1]!.io, spec(1, sighashes))).rejects.toThrow(/Deadline exceeded/);
    await expect(leadSigning(ring[0]!.io, spec(0, sighashes), proposal)).rejects.toThrow(/Deadline exceeded/);
    expect(destroyed.sessions).toHaveLength(5);
    expect(destroyed.sessions.every(s => s.destroyed)).toBe(true);
  });

  it('a reused ceremonyId with a stored sign-r1 throws before any share is computed', async () => {
    const proposal = makeProposal(vault.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    ring[1]!.io.store.put(key(SIGN_ROUNDS.r1, 1), enc('stale'));

    await expect(participateInSigning(ring[1]!.io, spec(1, sighashes))).rejects.toThrow(/Conflicting blob/);
    expect(ring[1]!.io.store.has(key(SIGN_ROUNDS.r2, 1))).toBe(false);
  });

  describe('participant abort', () => {
    it('refuses to start with an aborted signal', async () => {
      const { sighashes } = analyse(makeProposal(vault.vaultKey, NET));
      const ac = new AbortController();
      ac.abort();

      await expect(participateInSigning(ring[1]!.io, spec(1, sighashes), ac.signal)).rejects.toThrow('aborted');
      expect(ring[1]!.io.store.list(ceremonyId)).toHaveLength(0);
    });

    it('stops pulling when the signal aborts', async () => {
      const { sighashes } = analyse(makeProposal(vault.vaultKey, NET));
      ring = makeRing(3, { deadlineMs: 5000 });
      const ac = new AbortController();

      const running = participateInSigning(ring[1]!.io, spec(1, sighashes), ac.signal);
      const settled = running.then(() => 'resolved', (e: Error) => e.message);
      await sleep(30);
      ac.abort();

      expect(await settled).toBe('aborted');
      // Round 2 was never reached.
      expect(ring[1]!.io.store.has(key(SIGN_ROUNDS.r2, 1))).toBe(false);
    });
  });

  describe('2-of-3 vault', () => {
    it('never pulls from the non-signer', async () => {
      const vault23 = testVault(2, 3);
      const proposal = makeProposal(vault23.vaultKey, NET);
      const analysis = analyzeProposal(proposal, vault23.vaultKey, NET);
      const sighashes = analysis.sighashes.map(s => fromHex(s.hash));
      const spec23 = (i: PartyId): SignCeremonySpec => ({
        ceremonyId,
        signers: [0, 1],
        sighashes,
        keyPackage: vault23.keyPackages[i]!,
        publicKeyPackage: vault23.publicKeyPackage,
        rng,
      });

      let pullsOnParty2 = 0;
      const store2 = ring[2]!.io.store;
      serveFrom(2, (_from, k) => {
        pullsOnParty2++;
        return store2.get(k) ?? null;
      });

      const [sigs] = await Promise.all([
        leadSigning(ring[0]!.io, spec23(0), proposal),
        participateInSigning(ring[1]!.io, spec23(1)),
      ]);

      expect(pullsOnParty2).toBe(0);
      const out = finalizeSend(
        proposal.tx,
        proposal.prevouts,
        sigs.map((s, index) => ({ index, signature: toHex(s) })),
        vaultPayment(vault23.vaultKey, NET).outputKey,
      );
      expect(out.txid).toBe(analysis.txid);
    });

    it('signs with any two of three parties', async () => {
      const proposal = makeProposal(vault.vaultKey, NET);
      const { analysis, sighashes } = analyse(proposal);

      // Leader is party 2, the other signer is party 0.
      const [sigs] = await Promise.all([
        leadSigning(ring[2]!.io, spec(2, sighashes, [2, 0]), proposal),
        participateInSigning(ring[0]!.io, spec(0, sighashes, [0, 2])),
      ]);

      const out = finalizeSend(
        proposal.tx,
        proposal.prevouts,
        sigs.map((s, index) => ({ index, signature: toHex(s) })),
        vaultPayment(vault.vaultKey, NET).outputKey,
      );
      expect(out.txid).toBe(analysis.txid);
    });
  });

  describe('input validation', () => {
    const hash = () => new Uint8Array(32).fill(7);
    const cases: Array<[string, (i: PartyId) => SignCeremonySpec, RegExp]> = [
      ['no sighashes', i => spec(i, []), /sighashes/],
      ['a short sighash', i => spec(i, [new Uint8Array(31)]), /sighash 0 is 31 bytes/],
      ['256 sighashes', i => spec(i, Array.from({ length: 256 }, hash)), /sighashes/],
      ['no signers', i => spec(i, [hash()], []), /signers/],
      ['duplicate signers', i => spec(i, [hash()], [0, 1, 1]), /unique/],
      ['signers that omit this node', i => spec(i, [hash()], [(i + 1) % 3, (i + 2) % 3]), /not in signers/],
      ['a signer outside the ring', i => spec(i, [hash()], [0, 1, 2, 3]), /ring/],
      ['fewer signers than the threshold', i => spec(i, [hash()], [i]), /at least 2/],
    ];

    it.each(cases)('leadSigning rejects %s before announcing', async (_name, make, expected) => {
      const heard: Uint8Array[] = [];
      ring[1]!.io.transport.onBroadcast((_from, bytes) => heard.push(bytes));

      await expect(leadSigning(ring[0]!.io, make(0), makeProposal(vault.vaultKey, NET))).rejects.toThrow(expected);

      expect(heard).toEqual([]);
      expect(ring[0]!.io.store.list(ceremonyId)).toHaveLength(0);
    });

    it.each(cases)('participateInSigning rejects %s before producing anything', async (_name, make, expected) => {
      await expect(participateInSigning(ring[1]!.io, make(1))).rejects.toThrow(expected);

      expect(ring[1]!.io.store.list(ceremonyId)).toHaveLength(0);
    });
  });
});
