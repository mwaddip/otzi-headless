import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DkgShareKeptError, type ShareStager } from '../core/dkg-ceremony';
import { setInMemoryPartition } from '../core/in-memory-transport';
import { parseMessage, type CeremonyMessage } from '../core/messages';
import type { BlobKey, PartyId } from '../core/types';
import { AutoGate } from '../gate/factory';
import { PolicyGate } from '../gate/policy';
import type { ApprovalGate, CeremonySpec, Decision } from '../gate/types';
import { MAX_LIVE_SIGNINGS_PER_LEADER, Orchestrator } from '../orchestrator/orchestrator';
import { rng } from '../otzi/lib/dkg.fixture';
import type { DecryptedShare } from '../otzi/lib/share-file';
import type { NetworkName } from '../otzi/lib/vault-types';
import { makeProposal, testVault, type TestVault } from '../testing/proposal';
import { makeRing, type RingNode } from '../testing/ring';
import { NO_VAULT_MESSAGE, RequestError } from './api';
import { GateRejection, LeaderDispatcher, type LeaderDeps, type LocalCeremonySlots } from './leader';

// Records blob-clear scheduling next to slot ends, to pin their order.
const order = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('../core/blob-retention', async importOriginal => {
  const actual = await importOriginal<typeof import('../core/blob-retention')>();
  return {
    ...actual,
    scheduleClear: (...args: Parameters<typeof actual.scheduleClear>) => {
      order.events.push(`clear ${args[1]}`);
      actual.scheduleClear(...args);
    },
  };
});

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
/**
 * A deadline for DKGs that must get past staging, confirmation or commit
 * before it passes: they take about 0.4 s idle and 1.1 s with the CPU
 * oversubscribed twice over.
 */
const LOADED_DKG_MS = 4_000;
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
        return {
          signal,
          end: () => {
            r.dkgEnds++;
            order.events.push(`end ${id}`);
          },
        };
      },
      beginLocalSigning(id) {
        r.signingIds.push(id);
        if (opts.signing === 'busy') return null;
        return {
          end: () => {
            r.signingEnds++;
            order.events.push(`end ${id}`);
          },
        };
      },
    },
  };
  return r;
}

/** Records every spec, then defers to `inner`. */
class RecordingGate implements ApprovalGate {
  readonly specs: CeremonySpec[] = [];
  constructor(private readonly inner: ApprovalGate) {}
  approve(spec: CeremonySpec): Promise<Decision> {
    this.specs.push(spec);
    return this.inner.approve(spec);
  }
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
    sharePath: '/test/share.json',
    stagedPath: '/test/share.json.pending',
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

const cosigners: Orchestrator[] = [];
afterEach(() => {
  for (const o of cosigners.splice(0)) o.stop();
});

/** A real participant orchestrator on `node` (for the leader's own node: its ceremony slots). */
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

  it('refuses a ceremony id in use before analysis and the gate', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots({ inUse: ['pay-used'] });
    const gate = new RecordingGate(new AutoGate());
    const foreign = makeProposal(tv.vaultKey, NET, { inputs: [{ amount: 100_000, script: `5120${'11'.repeat(32)}` }] });
    // Even a proposal that analysis would reject is refused for its id first.
    const err = await rejection(
      leaderOn(ring[0]!, { gate, slots: slots.slots }).sign({ ceremonyId: 'pay-used', signers: [0, 1, 2], proposal: foreign }),
    );
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ status: 409, message: 'ceremony id pay-used is already in use on this node' });
    expect(gate.specs).toEqual([]);
    expect(slots.signingIds).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('refuses a ceremony id taken while the gate deliberated, before announcing', async () => {
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

    // The clear is scheduled before the slot ends, so the id never comes free first.
    expect(order.events.filter(e => e.endsWith(' pay-3'))).toEqual(['clear pay-3', 'end pay-3']);
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
    expect(order.events.filter(e => e.endsWith(' gen-6'))).toEqual(['clear gen-6', 'end gen-6']);
    expect(ring[0]!.io.store.list('gen-6').map(b => b.key.round)).toEqual(['dkg-r1']);
    await vi.waitFor(() => expect(ring[0]!.io.store.list('gen-6')).toEqual([]), { timeout: 2_000, interval: 10 });
  });
});

// ─── Ceremony deadline (R26) ─────────────────────────────────────────────

describe('LeaderDispatcher ceremony deadline', () => {
  const CEREMONY_MS = 2_000;
  /**
   * Node 1's round-1 blob reaches the leader this late. A per-pull or per-round
   * deadline would then fail at least CEREMONY_MS after round 1 completes; the
   * ceremony deadline fails CEREMONY_MS after the start. Both margins (round 1
   * done before the deadline; the failure well under CEREMONY_MS after round 1)
   * are 1 s, many times what round 1 takes even under CPU load.
   */
  const LATE_MS = 1_000;
  /** The leader does not get `held` blobs from its peers while `held` says so. */
  function holdBack(node: RingNode, held: (key: BlobKey) => boolean): void {
    const pull = node.io.transport.pull.bind(node.io.transport);
    node.io.transport.pull = async key => (held(key) ? null : pull(key));
  }
  /** When `node` first stores a blob `matches` accepts (epoch ms), or null while it has not. */
  function firstStored(node: RingNode, matches: (key: BlobKey) => boolean): { at: number | null } {
    const seen: { at: number | null } = { at: null };
    node.io.store.onPut(key => {
      if (seen.at === null && matches(key)) seen.at = Date.now();
    });
    return seen;
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
    const round1Done = firstStored(ring[0]!, k => k.ceremonyId === 'pay-late' && k.round === 'sign-r2' && k.from === 0);

    const err = await rejection(
      leader.sign({ ceremonyId: 'pay-late', signers: [0, 1, 2], proposal: makeProposal(tv.vaultKey, NET) }),
    );
    const failedAt = Date.now();
    expect((err as Error).message).toBe(`ceremony deadline of ${CEREMONY_MS} ms passed`);
    expect(failedAt - started).toBeGreaterThanOrEqual(CEREMONY_MS - 50);
    // The leader got past round 1 (it produced its own sign-r2) before the deadline stopped it,
    // and failed less than CEREMONY_MS after that: the deadline runs from the start, not per pull.
    expect(ring[0]!.io.store.has({ ceremonyId: 'pay-late', round: 'sign-r2', from: 0 })).toBe(true);
    expect(round1Done.at).not.toBeNull();
    expect(round1Done.at! - started).toBeGreaterThanOrEqual(LATE_MS);
    expect(failedAt - round1Done.at!).toBeLessThan(CEREMONY_MS);
    expect(slots.signingEnds).toBe(1);
    for (const c of [c1, c2]) {
      expect(await c.waitFor('pay-late', 5_000)).toMatchObject({
        status: 'aborted',
        reason: `ceremony deadline of ${CEREMONY_MS} ms passed`,
      });
    }
  }, 20_000);

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
    const round1Done = firstStored(ring[0]!, k => k.ceremonyId === 'gen-late' && k.round === 'dkg-r2' && k.from === 0);

    const err = await rejection(leader.runDkg({ ceremonyId: 'gen-late' }));
    const failedAt = Date.now();
    expect((err as Error).message).toBe(`DKG aborted: ceremony deadline of ${CEREMONY_MS} ms passed`);
    expect(failedAt - started).toBeGreaterThanOrEqual(CEREMONY_MS - 50);
    // Round 1 completed (the leader produced its round-2 shares) before the deadline stopped it,
    // and the DKG failed less than CEREMONY_MS after that: the deadline runs from the start, not per pull.
    expect(ring[0]!.io.store.list('gen-late', 'dkg-r2').filter(b => b.key.from === 0)).toHaveLength(2);
    expect(round1Done.at).not.toBeNull();
    expect(round1Done.at! - started).toBeGreaterThanOrEqual(LATE_MS);
    expect(failedAt - round1Done.at!).toBeLessThan(CEREMONY_MS);
    expect(stager.calls).toEqual(['discard']);
    expect(slots.dkgEnds).toBe(1);
    // The leader announced the abort itself: the ceremony's own abort path stays silent on a signal.
    for (const c of [c1, c2]) {
      expect(await c.waitFor('gen-late', 5_000)).toMatchObject({
        status: 'aborted',
        reason: `ceremony deadline of ${CEREMONY_MS} ms passed`,
      });
    }
  }, 20_000);
});

describe('LeaderDispatcher: a DKG that fails after its confirmation', () => {
  it('fails at the deadline saying where the staged share was kept, and keeps it', async () => {
    const ring = makeRing(3);
    const [c1, c2] = [cosigner(ring[1]!), cosigner(ring[2]!)];
    const stager = recordingStager();
    const lines: string[] = [];
    const leader = leaderOn(ring[0]!, {
      vault: undefined,
      slots: fakeSlots().slots,
      createStager: () => stager,
      ceremonyDeadlines: { signingMs: LOADED_DKG_MS, dkgMs: LOADED_DKG_MS },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: msg => lines.push(msg) },
    });
    // The leader never gets party 1's confirmation; the co-signers get every one and commit.
    const pull = ring[0]!.io.transport.pull.bind(ring[0]!.io.transport);
    ring[0]!.io.transport.pull = async key => (key.round === 'dkg-verified' && key.from === 1 ? null : pull(key));

    const err = await rejection(leader.runDkg({ ceremonyId: 'gen-kept' }));

    expect(err).toBeInstanceOf(DkgShareKeptError);
    expect((err as Error).message).toMatch(
      new RegExp(
        `^DKG aborted: ceremony deadline of ${LOADED_DKG_MS} ms passed; this node published its confirmation of vault tb1p[0-9a-z]+, ` +
          `so its staged share was kept at /test/share\\.json\\.pending: run 'otzi vault' on the other nodes`,
      ),
    );
    expect(stager.calls).toEqual(['stage']);
    expect(lines).toEqual([`leader: dkg gen-kept failed: ${(err as Error).message}`]);
    for (const c of [c1, c2]) expect(await c.waitFor('gen-kept', 5_000)).toMatchObject({ status: 'done' });
  }, 20_000);
});

describe('LeaderDispatcher: the deadline does not hide the failure that was thrown', () => {
  const DKG_MS = LOADED_DKG_MS;
  const deadlines = { signingMs: DKG_MS, dkgMs: DKG_MS };

  /** Resolves when the leader's own ceremony deadline fires. */
  function deadlinePassed(leader: LeaderDispatcher): Promise<void> {
    const internals = leader as unknown as { startDeadline(kind: string): { signal: AbortSignal } };
    const startDeadline = internals.startDeadline.bind(leader);
    return new Promise(resolve => {
      internals.startDeadline = kind => {
        const deadline = startDeadline(kind);
        deadline.signal.addEventListener('abort', () => resolve(), { once: true });
        return deadline;
      };
    });
  }

  it('a DKG whose staging fails as the deadline passes names both', async () => {
    const ring = makeRing(3);
    cosigner(ring[1]!);
    cosigner(ring[2]!);
    const stager = recordingStager();
    const leader = leaderOn(ring[0]!, {
      vault: undefined,
      slots: fakeSlots().slots,
      createStager: () => stager,
      ceremonyDeadlines: deadlines,
    });
    const passed = deadlinePassed(leader);
    stager.stage = async () => {
      stager.calls.push('stage');
      await passed; // the failure strikes once the deadline has passed
      throw new Error('disk full');
    };

    const err = await rejection(leader.runDkg({ ceremonyId: 'gen-disk' }));

    expect((err as Error).message).toBe(`DKG aborted: ceremony deadline of ${DKG_MS} ms passed (disk full)`);
    expect(((err as Error).cause as Error).message).toBe('DKG aborted: disk full');
  }, 20_000);

  it('a kept share is reported with the failure that was thrown and the recovery', async () => {
    const ring = makeRing(3);
    cosigner(ring[1]!);
    cosigner(ring[2]!);
    const stager = recordingStager();
    const leader = leaderOn(ring[0]!, {
      vault: undefined,
      slots: fakeSlots().slots,
      createStager: () => stager,
      ceremonyDeadlines: deadlines,
    });
    const passed = deadlinePassed(leader);
    stager.commit = async () => {
      stager.calls.push('commit');
      await passed;
      throw new Error('share path already exists: /test/share.json');
    };

    const err = await rejection(leader.runDkg({ ceremonyId: 'gen-exists' }));

    expect(err).toBeInstanceOf(DkgShareKeptError);
    expect((err as Error).message).toMatch(
      new RegExp(
        `^DKG aborted: ceremony deadline of ${DKG_MS} ms passed \\(share path already exists: /test/share\\.json\\); ` +
          `this node published its confirmation of vault tb1p[0-9a-z]+, so its staged share was kept at /test/share\\.json\\.pending: `,
      ),
    );
    expect(stager.calls).toEqual(['stage', 'commit']);
  }, 20_000);
});

describe('LeaderDispatcher with this node\'s orchestrator as its slots', () => {
  it('a reused ceremony id never reaches the gate: no rate-window approval is consumed', async () => {
    const ring = makeRing(3);
    const own = cosigner(ring[0]!, shareOf(0));
    const [c1, c2] = [cosigner(ring[1]!, shareOf(1)), cosigner(ring[2]!, shareOf(2))];
    const gate = new RecordingGate(new PolicyGate({ maxCeremoniesPerHour: 1 }));
    const leader = leaderOn(ring[0]!, { gate, slots: own, ceremonyDeadlines: { signingMs: 10_000, dkgMs: 10_000 } });
    const req = () => ({ ceremonyId: 'pay-once', signers: [0, 1, 2], proposal: makeProposal(tv.vaultKey, NET) });

    const first = await leader.sign(req());
    expect(first.txid).toMatch(/^[0-9a-f]{64}$/);
    for (const c of [c1, c2]) expect(await c.waitFor('pay-once', 5_000)).toMatchObject({ status: 'done' });

    const again = await rejection(leader.sign(req()));
    expect(again).toBeInstanceOf(RequestError);
    expect(again).toMatchObject({ status: 409, message: 'ceremony id pay-once is already in use on this node' });
    expect(gate.specs).toHaveLength(1);
  });
});

describe('LeaderDispatcher: a ring that is not connected (fail fast)', () => {
  it('sign answers 503 naming a signer that is not connected, before the gate and the announce', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const slots = fakeSlots();
    const gate = new RecordingGate(new AutoGate());
    setInMemoryPartition(ring[0]!.io.transport, 2, true);

    const err = await rejection(
      leaderOn(ring[0]!, { gate, slots: slots.slots }).sign({
        ceremonyId: 'pay-dc',
        signers: [0, 1, 2],
        proposal: makeProposal(tv.vaultKey, NET),
      }),
    );
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ status: 503, message: 'signer 2 is not connected; retry when the ring is connected' });
    expect(gate.specs).toEqual([]);
    expect(slots.signingIds).toEqual([]);
    expect(seen).toEqual([]);
    expect(ring[0]!.io.store.list('pay-dc')).toEqual([]);
  });

  it('names the first signer that is not connected, in signers order', async () => {
    const ring = makeRing(3);
    setInMemoryPartition(ring[0]!.io.transport, 1, true);
    setInMemoryPartition(ring[0]!.io.transport, 2, true);
    const err = await rejection(
      leaderOn(ring[0]!).sign({ ceremonyId: 'pay-dc2', signers: [0, 2, 1], proposal: makeProposal(tv.vaultKey, NET) }),
    );
    expect(err).toMatchObject({ status: 503, message: 'signer 2 is not connected; retry when the ring is connected' });
  });

  it('a 503 consumes no approval: once the ring reconnects the same request signs', async () => {
    const ring = makeRing(3);
    const own = cosigner(ring[0]!, shareOf(0));
    const [c1, c2] = [cosigner(ring[1]!, shareOf(1)), cosigner(ring[2]!, shareOf(2))];
    // One approval per hour: a refusal that consumed it would leave the retry rejected.
    const gate = new RecordingGate(new PolicyGate({ maxCeremoniesPerHour: 1 }));
    const leader = leaderOn(ring[0]!, { gate, slots: own, ceremonyDeadlines: { signingMs: 10_000, dkgMs: 10_000 } });
    const req = { ceremonyId: 'pay-retry', signers: [0, 1, 2], proposal: makeProposal(tv.vaultKey, NET) };

    setInMemoryPartition(ring[0]!.io.transport, 1, true);
    expect(await rejection(leader.sign(req))).toMatchObject({ status: 503 });
    expect(gate.specs).toEqual([]);

    setInMemoryPartition(ring[0]!.io.transport, 1, false);
    const signed = await leader.sign(req);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(gate.specs).toHaveLength(1);
    for (const c of [c1, c2]) expect(await c.waitFor('pay-retry', 5_000)).toMatchObject({ status: 'done' });
  });

  it('runDkg answers 503 naming a party that is not connected, before the gate and the announce', async () => {
    const ring = makeRing(3);
    const seen = inbox(ring[2]!);
    const slots = fakeSlots();
    const gate = new RecordingGate(new AutoGate());
    const stager = recordingStager();
    setInMemoryPartition(ring[0]!.io.transport, 1, true);

    const err = await rejection(
      leaderOn(ring[0]!, { vault: undefined, gate, slots: slots.slots, createStager: () => stager }).runDkg({
        ceremonyId: 'gen-dc',
      }),
    );
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ status: 503, message: 'party 1 is not connected; retry when the ring is connected' });
    expect(gate.specs).toEqual([]);
    expect(seen).toEqual([]);
    expect(stager.calls).toEqual([]);
    // The DKG slot was taken (the 409 checks come first) and is released.
    expect(slots.dkgIds).toEqual(['gen-dc']);
    expect(slots.dkgEnds).toBe(1);
  });
});

describe('LeaderDispatcher: at most 32 led signings', () => {
  const proposal = () => makeProposal(tv.vaultKey, NET);

  it('the 33rd request awaiting the gate is refused with 503 before the gate; a place frees when one settles', async () => {
    expect(MAX_LIVE_SIGNINGS_PER_LEADER).toBe(32);
    const ring = makeRing(3);
    const seen = inbox(ring[1]!);
    const decide: Array<(d: Decision) => void> = [];
    const gate = new FixedGate(() => new Promise<Decision>(resolve => decide.push(resolve)));
    const leader = leaderOn(ring[0]!, { gate });

    const held = Array.from({ length: 32 }, (_, i) =>
      rejection(leader.sign({ ceremonyId: `cap-${i}`, signers: [0, 1, 2], proposal: proposal() })),
    );
    await vi.waitFor(() => expect(gate.specs).toHaveLength(32), { timeout: 5_000, interval: 10 });

    const over = await rejection(leader.sign({ ceremonyId: 'cap-32', signers: [0, 1, 2], proposal: proposal() }));
    expect(over).toBeInstanceOf(RequestError);
    expect(over).toMatchObject({ status: 503, message: 'this node already leads 32 live signing ceremonies; retry later' });
    expect(gate.specs).toHaveLength(32);

    // One settles (its gate rejects): its place frees, and the next request reaches the gate.
    decide[0]!('reject');
    expect(await held[0]).toBeInstanceOf(GateRejection);
    const next = rejection(leader.sign({ ceremonyId: 'cap-33', signers: [0, 1, 2], proposal: proposal() }));
    await vi.waitFor(() => expect(gate.specs).toHaveLength(33), { timeout: 5_000, interval: 10 });
    expect(gate.specs[32]).toMatchObject({ ceremonyId: 'cap-33' });
    // Full again.
    expect(await rejection(leader.sign({ ceremonyId: 'cap-34', signers: [0, 1, 2], proposal: proposal() }))).toMatchObject({
      status: 503,
    });

    for (const d of decide.slice(1)) d('reject');
    for (const r of await Promise.all([...held.slice(1), next])) expect(r).toBeInstanceOf(GateRejection);
    expect(seen).toEqual([]);
  });

  it('counts announced ceremonies until they settle', async () => {
    const CEREMONY_MS = 3_000;
    const ring = makeRing(3, ONE_ATTEMPT);
    const seen = inbox(ring[1]!);
    let approvals = 0;
    // Approves the first 32; the request after them only has to reach the gate.
    const gate = new FixedGate(async () => (approvals++ < 32 ? 'approve' : 'reject'));
    const leader = leaderOn(ring[0]!, { gate, ceremonyDeadlines: { signingMs: CEREMONY_MS, dkgMs: CEREMONY_MS } });

    // Nobody else takes part: each ceremony pulls until its deadline.
    const live = Array.from({ length: 32 }, (_, i) =>
      rejection(leader.sign({ ceremonyId: `led-${i}`, signers: [0, 1, 2], proposal: proposal() })),
    );
    await vi.waitFor(() => expect(seen.filter(m => m.kind === 'announce-sign')).toHaveLength(32), {
      timeout: CEREMONY_MS - 500,
      interval: 10,
    });
    const over = await rejection(leader.sign({ ceremonyId: 'led-32', signers: [0, 1, 2], proposal: proposal() }));
    expect(over).toMatchObject({ status: 503, message: 'this node already leads 32 live signing ceremonies; retry later' });
    expect(gate.specs).toHaveLength(32);

    for (const err of await Promise.all(live)) {
      expect((err as Error).message).toBe(`ceremony deadline of ${CEREMONY_MS} ms passed`);
    }
    const after = await rejection(leader.sign({ ceremonyId: 'led-33', signers: [0, 1, 2], proposal: proposal() }));
    expect(after).toBeInstanceOf(GateRejection);
    expect(gate.specs).toHaveLength(33);
  }, 20_000);
});
