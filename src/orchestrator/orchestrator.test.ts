import { ThresholdMLDSA } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import {
  dkgFinalize,
  dkgRound1,
  dkgRound2,
  type KeyPackage,
  type PublicKeyPackage,
  type Rng,
  type Round1Package,
  type Round1SecretPackage,
  type Round2Package,
  type Round2SecretPackage,
} from '@mwaddip/frots';
import { describe, expect, it } from 'vitest';
import { BlobPuller, type PullOpts } from '../core/blob-puller';
import { BlobServer } from '../core/blob-server';
import { BlobStore } from '../core/blob-store';
import { CeremonyRunner } from '../core/ceremony-runner';
import { createInMemoryRing } from '../core/in-memory-transport';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import { AutoGate } from '../gate/factory';
import { PolicyGate } from '../gate/policy';
import type { ApprovalGate } from '../gate/types';
import { getKL } from '../wire/dkg';
import { toHex } from '../wire/hex';
import type { DecryptedShare } from '../wire/share-crypto';
import { Orchestrator } from './orchestrator';
import type { CeremonyOutcome, OrchestratorDeps } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

const FAST_PULL_OPTS: PullOpts = {
  maxAttempts: 50,
  initialDelayMs: 2,
  maxDelayMs: 20,
  deadlineMs: 30_000,
};

const DKG_PULL_OPTS: PullOpts = {
  maxAttempts: 200,
  initialDelayMs: 5,
  maxDelayMs: 50,
  deadlineMs: 120_000,
};

const SYSTEM_RNG: Rng = {
  fillBytes(dest) {
    crypto.getRandomValues(dest);
  },
};

const TEST_DEADLINES = { signingMs: 60_000, dkgMs: 180_000 };

interface NodeCtx {
  id: string;
  partyId: PartyId;
  transport: Transport;
  store: BlobStore;
  server: BlobServer;
  puller: BlobPuller;
  runner: CeremonyRunner;
}

function buildRing(peerIds: PartyId[]): { ctx: Map<PartyId, NodeCtx>; close: () => void; peersById: Map<PartyId, string> } {
  const ring = createInMemoryRing(peerIds);
  const ctx = new Map<PartyId, NodeCtx>();
  const peersById = new Map<PartyId, string>();
  for (const pid of peerIds) {
    const id = `node-${String.fromCharCode(97 + pid)}`;
    peersById.set(pid, id);
    const transport = ring.get(pid)!;
    const store = new BlobStore();
    const server = new BlobServer(transport, store);
    const puller = new BlobPuller(transport, store);
    const runner = new CeremonyRunner(transport, store, puller);
    ctx.set(pid, { id, partyId: pid, transport, store, server, puller, runner });
  }
  const close = () => {
    for (const c of ctx.values()) c.server.close();
  };
  return { ctx, close, peersById };
}

function dealerKeygen(t: number, n: number, level = 44): {
  publicKeyHex: string;
  shares: DecryptedShare[];
} {
  const tm = ThresholdMLDSA.create(level, t, n);
  const { publicKey, shares } = tm.keygen();
  const publicKeyHex = toHex(publicKey);
  const { K, L } = getKL(level);
  const wrapped: DecryptedShare[] = shares.map((ks) => ({
    publicKey: publicKeyHex,
    partyId: ks.id,
    threshold: t,
    parties: n,
    level,
    shareBytes: new Uint8Array(0),
    keyShare: ks,
    K,
    L,
  }));
  return { publicKeyHex, shares: wrapped };
}

function frostDkgInMemory(
  minSigners: number,
  maxSigners: number,
): { keyPackages: KeyPackage[]; publicKeyPackage: PublicKeyPackage } {
  const round1Secrets: Round1SecretPackage[] = [];
  const round1Packages: Round1Package[] = [];
  for (let i = 0; i < maxSigners; i++) {
    const out = dkgRound1(BigInt(i + 1), maxSigners, minSigners, SYSTEM_RNG);
    round1Secrets.push(out.secretPackage);
    round1Packages.push(out.package);
  }
  const receivedRound1PerParty: Map<bigint, Round1Package>[] = [];
  for (let i = 0; i < maxSigners; i++) {
    const m = new Map<bigint, Round1Package>();
    for (let j = 0; j < maxSigners; j++) {
      if (i !== j) m.set(BigInt(j + 1), round1Packages[j]!);
    }
    receivedRound1PerParty.push(m);
  }
  const round2Secrets: Round2SecretPackage[] = [];
  const round2PackagesPerSender: ReadonlyMap<bigint, Round2Package>[] = [];
  for (let i = 0; i < maxSigners; i++) {
    const out = dkgRound2(round1Secrets[i]!, receivedRound1PerParty[i]!);
    round2Secrets.push(out.secretPackage);
    round2PackagesPerSender.push(out.packages);
  }
  const receivedRound2PerParty: Map<bigint, Round2Package>[] = [];
  for (let recipient = 0; recipient < maxSigners; recipient++) {
    const m = new Map<bigint, Round2Package>();
    for (let sender = 0; sender < maxSigners; sender++) {
      if (sender === recipient) continue;
      const pkg = round2PackagesPerSender[sender]!.get(BigInt(recipient + 1));
      if (!pkg) throw new Error(`DKG: missing R2 from ${sender + 1} to ${recipient + 1}`);
      m.set(BigInt(sender + 1), pkg);
    }
    receivedRound2PerParty.push(m);
  }
  let publicKeyPackage: PublicKeyPackage | null = null;
  const keyPackages: KeyPackage[] = [];
  for (let i = 0; i < maxSigners; i++) {
    const out = dkgFinalize(
      round2Secrets[i]!,
      receivedRound1PerParty[i]!,
      receivedRound2PerParty[i]!,
    );
    keyPackages.push(out.keyPackage);
    if (!publicKeyPackage) publicKeyPackage = out.publicKeyPackage;
  }
  return { keyPackages, publicKeyPackage: publicKeyPackage! };
}

function buildOrchestrator(
  nctx: NodeCtx,
  peersById: Map<PartyId, string>,
  extras: {
    gate?: ApprovalGate;
    share?: DecryptedShare;
    frostKeyPackage?: KeyPackage;
    frostPublicKeyPackage?: PublicKeyPackage;
  },
): Orchestrator {
  const gate = extras.gate ?? new AutoGate();
  const share = extras.share ?? ({} as DecryptedShare);
  const deps: OrchestratorDeps = {
    transport: nctx.transport,
    runner: nctx.runner,
    gate,
    node: { id: nctx.id, partyId: nctx.partyId },
    peersById,
    share,
    frostKeyPackage: extras.frostKeyPackage,
    frostPublicKeyPackage: extras.frostPublicKeyPackage,
    rng: SYSTEM_RNG,
    pullOpts: FAST_PULL_OPTS,
    ceremonyDeadlines: TEST_DEADLINES,
  };
  return new Orchestrator(deps);
}

// ─────────────────────────────────────────────────────────────────────────
// ML-DSA signing
// ─────────────────────────────────────────────────────────────────────────

describe('Orchestrator — ML-DSA signing', () => {
  it('participant joins via orchestrator; settles on signoff-done with the leader sig', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'mldsa-sig-1';
    const message = new TextEncoder().encode('hello orchestrator');
    const signers: PartyId[] = [0, 1];

    const orch = buildOrchestrator(ctx.get(1)!, peersById, { share: shares[1]! });
    orch.start();

    try {
      const pending = orch.waitFor(baseId, 60_000);
      const sig = await ctx.get(0)!.runner.signAsLeader(
        { ceremonyId: baseId, message, signers, share: shares[0]! },
        FAST_PULL_OPTS,
      );
      await ctx.get(0)!.runner.sendSigningDoneSignoff(baseId, sig);

      const outcome = await pending;
      expect(outcome.kind).toBe('signing-mldsa');
      expect(outcome.status).toBe('done');
      if (outcome.kind === 'signing-mldsa') {
        expect(outcome.signatureHex).toBe(toHex(sig));
      }
    } finally {
      orch.stop();
      close();
    }
  }, 60_000);

  it('aborted signoff settles as aborted', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'mldsa-sig-aborted';

    // Party 2 is a passive listener — not in the signer set, just observing.
    const orch = buildOrchestrator(ctx.get(2)!, peersById, { share: shares[2]! });
    orch.start();

    try {
      const pending = orch.waitFor(baseId, 10_000);
      // Leader with signers [0,1]; party 1 never participates → abort.
      await expect(
        ctx.get(0)!.runner.signAsLeader(
          {
            ceremonyId: baseId,
            message: new TextEncoder().encode('won\'t sign'),
            signers: [0, 1],
            share: shares[0]!,
          },
          { maxAttempts: 2, initialDelayMs: 2, maxDelayMs: 5, deadlineMs: 30 },
        ),
      ).rejects.toThrow();

      const outcome = await pending;
      expect(outcome.status).toBe('aborted');
    } finally {
      orch.stop();
      close();
    }
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────
// FROST signing
// ─────────────────────────────────────────────────────────────────────────

describe('Orchestrator — FROST signing', () => {
  it('participant joins via orchestrator; settles on signoff-frost-done', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'frost-sig-1';
    const sighash = new Uint8Array(32);
    crypto.getRandomValues(sighash);

    const orch = buildOrchestrator(ctx.get(1)!, peersById, {
      frostKeyPackage: keyPackages[1]!,
      frostPublicKeyPackage: publicKeyPackage,
    });
    orch.start();

    try {
      const pending = orch.waitFor(baseId, 60_000);
      const sigs = await ctx.get(0)!.runner.signFrostAsLeader(
        {
          ceremonyId: baseId,
          sighashes: [{ hash: sighash, tweaked: true }],
          signers: [0, 1],
          keyPackage: keyPackages[0]!,
          publicKeyPackage,
          rng: SYSTEM_RNG,
        },
        FAST_PULL_OPTS,
      );
      await ctx.get(0)!.runner.sendFrostSigningDoneSignoff(baseId, sigs);

      const outcome = await pending;
      expect(outcome.kind).toBe('signing-frost');
      expect(outcome.status).toBe('done');
      if (outcome.kind === 'signing-frost') {
        expect(outcome.signaturesHex).toEqual(sigs.map((s) => toHex(s)));
      }
    } finally {
      orch.stop();
      close();
    }
  }, 60_000);

  it('FROST signing rejected when no frostKeyPackage is loaded (misconfigured daemon)', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'frost-sig-missing-key';

    // Party 1's orchestrator missing FROST key material — should not participate.
    const orch = buildOrchestrator(ctx.get(1)!, peersById, {});
    orch.start();

    try {
      // Leader will time out on pulls since participant never produces blobs.
      await expect(
        ctx.get(0)!.runner.signFrostAsLeader(
          {
            ceremonyId: baseId,
            sighashes: [{ hash: new Uint8Array(32), tweaked: true }],
            signers: [0, 1],
            keyPackage: keyPackages[0]!,
            publicKeyPackage,
            rng: SYSTEM_RNG,
          },
          { maxAttempts: 2, initialDelayMs: 2, maxDelayMs: 5, deadlineMs: 30 },
        ),
      ).rejects.toThrow();
    } finally {
      orch.stop();
      close();
    }
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────
// DKG — all three flavors
// ─────────────────────────────────────────────────────────────────────────

describe('Orchestrator — ML-DSA DKG', () => {
  it('two participants join via orchestrator; each settles with matching DKG result', async () => {
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'mldsa-dkg-1';
    const orchs = [1, 2].map((id) => buildOrchestrator(ctx.get(id)!, peersById, {}));
    orchs.forEach((o) => o.start());

    try {
      const pendings = orchs.map((o) => o.waitFor(baseId, 120_000));
      const leaderResult = await ctx.get(0)!.runner.runMldsaDkg(
        { ceremonyId: baseId, threshold: 2, parties: 3, level: 44 },
        DKG_PULL_OPTS,
      );

      const outcomes = await Promise.all(pendings);
      for (let i = 0; i < 2; i++) {
        const o = outcomes[i]!;
        expect(o.kind).toBe('dkg-mldsa');
        expect(o.status).toBe('done');
        if (o.kind === 'dkg-mldsa') {
          expect(o.result!.share.id).toBe(i + 1);
          expect(toHex(o.result!.publicKey)).toBe(toHex(leaderResult.publicKey));
        }
      }
    } finally {
      orchs.forEach((o) => o.stop());
      close();
    }
  }, 180_000);
});

describe('Orchestrator — FROST DKG', () => {
  it('participants join via orchestrator; verifyingKey agrees across peers', async () => {
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'frost-dkg-1';
    const orchs = [1, 2].map((id) => buildOrchestrator(ctx.get(id)!, peersById, {}));
    orchs.forEach((o) => o.start());

    try {
      const pendings = orchs.map((o) => o.waitFor(baseId, 60_000));
      const leaderResult = await ctx.get(0)!.runner.runFrostDkg(
        { ceremonyId: baseId, threshold: 2, parties: 3, rng: SYSTEM_RNG },
        FAST_PULL_OPTS,
      );
      const outcomes = await Promise.all(pendings);
      for (let i = 0; i < 2; i++) {
        const o = outcomes[i]!;
        expect(o.kind).toBe('dkg-frost');
        expect(o.status).toBe('done');
        if (o.kind === 'dkg-frost') {
          expect(o.keyPackage!.identifier).toBe(BigInt(i + 2));
          expect(toHex(o.publicKeyPackage!.verifyingKey)).toBe(
            toHex(leaderResult.publicKeyPackage.verifyingKey),
          );
        }
      }
    } finally {
      orchs.forEach((o) => o.stop());
      close();
    }
  }, 120_000);
});

describe('Orchestrator — Combined DKG', () => {
  it('participants settle with matching ML-DSA + FROST outputs', async () => {
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'combined-dkg-1';
    const orchs = [1, 2].map((id) => buildOrchestrator(ctx.get(id)!, peersById, {}));
    orchs.forEach((o) => o.start());

    try {
      const pendings = orchs.map((o) => o.waitFor(baseId, 120_000));
      const leaderResult = await ctx.get(0)!.runner.runCombinedDkg(
        { ceremonyId: baseId, threshold: 2, parties: 3, level: 44, rng: SYSTEM_RNG },
        DKG_PULL_OPTS,
      );
      const outcomes = await Promise.all(pendings);
      for (let i = 0; i < 2; i++) {
        const o = outcomes[i]!;
        expect(o.kind).toBe('dkg-combined');
        expect(o.status).toBe('done');
        if (o.kind === 'dkg-combined') {
          expect(toHex(o.result!.mldsa.publicKey)).toBe(toHex(leaderResult.mldsa.publicKey));
          expect(toHex(o.result!.frost.publicKeyPackage.verifyingKey)).toBe(
            toHex(leaderResult.frost.publicKeyPackage.verifyingKey),
          );
        }
      }
    } finally {
      orchs.forEach((o) => o.stop());
      close();
    }
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Leader auth + gate integration
// ─────────────────────────────────────────────────────────────────────────

describe('Orchestrator — leader authentication', () => {
  it('ignores announces from a peer that is not the established leader', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'mldsa-auth-1';
    const message = new TextEncoder().encode('leader auth');

    const orch = buildOrchestrator(ctx.get(1)!, peersById, { share: shares[1]! });
    orch.start();

    try {
      const outcomes: CeremonyOutcome[] = [];
      orch.onCompleted((o) => outcomes.push(o));

      // Leader = party 0. Leader announces the ceremony first.
      const pending = orch.waitFor(baseId, 30_000);
      // Parallel: party 2 tries to inject a rogue announce with the same baseId.
      const rogueAnnounce = new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          kind: 'announce',
          ceremonyId: baseId,
          baseCeremonyId: baseId,
          messageHex: '00',
          signers: [0, 1],
        }),
      );
      // Broadcast from party 0 first (establishes leader), then rogue.
      const sig = await ctx.get(0)!.runner.signAsLeader(
        { ceremonyId: baseId, message, signers: [0, 1], share: shares[0]! },
        FAST_PULL_OPTS,
      );
      // Rogue broadcast from party 2 (after leader is pinned).
      await ctx.get(2)!.transport.broadcast(rogueAnnounce);
      await ctx.get(0)!.runner.sendSigningDoneSignoff(baseId, sig);

      const outcome = await pending;
      expect(outcome.status).toBe('done');
      // Only the real leader's sig was settled; rogue announce produced no additional outcomes.
      expect(outcomes.filter((o) => o.baseCeremonyId === baseId)).toHaveLength(1);
    } finally {
      orch.stop();
      close();
    }
  }, 60_000);

  it('ignores signoffs from a peer that is not the established leader', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'mldsa-auth-2';

    const orch = buildOrchestrator(ctx.get(1)!, peersById, { share: shares[1]! });
    orch.start();

    try {
      const pending = orch.waitFor(baseId, 30_000);
      // Party 0 legitimately announces.
      const p = ctx.get(0)!.runner.signAsLeader(
        { ceremonyId: baseId, message: new TextEncoder().encode('x'), signers: [0, 1], share: shares[0]! },
        FAST_PULL_OPTS,
      );
      // Party 2 tries to send a rogue signoff-done BEFORE the real one.
      const fakeSig = new Uint8Array(64);
      const rogueSignoff = new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          kind: 'signoff-done',
          baseCeremonyId: baseId,
          signatureHex: toHex(fakeSig),
        }),
      );
      await ctx.get(2)!.transport.broadcast(rogueSignoff);

      const sig = await p;
      await ctx.get(0)!.runner.sendSigningDoneSignoff(baseId, sig);

      const outcome = await pending;
      expect(outcome.status).toBe('done');
      if (outcome.kind === 'signing-mldsa') {
        expect(outcome.signatureHex).toBe(toHex(sig));
        expect(outcome.signatureHex).not.toBe(toHex(fakeSig));
      }
    } finally {
      orch.stop();
      close();
    }
  }, 60_000);
});

describe('Orchestrator — gate integration', () => {
  it('silent drop when gate rejects — leader sees no participation and aborts', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'gate-reject-1';

    // PolicyGate with maxAmount set but spec.amount will be undefined (announce has no amount)
    // → strict-by-default rejects the generic signing.
    const policyGate = new PolicyGate({ maxAmount: 1_000n });
    const orch = buildOrchestrator(ctx.get(1)!, peersById, { share: shares[1]!, gate: policyGate });
    orch.start();

    try {
      await expect(
        ctx.get(0)!.runner.signAsLeader(
          {
            ceremonyId: baseId,
            message: new TextEncoder().encode('rejected'),
            signers: [0, 1],
            share: shares[0]!,
          },
          { maxAttempts: 2, initialDelayMs: 2, maxDelayMs: 5, deadlineMs: 30 },
        ),
      ).rejects.toThrow();
      // The orchestrator's participant task was never dispatched; leader gave up.
      // We can't assert "no participation" directly other than the leader aborting.
    } finally {
      orch.stop();
      close();
    }
  }, 20_000);

  it('AutoGate passes through — ceremony completes', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'gate-auto-1';

    const orch = buildOrchestrator(ctx.get(1)!, peersById, {
      share: shares[1]!,
      gate: new AutoGate(),
    });
    orch.start();

    try {
      const pending = orch.waitFor(baseId, 60_000);
      const sig = await ctx.get(0)!.runner.signAsLeader(
        { ceremonyId: baseId, message: new TextEncoder().encode('auto'), signers: [0, 1], share: shares[0]! },
        FAST_PULL_OPTS,
      );
      await ctx.get(0)!.runner.sendSigningDoneSignoff(baseId, sig);
      const outcome = await pending;
      expect(outcome.status).toBe('done');
    } finally {
      orch.stop();
      close();
    }
  }, 60_000);

  it('caches gate decision across ML-DSA retries (gate called once per baseId)', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close, peersById } = buildRing([0, 1, 2]);
    const baseId = 'gate-cache-1';

    let gateCalls = 0;
    const countingGate: ApprovalGate = {
      async approve() {
        gateCalls++;
        return 'approve';
      },
    };
    const orch = buildOrchestrator(ctx.get(1)!, peersById, {
      share: shares[1]!,
      gate: countingGate,
    });
    orch.start();

    try {
      const pending = orch.waitFor(baseId, 60_000);
      const sig = await ctx.get(0)!.runner.signAsLeader(
        { ceremonyId: baseId, message: new TextEncoder().encode('cache'), signers: [0, 1], share: shares[0]! },
        FAST_PULL_OPTS,
      );
      await ctx.get(0)!.runner.sendSigningDoneSignoff(baseId, sig);
      await pending;
      // Regardless of retries (there may be 0+ #N attempts), the gate runs once per baseId.
      expect(gateCalls).toBe(1);
    } finally {
      orch.stop();
      close();
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe('Orchestrator — lifecycle', () => {
  it('stop() rejects pending waitFor with "stopped" error', async () => {
    const { ctx, close, peersById } = buildRing([0, 1]);
    const orch = buildOrchestrator(ctx.get(1)!, peersById, {});
    orch.start();

    const pending = orch.waitFor('never-fires', 10_000);
    orch.stop();
    await expect(pending).rejects.toThrow(/stopped before/);
    close();
  });

  it('waitFor times out when no matching outcome arrives', async () => {
    const { ctx, close, peersById } = buildRing([0, 1]);
    const orch = buildOrchestrator(ctx.get(1)!, peersById, {});
    orch.start();

    await expect(orch.waitFor('no-such-ceremony', 50)).rejects.toThrow(/timed out/);
    orch.stop();
    close();
  });

  it('double-start is idempotent; double-stop is idempotent', () => {
    const { ctx, close, peersById } = buildRing([0, 1]);
    const orch = buildOrchestrator(ctx.get(1)!, peersById, {});
    orch.start();
    orch.start();
    orch.stop();
    orch.stop();
    close();
  });
});
