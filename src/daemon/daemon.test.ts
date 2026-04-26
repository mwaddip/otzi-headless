import { ThresholdMLDSA } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { Rng } from '@mwaddip/frots';
import { describe, expect, it } from 'vitest';
import type { PullOpts } from '../core/blob-puller';
import { createInMemoryRing } from '../core/in-memory-transport';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import { getKL } from '../wire/dkg';
import { toHex } from '../wire/hex';
import type { DecryptedShare } from '../wire/share-crypto';
import type { DaemonConfig } from '../config/types';
import { buildStateFromShare } from './config-merge';
import { Daemon } from './daemon';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const FAST_PULL: PullOpts = {
  maxAttempts: 50,
  initialDelayMs: 2,
  maxDelayMs: 20,
  deadlineMs: 30_000,
};

const DKG_PULL: PullOpts = {
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

function dealerKeygen(t: number, n: number, level = 44): DecryptedShare[] {
  const tm = ThresholdMLDSA.create(level, t, n);
  const { publicKey, shares } = tm.keygen();
  const publicKeyHex = toHex(publicKey);
  const { K, L } = getKL(level);
  return shares.map((ks) => ({
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
}

function makeConfig(overrides: {
  nodeId: string;
  partyId: PartyId;
  peerIds: ReadonlyArray<{ id: string; partyId: PartyId }>;
  httpBind?: string;
  gateStrategy?: 'auto' | 'policy';
}): DaemonConfig {
  return {
    share: { path: '/dev/null', passwordEnv: 'UNUSED' },
    node: { id: overrides.nodeId, partyId: overrides.partyId },
    network: { name: 'testnet', opnetRpc: 'https://testnet.opnet.org' },
    transport: { kind: 'peer-mesh' },
    peers: overrides.peerIds.map((p) => ({ id: p.id, partyId: p.partyId })),
    gate: { strategy: overrides.gateStrategy ?? 'auto' },
    deadlines: { signingMs: 60_000, dkgMs: 180_000 },
    triggers: overrides.httpBind
      ? [{ kind: 'http', params: { bind: overrides.httpBind } }]
      : [],
  };
}

interface Ring {
  transports: Map<PartyId, Transport>;
  shares: DecryptedShare[];
  configs: Map<PartyId, DaemonConfig>;
}

function buildRing(parties: number, leaderHttpBind: string, threshold = 2): Ring {
  const peerIds = Array.from({ length: parties }, (_, i) => i);
  const ring = createInMemoryRing(peerIds);
  const shares = dealerKeygen(threshold, parties);
  const configs = new Map<PartyId, DaemonConfig>();
  for (const pid of peerIds) {
    const nodeId = `node-${pid}`;
    const peerList = peerIds
      .filter((p) => p !== pid)
      .map((p) => ({ id: `node-${p}`, partyId: p }));
    configs.set(
      pid,
      makeConfig({
        nodeId,
        partyId: pid,
        peerIds: peerList,
        httpBind: pid === 0 ? leaderHttpBind : undefined,
      }),
    );
  }
  return { transports: ring, shares, configs };
}

async function buildDaemon(
  transport: Transport,
  config: DaemonConfig,
  share: DecryptedShare,
): Promise<Daemon> {
  const state = buildStateFromShare(config, share);
  return new Daemon({
    state,
    transport,
    rng: SYSTEM_RNG,
    pullOpts: FAST_PULL,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// config-merge
// ─────────────────────────────────────────────────────────────────────────

describe('buildStateFromShare — cross-validation', () => {
  it('accepts a coherent config + share', () => {
    const shares = dealerKeygen(2, 3);
    const cfg = makeConfig({
      nodeId: 'node-0',
      partyId: 0,
      peerIds: [{ id: 'node-1', partyId: 1 }, { id: 'node-2', partyId: 2 }],
    });
    const state = buildStateFromShare(cfg, shares[0]!);
    expect(state.peersById.get(0)).toBe('node-0');
    expect(state.peersById.get(1)).toBe('node-1');
    expect(state.peersById.get(2)).toBe('node-2');
    expect(state.peersById.size).toBe(3);
  });

  it('rejects partyId mismatch between config and share', () => {
    const shares = dealerKeygen(2, 3);
    const cfg = makeConfig({
      nodeId: 'node-x',
      partyId: 1, // share is partyId 0
      peerIds: [{ id: 'node-y', partyId: 0 }, { id: 'node-z', partyId: 2 }],
    });
    expect(() => buildStateFromShare(cfg, shares[0]!)).toThrow(
      /share\.partyId \(0\) does not match/,
    );
  });

  it('rejects peer-count mismatch', () => {
    const shares = dealerKeygen(2, 3);
    const cfg = makeConfig({
      nodeId: 'node-0',
      partyId: 0,
      peerIds: [{ id: 'node-1', partyId: 1 }], // only 1 peer, share.parties=3
    });
    expect(() => buildStateFromShare(cfg, shares[0]!)).toThrow(
      /peers count \+ self \(2\) does not match share\.parties \(3\)/,
    );
  });

  it('rejects partyId gap in the ring', () => {
    const shares = dealerKeygen(2, 3);
    const cfg = makeConfig({
      nodeId: 'node-0',
      partyId: 0,
      peerIds: [{ id: 'node-1', partyId: 1 }, { id: 'node-2', partyId: 3 }], // missing 2
    });
    expect(() => buildStateFromShare(cfg, shares[0]!)).toThrow(
      /partyId 2 missing from config/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Daemon — HTTP-driven combined DKG
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon — HTTP-driven DKG end-to-end', () => {
  it('combined DKG: leader dispatches via HTTP; participants run orchestrator-side', async () => {
    const ring = buildRing(3, '127.0.0.1:0');
    const daemons: Daemon[] = [];
    for (const pid of [0, 1, 2] as PartyId[]) {
      daemons.push(
        await buildDaemon(ring.transports.get(pid)!, ring.configs.get(pid)!, ring.shares[pid]!),
      );
    }
    for (const d of daemons) await d.start();

    try {
      // Leader's HTTP address (the only daemon with an http trigger).
      const leaderHttp = (daemons[0] as unknown as { triggers: Array<{ address?: () => { host: string; port: number } | null }> })
        .triggers[0]!.address!()!;
      const baseUrl = `http://${leaderHttp.host}:${leaderHttp.port}`;

      const ceremonyId = 'integration-dkg-1';
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'dkg-combined',
          ceremonyId,
          threshold: 2,
          parties: 3,
          level: 44,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ceremonyId: string;
        status: string;
        mldsaPublicKeyHex: string;
        frostVerifyingKeyHex: string;
        btcAddress: string;
        opnetAddress: string;
        network: string;
      };
      expect(json.ceremonyId).toBe(ceremonyId);
      expect(json.status).toBe('done');
      expect(json.mldsaPublicKeyHex.length).toBeGreaterThan(0);
      expect(json.frostVerifyingKeyHex.length).toBe(66); // 33B compressed secp → 66 hex
      expect(json.btcAddress.length).toBeGreaterThan(0);
      expect(json.opnetAddress).toMatch(/^0x[0-9a-f]{64}$/);
      expect(['mainnet', 'testnet', 'regtest']).toContain(json.network);
    } finally {
      for (const d of daemons) await d.stop();
    }
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Daemon — HTTP-driven ML-DSA signing
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon — HTTP-driven ML-DSA signing', () => {
  it('op=sign scheme=mldsa: leader produces a signature; participants contribute blobs', async () => {
    const ring = buildRing(3, '127.0.0.1:0');
    const daemons: Daemon[] = [];
    for (const pid of [0, 1, 2] as PartyId[]) {
      daemons.push(
        await buildDaemon(ring.transports.get(pid)!, ring.configs.get(pid)!, ring.shares[pid]!),
      );
    }
    // Use `pullOpts` with more attempts — ML-DSA signing can need a few retries
    // for rejection sampling and our FAST_PULL deadline is tight.
    for (const d of daemons) await d.start();

    try {
      const leaderHttp = (daemons[0] as unknown as { triggers: Array<{ address?: () => { host: string; port: number } | null }> })
        .triggers[0]!.address!()!;
      const baseUrl = `http://${leaderHttp.host}:${leaderHttp.port}`;

      const msg = 'hello from the headless daemon';
      const msgHex = toHex(new TextEncoder().encode(msg));
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'sign',
          scheme: 'mldsa',
          protocol: 'raw',
          ceremonyId: 'sig-integration-1',
          messageHex: msgHex,
          signers: [0, 1],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; scheme: string; signatureHex: string };
      expect(json.status).toBe('done');
      expect(json.scheme).toBe('mldsa');
      expect(json.signatureHex.length).toBeGreaterThan(0);
    } finally {
      for (const d of daemons) await d.stop();
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Daemon — HTTP error paths
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon — HTTP error paths', () => {
  async function bootLeaderOnly(): Promise<{
    daemon: Daemon;
    baseUrl: string;
    cleanup: () => Promise<void>;
  }> {
    const ring = buildRing(3, '127.0.0.1:0');
    const daemon = await buildDaemon(
      ring.transports.get(0)!,
      ring.configs.get(0)!,
      ring.shares[0]!,
    );
    await daemon.start();
    const http = (daemon as unknown as { triggers: Array<{ address?: () => { host: string; port: number } | null }> })
      .triggers[0]!.address!()!;
    return {
      daemon,
      baseUrl: `http://${http.host}:${http.port}`,
      cleanup: async () => {
        await daemon.stop();
      },
    };
  }

  it('rejects non-POST requests with 405', async () => {
    const { baseUrl, cleanup } = await bootLeaderOnly();
    try {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(405);
    } finally {
      await cleanup();
    }
  });

  it('rejects missing op with 400', async () => {
    const { baseUrl, cleanup } = await bootLeaderOnly();
    try {
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ceremonyId: 'x' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/missing 'op'/);
    } finally {
      await cleanup();
    }
  });

  it('rejects deprecated protocol:opnet with 400', async () => {
    const { baseUrl, cleanup } = await bootLeaderOnly();
    try {
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'sign',
          scheme: 'frost',
          protocol: 'opnet',
          signers: [0, 1],
          unsignedTxHex: '00',
          inputs: [{ scriptHex: 'aa', valueSat: '1000' }],
        }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/deprecated|opnet-params/i);
    } finally {
      await cleanup();
    }
  });

  it('returns 403 when the gate rejects a signing request', async () => {
    const ring = buildRing(3, '127.0.0.1:0');
    // Override leader gate to policy with a cap that will reject generic signings.
    const leaderCfg = { ...ring.configs.get(0)! };
    leaderCfg.gate = { strategy: 'policy', params: { max_amount: 1 } };
    const leader = await buildDaemon(ring.transports.get(0)!, leaderCfg, ring.shares[0]!);
    await leader.start();
    try {
      const http = (leader as unknown as { triggers: Array<{ address?: () => { host: string; port: number } | null }> })
        .triggers[0]!.address!()!;
      const baseUrl = `http://${http.host}:${http.port}`;
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'sign',
          scheme: 'mldsa',
          protocol: 'raw',
          messageHex: toHex(new TextEncoder().encode('x')),
          signers: [0, 1],
        }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('gate rejected');
      expect(json.decision).toBe('reject');
    } finally {
      await leader.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Daemon — lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon — lifecycle', () => {
  it('double-start / double-stop are idempotent', async () => {
    const ring = buildRing(3, '127.0.0.1:0');
    const daemon = await buildDaemon(ring.transports.get(0)!, ring.configs.get(0)!, ring.shares[0]!);
    await daemon.start();
    await daemon.start();
    await daemon.stop();
    await daemon.stop();
  });

  it('throws when a cron trigger job_name has no registered handler', async () => {
    const ring = buildRing(3, '127.0.0.1:0');
    const cfg = { ...ring.configs.get(0)! };
    cfg.triggers = [
      { kind: 'cron', params: { schedule: '0 0 * * *', job_name: 'heartbeat' } },
    ];
    expect(() =>
      new Daemon({
        state: buildStateFromShare(cfg, ring.shares[0]!),
        transport: ring.transports.get(0)!,
        rng: SYSTEM_RNG,
        pullOpts: FAST_PULL,
      }),
    ).toThrow(/job_name='heartbeat' has no registered handler/);
  });

});
