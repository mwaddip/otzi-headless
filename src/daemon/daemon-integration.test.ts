import { ThresholdMLDSA } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import { type Rng } from '@mwaddip/frots';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBook, type PubkeyBook } from '../bootstrap/pubkey-book';
import type { PullOpts } from '../core/blob-puller';
import type { PartyId } from '../core/types';
import type { DkgPersistenceSink } from '../orchestrator/types';
import { RelayServer } from '../transport/relay/server';
import { generateIdentity, type IdentityKeyPair } from '../transport/identity';
import { getKL } from '../wire/dkg';
import { toHex } from '../wire/hex';
import {
  decryptShareFile,
  type DecryptedShare,
  type ShareFile,
} from '../wire/share-crypto';
import type { DaemonConfig } from '../config/types';
import { buildStateFromShare, validateLoaded, type LoadedDaemonState } from './config-merge';
import { Daemon } from './daemon';
import { persistCombinedDkgShare } from './share-persistence';
import {
  buildTransportFromMemory,
  type TransportBundle,
} from './transport-factory';

const SYSTEM_RNG: Rng = {
  fillBytes(dest) {
    crypto.getRandomValues(dest);
  },
};

/**
 * Per-peer logger — defaults to no-op. Set `OTZI_TEST_LOG=1` in the env to
 * enable stderr printing while debugging transport issues locally.
 */
function makeLogger(prefix: string) {
  if (process.env.OTZI_TEST_LOG !== '1') {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }
  const log = (level: string, msg: string, extra?: Record<string, unknown>) => {
    const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
    process.stderr.write(`[${prefix}] ${level} ${msg}${extraStr}\n`);
  };
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log('DEBUG', msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log('INFO', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('WARN', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('ERROR', msg, extra),
  };
}

const DKG_PULL_OPTS: PullOpts = {
  maxAttempts: 500,
  initialDelayMs: 20,
  maxDelayMs: 300,
  deadlineMs: 120_000,
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('freePort: no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

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

function makeIntegrationConfig(args: {
  nodeId: string;
  partyId: PartyId;
  peerIds: Array<{ id: string; partyId: PartyId; endpoint?: string }>;
  transport: { kind: 'peer-mesh'; listen: string } | { kind: 'relay'; url: string };
  httpBind: string;
}): DaemonConfig {
  return {
    share: { path: '/dev/null', passwordEnv: 'UNUSED' },
    node: { id: args.nodeId, partyId: args.partyId },
    network: { name: 'testnet', opnetRpc: 'https://testnet.opnet.org' },
    transport: args.transport,
    peers: args.peerIds.map((p) => {
      const out: { id: string; partyId: PartyId; endpoint?: string } = {
        id: p.id,
        partyId: p.partyId,
      };
      if (p.endpoint !== undefined) out.endpoint = p.endpoint;
      return out;
    }),
    gate: { strategy: 'auto' },
    deadlines: { signingMs: 60_000, dkgMs: 180_000 },
    triggers: [{ kind: 'http', params: { bind: args.httpBind } }],
  };
}

async function buildBookFromIdentities(
  identities: IdentityKeyPair[],
): Promise<PubkeyBook> {
  return buildBook(
    identities.map((id, i) => ({
      nodeId: `node-${i}`,
      partyId: i,
      publicKeyHex: toHex(id.publicKeyRaw),
    })),
  );
}

interface Harness {
  daemons: Daemon[];
  bundles: TransportBundle[];
  httpAddrs: string[];
  teardown: () => Promise<void>;
}

async function buildPeerMeshHarness(n: number): Promise<Harness> {
  const identities = await Promise.all(Array.from({ length: n }, () => generateIdentity(true)));
  const listenPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
  const httpPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
  const shares = dealerKeygen(2, n);
  const book = await buildBookFromIdentities(identities);

  const daemons: Daemon[] = [];
  const bundles: TransportBundle[] = [];
  for (let i = 0; i < n; i++) {
    const peerIds = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      peerIds.push({
        id: `node-${j}`,
        partyId: j,
        endpoint: `ws://127.0.0.1:${listenPorts[j]}`,
      });
    }
    const cfg = makeIntegrationConfig({
      nodeId: `node-${i}`,
      partyId: i,
      peerIds,
      transport: { kind: 'peer-mesh', listen: `127.0.0.1:${listenPorts[i]}` },
      httpBind: `127.0.0.1:${httpPorts[i]}`,
    });
    const state = buildStateFromShare(cfg, shares[i]!);
    const logger = makeLogger(`peer${i}`);
    const bundle = await buildTransportFromMemory(state, identities[i]!, book, { logger });
    await bundle.start();
    const daemon = new Daemon({
      state,
      transport: bundle.transport,
      rng: SYSTEM_RNG,
      pullOpts: DKG_PULL_OPTS,
      logger,
    });
    bundles.push(bundle);
    daemons.push(daemon);
  }

  for (const d of daemons) await d.start();

  const httpAddrs = httpPorts.map((p) => `http://127.0.0.1:${p}`);

  return {
    daemons,
    bundles,
    httpAddrs,
    teardown: async () => {
      for (const d of daemons) await d.stop();
      for (const b of bundles) await b.stop();
    },
  };
}

async function buildRelayHarness(n: number): Promise<{ harness: Harness; relay: RelayServer }> {
  const relayPort = await freePort();
  const relay = new RelayServer({ listen: `127.0.0.1:${relayPort}` });
  await relay.start();

  const identities = await Promise.all(Array.from({ length: n }, () => generateIdentity(true)));
  const httpPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
  const shares = dealerKeygen(2, n);
  const book = await buildBookFromIdentities(identities);

  const daemons: Daemon[] = [];
  const bundles: TransportBundle[] = [];
  for (let i = 0; i < n; i++) {
    const peerIds = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      peerIds.push({ id: `node-${j}`, partyId: j });
    }
    const cfg = makeIntegrationConfig({
      nodeId: `node-${i}`,
      partyId: i,
      peerIds,
      transport: { kind: 'relay', url: `ws://127.0.0.1:${relayPort}` },
      httpBind: `127.0.0.1:${httpPorts[i]}`,
    });
    const state = buildStateFromShare(cfg, shares[i]!);
    const bundle = await buildTransportFromMemory(state, identities[i]!, book);
    await bundle.start();
    const daemon = new Daemon({
      state,
      transport: bundle.transport,
      rng: SYSTEM_RNG,
      pullOpts: DKG_PULL_OPTS,
    });
    bundles.push(bundle);
    daemons.push(daemon);
  }

  for (const d of daemons) await d.start();

  const httpAddrs = httpPorts.map((p) => `http://127.0.0.1:${p}`);

  return {
    harness: {
      daemons,
      bundles,
      httpAddrs,
      teardown: async () => {
        for (const d of daemons) await d.stop();
        for (const b of bundles) await b.stop();
        await relay.stop();
      },
    },
    relay,
  };
}

async function waitUntilConnected(bundle: TransportBundle, expectedPeers: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const states = (bundle.transport as unknown as {
      peerStates: Map<PartyId, { status?: string; connection?: unknown }>;
    }).peerStates;
    let connectedCount = 0;
    for (const s of states.values()) {
      if (s.status === 'connected' || s.connection) connectedCount++;
    }
    if (connectedCount === expectedPeers) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timeout waiting for ${expectedPeers} peer connections`);
}

// ─────────────────────────────────────────────────────────────────────────
// Peer-mesh integration
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon integration — peer-mesh transport', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = null;
  });

  it('3-peer ring: combined DKG completes via HTTP over peer-mesh', async () => {
    harness = await buildPeerMeshHarness(3);
    // Wait for the transport mesh to come up before firing ceremonies.
    for (const b of harness.bundles) await waitUntilConnected(b, 2);

    const ceremonyId = 'integration-peer-mesh-dkg';
    const res = await fetch(`${harness.httpAddrs[0]}/`, {
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
    const bodyText = await res.text();
    if (res.status !== 200) {
      throw new Error(`peer-mesh DKG returned ${res.status}: ${bodyText}`);
    }
    const json = JSON.parse(bodyText) as {
      ceremonyId: string;
      status: string;
      mldsaPublicKeyHex: string;
      frostVerifyingKeyHex: string;
    };
    expect(json.ceremonyId).toBe(ceremonyId);
    expect(json.status).toBe('done');
    expect(json.mldsaPublicKeyHex.length).toBeGreaterThan(0);
    expect(json.frostVerifyingKeyHex).toHaveLength(66);
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Persistence + restart
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon integration — DKG persistence + restart', () => {
  let tmpDir: string | null = null;
  let envCleanup: Array<() => void> = [];
  let firstHarness: Harness | null = null;
  let secondHarness: Harness | null = null;

  afterEach(async () => {
    if (firstHarness) await firstHarness.teardown();
    if (secondHarness) await secondHarness.teardown();
    firstHarness = null;
    secondHarness = null;
    for (const fn of envCleanup) fn();
    envCleanup = [];
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it(
    '3-peer ring: combined DKG persists shares to disk; restarted daemons sign with reloaded keys',
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'otzi-persistence-'));
      const n = 3;
      const password = 'integration-test-share-pw';

      // Setup that survives across both restarts: identities, ports, pubkey book.
      const identities = await Promise.all(
        Array.from({ length: n }, () => generateIdentity(true)),
      );
      const listenPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
      const httpPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
      const book = await buildBookFromIdentities(identities);

      // Per-daemon share path + password env var (suffixed with random
      // string to avoid collisions with concurrent test runs).
      const runTag = Math.random().toString(36).slice(2);
      const sharePaths: string[] = [];
      const passwordEnvs: string[] = [];
      for (let i = 0; i < n; i++) {
        sharePaths.push(join(tmpDir, `share-${i}.json`));
        const envName = `OTZI_TEST_SHARE_PWD_${i}_${runTag}`;
        passwordEnvs.push(envName);
        process.env[envName] = password;
        envCleanup.push(() => {
          delete process.env[envName];
        });
      }

      const configs: DaemonConfig[] = Array.from({ length: n }, (_, i) => {
        const peers = [];
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          peers.push({
            id: `node-${j}`,
            partyId: j,
            endpoint: `ws://127.0.0.1:${listenPorts[j]}`,
          });
        }
        return {
          share: { path: sharePaths[i]!, passwordEnv: passwordEnvs[i]! },
          node: { id: `node-${i}`, partyId: i },
          network: { name: 'testnet' as const, opnetRpc: 'https://testnet.opnet.org' },
          transport: {
            kind: 'peer-mesh' as const,
            listen: `127.0.0.1:${listenPorts[i]}`,
          },
          peers,
          gate: { strategy: 'auto' as const },
          deadlines: { signingMs: 60_000, dkgMs: 180_000 },
          triggers: [
            { kind: 'http' as const, params: { bind: `127.0.0.1:${httpPorts[i]}` } },
          ],
        };
      });

      // ── Round 1: bootstrap daemons with NO share file (real "first DKG"
      // flow). validateLoaded hits ENOENT → state.share = undefined,
      // persistDkgShare bound and ready for the post-DKG write.
      const round1States: LoadedDaemonState[] = await Promise.all(
        configs.map((cfg) => validateLoaded(cfg, { env: process.env })),
      );
      for (let i = 0; i < n; i++) {
        // Sanity: no share at round 1, but persistence sink is set.
        expect(round1States[i]!.share).toBeUndefined();
        expect(round1States[i]!.persistDkgShare).toBeDefined();
      }

      const round1Daemons: Daemon[] = [];
      const round1Bundles: TransportBundle[] = [];
      for (let i = 0; i < n; i++) {
        const bundle = await buildTransportFromMemory(
          round1States[i]!,
          identities[i]!,
          book,
        );
        await bundle.start();
        const daemon = new Daemon({
          state: round1States[i]!,
          transport: bundle.transport,
          rng: SYSTEM_RNG,
          pullOpts: DKG_PULL_OPTS,
        });
        await daemon.start();
        round1Bundles.push(bundle);
        round1Daemons.push(daemon);
      }
      firstHarness = {
        daemons: round1Daemons,
        bundles: round1Bundles,
        httpAddrs: httpPorts.map((p) => `http://127.0.0.1:${p}`),
        teardown: async () => {
          for (const d of round1Daemons) await d.stop();
          for (const b of round1Bundles) await b.stop();
        },
      };

      for (const b of round1Bundles) await waitUntilConnected(b, n - 1);

      // Subscribe to participant outcomes BEFORE firing DKG so we don't
      // miss the settle event.
      const participantDone = round1Daemons.slice(1).map(
        (d) =>
          new Promise<void>((resolve, reject) => {
            const off = d.onCompleted((outcome) => {
              if (outcome.kind !== 'dkg-combined') return;
              off();
              if (outcome.status === 'done') resolve();
              else reject(new Error(`participant settled ${outcome.status}, expected done`));
            });
          }),
      );

      // Trigger DKG on daemon 0 (the leader).
      const dkgRes = await fetch(`http://127.0.0.1:${httpPorts[0]}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'dkg-combined',
          ceremonyId: 'integration-persistence-dkg',
          threshold: 2,
          parties: 3,
          level: 44,
        }),
      });
      const dkgBodyText = await dkgRes.text();
      if (dkgRes.status !== 200) {
        throw new Error(`DKG returned ${dkgRes.status}: ${dkgBodyText}`);
      }
      const dkgJson = JSON.parse(dkgBodyText) as {
        ceremonyId: string;
        status: string;
        mldsaPublicKeyHex: string;
        frostVerifyingKeyHex: string;
      };
      expect(dkgJson.status).toBe('done');

      // Leader's persist runs synchronously inside runCombinedDkg; participants
      // settle async via the orchestrator.
      await Promise.all(participantDone);

      // Verify all share files match the DKG output.
      for (let i = 0; i < n; i++) {
        const fileText = await readFile(sharePaths[i]!, 'utf8');
        const sharefile = JSON.parse(fileText) as ShareFile & { frostPublicKey?: string };
        expect(sharefile.version).toBe(3);
        expect(sharefile.publicKey).toBe(dkgJson.mldsaPublicKeyHex);
        expect(sharefile.frostPublicKey).toBe(dkgJson.frostVerifyingKeyHex);
        expect(sharefile.partyId).toBe(i);
        expect(sharefile.threshold).toBe(2);
        expect(sharefile.parties).toBe(3);
        expect(sharefile.level).toBe(44);
        // Decrypt round-trip — proves password + V3 deserialize work.
        const decrypted = await decryptShareFile(sharefile, password);
        expect(decrypted.partyId).toBe(i);
        expect(decrypted.frostKeyPackage).toBeDefined();
      }

      // ── Stop round 1, then start round 2 with persisted shares. ──
      await firstHarness.teardown();
      firstHarness = null;

      const round2States: LoadedDaemonState[] = await Promise.all(
        configs.map((cfg) => validateLoaded(cfg, { env: process.env })),
      );
      // Sanity: state.share carries the DKG-produced public key, not a
      // dealer placeholder.
      for (let i = 0; i < n; i++) {
        expect(round2States[i]!.share!.publicKey).toBe(dkgJson.mldsaPublicKeyHex);
        expect(round2States[i]!.share!.partyId).toBe(i);
        // Persistence sink is now bound by validateLoaded.
        expect(round2States[i]!.persistDkgShare).toBeDefined();
      }

      const round2Daemons: Daemon[] = [];
      const round2Bundles: TransportBundle[] = [];
      for (let i = 0; i < n; i++) {
        const bundle = await buildTransportFromMemory(
          round2States[i]!,
          identities[i]!,
          book,
        );
        await bundle.start();
        const daemon = new Daemon({
          state: round2States[i]!,
          transport: bundle.transport,
          rng: SYSTEM_RNG,
          pullOpts: DKG_PULL_OPTS,
        });
        await daemon.start();
        round2Bundles.push(bundle);
        round2Daemons.push(daemon);
      }
      secondHarness = {
        daemons: round2Daemons,
        bundles: round2Bundles,
        httpAddrs: httpPorts.map((p) => `http://127.0.0.1:${p}`),
        teardown: async () => {
          for (const d of round2Daemons) await d.stop();
          for (const b of round2Bundles) await b.stop();
        },
      };

      for (const b of round2Bundles) await waitUntilConnected(b, n - 1);

      // Sign with the reloaded share — ML-DSA first (scheme='mldsa'), then FROST.
      const message = new Uint8Array(32);
      crypto.getRandomValues(message);
      const signRes = await fetch(`http://127.0.0.1:${httpPorts[0]}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'sign',
          scheme: 'mldsa',
          protocol: 'raw',
          ceremonyId: 'integration-persistence-sign',
          messageHex: toHex(message),
          signers: [0, 1],
        }),
      });
      const signBodyText = await signRes.text();
      if (signRes.status !== 200) {
        throw new Error(`sign mldsa returned ${signRes.status}: ${signBodyText}`);
      }
      const signJson = JSON.parse(signBodyText) as {
        ceremonyId: string;
        status: string;
        scheme: string;
        signatureHex: string;
      };
      expect(signJson.status).toBe('done');
      expect(signJson.scheme).toBe('mldsa');
      expect(signJson.signatureHex.length).toBeGreaterThan(0);

      // FROST key-path sign-via-deprecated-opnet path was here in phase 8;
      // removed in phase 9a.4 because `protocol:'opnet'` now returns 400
      // (un-verifiable raw-tx surface). Reloaded-share-produces-valid-sigs
      // is already verified by the ML-DSA sign above; phase B2 has the
      // dedicated FROST sign coverage via `protocol:'btc'` construction
      // params.
    },
    300_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Relay integration
// ─────────────────────────────────────────────────────────────────────────

describe('Daemon integration — relay transport', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await harness.teardown();
    harness = null;
  });

  it('3-peer ring: combined DKG completes via HTTP over relay', async () => {
    const built = await buildRelayHarness(3);
    harness = built.harness;
    for (const b of harness.bundles) await waitUntilConnected(b, 2);

    const ceremonyId = 'integration-relay-dkg';
    const res = await fetch(`${harness.httpAddrs[0]}/`, {
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
    const bodyText = await res.text();
    if (res.status !== 200) {
      throw new Error(`relay DKG returned ${res.status}: ${bodyText}`);
    }
    const json = JSON.parse(bodyText) as {
      ceremonyId: string;
      status: string;
      mldsaPublicKeyHex: string;
      frostVerifyingKeyHex: string;
    };
    expect(json.ceremonyId).toBe(ceremonyId);
    expect(json.status).toBe('done');
    expect(json.mldsaPublicKeyHex.length).toBeGreaterThan(0);
    expect(json.frostVerifyingKeyHex).toHaveLength(66);
  }, 240_000);
});
