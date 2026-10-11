import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDkgCeremony, type ShareStager } from '../core/dkg-ceremony';
import { encodeMessage, parseMessage, type AnnounceDkg, type CeremonyMessage } from '../core/messages';
import { leadSigning, type SignCeremonySpec } from '../core/sign-ceremony';
import type { BlobKey, PartyId } from '../core/types';
import { createShareStager, pendingPath, vaultFileExists } from '../daemon/vault-share';
import { AutoGate } from '../gate/factory';
import { PolicyGate } from '../gate/policy';
import type { ApprovalGate, CeremonySpec, Decision, SigningSpec } from '../gate/types';
import { analyzeProposal, vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { rng } from '../otzi/lib/dkg.fixture';
import { fromHex, toHex } from '../otzi/lib/hex';
import type { DecryptedShare } from '../otzi/lib/share-file';
import type { NetworkName, SendProposal } from '../otzi/lib/vault-types';
import { makeProposal, testVault, type TestVault } from '../testing/proposal';
import { makeRing, type RingNode } from '../testing/ring';
import { MAX_LIVE_SIGNINGS_PER_LEADER, Orchestrator } from './orchestrator';
import type { CeremonyOutcome, Logger, OrchestratorDeps } from './types';

const NET: NetworkName = 'testnet4';
const peersById: ReadonlyMap<PartyId, string> = new Map([
  [0, 'node-0'],
  [1, 'node-1'],
  [2, 'node-2'],
]);
/** Leader pulls in these tests: generous, so only the participant side is under test. */
const LEADER_PULLS = { maxAttempts: 1_000, deadlineMs: 8_000 };
const WAIT_MS = 10_000;

// ─── Fakes ─────────────────────────────────────────────────────────────────

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

interface RecordingLogger extends Logger {
  lines: LogLine[];
  /** Lines that mention `text` (a ceremonyId, usually). */
  about(text: string): LogLine[];
}

function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (msg: string) => {
    lines.push({ level, msg });
  };
  return {
    lines,
    about: text => lines.filter(l => l.msg.includes(text)),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

interface RecordingStager extends ShareStager {
  calls: string[];
}

function recordingStager(failStage?: string): RecordingStager {
  const s: RecordingStager = {
    sharePath: '/test/share.json',
    stagedPath: '/test/share.json.pending',
    calls: [],
    async stage() {
      s.calls.push('stage');
      if (failStage) throw new Error(failStage);
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

/** Records every spec, then defers to `inner`. */
class SpyGate implements ApprovalGate {
  readonly specs: CeremonySpec[] = [];
  constructor(private readonly inner: ApprovalGate) {}
  approve(spec: CeremonySpec): Promise<Decision> {
    this.specs.push(spec);
    return this.inner.approve(spec);
  }
}

function shareOf(tv: TestVault, partyId: PartyId): DecryptedShare {
  return {
    network: NET,
    internalKey: tv.vaultKey.untweakedVerifyingKey,
    partyId,
    threshold: tv.publicKeyPackage.minSigners,
    parties: peersById.size,
    keyPackage: tv.keyPackages[partyId]!,
    publicKeyPackage: tv.publicKeyPackage,
  };
}

// ─── Harness ───────────────────────────────────────────────────────────────

interface Participant {
  orch: Orchestrator;
  log: RecordingLogger;
  gate: SpyGate;
  stagers: RecordingStager[];
  createStager: ReturnType<typeof vi.fn<() => ShareStager>>;
}

type ParticipantOptions = Partial<Omit<OrchestratorDeps, 'createStager'>> & {
  createStager?: () => ShareStager;
};

const started: Orchestrator[] = [];

function participant(node: RingNode, over: ParticipantOptions = {}): Participant {
  const log = recordingLogger();
  const gate = new SpyGate(over.gate ?? new AutoGate());
  const stagers: RecordingStager[] = [];
  const createStager = vi.fn(
    over.createStager ??
      (() => {
        const s = recordingStager();
        stagers.push(s);
        return s;
      }),
  );
  const orch = new Orchestrator({
    io: node.io,
    node: { id: peersById.get(node.partyId)!, partyId: node.partyId },
    peersById,
    network: NET,
    vaultExists: async () => false,
    rng,
    ceremonyDeadlines: { signingMs: 5_000, dkgMs: 8_000 },
    logger: log,
    ...over,
    gate,
    createStager,
  });
  orch.start();
  started.push(orch);
  return { orch, log, gate, stagers, createStager };
}

afterEach(() => {
  for (const o of started.splice(0)) o.stop();
});

function broadcastFrom(ring: RingNode[], p: PartyId, msg: CeremonyMessage): Promise<void> {
  return ring[p]!.io.transport.broadcast(encodeMessage(msg));
}

function announceDkg(ceremonyId: string, sessionId: Uint8Array, over: Partial<AnnounceDkg> = {}): AnnounceDkg {
  return {
    v: 2,
    kind: 'announce-dkg',
    ceremonyId,
    sessionIdHex: toHex(sessionId),
    threshold: 3,
    parties: 3,
    network: NET,
    ...over,
  };
}

/** Node `p` leads a DKG directly: announce, then the symmetric ceremony. */
async function leadDkg(ring: RingNode[], p: PartyId, ceremonyId: string, signal?: AbortSignal) {
  const sessionId = crypto.getRandomValues(new Uint8Array(32));
  await broadcastFrom(ring, p, announceDkg(ceremonyId, sessionId));
  return runDkgCeremony(
    ring[p]!.io,
    { ceremonyId, sessionId, threshold: 3, parties: 3, network: NET, rng },
    recordingStager(),
    signal,
  );
}

/** Wait until `fn` stops throwing. */
const eventually = (fn: () => void) => vi.waitFor(fn, { timeout: 3_000, interval: 5 });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─── DKG ───────────────────────────────────────────────────────────────────

describe('Orchestrator: DKG participation', () => {
  let ring: RingNode[];

  beforeEach(() => {
    ring = makeRing(3, LEADER_PULLS);
  });

  it('participates in a DKG and settles done with the vault address', async () => {
    const id = 'dkg-done';
    const p1 = participant(ring[1]!);
    const p2 = participant(ring[2]!);
    const outcomes: CeremonyOutcome[] = [];
    p1.orch.onCompleted(o => outcomes.push(o));

    const result = await leadDkg(ring, 0, id);
    const address = vaultPayment(toVaultKey(result.publicKeyPackage), NET).address;

    for (const p of [p1, p2]) {
      expect(await p.orch.waitFor(id, WAIT_MS)).toEqual({ ceremonyId: id, kind: 'dkg', status: 'done', address });
      expect(p.createStager).toHaveBeenCalledTimes(1);
      expect(p.stagers[0]!.calls).toEqual(['stage', 'commit']);
      expect(p.gate.specs).toEqual([
        {
          kind: 'dkg',
          ceremonyId: id,
          leader: 'node-0',
          role: 'participant',
          threshold: 3,
          parties: 3,
          network: NET,
          peerIds: ['node-0', 'node-1', 'node-2'],
        },
      ]);
    }
    expect(outcomes).toHaveLength(1);
  });

  it('drops announce-dkg when a vault exists and never creates a stager', async () => {
    const id = 'dkg-vault';
    const tv = testVault(3, 3);
    const p1 = participant(ring[1]!, { vaultExists: async () => true });
    const vaultExists2 = vi.fn(async () => false);
    const p2 = participant(ring[2]!, { vault: shareOf(tv, 2), vaultExists: vaultExists2 });

    await broadcastFrom(ring, 0, announceDkg(id, new Uint8Array(32).fill(7)));

    // A share file at the share path (node 1) and a loaded share (node 2) both refuse.
    await eventually(() => expect(p1.log.about(id)).toHaveLength(1));
    expect(p1.log.about(id)[0]).toMatchObject({ level: 'warn' });
    expect(p1.log.about(id)[0]!.msg).toMatch(/share file exists/);
    expect(p2.log.about(id)).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p2.log.about(id)[0]!.msg).toMatch(/already holds a vault/);
    expect(vaultExists2).not.toHaveBeenCalled();

    for (const [p, node] of [[p1, ring[1]!], [p2, ring[2]!]] as const) {
      expect(p.createStager).not.toHaveBeenCalled();
      expect(p.gate.specs).toEqual([]);
      expect(node.io.store.list(id)).toEqual([]);
      await expect(p.orch.waitFor(id, 50)).rejects.toThrow(/timed out/);
    }
  });

  it('drops announce-dkg for another network or party count', async () => {
    const p1 = participant(ring[1]!);
    const sessionId = new Uint8Array(32).fill(1);

    await broadcastFrom(ring, 0, announceDkg('dkg-net', sessionId, { network: 'signet' }));
    await broadcastFrom(ring, 0, announceDkg('dkg-parties', sessionId, { threshold: 2, parties: 2 }));

    expect(p1.log.about('dkg-net')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about('dkg-net')[0]!.msg).toMatch(/network signet/);
    expect(p1.log.about('dkg-parties')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about('dkg-parties')[0]!.msg).toMatch(/parties 2/);
    expect(p1.createStager).not.toHaveBeenCalled();
    expect(p1.gate.specs).toEqual([]);
    await expect(p1.orch.waitFor('dkg-net', 50)).rejects.toThrow(/timed out/);
    await expect(p1.orch.waitFor('dkg-parties', 50)).rejects.toThrow(/timed out/);
  });

  it('settles rejected when the gate refuses a DKG, and never creates a stager', async () => {
    const thrower: ApprovalGate = { approve: () => Promise.reject(new Error('approver unreachable')) };
    const p1 = participant(ring[1]!, { gate: new PolicyGate({ dkgLeaderAllowlist: ['node-2'] }) });
    const p2 = participant(ring[2]!, { gate: thrower });

    await broadcastFrom(ring, 0, announceDkg('dkg-gate', new Uint8Array(32).fill(2)));

    const o1 = await p1.orch.waitFor('dkg-gate', WAIT_MS);
    expect(o1).toEqual({ ceremonyId: 'dkg-gate', kind: 'dkg', status: 'rejected', reason: 'gate decision: reject' });
    expect(p1.log.about('dkg-gate')).toEqual([expect.objectContaining({ level: 'info' })]);
    const o2 = await p2.orch.waitFor('dkg-gate', WAIT_MS);
    expect(o2).toMatchObject({ status: 'rejected', reason: 'gate error: approver unreachable' });
    expect(p2.log.about('dkg-gate')).toEqual([expect.objectContaining({ level: 'warn' })]);
    for (const [p, node] of [[p1, ring[1]!], [p2, ring[2]!]] as const) {
      expect(p.gate.specs).toHaveLength(1);
      expect(p.createStager).not.toHaveBeenCalled();
      expect(node.io.store.list('dkg-gate')).toEqual([]);
    }
  });

  it('stops a DKG when any ring member aborts', async () => {
    const id = 'dkg-abort';
    const p1 = participant(ring[1]!);
    // Node 2 is not the leader; its disk fails, so it aborts the ceremony for everyone.
    const failing = recordingStager('disk full');
    const p2 = participant(ring[2]!, { createStager: () => failing });
    const leaderAbort = new AbortController();
    ring[0]!.io.transport.onBroadcast((_from, bytes) => {
      const msg = parseMessage(bytes);
      if (msg?.kind === 'signoff-aborted' && msg.ceremonyId === id) leaderAbort.abort();
    });

    await expect(leadDkg(ring, 0, id, leaderAbort.signal)).rejects.toThrow(/DKG aborted/);

    const o1 = await p1.orch.waitFor(id, WAIT_MS);
    expect(o1).toMatchObject({ ceremonyId: id, kind: 'dkg', status: 'aborted' });
    expect(o1.reason).toContain('disk full');
    const o2 = await p2.orch.waitFor(id, WAIT_MS);
    expect(o2).toMatchObject({ ceremonyId: id, kind: 'dkg', status: 'aborted' });
    expect(o2.reason).toContain('disk full');

    // Node 1 discards its staged share unless it had already published its confirmation.
    const confirmed = ring[1]!.io.store.has({ ceremonyId: id, round: 'dkg-verified', from: 1 });
    if (confirmed) {
      await eventually(() => expect(p1.log.lines.some(l => l.level === 'error' && l.msg.includes(id))).toBe(true));
      expect(p1.stagers[0]!.calls).toEqual(['stage']);
    } else {
      await eventually(() => expect(p1.stagers[0]!.calls).toContain('discard'));
    }
    expect(p1.stagers[0]!.calls).not.toContain('commit');
    expect(failing.calls).toEqual(['stage', 'discard']);
  });

  it('keeps the staged share and logs an error when a ring member aborts after its confirmation', async () => {
    const id = 'dkg-kept';
    const p1 = participant(ring[1]!);
    participant(ring[2]!);
    // Node 1 never gets node 2's confirmation.
    const pull = ring[1]!.io.transport.pull.bind(ring[1]!.io.transport);
    ring[1]!.io.transport.pull = async key => (key.round === 'dkg-verified' && key.from === 2 ? null : pull(key));

    const led = leadDkg(ring, 0, id).catch(() => undefined);
    await vi.waitFor(() => expect(ring[1]!.io.store.has({ ceremonyId: id, round: 'dkg-verified', from: 1 })).toBe(true), {
      timeout: WAIT_MS,
      interval: 5,
    });
    await broadcastFrom(ring, 2, { v: 2, kind: 'signoff-aborted', ceremonyId: id, reason: 'operator abort' });

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'aborted', reason: 'operator abort' });
    await eventually(() => expect(p1.log.about(id).filter(l => l.level === 'error')).toHaveLength(1));
    const line = p1.log.about(id).find(l => l.level === 'error')!;
    expect(line.msg).toMatch(/so its staged share was kept at \/test\/share\.json\.pending/);
    expect(line.msg).toMatch(/run 'otzi vault' on the other nodes/);
    expect(p1.stagers[0]!.calls).toEqual(['stage']);
    await led;
  });

  it('settles timeout when the DKG deadline passes', async () => {
    const id = 'dkg-timeout';
    const p1 = participant(ring[1]!, { ceremonyDeadlines: { signingMs: 5_000, dkgMs: 150 } });

    // The announcing node never takes part.
    await broadcastFrom(ring, 0, announceDkg(id, new Uint8Array(32).fill(3)));

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ ceremonyId: id, kind: 'dkg', status: 'timeout' });
    await eventually(() => expect(p1.stagers[0]!.calls).toEqual(['discard']));
  });

  it('drops announce-dkg from a sender outside the ring', async () => {
    const big = makeRing(4, LEADER_PULLS);
    // Node 1's ring is parties 0..2: party 3 is not a member.
    const p1 = participant(big[1]!);

    await broadcastFrom(big, 3, announceDkg('dkg-stranger', new Uint8Array(32).fill(1)));

    expect(p1.log.about('dkg-stranger')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about('dkg-stranger')[0]!.msg).toMatch(/party 3 is not a ring member/);
    expect(p1.createStager).not.toHaveBeenCalled();
    expect(p1.gate.specs).toEqual([]);
    await expect(p1.orch.waitFor('dkg-stranger', 50)).rejects.toThrow(/timed out/);
  });

  it('stop() schedules the clear of a live ceremony\'s blobs', async () => {
    const id = 'dkg-stopped';
    const p1 = participant(ring[1]!, { blobRetentionMs: { signing: 50, dkg: 50 } });

    // The announcing node never takes part: node 1 produces its round-1 blob and waits.
    await broadcastFrom(ring, 0, announceDkg(id, new Uint8Array(32).fill(11)));
    await eventually(() => expect(ring[1]!.io.store.list(id).length).toBeGreaterThan(0));
    p1.orch.stop();

    await eventually(() => expect(ring[1]!.io.store.list(id)).toEqual([]));
  });

  it('accepts a fresh DKG after a leftover pending file', async () => {
    const id = 'dkg-pending';
    const dir = await mkdtemp(join(tmpdir(), 'otzi-orchestrator-'));
    try {
      const path = join(dir, 'share.json');
      await writeFile(pendingPath(path), '{"left":"over"}', { mode: 0o600 });
      const p1 = participant(ring[1]!, {
        vaultExists: () => vaultFileExists(path),
        createStager: () =>
          createShareStager({ path, password: 'pw', network: NET, partyId: 1, vaultPubkeyPath: join(dir, 'vault-pubkey.json') }),
      });
      participant(ring[2]!);

      const result = await leadDkg(ring, 0, id);

      const address = vaultPayment(toVaultKey(result.publicKeyPackage), NET).address;
      expect(await p1.orch.waitFor(id, WAIT_MS)).toEqual({ ceremonyId: id, kind: 'dkg', status: 'done', address });
      expect(await vaultFileExists(path)).toBe(true);
      expect(await vaultFileExists(pendingPath(path))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Local slots ───────────────────────────────────────────────────────────

describe('Orchestrator: local ceremony slots', () => {
  let ring: RingNode[];

  beforeEach(() => {
    ring = makeRing(3, LEADER_PULLS);
  });

  it('refuses a second DKG while the first slot is live', () => {
    const { orch } = participant(ring[1]!);

    const first = orch.beginLocalDkg('local-a');
    expect(first).not.toBeNull();
    expect(orch.beginLocalDkg('local-b')).toBeNull();

    first!.end();
    first!.end(); // idempotent
    const second = orch.beginLocalDkg('local-c');
    expect(second).not.toBeNull();

    first!.end(); // a stale end() never releases a later slot
    expect(orch.beginLocalDkg('local-d')).toBeNull();
    second!.end();
    expect(orch.beginLocalDkg('local-e')).not.toBeNull();
  });

  it('refuses while a participant DKG is live, and refuses its id after it ended', async () => {
    const id = 'dkg-joined';
    const p1 = participant(ring[1]!, { ceremonyDeadlines: { signingMs: 5_000, dkgMs: 150 } });

    await broadcastFrom(ring, 0, announceDkg(id, new Uint8Array(32).fill(4)));
    expect(p1.orch.beginLocalDkg('local-a')).toBeNull();

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'timeout' });
    let slot: ReturnType<Orchestrator['beginLocalDkg']> = null;
    await eventually(() => {
      slot = p1.orch.beginLocalDkg('local-a');
      expect(slot).not.toBeNull();
    });
    slot!.end();
    // The ended ceremony's id stays taken for its retention period.
    expect(p1.orch.beginLocalDkg(id)).toBeNull();
    expect(p1.orch.beginLocalSigning(id)).toBeNull();
  });

  it('holds the DKG slot until a joined DKG finishes unwinding', async () => {
    const id = 'dkg-unwinding';
    const release = deferred();
    const stager = recordingStager();
    stager.discard = async () => {
      stager.calls.push('discard');
      await release.promise;
    };
    const p1 = participant(ring[1]!, { createStager: () => stager });

    // Node 0 announces but never takes part; node 2 then aborts the ceremony.
    await broadcastFrom(ring, 0, announceDkg(id, new Uint8Array(32).fill(6)));
    await eventually(() => expect(p1.createStager).toHaveBeenCalledTimes(1));
    await broadcastFrom(ring, 2, { v: 2, kind: 'signoff-aborted', ceremonyId: id, reason: 'operator abort' });
    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'aborted', reason: 'operator abort' });
    await eventually(() => expect(stager.calls).toEqual(['discard']));

    // The tracker is gone, but the ceremony is still inside discard(): no second DKG.
    expect(p1.orch.beginLocalDkg('local-a')).toBeNull();
    await broadcastFrom(ring, 0, announceDkg('dkg-next', new Uint8Array(32).fill(7)));
    expect(p1.log.about('dkg-next')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about('dkg-next')[0]!.msg).toMatch(/a DKG is already running/);
    expect(p1.createStager).toHaveBeenCalledTimes(1);

    release.resolve();
    let slot: ReturnType<Orchestrator['beginLocalDkg']> = null;
    await eventually(() => {
      slot = p1.orch.beginLocalDkg('local-a');
      expect(slot).not.toBeNull();
    });
    slot!.end();
  });

  it('drops announce-dkg while a local DKG is live', async () => {
    const p1 = participant(ring[1]!);
    const slot = p1.orch.beginLocalDkg('local-a')!;

    await broadcastFrom(ring, 0, announceDkg('remote-b', new Uint8Array(32).fill(5)));

    expect(p1.log.about('remote-b')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about('remote-b')[0]!.msg).toMatch(/a DKG is already running/);
    expect(p1.createStager).not.toHaveBeenCalled();
    expect(p1.gate.specs).toEqual([]);
    await expect(p1.orch.waitFor('remote-b', 50)).rejects.toThrow(/timed out/);
    slot.end();
  });

  it('aborts the local DKG when any ring member aborts it', async () => {
    const id = 'dkg-local';
    const p1 = participant(ring[1]!);
    participant(ring[0]!);
    participant(ring[2]!, { createStager: () => recordingStager('disk full') });

    const slot = p1.orch.beginLocalDkg(id)!;
    // An abort for another ceremony does not touch the slot.
    await broadcastFrom(ring, 2, { v: 2, kind: 'signoff-aborted', ceremonyId: 'unrelated' });
    expect(slot.signal.aborted).toBe(false);

    try {
      // Node 1 leads through its slot; node 2 fails and broadcasts signoff-aborted.
      // Without the slot signal node 1 would wait for its pull deadline instead.
      await expect(leadDkg(ring, 1, id, slot.signal)).rejects.toThrow('DKG aborted: aborted');
      expect(slot.signal.aborted).toBe(true);
    } finally {
      slot.end();
    }
  });

  it('reserves signing ids this node leads', async () => {
    const retention = { signing: 60, dkg: 60 };
    const { orch } = participant(ring[1]!, { blobRetentionMs: retention });

    const a = orch.beginLocalSigning('sign-a');
    expect(a).not.toBeNull();
    expect(orch.ceremonyIdInUse('sign-a')).toBe(true);
    expect(orch.beginLocalSigning('sign-a')).toBeNull();
    expect(orch.beginLocalDkg('sign-a')).toBeNull();
    const b = orch.beginLocalSigning('sign-b'); // distinct ids run side by side
    expect(b).not.toBeNull();
    b!.end();

    a!.end();
    a!.end(); // idempotent
    // Ended here: the id stays taken for the signing retention period.
    expect(orch.ceremonyIdInUse('sign-a')).toBe(true);
    expect(orch.beginLocalSigning('sign-a')).toBeNull();
    expect(orch.beginLocalDkg('sign-a')).toBeNull();
    await eventually(() => expect(orch.ceremonyIdInUse('sign-a')).toBe(false));
    const again = orch.beginLocalSigning('sign-a');
    expect(again).not.toBeNull();
    a!.end(); // a stale end() never releases a later reservation
    expect(orch.beginLocalSigning('sign-a')).toBeNull();
    again!.end();

    const dkg = orch.beginLocalDkg('dkg-a')!;
    expect(orch.beginLocalSigning('dkg-a')).toBeNull();
    dkg.end();
    expect(orch.beginLocalSigning('dkg-a')).toBeNull();
    const other = orch.beginLocalDkg('dkg-b'); // the DKG slot itself is free again
    expect(other).not.toBeNull();
    other!.end();
    await eventually(() => expect(orch.beginLocalDkg('dkg-a')).not.toBeNull());
  });

  it('keeps an ended local id for its own kind\'s retention period', async () => {
    const { orch } = participant(ring[1]!, { blobRetentionMs: { signing: 40, dkg: 400 } });
    orch.beginLocalSigning('led-sign')!.end();
    orch.beginLocalDkg('led-dkg')!.end();
    const ended = Date.now();

    await eventually(() => expect(orch.ceremonyIdInUse('led-sign')).toBe(false));
    expect(orch.ceremonyIdInUse('led-dkg')).toBe(true);
    await eventually(() => expect(orch.ceremonyIdInUse('led-dkg')).toBe(false));
    expect(Date.now() - ended).toBeGreaterThanOrEqual(390);
  });

  it('forgets ended local ids on stop', () => {
    const { orch } = participant(ring[1]!);
    orch.beginLocalSigning('led-stop')!.end();
    expect(orch.ceremonyIdInUse('led-stop')).toBe(true);
    orch.stop();
    expect(orch.ceremonyIdInUse('led-stop')).toBe(false);
  });

  it('drops an announce whose id this node led within retention', async () => {
    const p1 = participant(ring[1]!);
    p1.orch.beginLocalDkg('led-before')!.end();

    await broadcastFrom(ring, 0, announceDkg('led-before', new Uint8Array(32).fill(9)));

    expect(p1.log.about('led-before')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about('led-before')[0]!.msg).toMatch(/this node led a ceremony with this id/);
    expect(p1.createStager).not.toHaveBeenCalled();
    expect(p1.gate.specs).toEqual([]);
    await expect(p1.orch.waitFor('led-before', 50)).rejects.toThrow(/timed out/);
  });

  it.each([
    ['a DKG that completes (promise path)', false],
    ['a DKG deadline (timer path)', true],
  ])('isolates a throwing onCompleted handler: %s', async (_name, timesOut) => {
    const id = 'dkg-handler';
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => escaped.push(err);
    process.on('unhandledRejection', onEscape);
    process.on('uncaughtException', onEscape);
    try {
      const p1 = participant(ring[1]!, timesOut ? { ceremonyDeadlines: { signingMs: 5_000, dkgMs: 150 } } : {});
      if (!timesOut) participant(ring[2]!);
      const seen: CeremonyOutcome[] = [];
      p1.orch.onCompleted(() => {
        throw new Error('handler boom');
      });
      p1.orch.onCompleted(o => seen.push(o));
      const waiting = p1.orch.waitFor(id, WAIT_MS);

      if (timesOut) await broadcastFrom(ring, 0, announceDkg(id, new Uint8Array(32).fill(8)));
      else await leadDkg(ring, 0, id);

      expect(await waiting).toMatchObject({ ceremonyId: id, status: timesOut ? 'timeout' : 'done' });
      expect(seen).toHaveLength(1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(escaped).toEqual([]);
      expect(p1.log.lines.filter(l => l.level === 'error' && l.msg.includes('handler boom'))).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onEscape);
      process.off('uncaughtException', onEscape);
    }
  });
});

// ─── Signing ───────────────────────────────────────────────────────────────

describe('Orchestrator: proposal signing', () => {
  let tv: TestVault;
  let foreign: TestVault;
  let ring: RingNode[];

  beforeAll(() => {
    tv = testVault(3, 3);
    foreign = testVault(3, 3);
  });

  beforeEach(() => {
    ring = makeRing(3, LEADER_PULLS);
  });

  function analyse(proposal: SendProposal) {
    const analysis = analyzeProposal(proposal, tv.vaultKey, NET);
    return { analysis, sighashes: analysis.sighashes.map(s => fromHex(s.hash)) };
  }

  const leaderSpec = (ceremonyId: string, sighashes: Uint8Array[]): SignCeremonySpec => ({
    ceremonyId,
    signers: [0, 1, 2],
    sighashes,
    keyPackage: tv.keyPackages[0]!,
    publicKeyPackage: tv.publicKeyPackage,
    rng,
  });

  /** Nodes 1 and 2 run orchestrators with the vault loaded. */
  function participants(over: [ParticipantOptions?, ParticipantOptions?] = []): [Participant, Participant] {
    return [
      participant(ring[1]!, { vault: shareOf(tv, 1), ...over[0] }),
      participant(ring[2]!, { vault: shareOf(tv, 2), ...over[1] }),
    ];
  }

  /** Node 0 leads the signing ceremony directly; resolves with the signatures. */
  async function lead(ceremonyId: string, proposal: SendProposal, nodes: RingNode[] = ring): Promise<string[]> {
    const { sighashes } = analyse(proposal);
    const sigs = await leadSigning(nodes[0]!.io, leaderSpec(ceremonyId, sighashes), proposal);
    return sigs.map(toHex);
  }

  const signoffDone = (ceremonyId: string, signaturesHex: string[]): CeremonyMessage => ({
    v: 2,
    kind: 'signoff-done',
    ceremonyId,
    signaturesHex,
  });

  const announceSign = (ceremonyId: string, proposal: SendProposal): CeremonyMessage => ({
    v: 2,
    kind: 'announce-sign',
    ceremonyId,
    signers: [0, 1, 2],
    proposal,
  });

  it('signs an approved proposal and settles done on a valid signoff', async () => {
    const id = 'sign-done';
    const [p1, p2] = participants();
    const proposal = makeProposal(tv.vaultKey, NET);
    const { analysis } = analyse(proposal);

    const signaturesHex = await lead(id, proposal);
    await broadcastFrom(ring, 0, signoffDone(id, signaturesHex));

    for (const p of [p1, p2]) {
      expect(await p.orch.waitFor(id, WAIT_MS)).toEqual({ ceremonyId: id, kind: 'signing', status: 'done', signaturesHex });
      expect(p.gate.specs).toHaveLength(1);
      expect(p.gate.specs[0]).toMatchObject({
        kind: 'signing',
        ceremonyId: id,
        leader: 'node-0',
        role: 'participant',
        network: NET,
        txid: analysis.txid,
        amount: 50_000,
        fee: 1_000,
      });
    }
  });

  it('stays silent on a proposal spending a foreign input', async () => {
    const id = 'sign-foreign';
    const [p1] = participants();
    const sent = vi.spyOn(ring[1]!.io.transport, 'broadcast');
    const foreignScript = toHex(vaultPayment(foreign.vaultKey, NET).script);
    const proposal = makeProposal(tv.vaultKey, NET, { inputs: [{ amount: 100_000, script: foreignScript }] });

    await broadcastFrom(ring, 0, announceSign(id, proposal));

    const o = await p1.orch.waitFor(id, WAIT_MS);
    expect(o).toMatchObject({ ceremonyId: id, kind: 'signing', status: 'rejected' });
    expect(o.reason).toMatch(/does not spend a coin of this vault/);
    expect(p1.log.about(id)).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.gate.specs).toEqual([]);
    expect(ring[1]!.io.store.list(id)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it('stays silent on a proposal for another network', async () => {
    const id = 'sign-network';
    const [p1] = participants();
    const sent = vi.spyOn(ring[1]!.io.transport, 'broadcast');
    const proposal = makeProposal(tv.vaultKey, 'signet');

    await broadcastFrom(ring, 0, announceSign(id, proposal));

    const o = await p1.orch.waitFor(id, WAIT_MS);
    expect(o).toMatchObject({ ceremonyId: id, kind: 'signing', status: 'rejected' });
    expect(o.reason).toMatch(/Proposal is for signet/);
    expect(p1.gate.specs).toEqual([]);
    expect(ring[1]!.io.store.list(id)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it('stays silent when the policy gate rejects a fee burn', async () => {
    const id = 'sign-fee';
    const [p1] = participants([{ gate: new PolicyGate({ maxFeeSats: 1_000 }) }]);
    const sent = vi.spyOn(ring[1]!.io.transport, 'broadcast');
    const proposal = makeProposal(tv.vaultKey, NET, { change: 0 }); // 100 000 in, 50 000 out

    await broadcastFrom(ring, 0, announceSign(id, proposal));

    const o = await p1.orch.waitFor(id, WAIT_MS);
    expect(o).toMatchObject({ ceremonyId: id, kind: 'signing', status: 'rejected' });
    expect(o.reason).toMatch(/reject/);
    expect(p1.gate.specs).toEqual([expect.objectContaining({ kind: 'signing', fee: 50_000 })]);
    expect(p1.log.about(id)).toEqual([expect.objectContaining({ level: 'info' })]);
    expect(ring[1]!.io.store.list(id)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it.each([
    ['this node is not in signers', { signers: [0, 2] }, 'info', /party 1 is not in signers/],
    ['the leader is not in signers', { signers: [1, 2] }, 'warn', /leader party 0 is not in signers/],
    ['signers has duplicates', { signers: [0, 1, 1, 2] }, 'warn', /signers has duplicates/],
    ['a signer is outside the ring', { signers: [0, 1, 2, 7] }, 'warn', /signer 7 is not in the ring/],
    ['signers is below the threshold', { signers: [0, 1] }, 'warn', /signers has 2 entries, the vault needs 3/],
    ['no vault is loaded', { signers: [0, 1, 2], noVault: true }, 'warn', /no vault loaded/],
  ] as const)('drops announce-sign when %s', async (_name, c, level, reason) => {
    const id = 'sign-structural';
    const p1 = participant(ring[1]!, 'noVault' in c ? {} : { vault: shareOf(tv, 1) });
    const sent = vi.spyOn(ring[1]!.io.transport, 'broadcast');

    await broadcastFrom(ring, 0, {
      v: 2,
      kind: 'announce-sign',
      ceremonyId: id,
      signers: [...c.signers],
      proposal: makeProposal(tv.vaultKey, NET),
    });

    const lines = p1.log.about(id);
    expect(lines).toEqual([expect.objectContaining({ level })]);
    expect(lines[0]!.msg).toMatch(reason);
    expect(p1.gate.specs).toEqual([]);
    expect(ring[1]!.io.store.list(id)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    await expect(p1.orch.waitFor(id, 50)).rejects.toThrow(/timed out/);
  });

  it('refuses to lead a ceremony whose id is live or ended here', async () => {
    const id = 'sign-taken';
    const [p1] = participants();

    const signaturesHex = await lead(id, makeProposal(tv.vaultKey, NET));
    // Live tracker (awaiting the signoff).
    expect(p1.orch.beginLocalSigning(id)).toBeNull();
    expect(p1.orch.beginLocalDkg(id)).toBeNull();
    const free = p1.orch.beginLocalDkg('dkg-free'); // the refusal above is about the id
    expect(free).not.toBeNull();
    free!.end();

    await broadcastFrom(ring, 0, signoffDone(id, signaturesHex));
    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'done' });
    // Ended record, within retention.
    expect(p1.orch.beginLocalSigning(id)).toBeNull();
    expect(p1.orch.beginLocalDkg(id)).toBeNull();
  });

  it('drops an announce-sign whose id this node leads', async () => {
    const id = 'sign-local';
    const [p1] = participants();
    const slot = p1.orch.beginLocalSigning(id)!;

    await broadcastFrom(ring, 0, announceSign(id, makeProposal(tv.vaultKey, NET)));

    expect(p1.log.about(id)).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(p1.log.about(id)[0]!.msg).toMatch(/this node leads a ceremony with this id/);
    expect(p1.gate.specs).toEqual([]);
    expect(ring[1]!.io.store.list(id)).toEqual([]);
    await expect(p1.orch.waitFor(id, 50)).rejects.toThrow(/timed out/);
    slot.end();
  });

  it('drops announce-sign from a non-leader for a pinned ceremony', async () => {
    const id = 'sign-pinned';
    const [p1] = participants();
    const proposal = makeProposal(tv.vaultKey, NET);

    const signaturesHex = await lead(id, proposal);
    const mark = p1.log.about(id).length;

    // Node 2 is a co-signer, not the leader: it cannot re-announce, sign off or abort.
    await broadcastFrom(ring, 2, announceSign(id, makeProposal(tv.vaultKey, NET)));
    await broadcastFrom(ring, 2, signoffDone(id, signaturesHex));
    await broadcastFrom(ring, 2, { v: 2, kind: 'signoff-aborted', ceremonyId: id, reason: 'hijack' });
    // The leader's own duplicate announce is benign.
    await broadcastFrom(ring, 0, announceSign(id, proposal));

    const lines = p1.log.about(id).slice(mark);
    expect(lines.map(l => l.level)).toEqual(['warn', 'warn', 'warn', 'info']);
    expect(lines[0]!.msg).toMatch(/not the pinned leader/);
    expect(p1.gate.specs).toHaveLength(1);

    await broadcastFrom(ring, 0, signoffDone(id, signaturesHex));
    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'done', signaturesHex });
  });

  it.each([
    ['a tampered signature', (sigs: string[]) => sigs.map(s => s.slice(0, -2) + (s.endsWith('00') ? '01' : '00'))],
    ['a missing signature', (sigs: string[]) => sigs.slice(1)],
  ])('settles invalid-signoff on a forged signoff-done (%s)', async (_name, forge) => {
    const id = 'sign-forged';
    const [p1] = participants();
    const proposal = makeProposal(tv.vaultKey, NET, { inputs: [{ amount: 60_000 }, { amount: 40_000 }] });

    const signaturesHex = await lead(id, proposal);
    await broadcastFrom(ring, 0, signoffDone(id, forge(signaturesHex)));

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ ceremonyId: id, status: 'invalid-signoff' });
    expect(p1.log.about(id).filter(l => l.level === 'error')).toHaveLength(1);
  });

  it('settles timeout when no signoff arrives', async () => {
    const id = 'sign-timeout';
    const [p1] = participants([{ ceremonyDeadlines: { signingMs: 1_500, dkgMs: 8_000 } }]);

    await lead(id, makeProposal(tv.vaultKey, NET));

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ ceremonyId: id, kind: 'signing', status: 'timeout' });
  });

  it('settles aborted on the leader signoff-aborted', async () => {
    const id = 'sign-aborted';
    const [p1] = participants();

    await lead(id, makeProposal(tv.vaultKey, NET));
    await broadcastFrom(ring, 0, { v: 2, kind: 'signoff-aborted', ceremonyId: id, reason: 'broadcast failed' });

    expect(await p1.orch.waitFor(id, WAIT_MS)).toEqual({
      ceremonyId: id,
      kind: 'signing',
      status: 'aborted',
      reason: 'broadcast failed',
    });
  });

  it('clears ceremony blobs after the retention period', async () => {
    const id = 'sign-retention';
    const [p1] = participants([{ blobRetentionMs: { signing: 50, dkg: 50 } }]);

    const signaturesHex = await lead(id, makeProposal(tv.vaultKey, NET));
    await broadcastFrom(ring, 0, signoffDone(id, signaturesHex));
    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'done' });

    expect(ring[1]!.io.store.list(id).length).toBeGreaterThan(0);
    await eventually(() => expect(ring[1]!.io.store.list(id)).toEqual([]));
  });

  it('labels outputs from the address book, and signs without labels when the book cannot be read', async () => {
    const id = 'sign-labels';
    const recipient = vaultPayment(foreign.vaultKey, NET).address;
    const [p1, p2] = participants([
      { addressBook: async () => [{ label: 'cold storage', address: recipient }] },
      { addressBook: async () => Promise.reject(new Error('EACCES')) },
    ]);
    const proposal = makeProposal(tv.vaultKey, NET, { outputs: [{ address: recipient, amount: 50_000 }] });

    const signaturesHex = await lead(id, proposal);
    await broadcastFrom(ring, 0, signoffDone(id, signaturesHex));

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'done' });
    expect(await p2.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'done' });
    const outputs = (spec: CeremonySpec | undefined) => (spec as SigningSpec).outputs;
    expect(outputs(p1.gate.specs[0])).toEqual([
      { address: recipient, amount: 50_000, isChange: false, label: 'cold storage' },
      { address: vaultPayment(tv.vaultKey, NET).address, amount: 49_000, isChange: true },
    ]);
    expect(outputs(p2.gate.specs[0]).some(o => 'label' in o)).toBe(false);
    const bookLines = p2.log.lines.filter(l => /address book/.test(l.msg));
    expect(bookLines).toEqual([expect.objectContaining({ level: 'warn' })]);
  });

  it('pulls until the ceremony deadline, not the configured pull budget', async () => {
    const id = 'sign-slow-peer';
    // A pull budget far below the ceremony deadline: 3 attempts within 100 ms.
    const tight = makeRing(3, { maxAttempts: 3, deadlineMs: 100 });
    const ringPullOpts = { ...tight[1]!.io.pullOpts };
    const leaderIo = { ...tight[0]!.io, pullOpts: { ...tight[0]!.io.pullOpts, ...LEADER_PULLS } };
    const p1 = participant(tight[1]!, { vault: shareOf(tv, 1), ceremonyDeadlines: { signingMs: 4_000, dkgMs: 8_000 } });
    participant(tight[2]!, { vault: shareOf(tv, 2), ceremonyDeadlines: { signingMs: 4_000, dkgMs: 8_000 } });
    const pullAll = vi.spyOn(tight[1]!.io.puller, 'pullAll');

    // The leader serves nothing for its first 400 ms.
    tight[0]!.server.close();
    const since = Date.now();
    tight[0]!.io.transport.servePulls((from: PartyId, key: BlobKey) => {
      if (Date.now() - since < 400) return null;
      if (key.to !== undefined && key.to !== from) return null;
      return tight[0]!.io.store.get(key) ?? null;
    });

    const proposal = makeProposal(tv.vaultKey, NET);
    const { sighashes } = analyse(proposal);
    const sigs = await leadSigning(leaderIo, leaderSpec(id, sighashes), proposal);
    await broadcastFrom(tight, 0, signoffDone(id, sigs.map(toHex)));

    expect(await p1.orch.waitFor(id, WAIT_MS)).toMatchObject({ status: 'done' });
    expect(pullAll).toHaveBeenCalled();
    for (const call of pullAll.mock.calls) {
      expect(call[1]).toEqual({ ...ringPullOpts, deadlineMs: 4_000, maxAttempts: Number.MAX_SAFE_INTEGER });
    }
  });

  describe('live signing cap per leader', () => {
    /** Never decides: every accepted announce keeps its tracker live until a signoff, the deadline or stop(). */
    const undecided: ApprovalGate = { approve: () => new Promise<Decision>(() => {}) };
    const LIMIT = MAX_LIVE_SIGNINGS_PER_LEADER;
    const capId = (i: number) => `sign-cap-${i}`;

    /** Node `leader` announces `count` ceremonies `sign-cap-<from>..`. */
    async function announceMany(from: number, count: number, leader: PartyId = 0): Promise<void> {
      const proposal = makeProposal(tv.vaultKey, NET);
      for (let i = from; i < from + count; i++) await broadcastFrom(ring, leader, announceSign(capId(i), proposal));
    }

    it('pins the limit at 32', () => {
      expect(MAX_LIVE_SIGNINGS_PER_LEADER).toBe(32);
    });

    it('drops the announce that would exceed the limit, without a tracker or an outcome', async () => {
      const [p1] = participants([{ gate: undecided }]);
      const outcomes: CeremonyOutcome[] = [];
      p1.orch.onCompleted(o => outcomes.push(o));

      await announceMany(0, LIMIT);
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT));
      expect(p1.log.lines.filter(l => l.level === 'warn')).toEqual([]);

      const extra = capId(LIMIT);
      await announceMany(LIMIT, 1);

      const lines = p1.log.about(extra);
      expect(lines).toEqual([expect.objectContaining({ level: 'warn' })]);
      expect(lines[0]!.msg).toContain(`at most ${LIMIT}`);
      expect(lines[0]!.msg).toContain(`party 0 already leads ${LIMIT} live signing ceremonies`);
      // Nothing was analysed, gated or stored for it, and it left no outcome behind.
      await new Promise(r => setTimeout(r, 20));
      expect(p1.gate.specs).toHaveLength(LIMIT);
      expect(ring[1]!.io.store.list(extra)).toEqual([]);
      expect(outcomes).toEqual([]);
      await expect(p1.orch.waitFor(extra, 50)).rejects.toThrow(/timed out/);
      expect(p1.orch.ceremonyIdInUse(extra)).toBe(false);
    });

    it('still accepts announces from a different leader while one leader is at the limit', async () => {
      const [p1] = participants([{ gate: undecided }]);

      await announceMany(0, LIMIT + 1); // the last is dropped
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT));

      await broadcastFrom(ring, 2, announceSign('sign-other-leader', makeProposal(tv.vaultKey, NET)));

      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT + 1));
      expect(p1.gate.specs[LIMIT]).toMatchObject({ ceremonyId: 'sign-other-leader', leader: 'node-2' });
      expect(p1.log.about('sign-other-leader')).toEqual([]);
    });

    it('accepts a new announce once one of the leader\'s ceremonies has settled', async () => {
      const [p1] = participants([{ gate: undecided }]);

      await announceMany(0, LIMIT + 1);
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT));
      expect(p1.log.about(capId(LIMIT))).toEqual([expect.objectContaining({ level: 'warn' })]);

      // The leader aborts one ceremony: its slot frees.
      await broadcastFrom(ring, 0, { v: 2, kind: 'signoff-aborted', ceremonyId: capId(0), reason: 'done with it' });
      expect(await p1.orch.waitFor(capId(0), WAIT_MS)).toMatchObject({ status: 'aborted' });

      // The id dropped earlier left no trace, so it can be announced again.
      await announceMany(LIMIT, 1);
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT + 1));
      expect(p1.gate.specs[LIMIT]).toMatchObject({ ceremonyId: capId(LIMIT) });

      // Back at the limit.
      await announceMany(LIMIT + 1, 1);
      expect(p1.log.about(capId(LIMIT + 1))).toEqual([expect.objectContaining({ level: 'warn' })]);
      expect(p1.gate.specs).toHaveLength(LIMIT + 1);
    });

    it('frees the slot when a ceremony times out', async () => {
      const [p1] = participants([{ gate: undecided, ceremonyDeadlines: { signingMs: 1_500, dkgMs: 8_000 } }]);

      await announceMany(0, LIMIT);
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT));
      await announceMany(LIMIT, 1);
      expect(p1.log.about(capId(LIMIT))).toEqual([expect.objectContaining({ level: 'warn' })]);

      expect(await p1.orch.waitFor(capId(0), WAIT_MS)).toMatchObject({ status: 'timeout' });

      await announceMany(LIMIT, 1);
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT + 1));
    });

    it('does not count ceremonies this node leads against a remote leader', async () => {
      const [p1] = participants([{ gate: undecided }]);
      const slots = Array.from({ length: LIMIT + 8 }, (_, i) => p1.orch.beginLocalSigning(`sign-led-${i}`));
      expect(slots.every(s => s !== null)).toBe(true);

      await announceMany(0, LIMIT);
      await eventually(() => expect(p1.gate.specs).toHaveLength(LIMIT));
      // And the other direction: remote trackers never block this node from leading.
      expect(p1.orch.beginLocalSigning('sign-led-after')).not.toBeNull();
    });
  });
});
