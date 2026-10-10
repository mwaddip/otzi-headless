import { beforeEach, describe, expect, it } from 'vitest';
import { dkgRound1, dkgRound2, verifySignature } from '@mwaddip/frots';
import {
  decodeFrostRound1,
  decodeFrostRound2,
  dkgVerifyMessage,
  encodeFrostRound1,
  encodeFrostRound2,
  toVaultKey,
  type FrostRound1Package,
} from '../otzi/lib/dkg';
import { rng } from '../otzi/lib/dkg.fixture';
import { toHex } from '../otzi/lib/hex';
import { makeRing, type RingNode } from '../testing/ring';
import {
  DKG_ROUNDS,
  runDkgCeremony,
  type DkgCeremonyResult,
  type DkgCeremonySpec,
  type ShareStager,
} from './dkg-ceremony';
import { parseMessage, type CeremonyMessage, type SignoffAborted } from './messages';
import { blobKeyToString, type BlobKey, type PartyId } from './types';

const ceremonyId = 'dkg-test.1';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface RecordingStager extends ShareStager {
  calls: string[];
  failStage?: boolean;
}

function recordingStager(): RecordingStager {
  const s: RecordingStager = {
    calls: [],
    async stage() {
      s.calls.push('stage');
      // Longer than a signoff-aborted reason may be, to check truncation.
      if (s.failStage) throw new Error(`disk full ${'x'.repeat(2000)}`);
    },
    async commit() {
      s.calls.push('commit');
    },
    async discard() {
      s.calls.push('discard');
    },
  };
  return s;
}

interface Heard {
  by: PartyId;
  from: PartyId;
  msg: CeremonyMessage | null;
}

function reasonOf(o: PromiseSettledResult<unknown> | undefined): string {
  if (!o || o.status !== 'rejected') throw new Error('expected a rejected ceremony');
  return (o.reason as Error).message;
}

function abortsFrom(heard: readonly Heard[]): Set<PartyId> {
  return new Set(heard.filter(h => h.msg?.kind === 'signoff-aborted').map(h => h.from));
}

describe('runDkgCeremony', () => {
  let ring: RingNode[];
  let stagers: RecordingStager[];
  let spec: DkgCeremonySpec;

  beforeEach(() => {
    ring = makeRing(3);
    stagers = ring.map(() => recordingStager());
    spec = {
      ceremonyId,
      sessionId: crypto.getRandomValues(new Uint8Array(32)),
      threshold: 3,
      parties: 3,
      network: 'testnet4',
      rng,
    };
  });

  /**
   * Records every broadcast the given nodes hear and, like the Orchestrator,
   * aborts a node's ceremony when it hears `signoff-aborted` for it.
   */
  function wire(nodes: readonly PartyId[]): { heard: Heard[]; signals: Map<PartyId, AbortSignal> } {
    const heard: Heard[] = [];
    const signals = new Map<PartyId, AbortSignal>();
    for (const i of nodes) {
      const ac = new AbortController();
      signals.set(i, ac.signal);
      ring[i]!.io.transport.onBroadcast((from, bytes) => {
        const msg = parseMessage(bytes);
        heard.push({ by: i, from, msg });
        if (msg?.kind === 'signoff-aborted' && msg.ceremonyId === spec.ceremonyId) ac.abort();
      });
    }
    return { heard, signals };
  }

  function runNodes(nodes: readonly PartyId[]) {
    const { heard, signals } = wire(nodes);
    const settled = Promise.allSettled(
      nodes.map(i => runDkgCeremony(ring[i]!.io, spec, stagers[i]!, signals.get(i))),
    );
    return { heard, settled };
  }

  /** Replaces node `p`'s BlobServer with `handler` (the node misbehaves). */
  function serveFrom(p: PartyId, handler: (from: PartyId, key: BlobKey) => Uint8Array | null) {
    ring[p]!.server.close();
    ring[p]!.io.transport.servePulls(handler);
  }

  it('three nodes agree on one vault and commit their shares', async () => {
    const { heard, settled } = runNodes([0, 1, 2]);
    const out = await settled;
    const results: DkgCeremonyResult[] = out.map(o => {
      if (o.status !== 'fulfilled') throw o.reason;
      return o.value;
    });

    const keys = results.map(r => toHex(r.publicKeyPackage.verifyingKey));
    expect(new Set(keys).size).toBe(1);
    for (const s of stagers) expect(s.calls).toEqual(['stage', 'commit']);
    expect(Object.keys(toVaultKey(results[0]!.publicKeyPackage).verifyingShares)).toEqual(['1', '2', '3']);
    results.forEach((r, i) => expect(r.keyPackage.identifier).toBe(BigInt(i + 1)));

    // Every node confirmed with the same raw 64-byte signature over M.
    const M = dkgVerifyMessage(spec.sessionId, spec.network, results[0]!.publicKeyPackage);
    const sigs = ring.map(n => n.io.store.get({ ceremonyId, round: DKG_ROUNDS.verified, from: n.partyId })!);
    for (const sig of sigs) expect(sig).toHaveLength(64);
    expect(new Set(sigs.map(toHex)).size).toBe(1);
    expect(verifySignature(sigs[0]!, M, results[0]!.publicKeyPackage.verifyingKey)).toBe(true);

    // Round-2 shares are addressed blobs, one per peer.
    const r2 = ring[0]!.io.store.list(ceremonyId, DKG_ROUNDS.r2).filter(e => e.key.from === 0);
    expect(r2.map(e => e.key.to).sort()).toEqual([1, 2]);

    expect(heard).toEqual([]);
  });

  it('a node that fails before confirming keeps everyone else from committing', async () => {
    stagers[2]!.failStage = true;
    const { heard, settled } = runNodes([0, 1, 2]);
    const out = await settled;

    expect(out.every(o => o.status === 'rejected')).toBe(true);
    for (const s of stagers) expect(s.calls).not.toContain('commit');
    for (const s of stagers) expect(s.calls.at(-1)).toBe('discard');
    expect(stagers[2]!.calls).toEqual(['stage', 'discard']);
    expect(reasonOf(out[2])).toMatch(/^DKG aborted: disk full x/);
    // A node publishes its confirmation only after staging.
    expect(ring[2]!.io.store.has({ ceremonyId, round: DKG_ROUNDS.verified, from: 2 })).toBe(false);

    // Node 2 announced the abort; the others stopped on it and stayed silent.
    expect(abortsFrom(heard)).toEqual(new Set([2]));
    const msg = heard.find(h => h.from === 2)!.msg as SignoffAborted;
    expect(msg.ceremonyId).toBe(ceremonyId);
    expect(msg.reason).toMatch(/^disk full x/);
    expect(msg.reason!.length).toBeLessThanOrEqual(1024);
    for (const i of [0, 1]) expect(reasonOf(out[i])).toBe('DKG aborted: aborted');
  });

  it('nobody commits when a node fails to stage, even without hearing its abort', async () => {
    // No signals wired: only the protocol ordering (stage before dkg-verified) protects the others.
    ring = makeRing(3, { deadlineMs: 500 });
    const slow = stagers[2]!;
    slow.stage = async () => {
      slow.calls.push('stage');
      await sleep(50);
      throw new Error('disk full');
    };

    const out = await Promise.allSettled(ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!)));

    expect(out.every(o => o.status === 'rejected')).toBe(true);
    for (const s of stagers) expect(s.calls).not.toContain('commit');
    expect(reasonOf(out[2])).toBe('DKG aborted: disk full');
    const verifiedFrom2 = blobKeyToString({ ceremonyId, round: DKG_ROUNDS.verified, from: 2 });
    for (const i of [0, 1]) {
      expect(stagers[i]!.calls).toEqual(['stage', 'discard']);
      expect(reasonOf(out[i])).toContain(verifiedFrom2);
    }
  });

  it('an inconsistent round-2 share aborts and nobody commits', async () => {
    // Node 2 serves recipient 1 a share that does not match its own commitments.
    const store2 = ring[2]!.io.store;
    serveFrom(2, (from, key) => {
      if (key.to !== undefined && from !== key.to) return null;
      const blob = store2.get(key);
      if (!blob || key.round !== DKG_ROUNDS.r2 || key.to !== 1) return blob ?? null;
      const pkg = decodeFrostRound2(dec(blob))!;
      return enc(encodeFrostRound2({ ...pkg, signingShare: pkg.signingShare + 1n }, spec.sessionId));
    });

    const { heard, settled } = runNodes([0, 1, 2]);
    const out = await settled;

    expect(out.every(o => o.status === 'rejected')).toBe(true);
    for (const s of stagers) expect(s.calls).not.toContain('commit');
    expect(stagers[1]!.calls).toEqual(['discard']);
    // frots names the FROST identifier: 3 is party 2.
    expect(reasonOf(out[1])).toMatch(/^DKG aborted: .*VSS verification failed for share from sender 3/);
    expect(abortsFrom(heard)).toEqual(new Set([1]));
  });

  it('an equivocating round-1 node keeps every node from committing', async () => {
    ring = makeRing(3, { deadlineMs: 750 });
    // Node 2 runs no ceremony: it shows node 0 one round-1 package and node 1 another.
    const variantA = dkgRound1(3n, 3, 3, rng);
    const variantB = dkgRound1(3n, 3, 3, rng);
    const r1A = enc(encodeFrostRound1(variantA.package, spec.sessionId));
    const r1B = enc(encodeFrostRound1(variantB.package, spec.sessionId));
    let r2ByRecipient: Map<PartyId, Uint8Array> | null = null;

    serveFrom(2, (from, key) => {
      if (key.ceremonyId !== ceremonyId) return null;
      if (key.round === DKG_ROUNDS.r1) return from === 0 ? r1A : from === 1 ? r1B : null;
      if (key.round === DKG_ROUNDS.r2 && key.to === from) return r2ByRecipient?.get(from) ?? null;
      return null; // nothing for the verify rounds
    });

    // Each recipient gets the share consistent with the variant it saw.
    const precompute = (async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const blobs = await Promise.all(
          [0, 1].map(p => ring[2]!.io.transport.pull({ ceremonyId, round: DKG_ROUNDS.r1, from: p })),
        );
        if (blobs.every(b => b !== null)) {
          const honest = new Map<bigint, FrostRound1Package>(
            blobs.map(b => {
              const pkg = decodeFrostRound1(dec(b!))!;
              return [pkg.identifier, pkg];
            }),
          );
          const fromA = dkgRound2(variantA.secretPackage, honest).packages;
          const fromB = dkgRound2(variantB.secretPackage, honest).packages;
          r2ByRecipient = new Map([
            [0, enc(encodeFrostRound2(fromA.get(1n)!, spec.sessionId))],
            [1, enc(encodeFrostRound2(fromB.get(2n)!, spec.sessionId))],
          ]);
          return;
        }
        await sleep(2);
      }
      throw new Error('honest dkg-r1 blobs never appeared');
    })();

    const { settled } = runNodes([0, 1]);
    const [out] = await Promise.all([settled, precompute]);

    expect(out.every(o => o.status === 'rejected')).toBe(true);
    for (const i of [0, 1]) expect(stagers[i]!.calls).toEqual(['discard']);
    // Both honest nodes finalized a key (the equivocation passes rounds 1 and 2)...
    for (const i of [0, 1]) {
      expect(ring[i]!.io.store.has({ ceremonyId, round: DKG_ROUNDS.verifyR1, from: i })).toBe(true);
    }
    // ...and node 2 never signs: an honest node gives up pulling its verification commitments.
    const verifyFrom2 = blobKeyToString({ ceremonyId, round: DKG_ROUNDS.verifyR1, from: 2 });
    expect(out.map(reasonOf).some(r => r.includes(verifyFrom2))).toBe(true);
  });

  it.each([
    ['a forged', (sig: Uint8Array) => sig.map((b, i) => (i === 0 ? b ^ 1 : b)), /^DKG aborted: dkg-verified from party 2 does not verify$/],
    ['a truncated', (sig: Uint8Array) => sig.slice(0, 63), /^DKG aborted: dkg-verified from party 2 is 63 bytes, expected 64$/],
  ])('%s dkg-verified confirmation keeps the honest nodes from committing', async (_, tamper, expected) => {
    const store2 = ring[2]!.io.store;
    serveFrom(2, (from, key) => {
      if (key.to !== undefined && from !== key.to) return null;
      const blob = store2.get(key);
      return blob && key.round === DKG_ROUNDS.verified ? tamper(blob) : (blob ?? null);
    });

    const { settled } = runNodes([0, 1, 2]);
    const out = await settled;

    // Node 2 (the cheater) may complete; the honest nodes must not.
    for (const i of [0, 1]) {
      expect(stagers[i]!.calls).toEqual(['stage', 'discard']);
      expect(reasonOf(out[i])).toMatch(new RegExp(`${expected.source}|^DKG aborted: aborted$`));
    }
    expect([0, 1].some(i => expected.test(reasonOf(out[i])))).toBe(true);
  });

  it('a dkg-r1 blob claiming another party aborts naming the sender', async () => {
    // Node 2 shows node 0 a round-1 package in party 1's name.
    const forged = enc(encodeFrostRound1(dkgRound1(2n, 3, 3, rng).package, spec.sessionId));
    const store2 = ring[2]!.io.store;
    serveFrom(2, (from, key) => {
      if (key.round === DKG_ROUNDS.r1 && from === 0) return forged;
      if (key.to !== undefined && from !== key.to) return null;
      return store2.get(key) ?? null;
    });

    const { heard, settled } = runNodes([0, 1, 2]);
    const out = await settled;

    expect(out.every(o => o.status === 'rejected')).toBe(true);
    for (const s of stagers) expect(s.calls).toEqual(['discard']);
    expect(reasonOf(out[0])).toBe(
      'DKG aborted: Rejected dkg-r1 blob from party 2: r1 blob from party 2 claims party 1',
    );
    expect(abortsFrom(heard)).toEqual(new Set([0]));
    const msg = heard.find(h => h.from === 0)!.msg as SignoffAborted;
    expect(msg.reason).toBe('Rejected dkg-r1 blob from party 2: r1 blob from party 2 claims party 1');
    for (const i of [1, 2]) expect(reasonOf(out[i])).toBe('DKG aborted: aborted');
  });

  it('an abort signal stops the ceremony and discards the staged share', async () => {
    const { heard } = wire([0, 1, 2]);
    const ac = new AbortController();
    // The operator aborts once every node has staged its share.
    for (const s of stagers) {
      const stage = s.stage;
      s.stage = async r => {
        await stage(r);
        if (stagers.every(x => x.calls.includes('stage'))) ac.abort();
      };
    }

    const out = await Promise.allSettled(
      ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!, ac.signal)),
    );

    for (const o of out) expect(reasonOf(o)).toBe('DKG aborted: aborted');
    for (const s of stagers) expect(s.calls).toEqual(['stage', 'discard']);
    expect(heard).toEqual([]); // aborted by signal: nobody broadcasts
  });

  it('a signal aborted before the start produces nothing', async () => {
    const { heard } = wire([1, 2]); // they would hear node 0's broadcast
    const ac = new AbortController();
    ac.abort();

    await expect(runDkgCeremony(ring[0]!.io, spec, stagers[0]!, ac.signal)).rejects.toThrow(
      'DKG aborted: aborted',
    );
    expect(stagers[0]!.calls).toEqual(['discard']);
    expect(ring[0]!.io.store.list(ceremonyId)).toEqual([]);
    expect(heard).toEqual([]);
  });
});
