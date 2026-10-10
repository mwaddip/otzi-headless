import type { Rng } from '@mwaddip/frots';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBook, type PubkeyBook } from '../bootstrap/pubkey-book';
import type { PullOpts } from '../core/blob-puller';
import type { PartyId } from '../core/types';
import type { CeremonyOutcome, Logger } from '../orchestrator/types';
import { finalizeSend } from '../otzi/backend/bitcoin';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { toHex } from '../otzi/lib/hex';
import type { NetworkName } from '../otzi/lib/vault-types';
import { makeProposal } from '../testing/proposal';
import { generateIdentity, type IdentityKeyPair } from '../transport/identity';
import { loadAndValidate } from './config-merge';
import { Daemon } from './daemon';
import { buildTransportFromMemory, type TransportBundle } from './transport-factory';

const NET: NetworkName = 'testnet4';
const PASSWORD = 'integration-test-share-password';
const ENV = { OTZI_SHARE_PASSWORD: PASSWORD };

const SYSTEM_RNG: Rng = {
  fillBytes(dest) {
    crypto.getRandomValues(dest);
  },
};

/** Ceremony backoff on loopback; orchestrator and leader pull until the ceremony deadline. */
const PULLS: PullOpts = { maxAttempts: 500, initialDelayMs: 20, maxDelayMs: 300, deadlineMs: 120_000 };

/** No-op unless `OTZI_TEST_LOG=1`, which prints to stderr while debugging transport issues. */
function makeLogger(prefix: string): Logger {
  if (process.env.OTZI_TEST_LOG !== '1') {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  }
  const log = (level: string) => (msg: string, extra?: Record<string, unknown>) =>
    process.stderr.write(`[${prefix}] ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`);
  return { debug: log('DEBUG'), info: log('INFO'), warn: log('WARN'), error: log('ERROR') };
}

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

function buildBookFromIdentities(identities: IdentityKeyPair[], advertisedEndpoints: readonly string[]): PubkeyBook {
  return buildBook(
    identities.map((id, i) => ({
      partyId: i,
      publicKeyHex: toHex(id.publicKeyRaw),
      advertisedEndpoint: advertisedEndpoints[i]!,
    })),
  );
}

async function waitUntilConnected(bundle: TransportBundle, expectedPeers: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const states = (bundle.transport as unknown as {
      peerStates: Map<PartyId, { status?: string; connection?: unknown }>;
    }).peerStates;
    let connected = 0;
    for (const s of states.values()) if (s.status === 'connected' || s.connection) connected++;
    if (connected === expectedPeers) return;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(`timeout waiting for ${expectedPeers} peer connections`);
}

function outcomeOf(d: Daemon, ceremonyId: string): Promise<CeremonyOutcome> {
  return new Promise(resolve => {
    const off = d.onCompleted(o => {
      if (o.ceremonyId !== ceremonyId) return;
      off();
      resolve(o);
    });
  });
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
}

interface Node {
  configPath: string;
  vaultPubkeyPath: string;
  identity: IdentityKeyPair;
  url: string;
}

interface Running {
  daemons: Daemon[];
  bundles: TransportBundle[];
}

/** Start every node from its config files: loadAndValidate, real peer-mesh transport, Daemon. */
async function boot(nodes: Node[], book: PubkeyBook): Promise<Running> {
  const daemons: Daemon[] = [];
  const bundles: TransportBundle[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const logger = makeLogger(`node-${i}`);
    const state = await loadAndValidate(node.configPath, { env: ENV, vaultPubkeyPath: node.vaultPubkeyPath, logger });
    const bundle = await buildTransportFromMemory(state, node.identity, book, { logger });
    await bundle.start();
    bundles.push(bundle);
    const daemon = new Daemon({
      state,
      transport: bundle.transport,
      selfPartyId: bundle.selfPartyId,
      peersById: bundle.peersById,
      rng: SYSTEM_RNG,
      pullOpts: PULLS,
      logger,
      vaultPubkeyPath: node.vaultPubkeyPath,
    });
    await daemon.start();
    daemons.push(daemon);
  }
  for (const b of bundles) await waitUntilConnected(b, nodes.length - 1);
  return { daemons, bundles };
}

async function shutdown(r: Running | null): Promise<void> {
  if (!r) return;
  for (const d of r.daemons) await d.stop();
  for (const b of r.bundles) await b.stop();
}

describe('Daemon integration: peer-mesh on loopback', () => {
  let dir: string | null = null;
  let running: Running | null = null;

  afterEach(async () => {
    await shutdown(running);
    running = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('three daemons over peer-mesh run DKG, restart and sign a proposal', async () => {
    dir = await mkdtemp(join(tmpdir(), 'otzi-integration-'));
    const n = 3;
    const identities = await Promise.all(Array.from({ length: n }, () => generateIdentity(true)));
    const meshPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
    const httpPorts = await Promise.all(Array.from({ length: n }, () => freePort()));
    const advertised = meshPorts.map(p => `127.0.0.1:${p}`);
    const book = buildBookFromIdentities(identities, advertised);

    const nodes: Node[] = [];
    for (let i = 0; i < n; i++) {
      const nodeDir = join(dir, `node-${i}`);
      await mkdir(nodeDir, { recursive: true });
      const configPath = join(nodeDir, 'daemon.toml');
      const peers = advertised
        .filter((_, j) => j !== i)
        .map(e => `[[peers]]\nendpoint = "${e}"\n`)
        .join('\n');
      await writeFile(
        configPath,
        `
[share]
path = "${join(nodeDir, 'share.json')}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-${i}"

[network]
name = "${NET}"

[transport]
kind = "peer-mesh"
advertised_endpoint = "${advertised[i]}"

${peers}

[gate]
strategy = "auto"

[deadlines]
signing_ms = 60000
dkg_ms = 120000

[[triggers]]
kind = "http"
bind = "127.0.0.1:${httpPorts[i]}"
`,
      );
      nodes.push({
        configPath,
        vaultPubkeyPath: join(nodeDir, 'vault-pubkey.json'),
        identity: identities[i]!,
        url: `http://127.0.0.1:${httpPorts[i]}/`,
      });
    }

    // Setup mode: no share anywhere; node 0 runs the DKG.
    running = await boot(nodes, book);
    const joined = running.daemons.slice(1).map(d => outcomeOf(d, 'gen-mesh'));
    const dkg = await post(nodes[0]!.url, { op: 'dkg', ceremonyId: 'gen-mesh' });
    expect(dkg.status, JSON.stringify(dkg.json)).toBe(200);
    const address = dkg.json.address as string;
    expect(dkg.json).toMatchObject({ ceremonyId: 'gen-mesh', status: 'done', network: NET });
    for (const o of await Promise.all(joined)) expect(o).toMatchObject({ kind: 'dkg', status: 'done', address });

    // Restart every daemon (and transport) so the new shares load.
    await shutdown(running);
    running = null;
    running = await boot(nodes, book);

    const info = await post(nodes[1]!.url, { op: 'vault-info' });
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({ partyIds: [0, 1, 2], threshold: n, parties: n, network: NET, address });

    // Any node can lead: node 2 signs a two-input proposal.
    const state = await loadAndValidate(nodes[2]!.configPath, { env: ENV, vaultPubkeyPath: nodes[2]!.vaultPubkeyPath });
    const vaultKey = toVaultKey(state.share!.publicKeyPackage);
    const proposal = makeProposal(vaultKey, NET, { inputs: [{ amount: 70_000 }, { amount: 30_000 }], change: 48_000 });
    const signed = [running.daemons[0]!, running.daemons[1]!].map(d => outcomeOf(d, 'pay-mesh'));
    const res = await post(nodes[2]!.url, { op: 'sign', ceremonyId: 'pay-mesh', proposal });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { txid, signedTxHex, signaturesHex } = res.json as { txid: string; signedTxHex: string; signaturesHex: string[] };
    expect(res.json).toEqual({ ceremonyId: 'pay-mesh', status: 'done', txid, signedTxHex, signaturesHex });

    const finalized = finalizeSend(
      proposal.tx,
      proposal.prevouts,
      signaturesHex.map((signature, index) => ({ index, signature })),
      vaultPayment(vaultKey, NET).outputKey,
    );
    expect(finalized).toEqual({ hex: signedTxHex, txid });
    for (const o of await Promise.all(signed)) expect(o).toMatchObject({ kind: 'signing', status: 'done', signaturesHex });
  }, 120_000);
});
