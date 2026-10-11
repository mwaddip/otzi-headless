import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createShareStager, loadVaultShare, pendingPath } from '../daemon/vault-share';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { rng } from '../otzi/lib/dkg.fixture';
import { toHex } from '../otzi/lib/hex';
import { makeRing, type RingNode } from '../testing/ring';
import {
  DKG_ROUNDS,
  DkgShareKeptError,
  runDkgCeremony,
  type DkgCeremonyResult,
  type DkgCeremonySpec,
  type ShareStager,
} from './dkg-ceremony';
import { encodeMessage, parseMessage, type CeremonyMessage, type SignoffAborted } from './messages';
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
    sharePath: '/test/share.json',
    stagedPath: '/test/share.json.pending',
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

/** The failure of a node that had published its confirmation: it kept its staged share. */
function keptError(o: PromiseSettledResult<unknown> | undefined): DkgShareKeptError {
  if (!o || o.status !== 'rejected') throw new Error('expected a rejected ceremony');
  expect(o.reason).toBeInstanceOf(DkgShareKeptError);
  return o.reason as DkgShareKeptError;
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
    // A node discards its staged share only if it had not yet published its confirmation.
    for (const i of [0, 1]) {
      const confirmed = ring[i]!.io.store.has({ ceremonyId, round: DKG_ROUNDS.verified, from: i });
      if (confirmed) {
        expect(stagers[i]!.calls).toEqual(['stage']);
        keptError(out[i]);
      } else {
        expect(stagers[i]!.calls.at(-1)).toBe('discard');
      }
    }
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
    for (const i of [0, 1]) expect(reasonOf(out[i])).toMatch(/^DKG aborted: aborted($|; )/);
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
      // Nodes 0 and 1 had published their confirmations: they keep their staged shares.
      expect(stagers[i]!.calls).toEqual(['stage']);
      const err = keptError(out[i]);
      expect(err.message).toContain(verifiedFrom2);
      expect(err.stagedPath).toBe('/test/share.json.pending');
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
    // frots names FROST identifier 3; the message names party 2.
    expect(reasonOf(out[1])).toMatch(/^DKG aborted: .*VSS verification failed for share from party 2$/);
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
    ['a forged', (sig: Uint8Array) => sig.map((b, i) => (i === 0 ? b ^ 1 : b)), /dkg-verified from party 2 does not verify$/],
    ['a truncated', (sig: Uint8Array) => sig.slice(0, 63), /dkg-verified from party 2 is 63 bytes, expected 64$/],
  ])('%s dkg-verified confirmation keeps the honest nodes from committing', async (_, tamper, expected) => {
    const store2 = ring[2]!.io.store;
    serveFrom(2, (from, key) => {
      if (key.to !== undefined && from !== key.to) return null;
      const blob = store2.get(key);
      return blob && key.round === DKG_ROUNDS.verified ? tamper(blob) : (blob ?? null);
    });

    const { settled } = runNodes([0, 1, 2]);
    const out = await settled;

    // Node 2 (the cheater) may complete; the honest nodes must not. They had published their
    // confirmations, so they keep their staged shares: the cheater may have committed.
    for (const i of [0, 1]) {
      expect(stagers[i]!.calls).toEqual(['stage']);
      expect(keptError(out[i]).reason).toMatch(new RegExp(`${expected.source}|^aborted$`));
    }
    expect([0, 1].some(i => expected.test(`DKG aborted: ${keptError(out[i]).reason}`))).toBe(true);
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
    // The operator aborts once every node has staged its share; no node gets
    // past staging (to its confirmation) before that.
    for (const s of stagers) {
      const stage = s.stage;
      s.stage = async r => {
        await stage(r);
        if (stagers.every(x => x.calls.includes('stage'))) ac.abort();
        else await new Promise(resolve => ac.signal.addEventListener('abort', resolve, { once: true }));
      };
    }

    const out = await Promise.allSettled(
      ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!, ac.signal)),
    );

    for (const o of out) expect(reasonOf(o)).toBe('DKG aborted: aborted');
    for (const s of stagers) expect(s.calls).toEqual(['stage', 'discard']);
    expect(heard).toEqual([]); // aborted by signal: nobody broadcasts
  });

  it('commits once every confirmation verified, even when the signal aborts then', async () => {
    const ac = new AbortController();
    // Node 0's signal aborts right after its confirmation pull completed.
    const puller = ring[0]!.io.puller;
    const pullAll = puller.pullAll.bind(puller);
    puller.pullAll = async (keys, opts, signal) => {
      await pullAll(keys, opts, signal);
      if (keys[0]?.round === DKG_ROUNDS.verified) ac.abort();
    };

    const out = await Promise.allSettled(
      ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!, i === 0 ? ac.signal : undefined)),
    );

    expect(ac.signal.aborted).toBe(true);
    expect(out.map(o => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    for (const s of stagers) expect(s.calls).toEqual(['stage', 'commit']);
  });

  it('after its confirmation a failing node names the kept share and the recovery', async () => {
    // Node 2 never shows its confirmation to node 0.
    const store2 = ring[2]!.io.store;
    serveFrom(2, (from, key) => {
      if (key.to !== undefined && from !== key.to) return null;
      if (key.round === DKG_ROUNDS.verified && from === 0) return null;
      return store2.get(key) ?? null;
    });
    ring[0]!.io.pullOpts = { ...ring[0]!.io.pullOpts, maxAttempts: 5 };

    const { heard, settled } = runNodes([0, 1, 2]);
    const out = await settled;

    const err = keptError(out[0]);
    expect(stagers[0]!.calls).toEqual(['stage']);
    const vault = out.find(o => o.status === 'fulfilled') as PromiseFulfilledResult<DkgCeremonyResult> | undefined;
    const address = vault
      ? vaultPayment(toVaultKey(vault.value.publicKeyPackage), spec.network).address
      : undefined;
    expect(err.message).toBe(`DKG aborted: ${err.reason}; ${err.keptNote}`);
    expect(err.reason).toMatch(/dkg-verified/);
    expect(err.keptNote).toMatch(
      /^this node published its confirmation of vault tb1p[0-9a-z]+, so its staged share was kept at \/test\/share\.json\.pending: run 'otzi vault' on the other nodes; if any of them shows tb1p[0-9a-z]+, rename \/test\/share\.json\.pending to \/test\/share\.json and restart this daemon, otherwise remove \/test\/share\.json\.pending$/,
    );
    if (address) expect(err.keptNote).toContain(address);
    // The abort is still announced, without local paths.
    const sent = heard.find(h => h.from === 0 && h.msg?.kind === 'signoff-aborted')?.msg as SignoffAborted | undefined;
    expect(sent?.reason).toBe(err.reason);
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

// ─── Failure atomicity with real share stagers ─────────────────────────────

/** Real stagers encrypt each share (PBKDF2): generous, for loaded CI machines. */
const REAL_STAGER_TEST_MS = 60_000;

describe('runDkgCeremony with real share stagers: no lost share', () => {
  let dir: string;
  let ring: RingNode[];
  let spec: DkgCeremonySpec;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dkg-atomicity-'));
    // Generous pulls: a failure in these tests is always the one the test causes.
    ring = makeRing(3, { maxAttempts: 1_000_000, deadlineMs: 20_000 });
    spec = {
      ceremonyId,
      sessionId: crypto.getRandomValues(new Uint8Array(32)),
      threshold: 3,
      parties: 3,
      network: 'testnet4',
      rng,
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sharePath = (i: PartyId) => join(dir, `node-${i}`, 'share.json');
  const vaultPubkeyPath = (i: PartyId) => join(dir, `node-${i}`, 'vault-pubkey.json');
  const stagerFor = (i: PartyId, over: { vaultPubkeyPath?: string } = {}) =>
    createShareStager({
      path: sharePath(i),
      password: 'pw',
      network: 'testnet4',
      partyId: i,
      vaultPubkeyPath: over.vaultPubkeyPath ?? vaultPubkeyPath(i),
    });

  /** Like the Orchestrator: a node's signal aborts when it hears signoff-aborted for the ceremony. */
  function signals(): AbortSignal[] {
    return ring.map(node => {
      const ac = new AbortController();
      node.io.transport.onBroadcast((_from, bytes) => {
        const msg = parseMessage(bytes);
        if (msg?.kind === 'signoff-aborted' && msg.ceremonyId === spec.ceremonyId) ac.abort();
      });
      return ac.signal;
    });
  }

  /** The vault's internal key in the share file at `path`, decrypted. */
  async function internalKeyAt(path: string): Promise<string> {
    const staging = join(dir, 'probe.json');
    await writeFile(staging, readFileSync(path));
    const share = await loadVaultShare(staging, 'pw', 'testnet4');
    await rm(staging);
    return share!.internalKey;
  }

  /** Every node holds the vault's share: committed, or kept at its staging path. */
  async function expectNoLostShare(internalKey: string): Promise<void> {
    for (const i of [0, 1, 2]) {
      const committed = existsSync(sharePath(i)) && !existsSync(pendingPath(sharePath(i)));
      const at = committed ? sharePath(i) : pendingPath(sharePath(i));
      expect(existsSync(at), `node ${i} holds no share`).toBe(true);
      expect(await internalKeyAt(at)).toBe(internalKey);
    }
  }

  it('a node whose commit fails after its confirmation keeps its staged share', async () => {
    const stagers = [0, 1, 2].map(i => stagerFor(i));
    // Node 2's commit is refused only after nodes 0 and 1 have finished their ceremonies. Its failure
    // broadcasts signoff-aborted, and a peer still short of one confirmation stops on it; which node
    // stages last (PBKDF2, so it depends on load) would otherwise decide whether any peer completes.
    // Waiting on the ceremonies themselves, not a sleep, fixes the order under any load, and they are
    // bounded by the ring's pull deadline. Node 2's confirmation is already served by then.
    let othersFinished: Promise<unknown> = Promise.resolve();
    // Something appears at node 2's share path after it staged: its commit is refused.
    const commit2 = stagers[2]!.commit.bind(stagers[2]);
    stagers[2]!.commit = async () => {
      await othersFinished;
      await writeFile(sharePath(2), 'not a share');
      return commit2();
    };
    const sigs = signals();

    const runs = ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!, sigs[i]));
    othersFinished = Promise.allSettled([runs[0]!, runs[1]!]);
    const out = await Promise.allSettled(runs);

    // Nodes 0 and 1 verified every confirmation before node 2 failed: they committed the vault.
    for (const i of [0, 1]) {
      expect(out[i]!.status, `node ${i}`).toBe('fulfilled');
      expect(existsSync(sharePath(i)), `node ${i} did not commit`).toBe(true);
      expect(existsSync(pendingPath(sharePath(i))), `node ${i} left its staged share`).toBe(false);
    }
    expect(existsSync(pendingPath(sharePath(2))), 'node 2 deleted its staged share').toBe(true);
    const err = keptError(out[2]);
    expect(err.reason).toBe(`share path already exists: ${sharePath(2)}`);
    expect(err.stagedPath).toBe(pendingPath(sharePath(2)));
    expect(err.keptNote).toContain(`rename ${pendingPath(sharePath(2))} to ${sharePath(2)}`);
    expect(readFileSync(sharePath(2), 'utf8')).toBe('not a share');
    const done = out[0] as PromiseFulfilledResult<DkgCeremonyResult>;
    const internalKey = toVaultKey(done.value.publicKeyPackage).untweakedVerifyingKey;
    await rm(sharePath(2)); // the operator moves the stray file away ...
    await expectNoLostShare(internalKey);
  }, REAL_STAGER_TEST_MS);

  it('a commit whose vault-pubkey.json write fails still completes the DKG on every node', async () => {
    await writeFile(join(dir, 'blocker'), 'x');
    const stagers = [0, 1, 2].map(i =>
      stagerFor(i, i === 1 ? { vaultPubkeyPath: join(dir, 'blocker', 'vault-pubkey.json') } : {}),
    );
    const sigs = signals();

    const out = await Promise.allSettled(ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!, sigs[i])));

    expect(out.map(o => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    for (const i of [0, 1, 2]) {
      expect(existsSync(sharePath(i))).toBe(true);
      expect(existsSync(pendingPath(sharePath(i)))).toBe(false);
    }
  }, REAL_STAGER_TEST_MS);

  it('a stalled confirmation pull deletes no staged share; completed nodes keep their committed shares', async () => {
    const stagers = [0, 1, 2].map(i => stagerFor(i));
    const sigs = signals();
    let othersSettled = false;
    // Node 2 cannot get node 0's confirmation: the pull stalls, then the connection fails.
    const pull = ring[2]!.io.transport.pull.bind(ring[2]!.io.transport);
    ring[2]!.io.transport.pull = async key => {
      if (key.round === DKG_ROUNDS.verified && key.from === 0) {
        if (othersSettled) throw new Error('connection to party 0 lost');
        return null;
      }
      return pull(key);
    };

    const others = Promise.allSettled([0, 1].map(i => runDkgCeremony(ring[i]!.io, spec, stagers[i]!, sigs[i])));
    const third = runDkgCeremony(ring[2]!.io, spec, stagers[2]!, sigs[2]).then(
      v => ({ status: 'fulfilled' as const, value: v }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    const done = await others;
    othersSettled = true;
    const out2 = await third;

    // Nodes 0 and 1 had every confirmation and committed.
    for (const o of done) expect(o.status).toBe('fulfilled');
    for (const i of [0, 1]) {
      expect(existsSync(sharePath(i))).toBe(true);
      expect(existsSync(pendingPath(sharePath(i)))).toBe(false);
    }
    // Node 2 failed after publishing its confirmation: it kept its staged share and says where.
    expect(existsSync(pendingPath(sharePath(2))), 'node 2 deleted its staged share').toBe(true);
    const err = keptError(out2);
    expect(err.reason).toMatch(/connection to party 0 lost/);
    expect(err.message).toContain(pendingPath(sharePath(2)));
    expect(existsSync(sharePath(2))).toBe(false);
    const internalKey = toVaultKey((done[0] as PromiseFulfilledResult<DkgCeremonyResult>).value.publicKeyPackage)
      .untweakedVerifyingKey;
    await expectNoLostShare(internalKey);

    // The recovery the error names: move the staged share into place; it loads.
    await rename(pendingPath(sharePath(2)), sharePath(2));
    expect((await loadVaultShare(sharePath(2), 'pw', 'testnet4'))!.partyId).toBe(2);
  }, REAL_STAGER_TEST_MS);

  it('a later DKG that fails before staging leaves the share a node kept (ruling R41, no lost share)', async () => {
    const stagers = [0, 1, 2].map(i => stagerFor(i));
    const sigs = signals();
    let othersSettled = false;
    // Node 2 cannot get node 0's confirmation: nodes 0 and 1 commit the vault, node 2 keeps its .pending.
    const pull = ring[2]!.io.transport.pull.bind(ring[2]!.io.transport);
    ring[2]!.io.transport.pull = async key => {
      if (key.round === DKG_ROUNDS.verified && key.from === 0) {
        if (othersSettled) throw new Error('connection to party 0 lost');
        return null;
      }
      return pull(key);
    };
    const others = Promise.allSettled([0, 1].map(i => runDkgCeremony(ring[i]!.io, spec, stagers[i]!, sigs[i])));
    const third = runDkgCeremony(ring[2]!.io, spec, stagers[2]!, sigs[2]).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    for (const o of await others) expect(o.status).toBe('fulfilled');
    othersSettled = true;
    expect(await third).toBeInstanceOf(DkgShareKeptError);
    const keptBefore = readFileSync(pendingPath(sharePath(2)));

    // Node 2 now runs (or joins) another DKG that the committed nodes do not take part in: they drop the
    // announce, so its pulls of dkg-r1 fail before anything is staged. The kept share must survive.
    ring[2]!.io.transport.pull = pull;
    Object.assign(ring[2]!.io.pullOpts, { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, deadlineMs: 300 });
    const later: DkgCeremonySpec = { ...spec, ceremonyId: 'dkg-test.2', sessionId: crypto.getRandomValues(new Uint8Array(32)) };
    await expect(runDkgCeremony(ring[2]!.io, later, stagerFor(2))).rejects.toThrow(/^DKG aborted: .*dkg-r1/);

    expect(existsSync(pendingPath(sharePath(2))), 'a failed later DKG deleted the share node 2 kept').toBe(true);
    expect(readFileSync(pendingPath(sharePath(2))).equals(keptBefore)).toBe(true);
    expect(existsSync(sharePath(2))).toBe(false);
    const internalKey = await internalKeyAt(sharePath(0));
    await expectNoLostShare(internalKey);
  }, REAL_STAGER_TEST_MS);

  it('a node that hears signoff-aborted after its own confirmation keeps its staged share', async () => {
    const stagers = [0, 1, 2].map(i => stagerFor(i));
    // Node 0 sends the abort, as a failing node would; its own ceremony stops with it.
    const sender = new AbortController();
    const sigs = signals().map((s, i) => (i === 0 ? AbortSignal.any([s, sender.signal]) : s));
    // Node 1 waits for node 2's confirmation; meanwhile node 0 announces an abort.
    const pull = ring[1]!.io.transport.pull.bind(ring[1]!.io.transport);
    ring[1]!.io.transport.pull = async key =>
      key.round === DKG_ROUNDS.verified && key.from === 2 ? null : pull(key);

    const all = Promise.allSettled(ring.map((n, i) => runDkgCeremony(n.io, spec, stagers[i]!, sigs[i])));
    await vi.waitFor(
      () => expect(ring[1]!.io.store.has({ ceremonyId, round: DKG_ROUNDS.verified, from: 1 })).toBe(true),
      { timeout: 15_000, interval: 5 },
    );
    sender.abort();
    await ring[0]!.io.transport.broadcast(
      encodeMessage({ v: 2, kind: 'signoff-aborted', ceremonyId, reason: 'operator abort' }),
    );
    const out = await all;

    expect(existsSync(pendingPath(sharePath(1))), 'node 1 deleted its staged share').toBe(true);
    const err = keptError(out[1]);
    expect(err.reason).toBe('aborted');
    expect(existsSync(sharePath(1))).toBe(false);
    // Whatever the others did: a node that published its confirmation still holds its share
    // (committed or staged); one that had not has discarded its staged share.
    for (const i of [0, 2]) {
      const confirmed = ring[i]!.io.store.has({ ceremonyId, round: DKG_ROUNDS.verified, from: i });
      const holds = existsSync(sharePath(i)) || existsSync(pendingPath(sharePath(i)));
      expect(holds, `node ${i} (confirmed: ${confirmed})`).toBe(confirmed);
    }
  }, REAL_STAGER_TEST_MS);
});

