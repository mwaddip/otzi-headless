import { describe, it, expect } from 'vitest';
import { ThresholdMLDSA } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import {
  dkgRound1,
  dkgRound2,
  dkgFinalize,
  verifySignature,
  type KeyPackage,
  type PublicKeyPackage,
  type Rng,
  type Round1SecretPackage,
  type Round1Package,
  type Round2SecretPackage,
  type Round2Package,
} from '@mwaddip/frots';
import { toHex } from '../wire/hex';
import { getKL } from '../wire/dkg';
import type { DecryptedShare } from '../wire/share-crypto';
import { createInMemoryRing } from './in-memory-transport';
import { BlobStore } from './blob-store';
import { BlobServer } from './blob-server';
import { BlobPuller, type PullOpts } from './blob-puller';
import { CeremonyRunner, type SigningSpec, type FrostSigningSpec, type MldsaDkgSpec, type FrostDkgSpec, type CombinedDkgSpec, type CombinedDkgResult } from './ceremony-runner';
import { parseCeremonyMessage, sighashesFromAnnounceFrost, sessionIdFromAnnounceDkg, sessionIdFromAnnounceFrostDkg, sessionIdFromAnnounceCombinedDkg, makeDummyFrostKeylinkExtras } from './ceremony-messages';
import type { DKGResult } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import { computeKeyLinkHash } from '../node/frost-link';
import type { NetworkName } from '../node/types';
import type { PartyId } from './types';
import type { Transport } from './transport';

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

const FAST_PULL_OPTS: PullOpts = {
  maxAttempts: 50,
  initialDelayMs: 2,
  maxDelayMs: 20,
  deadlineMs: 30_000,
};

interface NodeCtx {
  transport: Transport;
  store: BlobStore;
  server: BlobServer;
  puller: BlobPuller;
  runner: CeremonyRunner;
}

function buildRing(peers: PartyId[]) {
  const ring = createInMemoryRing(peers);
  const ctx = new Map<PartyId, NodeCtx>();
  for (const id of peers) {
    const transport = ring.get(id)!;
    const store = new BlobStore();
    const server = new BlobServer(transport, store);
    const puller = new BlobPuller(transport, store);
    const runner = new CeremonyRunner(transport, store, puller);
    ctx.set(id, { transport, store, server, puller, runner });
  }
  const close = () => { for (const c of ctx.values()) c.server.close(); };
  return { ctx, close };
}

/**
 * Test-side participant orchestrator — what the daemon's trigger layer will
 * own in phase 5. Listens for announces + signoffs from the leader; dispatches
 * participateInSigning per announcement; resolves when signoff arrives.
 */
function orchestrateParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  share: DecryptedShare,
  opts: PullOpts,
  timeoutMs: number,
): Promise<{ status: 'done' | 'aborted' | 'timeout'; signatureHex?: string }> {
  return new Promise((resolve) => {
    let leaderId: PartyId | null = null;
    const inflight: Promise<void>[] = [];
    let settled = false;

    const settle = (result: { status: 'done' | 'aborted' | 'timeout'; signatureHex?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      Promise.allSettled(inflight).then(() => resolve(result));
    };

    const timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs);

    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;

      if (msg.kind === 'announce') {
        if (leaderId === null) leaderId = from;
        else if (leaderId !== from) return;

        const attemptSpec: SigningSpec = {
          ceremonyId: msg.ceremonyId,
          message: new TextEncoder().encode(''), // replaced below
          signers: msg.signers,
          share,
        };
        // Replace message from announcement (keeps share unchanged).
        const decodedMessage = new Uint8Array(msg.messageHex.length / 2);
        for (let i = 0; i < decodedMessage.length; i++) {
          decodedMessage[i] = parseInt(msg.messageHex.slice(i * 2, i * 2 + 2), 16);
        }
        attemptSpec.message = decodedMessage;

        inflight.push(ctx.runner.participateInSigning(attemptSpec, opts).catch(() => {}));
      } else if (msg.kind === 'signoff-done') {
        if (leaderId !== null && leaderId !== from) return;
        settle({ status: 'done', signatureHex: msg.signatureHex });
      } else if (msg.kind === 'signoff-aborted') {
        if (leaderId !== null && leaderId !== from) return;
        settle({ status: 'aborted' });
      }
    });
  });
}

describe('CeremonyRunner — ML-DSA threshold signing (asymmetric: leader + participants)', () => {
  it('sanity: trusted-dealer keygen + tm.sign produces a non-empty signature', () => {
    const tm = ThresholdMLDSA.create(44, 2, 3);
    const { publicKey, shares } = tm.keygen();
    const sig = tm.sign(new TextEncoder().encode('sanity'), publicKey, [shares[0]!, shares[1]!]);
    expect(sig.length).toBeGreaterThan(0);
  });

  it('2-of-3: leader produces a sig; participant receives a matching signoff-done', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);
    const message = new TextEncoder().encode('hello otzi-headless');
    const signers: PartyId[] = [0, 1];
    const baseId = 'test-1';
    const leaderId: PartyId = 0;

    try {
      // Participant (party 1) orchestrator — starts listening before leader broadcasts.
      const participantDone = orchestrateParticipant(
        ctx.get(1)!,
        baseId,
        shares[1]!,
        FAST_PULL_OPTS,
        60_000,
      );

      // Leader drives the ceremony.
      const sig = await ctx.get(leaderId)!.runner.signAsLeader(
        { ceremonyId: baseId, message, signers, share: shares[leaderId]! },
        FAST_PULL_OPTS,
      );
      expect(sig.length).toBeGreaterThan(0);

      // Leader broadcasts signoff after (in a real flow, after tx broadcast).
      await ctx.get(leaderId)!.runner.sendSigningDoneSignoff(baseId, sig);

      const result = await participantDone;
      expect(result.status).toBe('done');
      expect(result.signatureHex).toBe(toHex(sig));
    } finally {
      close();
    }
  }, 60_000);

  it('3-of-3: leader + two participants complete via signoff-done', async () => {
    const { shares } = dealerKeygen(3, 3);
    const { ctx, close } = buildRing([0, 1, 2]);
    const message = new TextEncoder().encode('3-of-3');
    const signers: PartyId[] = [0, 1, 2];
    const baseId = 'test-2';
    const leaderId: PartyId = 0;

    try {
      const participants = [1, 2].map((id) =>
        orchestrateParticipant(ctx.get(id)!, baseId, shares[id]!, FAST_PULL_OPTS, 60_000),
      );

      const sig = await ctx.get(leaderId)!.runner.signAsLeader(
        { ceremonyId: baseId, message, signers, share: shares[leaderId]! },
        FAST_PULL_OPTS,
      );
      await ctx.get(leaderId)!.runner.sendSigningDoneSignoff(baseId, sig);

      const results = await Promise.all(participants);
      expect(results.every(r => r.status === 'done')).toBe(true);
      expect(results.every(r => r.signatureHex === toHex(sig))).toBe(true);
    } finally {
      close();
    }
  }, 60_000);

  it('leader rejects if not in the active signer set', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);

    try {
      await expect(
        ctx.get(2)!.runner.signAsLeader(
          {
            ceremonyId: 'test-3',
            message: new Uint8Array([1]),
            signers: [0, 1],
            share: shares[2]!,
          },
          FAST_PULL_OPTS,
        ),
      ).rejects.toThrow(/not in the active signer set/);
    } finally {
      close();
    }
  });

  it('participant rejects if not in the active signer set', async () => {
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);

    try {
      await expect(
        ctx.get(2)!.runner.participateInSigning(
          {
            ceremonyId: 'test-3b',
            message: new Uint8Array([1]),
            signers: [0, 1],
            share: shares[2]!,
          },
          FAST_PULL_OPTS,
        ),
      ).rejects.toThrow(/not in the active signer set/);
    } finally {
      close();
    }
  });

  it('leader broadcasts signoff-aborted on pull timeout; listeners see aborted', async () => {
    // Party 1 is a valid signer but never participates (no orchestrator on it).
    // Leader's pull for party 1's r1 will time out, triggering the abort path.
    const { shares } = dealerKeygen(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'test-5';

    try {
      // Use party 2 as a passive listener to observe the signoff-aborted broadcast.
      // (Party 2 is in the ring but not a signer, so it doesn't participate; it just watches.)
      const listenerDone = orchestrateParticipant(
        ctx.get(2)!,
        baseId,
        shares[2]!,
        FAST_PULL_OPTS,
        5_000,
      );

      await expect(
        ctx.get(0)!.runner.signAsLeader(
          {
            ceremonyId: baseId,
            message: new Uint8Array([1]),
            signers: [0, 1],
            share: shares[0]!,
          },
          { maxAttempts: 3, initialDelayMs: 2, maxDelayMs: 5, deadlineMs: 30 },
          1,
        ),
      ).rejects.toThrow(/Signing aborted/);

      const result = await listenerDone;
      expect(result.status).toBe('aborted');
    } finally {
      close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FROST signing tests
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_RNG: Rng = {
  fillBytes(dest) { crypto.getRandomValues(dest); },
};

/**
 * Run FROST DKG in-memory to produce a full keying (n KeyPackages +
 * shared PublicKeyPackage). Runs the three-round protocol with perfect
 * delivery. Used purely as test infrastructure — production keys come from a
 * real DKG ceremony (phase 2.5b).
 */
function frostDkgInMemory(minSigners: number, maxSigners: number): {
  keyPackages: KeyPackage[]; // indexed by 0-based partyId
  publicKeyPackage: PublicKeyPackage;
} {
  const rng = SYSTEM_RNG;

  // Round 1
  const round1Secrets: Round1SecretPackage[] = [];
  const round1Packages: Round1Package[] = [];
  for (let i = 0; i < maxSigners; i++) {
    const out = dkgRound1(BigInt(i + 1), maxSigners, minSigners, rng);
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

  // Round 2
  const round2Secrets: Round2SecretPackage[] = [];
  const round2PackagesPerSender: ReadonlyMap<bigint, Round2Package>[] = [];
  for (let i = 0; i < maxSigners; i++) {
    const out = dkgRound2(round1Secrets[i]!, receivedRound1PerParty[i]!);
    round2Secrets.push(out.secretPackage);
    round2PackagesPerSender.push(out.packages);
  }

  // Each party collects Round2 packages addressed to it.
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

  // Finalize
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

function randomSighash(): Uint8Array {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return buf;
}

/** FROST participant orchestrator — mirrors `orchestrateParticipant` but for FROST (no retries). */
function orchestrateFrostParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  keyPackage: KeyPackage,
  publicKeyPackage: PublicKeyPackage,
  opts: PullOpts,
  timeoutMs: number,
): Promise<{ status: 'done' | 'aborted' | 'timeout'; signaturesHex?: string[] }> {
  return new Promise((resolve) => {
    let leaderId: PartyId | null = null;
    let inflight: Promise<void> | null = null;
    let settled = false;

    const settle = (result: { status: 'done' | 'aborted' | 'timeout'; signaturesHex?: string[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      (inflight ?? Promise.resolve()).then(() => resolve(result));
    };

    const timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs);

    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;

      if (msg.kind === 'announce-frost') {
        if (leaderId === null) leaderId = from;
        else if (leaderId !== from) return;

        const sighashes = sighashesFromAnnounceFrost(msg);
        const spec: FrostSigningSpec = {
          ceremonyId: msg.ceremonyId,
          sighashes,
          signers: msg.signers,
          keyPackage,
          publicKeyPackage,
          rng: SYSTEM_RNG,
        };
        inflight = ctx.runner.participateInFrostSigning(spec, opts).catch(() => {});
      } else if (msg.kind === 'signoff-frost-done') {
        if (leaderId !== null && leaderId !== from) return;
        settle({ status: 'done', signaturesHex: msg.signaturesHex });
      } else if (msg.kind === 'signoff-aborted') {
        if (leaderId !== null && leaderId !== from) return;
        settle({ status: 'aborted' });
      }
    });
  });
}

describe('CeremonyRunner — FROST signing (asymmetric: leader + participants)', () => {
  it('sanity: FROST DKG in-memory produces usable key material', () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    expect(keyPackages).toHaveLength(3);
    expect(publicKeyPackage.verifyingKey.length).toBe(33);
    expect(publicKeyPackage.minSigners).toBe(2);
    for (let i = 0; i < 3; i++) {
      expect(keyPackages[i]!.identifier).toBe(BigInt(i + 1));
    }
  });

  it('2-of-3: leader signs 2 sighashes (mixed key-path + script-path); participant sees matching signoff', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);
    const signers: PartyId[] = [0, 1];
    const leaderId: PartyId = 0;
    const baseId = 'frost-test-1';

    const sighashes = [
      { hash: randomSighash(), tweaked: true },   // key-path
      { hash: randomSighash(), tweaked: false },  // script-path
    ];

    try {
      const participantDone = orchestrateFrostParticipant(
        ctx.get(1)!,
        baseId,
        keyPackages[1]!,
        publicKeyPackage,
        FAST_PULL_OPTS,
        60_000,
      );

      const sigs = await ctx.get(leaderId)!.runner.signFrostAsLeader(
        {
          ceremonyId: baseId,
          sighashes,
          signers,
          keyPackage: keyPackages[leaderId]!,
          publicKeyPackage,
          rng: SYSTEM_RNG,
        },
        FAST_PULL_OPTS,
        makeDummyFrostKeylinkExtras(),
      );
      expect(sigs).toHaveLength(2);
      for (const sig of sigs) expect(sig.length).toBe(64);

      // Verify each signature under the correct aggregate key.
      expect(verifySignature(sigs[0]!, sighashes[0]!.hash, publicKeyPackage.verifyingKey)).toBe(true);
      expect(verifySignature(sigs[1]!, sighashes[1]!.hash, publicKeyPackage.untweakedVerifyingKey)).toBe(true);

      await ctx.get(leaderId)!.runner.sendFrostSigningDoneSignoff(baseId, sigs);

      const result = await participantDone;
      expect(result.status).toBe('done');
      expect(result.signaturesHex).toEqual(sigs.map(s => toHex(s)));
    } finally {
      close();
    }
  }, 60_000);

  it('3-of-3: leader + two participants complete FROST signing', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(3, 3);
    const { ctx, close } = buildRing([0, 1, 2]);
    const signers: PartyId[] = [0, 1, 2];
    const leaderId: PartyId = 0;
    const baseId = 'frost-test-2';

    const sighashes = [{ hash: randomSighash(), tweaked: true }];

    try {
      const participants = [1, 2].map(id =>
        orchestrateFrostParticipant(
          ctx.get(id)!,
          baseId,
          keyPackages[id]!,
          publicKeyPackage,
          FAST_PULL_OPTS,
          60_000,
        ),
      );

      const sigs = await ctx.get(leaderId)!.runner.signFrostAsLeader(
        {
          ceremonyId: baseId,
          sighashes,
          signers,
          keyPackage: keyPackages[leaderId]!,
          publicKeyPackage,
          rng: SYSTEM_RNG,
        },
        FAST_PULL_OPTS,
        makeDummyFrostKeylinkExtras(),
      );
      expect(verifySignature(sigs[0]!, sighashes[0]!.hash, publicKeyPackage.verifyingKey)).toBe(true);

      await ctx.get(leaderId)!.runner.sendFrostSigningDoneSignoff(baseId, sigs);

      const results = await Promise.all(participants);
      expect(results.every(r => r.status === 'done')).toBe(true);
      expect(results.every(r => r.signaturesHex?.[0] === toHex(sigs[0]!))).toBe(true);
    } finally {
      close();
    }
  }, 60_000);

  it('leader rejects if not in the active signer set', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);

    try {
      await expect(
        ctx.get(2)!.runner.signFrostAsLeader(
          {
            ceremonyId: 'frost-test-3',
            sighashes: [{ hash: randomSighash(), tweaked: true }],
            signers: [0, 1],
            keyPackage: keyPackages[2]!,
            publicKeyPackage,
            rng: SYSTEM_RNG,
          },
          FAST_PULL_OPTS,
          makeDummyFrostKeylinkExtras(),
        ),
      ).rejects.toThrow(/not in the active signer set/);
    } finally {
      close();
    }
  });

  it('participant rejects if not in the active signer set', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);

    try {
      await expect(
        ctx.get(2)!.runner.participateInFrostSigning(
          {
            ceremonyId: 'frost-test-3b',
            sighashes: [{ hash: randomSighash(), tweaked: true }],
            signers: [0, 1],
            keyPackage: keyPackages[2]!,
            publicKeyPackage,
            rng: SYSTEM_RNG,
          },
          FAST_PULL_OPTS,
        ),
      ).rejects.toThrow(/not in the active signer set/);
    } finally {
      close();
    }
  });

  it('leader broadcasts signoff-aborted on pull timeout; listeners see aborted', async () => {
    const { keyPackages, publicKeyPackage } = frostDkgInMemory(2, 3);
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'frost-test-5';

    try {
      // Party 2 is a passive listener — not in signers, just watching.
      const listenerDone = orchestrateFrostParticipant(
        ctx.get(2)!,
        baseId,
        keyPackages[2]!,
        publicKeyPackage,
        FAST_PULL_OPTS,
        5_000,
      );

      await expect(
        ctx.get(0)!.runner.signFrostAsLeader(
          {
            ceremonyId: baseId,
            sighashes: [{ hash: randomSighash(), tweaked: true }],
            signers: [0, 1],  // party 1 never participates
            keyPackage: keyPackages[0]!,
            publicKeyPackage,
            rng: SYSTEM_RNG,
          },
          { maxAttempts: 3, initialDelayMs: 2, maxDelayMs: 5, deadlineMs: 30 },
          makeDummyFrostKeylinkExtras(),
        ),
      ).rejects.toThrow(/FROST signing aborted/);

      const result = await listenerDone;
      expect(result.status).toBe('aborted');
    } finally {
      close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// ML-DSA DKG tests (symmetric — all peers equal, each produces its own share)
// ─────────────────────────────────────────────────────────────────────────────

function orchestrateDkgParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  opts: PullOpts,
  timeoutMs: number,
): Promise<{ status: 'done' | 'aborted' | 'timeout'; result?: DKGResult }> {
  return new Promise((resolve) => {
    let initiatorId: PartyId | null = null;
    let inflight: Promise<unknown> = Promise.resolve();
    let settled = false;
    let capturedResult: DKGResult | undefined;

    const settle = (status: 'done' | 'aborted' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      void inflight.then(() => resolve({ status, result: capturedResult }));
    };

    const timer = setTimeout(() => settle('timeout'), timeoutMs);

    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;

      if (msg.kind === 'announce-dkg') {
        if (initiatorId === null) initiatorId = from;
        else if (initiatorId !== from) return;

        const sessionId = sessionIdFromAnnounceDkg(msg);
        const spec: MldsaDkgSpec = {
          ceremonyId: msg.ceremonyId,
          threshold: msg.threshold,
          parties: msg.parties,
          level: msg.level,
        };
        inflight = ctx.runner.participateInMldsaDkg(spec, sessionId, opts).then(
          (r) => {
            capturedResult = r;
            settle('done');
          },
          () => {
            // Error-path: rely on signoff-aborted or timeout to settle.
          },
        );
      } else if (msg.kind === 'signoff-aborted') {
        if (initiatorId !== null && initiatorId !== from) return;
        settle('aborted');
      }
    });
  });
}

const DKG_PULL_OPTS: PullOpts = {
  maxAttempts: 200,
  initialDelayMs: 5,
  maxDelayMs: 50,
  deadlineMs: 120_000,
};

describe('CeremonyRunner — ML-DSA DKG (symmetric)', () => {
  it('2-of-3: all peers agree on public key; each gets a share with matching partyId', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'dkg-test-1';
    const spec: MldsaDkgSpec = {
      ceremonyId: baseId,
      threshold: 2,
      parties: 3,
      level: 44,
    };

    try {
      const participants = [1, 2].map(id =>
        orchestrateDkgParticipant(ctx.get(id)!, baseId, DKG_PULL_OPTS, 120_000),
      );

      const initiatorResult = await ctx.get(0)!.runner.runMldsaDkg(spec, DKG_PULL_OPTS);
      const participantResults = await Promise.all(participants);

      expect(initiatorResult.publicKey.length).toBeGreaterThan(0);
      expect(initiatorResult.share.id).toBe(0);

      for (let i = 0; i < 2; i++) {
        const pr = participantResults[i]!;
        expect(pr.status).toBe('done');
        expect(pr.result).toBeDefined();
        expect(pr.result!.share.id).toBe(i + 1);
        expect(toHex(pr.result!.publicKey)).toBe(toHex(initiatorResult.publicKey));
      }
    } finally {
      close();
    }
  }, 180_000);

  it('DKG-produced shares can threshold-sign a message end-to-end', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'dkg-test-2';
    const spec: MldsaDkgSpec = {
      ceremonyId: baseId,
      threshold: 2,
      parties: 3,
      level: 44,
    };

    try {
      const participants = [1, 2].map(id =>
        orchestrateDkgParticipant(ctx.get(id)!, baseId, DKG_PULL_OPTS, 120_000),
      );

      const initiatorResult = await ctx.get(0)!.runner.runMldsaDkg(spec, DKG_PULL_OPTS);
      const participantResults = await Promise.all(participants);

      const shares = [initiatorResult.share, participantResults[0]!.result!.share];
      const instance = ThresholdMLDSA.create(44, 2, 3);
      const msg = new TextEncoder().encode('dkg end-to-end test');

      // instance.sign may return null on rejection sampling; retry.
      let sig: Uint8Array | null = null;
      for (let attempt = 0; attempt < 50 && !sig; attempt++) {
        try {
          const candidate = instance.sign(msg, initiatorResult.publicKey, shares);
          if (candidate && candidate.length > 0) sig = candidate;
        } catch {
          // rejection — retry
        }
      }
      expect(sig).not.toBeNull();
      expect(sig!.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FROST DKG tests (symmetric — 2 rounds, each peer computes own KeyPackage)
// ─────────────────────────────────────────────────────────────────────────────

interface FrostDkgOutcome {
  status: 'done' | 'aborted' | 'timeout';
  keyPackage?: KeyPackage;
  publicKeyPackage?: PublicKeyPackage;
}

function orchestrateFrostDkgParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  opts: PullOpts,
  timeoutMs: number,
): Promise<FrostDkgOutcome> {
  return new Promise((resolve) => {
    let initiatorId: PartyId | null = null;
    let inflight: Promise<unknown> = Promise.resolve();
    let settled = false;
    let outcome: Omit<FrostDkgOutcome, 'status'> = {};

    const settle = (status: 'done' | 'aborted' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      void inflight.then(() => resolve({ status, ...outcome }));
    };

    const timer = setTimeout(() => settle('timeout'), timeoutMs);

    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;

      if (msg.kind === 'announce-frost-dkg') {
        if (initiatorId === null) initiatorId = from;
        else if (initiatorId !== from) return;

        const sessionId = sessionIdFromAnnounceFrostDkg(msg);
        const spec: FrostDkgSpec = {
          ceremonyId: msg.ceremonyId,
          threshold: msg.threshold,
          parties: msg.parties,
          rng: SYSTEM_RNG,
        };
        inflight = ctx.runner.participateInFrostDkg(spec, sessionId, opts).then(
          (r) => {
            outcome = { keyPackage: r.keyPackage, publicKeyPackage: r.publicKeyPackage };
            settle('done');
          },
          () => {},
        );
      } else if (msg.kind === 'signoff-aborted') {
        if (initiatorId !== null && initiatorId !== from) return;
        settle('aborted');
      }
    });
  });
}

describe('CeremonyRunner — FROST DKG (symmetric)', () => {
  it('2-of-3: all peers agree on publicKeyPackage; each gets a distinct KeyPackage', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'frost-dkg-test-1';
    const spec: FrostDkgSpec = {
      ceremonyId: baseId,
      threshold: 2,
      parties: 3,
      rng: SYSTEM_RNG,
    };

    try {
      const participants = [1, 2].map(id =>
        orchestrateFrostDkgParticipant(ctx.get(id)!, baseId, FAST_PULL_OPTS, 60_000),
      );

      const initResult = await ctx.get(0)!.runner.runFrostDkg(spec, FAST_PULL_OPTS);
      const partResults = await Promise.all(participants);

      expect(initResult.publicKeyPackage.verifyingKey.length).toBe(33);
      expect(initResult.keyPackage.identifier).toBe(1n); // partyId 0 → FROST id 1

      for (let i = 0; i < 2; i++) {
        const pr = partResults[i]!;
        expect(pr.status).toBe('done');
        expect(pr.keyPackage!.identifier).toBe(BigInt(i + 2));
        // Every peer must derive the same group verifying key.
        expect(toHex(pr.publicKeyPackage!.verifyingKey)).toBe(toHex(initResult.publicKeyPackage.verifyingKey));
      }
    } finally {
      close();
    }
  }, 60_000);

  it('FROST DKG → FROST signing end-to-end: DKG-produced keys sign & verify', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const dkgBaseId = 'frost-dkg-test-2';
    const signBaseId = 'frost-dkg-test-2-sign';

    try {
      // Phase A: run FROST DKG on all 3 peers.
      const dkgParticipants = [1, 2].map(id =>
        orchestrateFrostDkgParticipant(ctx.get(id)!, dkgBaseId, FAST_PULL_OPTS, 60_000),
      );
      const initDkg = await ctx.get(0)!.runner.runFrostDkg(
        { ceremonyId: dkgBaseId, threshold: 2, parties: 3, rng: SYSTEM_RNG },
        FAST_PULL_OPTS,
      );
      const partDkgResults = await Promise.all(dkgParticipants);
      for (const pr of partDkgResults) expect(pr.status).toBe('done');

      // Phase B: use party 0 + party 1 to sign a sighash.
      const sighash = randomSighash();
      const signingParticipant = orchestrateFrostParticipant(
        ctx.get(1)!,
        signBaseId,
        partDkgResults[0]!.keyPackage!,
        partDkgResults[0]!.publicKeyPackage!,
        FAST_PULL_OPTS,
        60_000,
      );
      const sigs = await ctx.get(0)!.runner.signFrostAsLeader(
        {
          ceremonyId: signBaseId,
          sighashes: [{ hash: sighash, tweaked: true }],
          signers: [0, 1],
          keyPackage: initDkg.keyPackage,
          publicKeyPackage: initDkg.publicKeyPackage,
          rng: SYSTEM_RNG,
        },
        FAST_PULL_OPTS,
        makeDummyFrostKeylinkExtras(),
      );
      await ctx.get(0)!.runner.sendFrostSigningDoneSignoff(signBaseId, sigs);
      const signResult = await signingParticipant;
      expect(signResult.status).toBe('done');

      // Verify the aggregate signature under the DKG-produced group key.
      expect(sigs).toHaveLength(1);
      expect(sigs[0]!.length).toBe(64);
      expect(verifySignature(sigs[0]!, sighash, initDkg.publicKeyPackage.verifyingKey)).toBe(true);
    } finally {
      close();
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined DKG tests (ML-DSA + FROST under one sessionId, matches Ötzi V3)
// ─────────────────────────────────────────────────────────────────────────────

function orchestrateCombinedDkgParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  opts: PullOpts,
  timeoutMs: number,
  network?: NetworkName,
): Promise<{ status: 'done' | 'aborted' | 'timeout'; result?: CombinedDkgResult }> {
  return new Promise((resolve) => {
    let initiatorId: PartyId | null = null;
    let inflight: Promise<unknown> = Promise.resolve();
    let settled = false;
    let capturedResult: CombinedDkgResult | undefined;

    const settle = (status: 'done' | 'aborted' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      void inflight.then(() => resolve({ status, result: capturedResult }));
    };

    const timer = setTimeout(() => settle('timeout'), timeoutMs);

    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;

      if (msg.kind === 'announce-combined-dkg') {
        if (initiatorId === null) initiatorId = from;
        else if (initiatorId !== from) return;

        const sessionId = sessionIdFromAnnounceCombinedDkg(msg);
        const spec: CombinedDkgSpec = {
          ceremonyId: msg.ceremonyId,
          threshold: msg.threshold,
          parties: msg.parties,
          level: msg.level,
          rng: SYSTEM_RNG,
          ...(network ? { network } : {}),
        };
        inflight = ctx.runner.participateInCombinedDkg(spec, sessionId, opts).then(
          (r) => {
            capturedResult = r;
            settle('done');
          },
          () => {},
        );
      } else if (msg.kind === 'signoff-aborted') {
        if (initiatorId !== null && initiatorId !== from) return;
        settle('aborted');
      }
    });
  });
}

describe('CeremonyRunner — Combined DKG (ML-DSA + FROST, one sessionId)', () => {
  it('2-of-3: single announce produces matching ML-DSA publicKey + FROST publicKeyPackage on every peer', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'combined-dkg-test-1';
    const spec: CombinedDkgSpec = {
      ceremonyId: baseId,
      threshold: 2,
      parties: 3,
      level: 44,
      rng: SYSTEM_RNG,
    };

    try {
      const participants = [1, 2].map(id =>
        orchestrateCombinedDkgParticipant(ctx.get(id)!, baseId, DKG_PULL_OPTS, 180_000),
      );

      const initResult = await ctx.get(0)!.runner.runCombinedDkg(spec, DKG_PULL_OPTS);
      const partResults = await Promise.all(participants);

      // ML-DSA: every peer agrees on the same FIPS 204 public key, own share id matches partyId.
      expect(initResult.mldsa.share.id).toBe(0);
      for (let i = 0; i < 2; i++) {
        const pr = partResults[i]!;
        expect(pr.status).toBe('done');
        expect(pr.result!.mldsa.share.id).toBe(i + 1);
        expect(toHex(pr.result!.mldsa.publicKey)).toBe(toHex(initResult.mldsa.publicKey));
      }

      // FROST: every peer agrees on the same group verifying key.
      for (let i = 0; i < 2; i++) {
        const pr = partResults[i]!;
        expect(pr.result!.frost.keyPackage.identifier).toBe(BigInt(i + 2));
        expect(toHex(pr.result!.frost.publicKeyPackage.verifyingKey)).toBe(
          toHex(initResult.frost.publicKeyPackage.verifyingKey),
        );
      }

      // No network supplied → key-link phase skipped; frostLegacySig stays undefined.
      expect(initResult.frostLegacySig).toBeUndefined();
      for (const pr of partResults) expect(pr.result!.frostLegacySig).toBeUndefined();
    } finally {
      close();
    }
  }, 240_000);

  it('network=testnet: key-link phase produces matching frostLegacySig on every peer (BIP340 verifies under tweaked key)', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const baseId = 'combined-dkg-keylink-1';
    const spec: CombinedDkgSpec = {
      ceremonyId: baseId,
      threshold: 2,
      parties: 3,
      level: 44,
      rng: SYSTEM_RNG,
      network: 'testnet',
    };

    try {
      const participants = [1, 2].map(id =>
        orchestrateCombinedDkgParticipant(ctx.get(id)!, baseId, DKG_PULL_OPTS, 180_000, 'testnet'),
      );

      const initResult = await ctx.get(0)!.runner.runCombinedDkg(spec, DKG_PULL_OPTS);
      const partResults = await Promise.all(participants);

      // Every peer exited with a sig and they all match (n-of-n → deterministic).
      expect(initResult.frostLegacySig).toBeDefined();
      const sigHex = toHex(initResult.frostLegacySig!);
      for (const pr of partResults) {
        expect(pr.status).toBe('done');
        expect(pr.result!.frostLegacySig).toBeDefined();
        expect(toHex(pr.result!.frostLegacySig!)).toBe(sigHex);
      }

      // The sig commits to `computeKeyLinkHash(mldsaPub, tweakedFrostPub, untweakedFrostPub, 'testnet')`
      // and verifies under the tweaked group key — matches what the OPNet SDK
      // expects when it replays via `withFrostLegacySig`.
      const keyLinkHash = computeKeyLinkHash(
        initResult.mldsa.publicKey,
        initResult.frost.publicKeyPackage.verifyingKey,
        initResult.frost.publicKeyPackage.untweakedVerifyingKey,
        'testnet',
      );
      expect(
        verifySignature(initResult.frostLegacySig!, keyLinkHash, initResult.frost.publicKeyPackage.verifyingKey),
      ).toBe(true);
    } finally {
      close();
    }
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.5c — key-link signing as pure composition of existing ceremonies
// ─────────────────────────────────────────────────────────────────────────────
// Not a new runner. Demonstrates: combined DKG → each peer computes keyLinkHash
// locally → leader runs FROST signing over it → signoff broadcasts the sig →
// every peer (including non-signer listeners) captures it. This is what the
// phase-5 trigger layer will orchestrate at DKG completion so share files can
// be written in Ötzi V3 byte-compat format (ML-DSA share + FROST key package
// + frostLegacySig).

describe('Integration — combined DKG → key-link FROST signing (2.5c)', () => {
  it('all peers derive matching keyLinkHash; leader signs; all peers capture via signoff', async () => {
    const { ctx, close } = buildRing([0, 1, 2]);
    const dkgBaseId = '2.5c-dkg';
    const keylinkBaseId = '2.5c-keylink';
    const network: NetworkName = 'testnet';

    try {
      // (A) Combined DKG — every peer ends up with matching ML-DSA + FROST material.
      const dkgParticipants = [1, 2].map(id =>
        orchestrateCombinedDkgParticipant(ctx.get(id)!, dkgBaseId, DKG_PULL_OPTS, 180_000),
      );
      const initDkg = await ctx.get(0)!.runner.runCombinedDkg(
        { ceremonyId: dkgBaseId, threshold: 2, parties: 3, level: 44, rng: SYSTEM_RNG },
        DKG_PULL_OPTS,
      );
      const partDkg = await Promise.all(dkgParticipants);
      for (const pr of partDkg) expect(pr.status).toBe('done');

      const allDkg = [initDkg, partDkg[0]!.result!, partDkg[1]!.result!];

      // (B) Each peer computes keyLinkHash locally — must match bit-for-bit.
      const hashes = allDkg.map(r =>
        computeKeyLinkHash(
          r.mldsa.publicKey,
          r.frost.publicKeyPackage.verifyingKey,
          r.frost.publicKeyPackage.untweakedVerifyingKey,
          network,
        ),
      );
      expect(toHex(hashes[0]!)).toBe(toHex(hashes[1]!));
      expect(toHex(hashes[0]!)).toBe(toHex(hashes[2]!));
      const keyLinkHash = hashes[0]!;

      // (C) Peer 0 leads FROST signing over keyLinkHash with signers=[0,1].
      //     Peer 1 participates. Peer 2 is a non-signer listener — its
      //     `participateInFrostSigning` call throws (not in signer set), the
      //     orchestrator swallows that, and peer 2 settles via signoff instead.
      const signer1 = orchestrateFrostParticipant(
        ctx.get(1)!,
        keylinkBaseId,
        partDkg[0]!.result!.frost.keyPackage,
        partDkg[0]!.result!.frost.publicKeyPackage,
        FAST_PULL_OPTS,
        60_000,
      );
      const listener2 = orchestrateFrostParticipant(
        ctx.get(2)!,
        keylinkBaseId,
        partDkg[1]!.result!.frost.keyPackage,
        partDkg[1]!.result!.frost.publicKeyPackage,
        FAST_PULL_OPTS,
        60_000,
      );

      const sigs = await ctx.get(0)!.runner.signFrostAsLeader(
        {
          ceremonyId: keylinkBaseId,
          sighashes: [{ hash: keyLinkHash, tweaked: true }],
          signers: [0, 1],
          keyPackage: initDkg.frost.keyPackage,
          publicKeyPackage: initDkg.frost.publicKeyPackage,
          rng: SYSTEM_RNG,
        },
        FAST_PULL_OPTS,
        { protocol: 'keylink', network: 'testnet' },
      );
      await ctx.get(0)!.runner.sendFrostSigningDoneSignoff(keylinkBaseId, sigs);

      const signer1Result = await signer1;
      const listener2Result = await listener2;

      // (D) Every peer sees the same frostLegacySig bytes. BIP340 verifies under tweaked key.
      expect(signer1Result.status).toBe('done');
      expect(listener2Result.status).toBe('done');
      const frostLegacySigHex = toHex(sigs[0]!);
      expect(signer1Result.signaturesHex?.[0]).toBe(frostLegacySigHex);
      expect(listener2Result.signaturesHex?.[0]).toBe(frostLegacySigHex);
      expect(
        verifySignature(sigs[0]!, keyLinkHash, initDkg.frost.publicKeyPackage.verifyingKey),
      ).toBe(true);
    } finally {
      close();
    }
  }, 300_000);
});
