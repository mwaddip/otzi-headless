import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ShareStager } from '../core/dkg-ceremony';
import { parseMessage, type CeremonyMessage } from '../core/messages';
import type { BlobKey, PartyId } from '../core/types';
import { AutoGate } from '../gate/factory';
import type { ApprovalGate, CeremonySpec, Decision } from '../gate/types';
import { Orchestrator } from '../orchestrator/orchestrator';
import { rng } from '../otzi/lib/dkg.fixture';
import type { DecryptedShare } from '../otzi/lib/share-file';
import type { NetworkName } from '../otzi/lib/vault-types';
import { makeProposal, testVault, type TestVault } from '../testing/proposal';
import { makeRing, type RingNode } from '../testing/ring';
import { NO_VAULT_MESSAGE, RequestError } from './api';
import { GateRejection, LeaderDispatcher, type LeaderDeps, type LocalCeremonySlots } from './leader';

const NET: NetworkName = 'testnet4';
const peersById: ReadonlyMap<PartyId, string> = new Map([
  [0, 'node-0'],
  [1, 'node-1'],
  [2, 'node-2'],
]);
/**
 * A pull budget that would give up at once. The leader must replace it with
 * the ceremony deadline (R11), so a failure reads "Deadline exceeded".
 */
const ONE_ATTEMPT = { maxAttempts: 1, initialDelayMs: 5, maxDelayMs: 20, deadlineMs: 60_000 };
const DEADLINE_MS = 400;
const RETENTION_MS = 40;

let tv: TestVault;
beforeAll(() => {
  tv = testVault(3, 3);
});

function shareOf(partyId: PartyId): DecryptedShare {
  return {
    network: NET,
    internalKey: tv.vaultKey.untweakedVerifyingKey,
    partyId,
    threshold: 3,
    parties: 3,
    keyPackage: tv.keyPackages[partyId]!,
    publicKeyPackage: tv.publicKeyPackage,
  };
}

interface SlotRecord {
  slots: LocalCeremonySlots;
  dkgIds: string[];
  signingIds: string[];
  dkgEnds: number;
  signingEnds: number;
}

function fakeSlots(opts: { dkg?: 'busy' | AbortSignal; signing?: 'busy'; inUse?: string[] } = {}): SlotRecord {
  const r: SlotRecord = {
    dkgIds: [],
    signingIds: [],
    dkgEnds: 0,
    signingEnds: 0,
    slots: {
      ceremonyIdInUse: id => opts.inUse?.includes(id) ?? false,
      beginLocalDkg(id) {
        r.dkgIds.push(id);
        if (opts.dkg === 'busy') return null;
        const signal = opts.dkg ?? new AbortController().signal;
        return { signal, end: () => void r.dkgEnds++ };
      },
      beginLocalSigning(id) {
        r.signingIds.push(id);
        if (opts.signing === 'busy') return null;
        return { end: () => void r.signingEnds++ };
      },
    },
  };
  return r;
}

class FixedGate implements ApprovalGate {
  readonly specs: CeremonySpec[] = [];
  constructor(private readonly decide: () => Promise<Decision>) {}
  approve(spec: CeremonySpec): Promise<Decision> {
    this.specs.push(spec);
    return this.decide();
  }
}

function recordingStager(): ShareStager & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async stage() {
      calls.push('stage');
    },
    async commit() {
      calls.push('commit');
    },
    async discard() {
      calls.push('discard');
    },
  };
}

/** Every ceremony message `node` receives. */
function inbox(node: RingNode): CeremonyMessage[] {
  const msgs: CeremonyMessage[] = [];
  node.io.transport.onBroadcast((_from, bytes) => {
    const m = parseMessage(bytes);
    if (m) msgs.push(m);
  });
  return msgs;
}

function leaderOn(node: RingNode, over: Partial<LeaderDeps> = {}): LeaderDispatcher {
  return new LeaderDispatcher({
    io: node.io,
    gate: new AutoGate(),
    node: { id: peersById.get(node.partyId)!, partyId: node.partyId },
    peersById,
    network: NET,
    vault: shareOf(node.partyId),
    vaultExists: async () => false,
    createStager: () => recordingStager(),
    rng,
    ceremonyDeadlines: { signingMs: DEADLINE_MS, dkgMs: DEADLINE_MS },
    slots: fakeSlots().slots,
    blobRetentionMs: { signing: RETENTION_MS, dkg: RETENTION_MS },
    ...over,
  });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('LeaderDispatcher.sign', () => {
  it('refuses before announcing: no vault, failed analysis, gate non-approve', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots();
    const proposal = makeProposal(tv.vaultKey, NET);
    const req = { ceremonyId: 'pay-1', signers: [0, 1, 2], proposal };

    const noVault = await rejection(leaderOn(ring[0]!, { vault: undefined, slots: slots.slots }).sign(req));
    expect(noVault).toBeInstanceOf(RequestError);
    expect(noVault).toMatchObject({ status: 409, message: NO_VAULT_MESSAGE });

    const foreign = makeProposal(tv.vaultKey, NET, { inputs: [{ amount: 100_000, script: `5120${'11'.repeat(32)}` }] });
    const badInput = await rejection(leaderOn(ring[0]!, { slots: slots.slots }).sign({ ...req, proposal: foreign }));
    expect(badInput).toMatchObject({ status: 400, message: 'Input 0 does not spend a coin of this vault' });

    for (const [decide, decision] of [
      [async () => 'reject' as const, 'reject'],
      [async () => 'pending' as const, 'pending'],
      [async () => Promise.reject(new Error('approver down')), 'reject'],
    ] as const) {
      const gate = new FixedGate(decide);
      const err = await rejection(leaderOn(ring[0]!, { gate, slots: slots.slots }).sign(req));
      expect(err).toBeInstanceOf(GateRejection);
      expect(err).toMatchObject({ ceremonyId: 'pay-1', decision });
      expect(gate.specs).toHaveLength(1);
      expect(gate.specs[0]).toMatchObject({ kind: 'signing', ceremonyId: 'pay-1', leader: 'node-0', role: 'leader' });
    }

    expect(slots.signingIds).toEqual([]);
    expect(seen).toEqual([]);
    expect(ring[0]!.io.store.list('pay-1')).toEqual([]);
  });

  it('refuses a ceremony id already in use on this node, before announcing', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots({ signing: 'busy' });
    const err = await rejection(
      leaderOn(ring[0]!, { slots: slots.slots }).sign({
        ceremonyId: 'pay-2',
        signers: [0, 1, 2],
        proposal: makeProposal(tv.vaultKey, NET),
      }),
    );
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ status: 409, message: 'ceremony id pay-2 is already in use on this node' });
    expect(slots.signingIds).toEqual(['pay-2']);
    expect(seen).toEqual([]);
  });

  it('a failure after the announce broadcasts signoff-aborted, ends the slot and clears the blobs', async () => {
    const ring = makeRing(3, ONE_ATTEMPT);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots();
    const leader = leaderOn(ring[0]!, { slots: slots.slots });
    const started = Date.now();

    // Nobody else takes part: the round-1 pull runs until the signing deadline.
    const err = await rejection(
      leader.sign({ ceremonyId: 'pay-3', signers: [0, 1, 2], proposal: makeProposal(tv.vaultKey, NET) }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`ceremony deadline of ${DEADLINE_MS} ms passed`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 50);

    expect(seen.map(m => m.kind)).toEqual(['announce-sign', 'signoff-aborted']);
    const aborted = seen[1]!;
    expect(aborted).toMatchObject({ ceremonyId: 'pay-3', reason: (err as Error).message });
    expect(slots.signingEnds).toBe(1);

    // The leader's own sign-r1 is kept for the retention period, then cleared.
    expect(ring[0]!.io.store.list('pay-3').map(b => b.key.round)).toEqual(['sign-r1']);
    await vi.waitFor(() => expect(ring[0]!.io.store.list('pay-3')).toEqual([]), { timeout: 2_000, interval: 10 });
  });

  it('caps the signoff-aborted reason at 1024 characters', async () => {
    const ring = makeRing(3, ONE_ATTEMPT);
    const seen = inbox(ring[1]!);
    // A transport failure with a long message, past the announce.
    ring[0]!.io.transport.pull = async () => {
      throw new Error(`transport down: ${'y'.repeat(2_000)}`);
    };
    const err = await rejection(
      leaderOn(ring[0]!).sign({ ceremonyId: 'pay-4', signers: [0, 1, 2], proposal: makeProposal(tv.vaultKey, NET) }),
    );
    expect((err as Error).message.length).toBeGreaterThan(1024);
    const aborted = seen.find(m => m.kind === 'signoff-aborted');
    expect(aborted).toBeDefined();
    expect(aborted!.kind === 'signoff-aborted' && aborted!.reason).toBe((err as Error).message.slice(0, 1024));
  });
});

describe('LeaderDispatcher.runDkg', () => {
  it('refuses when a vault is loaded, a DKG is running, or a share file exists', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);

    const loaded = fakeSlots();
    const withVault = await rejection(leaderOn(ring[0]!, { slots: loaded.slots }).runDkg({ ceremonyId: 'gen-1' }));
    expect(withVault).toBeInstanceOf(RequestError);
    expect(withVault).toMatchObject({ status: 409, message: 'this node already holds a vault' });
    expect(loaded.dkgIds).toEqual([]);

    const reused = fakeSlots({ inUse: ['gen-1b'] });
    const inUse = await rejection(
      leaderOn(ring[0]!, { vault: undefined, slots: reused.slots }).runDkg({ ceremonyId: 'gen-1b' }),
    );
    expect(inUse).toMatchObject({ status: 409, message: 'ceremony id gen-1b is already in use on this node' });
    expect(reused.dkgIds).toEqual([]);

    const busy = fakeSlots({ dkg: 'busy' });
    const running = await rejection(
      leaderOn(ring[0]!, { vault: undefined, slots: busy.slots }).runDkg({ ceremonyId: 'gen-2' }),
    );
    expect(running).toMatchObject({ status: 409, message: 'a DKG is already running on this node' });

    const onDisk = fakeSlots();
    const fileExists = await rejection(
      leaderOn(ring[0]!, { vault: undefined, vaultExists: async () => true, slots: onDisk.slots }).runDkg({
        ceremonyId: 'gen-3',
      }),
    );
    expect(fileExists).toMatchObject({ status: 409, message: 'this node already holds a vault' });
    expect(onDisk.dkgIds).toEqual(['gen-3']);
    expect(onDisk.dkgEnds).toBe(1);

    expect(seen).toEqual([]);
  });

  it('gates an n-of-n DKG spec as leader; a rejection announces nothing and ends the slot', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots();
    const gate = new FixedGate(async () => 'reject');
    const err = await rejection(
      leaderOn(ring[0]!, { vault: undefined, gate, slots: slots.slots }).runDkg({ ceremonyId: 'gen-4' }),
    );
    expect(err).toBeInstanceOf(GateRejection);
    expect(err).toMatchObject({ ceremonyId: 'gen-4', decision: 'reject' });
    expect(gate.specs).toEqual([
      {
        kind: 'dkg',
        ceremonyId: 'gen-4',
        leader: 'node-0',
        role: 'leader',
        threshold: 3,
        parties: 3,
        network: NET,
        peerIds: ['node-0', 'node-1', 'node-2'],
      },
    ]);
    expect(slots.dkgEnds).toBe(1);
    expect(seen).toEqual([]);
  });

  it('runs the ceremony under the slot signal and ends the slot', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const controller = new AbortController();
    controller.abort();
    const slots = fakeSlots({ dkg: controller.signal });
    const stager = recordingStager();
    const err = await rejection(
      leaderOn(ring[0]!, { vault: undefined, slots: slots.slots, createStager: () => stager }).runDkg({
        ceremonyId: 'gen-5',
      }),
    );
    expect((err as Error).message).toBe('DKG aborted: aborted');
    // Announced, then stopped by the slot's signal: no signoff-aborted of its own.
    expect(seen.map(m => m.kind)).toEqual(['announce-dkg']);
    expect(seen[0]).toMatchObject({ ceremonyId: 'gen-5', threshold: 3, parties: 3, network: NET });
    expect(stager.calls).toEqual(['discard']);
    expect(slots.dkgEnds).toBe(1);
  });

  it('pulls until the DKG deadline, then aborts and clears the blobs', async () => {
    const ring = makeRing(3, ONE_ATTEMPT);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots();
    const started = Date.now();
    const err = await rejection(leaderOn(ring[0]!, { vault: undefined, slots: slots.slots }).runDkg({ ceremonyId: 'gen-6' }));
    expect((err as Error).message).toBe(`DKG aborted: ceremony deadline of ${DEADLINE_MS} ms passed`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(seen.map(m => m.kind)).toEqual(['announce-dkg', 'signoff-aborted']);
    expect(seen[1]).toMatchObject({ ceremonyId: 'gen-6', reason: `ceremony deadline of ${DEADLINE_MS} ms passed` });
    expect(slots.dkgEnds).toBe(1);
    expect(ring[0]!.io.store.list('gen-6').map(b => b.key.round)).toEqual(['dkg-r1']);
    await vi.waitFor(() => expect(ring[0]!.io.store.list('gen-6')).toEqual([]), { timeout: 2_000, interval: 10 });
  });
});

// ─── Ceremony deadline (R26) ─────────────────────────────────────────────

describe('LeaderDispatcher ceremony deadline', () => {
  const CEREMONY_MS = 1_000;
  /** Node 1's round-1 blob reaches the leader this late; per-pull deadlines alone would fail at ≥ 1 700 ms. */
  const LATE_MS = 700;
  const cosigners: Orchestrator[] = [];
  afterEach(() => {
    for (const o of cosigners.splice(0)) o.stop();
  });

  function cosigner(node: RingNode, vault?: DecryptedShare): Orchestrator {
    const orch = new Orchestrator({
      io: node.io,
      gate: new AutoGate(),
      node: { id: peersById.get(node.partyId)!, partyId: node.partyId },
      peersById,
      network: NET,
      vault,
      vaultExists: async () => false,
      createStager: () => recordingStager(),
      rng,
      ceremonyDeadlines: { signingMs: 10_000, dkgMs: 10_000 },
    });
    orch.start();
    cosigners.push(orch);
    return orch;
  }

  /** The leader does not get `held` blobs from its peers while `held` says so. */
  function holdBack(node: RingNode, held: (key: BlobKey) => boolean): void {
    const pull = node.io.transport.pull.bind(node.io.transport);
    node.io.transport.pull = async key => (held(key) ? null : pull(key));
  }

  it('a leader whose co-signer never answers round 2 fails at the signing deadline', async () => {
    const ring = makeRing(3, ONE_ATTEMPT);
    const [c1, c2] = [cosigner(ring[1]!, shareOf(1)), cosigner(ring[2]!, shareOf(2))];
    const slots = fakeSlots();
    const leader = leaderOn(ring[0]!, { slots: slots.slots, ceremonyDeadlines: { signingMs: CEREMONY_MS, dkgMs: CEREMONY_MS } });
    const started = Date.now();
    holdBack(
      ring[0]!,
      k => k.from === 1 && (k.round === 'sign-r2' || (k.round === 'sign-r1' && Date.now() - started < LATE_MS)),
    );

    const err = await rejection(
      leader.sign({ ceremonyId: 'pay-late', signers: [0, 1, 2], proposal: makeProposal(tv.vaultKey, NET) }),
    );
    const elapsed = Date.now() - started;
    expect((err as Error).message).toBe(`ceremony deadline of ${CEREMONY_MS} ms passed`);
    expect(elapsed).toBeGreaterThanOrEqual(CEREMONY_MS - 50);
    expect(elapsed).toBeLessThan(LATE_MS + CEREMONY_MS - 300);
    // The leader got past round 1 (it produced its own sign-r2) before the deadline stopped it.
    expect(ring[0]!.io.store.has({ ceremonyId: 'pay-late', round: 'sign-r2', from: 0 })).toBe(true);
    expect(slots.signingEnds).toBe(1);
    for (const c of [c1, c2]) {
      expect(await c.waitFor('pay-late', 5_000)).toMatchObject({
        status: 'aborted',
        reason: `ceremony deadline of ${CEREMONY_MS} ms passed`,
      });
    }
  });

  it('a leader whose co-signer never answers DKG round 2 fails at the DKG deadline', async () => {
    const ring = makeRing(3, ONE_ATTEMPT);
    const [c1, c2] = [cosigner(ring[1]!), cosigner(ring[2]!)];
    const slots = fakeSlots();
    const stager = recordingStager();
    const leader = leaderOn(ring[0]!, {
      vault: undefined,
      slots: slots.slots,
      createStager: () => stager,
      ceremonyDeadlines: { signingMs: CEREMONY_MS, dkgMs: CEREMONY_MS },
    });
    const started = Date.now();
    holdBack(
      ring[0]!,
      k => k.from === 1 && (k.round === 'dkg-r2' || (k.round === 'dkg-r1' && Date.now() - started < LATE_MS)),
    );

    const err = await rejection(leader.runDkg({ ceremonyId: 'gen-late' }));
    const elapsed = Date.now() - started;
    expect((err as Error).message).toBe(`DKG aborted: ceremony deadline of ${CEREMONY_MS} ms passed`);
    expect(elapsed).toBeGreaterThanOrEqual(CEREMONY_MS - 50);
    expect(elapsed).toBeLessThan(LATE_MS + CEREMONY_MS - 300);
    // Round 1 completed (the leader produced its round-2 shares) before the deadline stopped it.
    expect(ring[0]!.io.store.list('gen-late', 'dkg-r2').filter(b => b.key.from === 0)).toHaveLength(2);
    expect(stager.calls).toEqual(['discard']);
    expect(slots.dkgEnds).toBe(1);
    // The leader announced the abort itself: the ceremony's own abort path stays silent on a signal.
    for (const c of [c1, c2]) {
      expect(await c.waitFor('gen-late', 5_000)).toMatchObject({
        status: 'aborted',
        reason: `ceremony deadline of ${CEREMONY_MS} ms passed`,
      });
    }
  });
});
