import type { Rng } from '@mwaddip/frots';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint, parseBook } from '../bootstrap/pubkey-book';
import type { PullOpts } from '../core/blob-puller';
import type { PartyId } from '../core/types';
import type { CeremonyOutcome, Logger } from '../orchestrator/types';
import { finalizeSend } from '../otzi/backend/bitcoin';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import type { NetworkName, SendProposal, VaultKey } from '../otzi/lib/vault-types';
import { makeProposal } from '../testing/proposal';
import { RelayServer } from '../transport/relay/server';
import { loadAndValidate } from './config-merge';
import { Daemon } from './daemon';
import { setupMaster, setupMember } from './setup';
import { buildTransportFromFiles, type TransportBundle } from './transport-factory';

const NET: NetworkName = 'testnet4';
const PASSWORD = 'relay-integration-share-password';
const ENV = { OTZI_SHARE_PASSWORD: PASSWORD };
const N = 3;

const SYSTEM_RNG: Rng = {
  fillBytes(dest) {
    crypto.getRandomValues(dest);
  },
};

/** Ceremony backoff on loopback; orchestrator and leader pull until the ceremony deadline. */
const PULLS: PullOpts = { maxAttempts: 500, initialDelayMs: 20, maxDelayMs: 300, deadlineMs: 120_000 };

/** How long the ring may take to reach a connection state (the relay client redials after ≥ 1 s). */
const RING_TIMEOUT_MS = 30_000;

const debugging = process.env.OTZI_TEST_LOG === '1';

/** No-op unless `OTZI_TEST_LOG=1`, which prints to stderr while debugging transport issues. */
function makeLogger(prefix: string): Logger {
  if (!debugging) return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const log = (level: string) => (msg: string, extra?: Record<string, unknown>) =>
    process.stderr.write(`[${prefix}] ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`);
  return { debug: log('DEBUG'), info: log('INFO'), warn: log('WARN'), error: log('ERROR') };
}

/** Phase timings on stderr under `OTZI_TEST_LOG=1`. */
const t0 = Date.now();
function phase(msg: string): void {
  if (debugging) process.stderr.write(`[relay-e2e +${Date.now() - t0} ms] ${msg}\n`);
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

/** Resolves once something accepts TCP connections on `port` (the setup leader's bootstrap server). */
async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>(resolve => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`port ${port} never opened`);
    await new Promise(r => setTimeout(r, 20));
  }
}

type PeerStatus = 'disconnected' | 'waiting-for-hs1' | 'waiting-for-hs2' | 'connected';

function peerStatuses(bundle: TransportBundle): Map<PartyId, PeerStatus> {
  const states = (bundle.transport as unknown as { peerStates: Map<PartyId, { status: PeerStatus }> }).peerStates;
  return new Map([...states].map(([partyId, s]) => [partyId, s.status]));
}

/** Waits until every node holds `want` with each of its peers; on timeout the error shows every node's view. */
async function waitForRing(bundles: TransportBundle[], want: PeerStatus, timeoutMs = RING_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const views = bundles.map(b => peerStatuses(b));
    if (views.every(v => v.size === N - 1 && [...v.values()].every(s => s === want))) return;
    if (Date.now() > deadline) {
      const shown = bundles.map((b, i) => `party ${b.selfPartyId}: ${JSON.stringify([...views[i]!])}`).join('; ');
      throw new Error(`ring not ${want} within ${timeoutMs} ms — ${shown}`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
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
  id: string;
  configPath: string;
  identityFile: string;
  bookFile: string;
  vaultPubkeyPath: string;
  addressBookPath: string;
  url: string;
}

interface Running {
  daemons: Daemon[];
  bundles: TransportBundle[];
}

/** Start every node as `otzi daemon` does: loadAndValidate, buildTransportFromFiles (relay), Daemon. */
async function boot(nodes: Node[]): Promise<Running> {
  const running: Running = { daemons: [], bundles: [] };
  try {
    for (const node of nodes) {
      const logger = makeLogger(node.id);
      const state = await loadAndValidate(node.configPath, { env: ENV, vaultPubkeyPath: node.vaultPubkeyPath, logger });
      const bundle = await buildTransportFromFiles(state, { logger });
      await bundle.start();
      running.bundles.push(bundle);
      const daemon = new Daemon({
        state,
        transport: bundle.transport,
        selfPartyId: bundle.selfPartyId,
        peersById: bundle.peersById,
        rng: SYSTEM_RNG,
        pullOpts: PULLS,
        logger,
        vaultPubkeyPath: node.vaultPubkeyPath,
        addressBookPath: node.addressBookPath,
      });
      await daemon.start();
      running.daemons.push(daemon);
    }
    await waitForRing(running.bundles, 'connected');
  } catch (err) {
    await shutdown(running);
    throw err;
  }
  return running;
}

async function shutdown(r: Running | null): Promise<void> {
  if (!r) return;
  for (const d of r.daemons) await d.stop();
  for (const b of r.bundles) await b.stop();
}

/**
 * `leader` signs `proposal` through its API; the returned signatures must
 * finalize the transaction against the vault's output key, and every other
 * node must settle `done` with the same signatures.
 */
async function signAndVerify(
  running: Running,
  nodes: Node[],
  leader: number,
  ceremonyId: string,
  vaultKey: VaultKey,
  proposal: SendProposal,
): Promise<void> {
  const settled = running.daemons.filter((_, i) => i !== leader).map(d => outcomeOf(d, ceremonyId));
  const res = await post(nodes[leader]!.url, { op: 'sign', ceremonyId, proposal });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const { txid, signedTxHex, signaturesHex } = res.json as { txid: string; signedTxHex: string; signaturesHex: string[] };
  expect(res.json).toEqual({ ceremonyId, status: 'done', txid, signedTxHex, signaturesHex });
  expect(signaturesHex).toHaveLength(proposal.prevouts.length);

  // finalizeSend checks every signature (BIP340) against the vault's output key.
  const finalized = finalizeSend(
    proposal.tx,
    proposal.prevouts,
    signaturesHex.map((signature, index) => ({ index, signature })),
    vaultPayment(vaultKey, NET).outputKey,
  );
  expect(finalized).toEqual({ hex: signedTxHex, txid });
  for (const o of await Promise.all(settled)) expect(o).toMatchObject({ kind: 'signing', status: 'done', signaturesHex });
}

/** The fingerprint line of `nodeId`'s setup banner (captured `console.error` lines). */
function bannerFingerprint(lines: string[], nodeId: string): string {
  const start = lines.findIndex(l => l.includes(`setup complete — ${nodeId}`));
  expect(start, `no setup banner for ${nodeId}`).toBeGreaterThanOrEqual(0);
  const line = lines.slice(start).find(l => l.trim().startsWith('fingerprint: '));
  expect(line, `no fingerprint line in ${nodeId}'s banner`).toBeDefined();
  return line!.trim().slice('fingerprint: '.length);
}

describe('Daemon integration: relay on loopback', () => {
  let dir: string | null = null;
  let running: Running | null = null;
  let relay: RelayServer | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdown(running);
    running = null;
    if (relay) await relay.stop();
    relay = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('three daemons over a real relay: relay-mode setup, DKG, signing, relay restart, signing again', async () => {
    dir = await mkdtemp(join(tmpdir(), 'otzi-relay-integration-'));

    // 1. A real relay server on an ephemeral loopback port.
    relay = new RelayServer({ listen: '127.0.0.1:0' });
    await relay.start();
    const relayPort = relay.address()!.port;
    const relayListen = `127.0.0.1:${relayPort}`;
    phase(`relay listening on ${relayListen}`);

    // 2. Three relay-mode nodes: no [[peers]], node-a leads setup for a ring of 3.
    const bootstrapPort = await freePort();
    const bootstrapBind = `127.0.0.1:${bootstrapPort}`;
    const httpPorts = await Promise.all(Array.from({ length: N }, () => freePort()));
    const nodes: Node[] = [];
    for (let i = 0; i < N; i++) {
      const id = `node-${'abc'[i]}`;
      const nodeDir = join(dir, id);
      await mkdir(nodeDir, { recursive: true });
      const node: Node = {
        id,
        configPath: join(nodeDir, 'daemon.toml'),
        identityFile: join(nodeDir, 'identity.json'),
        bookFile: join(nodeDir, 'pubkeys.json'),
        vaultPubkeyPath: join(nodeDir, 'vault-pubkey.json'),
        addressBookPath: join(nodeDir, 'address-book.json'),
        url: `http://127.0.0.1:${httpPorts[i]}/`,
      };
      const bootstrap =
        i === 0
          ? `[bootstrap]\nrole = "leader"\nbind = "${bootstrapBind}"\nparties = ${N}\n`
          : `[bootstrap]\nrole = "leaf"\nleader_url = "http://${bootstrapBind}"\n`;
      await writeFile(
        node.configPath,
        `
[share]
path = "${join(nodeDir, 'share.json')}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "${id}"
identity_key_file = "${node.identityFile}"
pubkey_book_file = "${node.bookFile}"

[network]
name = "${NET}"

[transport]
kind = "relay"
url = "ws://${relayListen}"

[gate]
strategy = "auto"

[deadlines]
signing_ms = 30000
dkg_ms = 45000

[[triggers]]
kind = "http"
bind = "127.0.0.1:${httpPorts[i]}"

${bootstrap}`,
      );
      nodes.push(node);
    }

    // Relay-mode setup, in-process: the leader admits a count, the members register without an endpoint.
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const [a, b, c] = nodes as [Node, Node, Node];
    const masterDone = setupMaster(a.configPath, bootstrapBind);
    await waitForPort(bootstrapPort);
    await Promise.all([masterDone, setupMember(b.configPath, `http://${bootstrapBind}`), setupMember(c.configPath, `http://${bootstrapBind}`)]);
    vi.restoreAllMocks();
    phase('setup complete');

    // Every node wrote the same book: three entries, none with an endpoint, one per node's own key.
    const bookText = await readFile(a.bookFile, 'utf8');
    expect(await readFile(b.bookFile, 'utf8')).toBe(bookText);
    expect(await readFile(c.bookFile, 'utf8')).toBe(bookText);
    const book = parseBook(bookText);
    expect(book.entries).toHaveLength(N);
    for (const e of book.entries) expect(e).not.toHaveProperty('advertisedEndpoint');
    expect(bookText).not.toContain('advertised');
    const ownKeys = await Promise.all(
      nodes.map(async n => (JSON.parse(await readFile(n.identityFile, 'utf8')) as { publicKeyHex: string }).publicKeyHex),
    );
    expect(book.entries.map(e => e.publicKeyHex).sort()).toEqual([...ownKeys].sort());

    // Identical fingerprints in every banner, and they are the book's.
    const fingerprint = await computeFingerprint(book);
    for (const n of nodes) expect(bannerFingerprint(lines, n.id)).toBe(fingerprint);

    // 3. Setup mode (no share anywhere): node-a runs the DKG through its API.
    running = await boot(nodes);
    phase('daemons up (setup mode), ring connected over the relay');
    const joined = running.daemons.slice(1).map(d => outcomeOf(d, 'gen-relay'));
    const dkg = await post(a.url, { op: 'dkg', ceremonyId: 'gen-relay' });
    expect(dkg.status, JSON.stringify(dkg.json)).toBe(200);
    const address = dkg.json.address as string;
    expect(dkg.json).toMatchObject({ ceremonyId: 'gen-relay', status: 'done', network: NET });
    expect(address).toMatch(/^tb1p/);
    for (const o of await Promise.all(joined)) expect(o).toMatchObject({ kind: 'dkg', status: 'done', address });
    phase(`DKG done: ${address}`);

    // 4. Restart every daemon (and its transport) so the committed shares load.
    await shutdown(running);
    running = null;
    running = await boot(nodes);
    phase('daemons restarted with shares');

    // Every node loaded a share of the same vault.
    for (const n of nodes) {
      const info = await post(n.url, { op: 'vault-info' });
      expect(info.status, JSON.stringify(info.json)).toBe(200);
      expect(info.json).toMatchObject({ partyIds: [0, 1, 2], threshold: N, parties: N, network: NET, address });
    }

    const state = await loadAndValidate(b.configPath, { env: ENV, vaultPubkeyPath: b.vaultPubkeyPath });
    const vaultKey = toVaultKey(state.share!.publicKeyPackage);
    expect(vaultPayment(vaultKey, NET).address).toBe(address);

    // node-b leads a two-input spend.
    await signAndVerify(
      running,
      nodes,
      1,
      'pay-relay-1',
      vaultKey,
      makeProposal(vaultKey, NET, { inputs: [{ amount: 70_000 }, { amount: 30_000 }], change: 48_000 }),
    );
    phase('first signing done');

    // 5. The relay goes away: every node sees the drop.
    await relay.stop();
    relay = null;
    await waitForRing(running.bundles, 'disconnected');
    phase('relay stopped; every node disconnected');

    // A new relay on the same address: the daemons redial it on their own (backoff from 1 s) and re-handshake.
    relay = new RelayServer({ listen: relayListen });
    await relay.start();
    await waitForRing(running.bundles, 'connected');
    phase('ring reconnected through the new relay');

    // node-c leads a spend over the new relay.
    await signAndVerify(running, nodes, 2, 'pay-relay-2', vaultKey, makeProposal(vaultKey, NET));
    phase('second signing done');
  }, 120_000);
});
