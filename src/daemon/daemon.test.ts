import { stat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullOpts } from '../core/blob-puller';
import { createInMemoryRing, setInMemoryPartition } from '../core/in-memory-transport';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import type { CeremonyOutcome, Logger } from '../orchestrator/types';
import { finalizeSend } from '../otzi/backend/bitcoin';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { rng } from '../otzi/lib/dkg.fixture';
import { toHex } from '../otzi/lib/hex';
import { decryptShareFile, encryptShareFile } from '../otzi/lib/share-file';
import type { NetworkName, SendProposal } from '../otzi/lib/vault-types';
import { makeProposal, testVault } from '../testing/proposal';
import type { HttpTrigger } from '../triggers/http';
import { writeAddressBook } from '../address-book/store';
import { NO_VAULT_MESSAGE } from './api';
import { loadAndValidate } from './config-merge';
import { Daemon } from './daemon';
import { readVaultPubkeyFile } from './vault-pubkey';
import { pendingPath, vaultFileExists } from './vault-share';

const NET: NetworkName = 'testnet4';
const PASSWORD = 'daemon-test-share-password';
const ENV = { OTZI_SHARE_PASSWORD: PASSWORD };
const N = 3;
const PULLS: PullOpts = { maxAttempts: 50, initialDelayMs: 2, maxDelayMs: 20, deadlineMs: 5_000 };

// ─── Cluster harness ─────────────────────────────────────────────────────

interface NodeFiles {
  configPath: string;
  sharePath: string;
  vaultPubkeyPath: string;
  /** Where this node's daemon reads its address book; absent until a test writes it. */
  addressBookPath: string;
}

interface Booted {
  daemons: Daemon[];
  transports: Transport[];
  urls: string[];
}

interface Cluster {
  dir: string;
  nodes: NodeFiles[];
  /** Every log line and API response body, for the password check. */
  transcript: string[];
  boot(): Promise<Booted>;
  shutdown(): Promise<void>;
}

const clusters: Cluster[] = [];
afterEach(async () => {
  for (const c of clusters.splice(0)) {
    await c.shutdown();
    await rm(c.dir, { recursive: true, force: true });
  }
});

function toml(i: number, sharePath: string, gate: string, triggers: string): string {
  const peers = Array.from({ length: N }, (_, j) => j)
    .filter(j => j !== i)
    .map(j => `[[peers]]\nendpoint = "127.0.0.1:${8800 + j}"\n`)
    .join('\n');
  return `
[share]
path = "${sharePath}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-${i}"

[network]
name = "${NET}"

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:${8800 + i}"

${peers}

${gate}

[deadlines]
signing_ms = 10000
dkg_ms = 10000

${triggers}
`;
}

const AUTO_GATE = '[gate]\nstrategy = "auto"';
const HTTP_TRIGGER = '[[triggers]]\nkind = "http"\nbind = "127.0.0.1:0"';

/** Three nodes with config files in a tmpdir; `gates[i]` overrides node i's `[gate]` table. */
async function cluster(opts: { gates?: Record<number, string>; triggers?: string } = {}): Promise<Cluster> {
  const dir = await mkdtemp(join(tmpdir(), 'otzi-daemon-test-'));
  const nodes: NodeFiles[] = [];
  for (let i = 0; i < N; i++) {
    const nodeDir = join(dir, `node-${i}`);
    await mkdir(nodeDir, { recursive: true });
    const files = {
      configPath: join(nodeDir, 'daemon.toml'),
      sharePath: join(nodeDir, 'state', 'share.json'),
      vaultPubkeyPath: join(nodeDir, 'meta', 'vault-pubkey.json'),
      addressBookPath: join(nodeDir, 'address-book.otzi.json'),
    };
    await writeFile(files.configPath, toml(i, files.sharePath, opts.gates?.[i] ?? AUTO_GATE, opts.triggers ?? HTTP_TRIGGER));
    nodes.push(files);
  }

  let running: Daemon[] = [];
  const transcript: string[] = [];
  const line = (level: string) => (msg: string, extra?: Record<string, unknown>) =>
    void transcript.push(`${level} ${msg} ${JSON.stringify(extra ?? {})}`);
  const logger: Logger = { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
  const c: Cluster = {
    dir,
    nodes,
    transcript,
    async boot() {
      await c.shutdown();
      // A restart is a fresh process on every node: new state from the files, a new ring.
      const ring = createInMemoryRing(nodes.map((_, i) => i));
      const daemons: Daemon[] = [];
      const transports: Transport[] = [];
      for (let i = 0; i < N; i++) {
        const state = await loadAndValidate(nodes[i]!.configPath, {
          env: ENV,
          vaultPubkeyPath: nodes[i]!.vaultPubkeyPath,
          logger,
        });
        const transport = ring.get(i)!;
        const peersById = new Map<PartyId, string>(nodes.map((_, j) => [j, j === i ? state.config.node.id : `peer-${j}`]));
        daemons.push(
          new Daemon({
            state,
            transport,
            selfPartyId: i,
            peersById,
            rng,
            pullOpts: PULLS,
            vaultPubkeyPath: nodes[i]!.vaultPubkeyPath,
            addressBookPath: nodes[i]!.addressBookPath,
            logger,
          }),
        );
        transports.push(transport);
      }
      for (const d of daemons) await d.start();
      running = daemons;
      return { daemons, transports, urls: daemons.map(httpUrl) };
    },
    async shutdown() {
      for (const d of running) await d.stop();
      running = [];
    },
  };
  clusters.push(c);
  return c;
}

function httpUrl(d: Daemon): string {
  const triggers = (d as unknown as { triggers: HttpTrigger[] }).triggers;
  const addr = triggers[0]!.address()!;
  return `http://${addr.host}:${addr.port}/`;
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** The outcome `d` settles for `ceremonyId`; subscribe before triggering the ceremony. */
function outcomeOf(d: Daemon, ceremonyId: string): Promise<CeremonyOutcome> {
  return new Promise(resolve => {
    const off = d.onCompleted(o => {
      if (o.ceremonyId !== ceremonyId) return;
      off();
      resolve(o);
    });
  });
}

/** Write a v4 share for every node from one dealer vault, as `otzi restore` would leave them. */
async function writeShares(c: Cluster): Promise<ReturnType<typeof testVault>> {
  const tv = testVault(N, N);
  for (let i = 0; i < N; i++) {
    const file = await encryptShareFile(tv.keyPackages[i]!, tv.publicKeyPackage, NET, i, PASSWORD);
    await mkdir(join(c.nodes[i]!.sharePath, '..'), { recursive: true });
    await writeFile(c.nodes[i]!.sharePath, JSON.stringify(file), { mode: 0o600 });
  }
  return tv;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Daemon API: refusals', () => {
  it('vault-info returns 409 before DKG', async () => {
    const c = await cluster();
    const { urls } = await c.boot();
    const res = await post(urls[0]!, { op: 'vault-info' });
    expect(res).toEqual({ status: 409, json: { error: NO_VAULT_MESSAGE } });
  });

  it('dkg returns 409 when a share file exists', async () => {
    const c = await cluster();
    const { urls, transports } = await c.boot();
    // Appears after startup (a restore, or a DKG joined meanwhile): not loaded, but present.
    await mkdir(join(c.nodes[0]!.sharePath, '..'), { recursive: true });
    await writeFile(c.nodes[0]!.sharePath, '{}');
    const broadcast = vi.spyOn(transports[0]!, 'broadcast');

    const res = await post(urls[0]!, { op: 'dkg', ceremonyId: 'gen-exists' });
    expect(res).toEqual({ status: 409, json: { error: 'this node already holds a vault' } });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('dkg and sign return a retryable 503 and broadcast nothing while a peer is not connected', async () => {
    const fresh = await cluster();
    const setup = await fresh.boot();
    setInMemoryPartition(setup.transports[0]!, 2, true);
    const dkgBroadcast = vi.spyOn(setup.transports[0]!, 'broadcast');
    expect(await post(setup.urls[0]!, { op: 'dkg', ceremonyId: 'gen-dc' })).toEqual({
      status: 503,
      json: { error: 'party 2 is not connected; retry when the ring is connected' },
    });
    expect(dkgBroadcast).not.toHaveBeenCalled();
    await fresh.shutdown();

    const c = await cluster();
    const tv = await writeShares(c);
    const { urls, transports } = await c.boot();
    setInMemoryPartition(transports[0]!, 1, true);
    const broadcast = vi.spyOn(transports[0]!, 'broadcast');
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-dc', proposal: makeProposal(tv.vaultKey, NET) })).toEqual({
      status: 503,
      json: { error: 'signer 1 is not connected; retry when the ring is connected' },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sign returns 409 with a restart hint when no vault is loaded', async () => {
    const c = await cluster();
    const { urls, daemons } = await c.boot();
    const probe = { network: NET, tx: '00', prevouts: [] };

    const before = await post(urls[0]!, { op: 'sign', proposal: probe });
    expect(before).toEqual({ status: 409, json: { error: NO_VAULT_MESSAGE } });
    expect(NO_VAULT_MESSAGE).toMatch(/restart the daemon/);

    // Right after generate, without a restart: the share is on disk but not loaded.
    const joined = daemons.slice(1).map(d => outcomeOf(d, 'gen-norestart'));
    const dkg = await post(urls[0]!, { op: 'dkg', ceremonyId: 'gen-norestart' });
    expect(dkg.status).toBe(200);
    await Promise.all(joined);

    const written = await decryptShareFile(JSON.parse(await readFile(c.nodes[0]!.sharePath, 'utf8')), PASSWORD);
    const after = await post(urls[0]!, { op: 'sign', proposal: makeProposal(toVaultKey(written.publicKeyPackage), NET) });
    expect(after).toEqual({ status: 409, json: { error: NO_VAULT_MESSAGE } });
    expect(await post(urls[0]!, { op: 'vault-info' })).toEqual({ status: 409, json: { error: NO_VAULT_MESSAGE } });
    expect(await post(urls[1]!, { op: 'dkg' })).toEqual({ status: 409, json: { error: 'this node already holds a vault' } });
  });

  it('rejects other methods, non-object bodies, unknown ops and unknown fields', async () => {
    const c = await cluster();
    const { urls } = await c.boot();
    const url = urls[0]!;
    expect((await fetch(url)).status).toBe(405);
    expect(await post(url, [1, 2])).toEqual({ status: 400, json: { error: 'body must be a JSON object' } });
    expect(await post(url, { ceremonyId: 'x' })).toEqual({ status: 400, json: { error: "missing 'op' field" } });
    expect(await post(url, { op: 'dkg-combined' })).toEqual({ status: 400, json: { error: "unknown op 'dkg-combined'" } });
    expect(await post(url, { op: 'vault-info', verbose: true })).toEqual({
      status: 400,
      json: { error: "unknown field 'verbose'" },
    });
    expect(await post(url, { op: 'dkg', threshold: 2 })).toEqual({ status: 400, json: { error: "unknown field 'threshold'" } });
    expect(await post(url, { op: 'dkg', ceremonyId: 'bad id' })).toEqual({
      status: 400,
      json: { error: 'ceremonyId must match ^[A-Za-z0-9._:-]{1,128}$' },
    });
  });
});

describe('Daemon API: DKG and signing', () => {
  it('dkg, restart, then sign returns a transaction that finalizes', async () => {
    const c = await cluster();
    const first = await c.boot();

    const joined = first.daemons.slice(1).map(d => outcomeOf(d, 'gen-1'));
    const dkg = await post(first.urls[0]!, { op: 'dkg', ceremonyId: 'gen-1' });
    expect(dkg.status).toBe(200);
    const { address, internalKey } = dkg.json as { address: string; internalKey: string };
    expect(dkg.json).toEqual({ ceremonyId: 'gen-1', status: 'done', address, internalKey, network: NET });
    expect(address).toMatch(/^tb1p[0-9a-z]{58}$/);
    expect(internalKey).toMatch(/^0[23][0-9a-f]{64}$/);
    for (const o of await Promise.all(joined)) expect(o).toMatchObject({ kind: 'dkg', status: 'done', address });

    // Every node committed its own share under the same vault, and nothing is left staged.
    for (let i = 0; i < N; i++) {
      const { sharePath, vaultPubkeyPath } = c.nodes[i]!;
      expect((await stat(sharePath)).mode & 0o777).toBe(0o600);
      const share = await decryptShareFile(JSON.parse(await readFile(sharePath, 'utf8')), PASSWORD);
      expect(share).toMatchObject({ network: NET, partyId: i, threshold: N, parties: N, internalKey });
      expect(vaultPayment(toVaultKey(share.publicKeyPackage), NET).address).toBe(address);
      expect((await readVaultPubkeyFile(vaultPubkeyPath)).address).toBe(address);
      expect(await vaultFileExists(pendingPath(sharePath))).toBe(false);
    }

    // Restart: fresh daemons from loadAndValidate on the written shares.
    const second = await c.boot();
    const info = await post(second.urls[2]!, { op: 'vault-info' });
    const meta = await readVaultPubkeyFile(c.nodes[2]!.vaultPubkeyPath);
    expect(info).toEqual({
      status: 200,
      json: {
        partyIds: [0, 1, 2],
        threshold: N,
        parties: N,
        network: NET,
        address,
        internalKey,
        outputKey: meta.outputKey,
      },
    });
    expect(await post(second.urls[0]!, { op: 'dkg' })).toEqual({
      status: 409,
      json: { error: 'this node already holds a vault' },
    });

    const vaultKey = meta.vaultKey;
    const proposal: SendProposal = makeProposal(vaultKey, NET, {
      inputs: [{ amount: 60_000 }, { amount: 40_000 }],
      change: 48_000,
    });
    const signed = second.daemons.slice(1).map(d => outcomeOf(d, 'pay-1'));
    const res = await post(second.urls[0]!, { op: 'sign', ceremonyId: 'pay-1', proposal });
    expect(res.status).toBe(200);
    const { txid, signedTxHex, signaturesHex } = res.json as { txid: string; signedTxHex: string; signaturesHex: string[] };
    expect(res.json).toEqual({ ceremonyId: 'pay-1', status: 'done', txid, signedTxHex, signaturesHex });
    expect(signaturesHex).toHaveLength(2);

    // The returned transaction is exactly what finalizing these signatures yields.
    const outputKey = vaultPayment(vaultKey, NET).outputKey;
    expect(toHex(outputKey)).toBe(meta.outputKey);
    const finalized = finalizeSend(
      proposal.tx,
      proposal.prevouts,
      signaturesHex.map((signature, index) => ({ index, signature })),
      outputKey,
    );
    expect(finalized).toEqual({ hex: signedTxHex, txid });

    for (const o of await Promise.all(signed)) expect(o).toMatchObject({ kind: 'signing', status: 'done', signaturesHex });

    // The share password never reaches a log line or an API response.
    c.transcript.push(...[dkg, info, res].map(r => JSON.stringify(r.json)));
    expect(c.transcript.some(l => l.includes('leader: signing pay-1 done'))).toBe(true);
    expect(c.transcript.filter(l => l.includes(PASSWORD))).toEqual([]);
  });

  it('a second dkg or sign with the same ceremonyId right after the first returns 409 and broadcasts nothing', async () => {
    const fresh = await cluster();
    const setup = await fresh.boot();
    const joined = setup.daemons.slice(1).map(d => outcomeOf(d, 'gen-again'));
    expect((await post(setup.urls[0]!, { op: 'dkg', ceremonyId: 'gen-again' })).status).toBe(200);
    await Promise.all(joined);
    const dkgBroadcast = vi.spyOn(setup.transports[0]!, 'broadcast');
    expect(await post(setup.urls[0]!, { op: 'dkg', ceremonyId: 'gen-again' })).toEqual({
      status: 409,
      json: { error: 'ceremony id gen-again is already in use on this node' },
    });
    expect(dkgBroadcast).not.toHaveBeenCalled();
    await fresh.shutdown();

    const restored = await cluster();
    const tv = await writeShares(restored);
    const { urls, daemons, transports } = await restored.boot();
    const signed = daemons.slice(1).map(d => outcomeOf(d, 'pay-again'));
    const first = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-again', proposal: makeProposal(tv.vaultKey, NET) });
    expect(first.status).toBe(200);
    await Promise.all(signed);
    const signBroadcast = vi.spyOn(transports[0]!, 'broadcast');
    expect(
      await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-again', proposal: makeProposal(tv.vaultKey, NET) }),
    ).toEqual({ status: 409, json: { error: 'ceremony id pay-again is already in use on this node' } });
    expect(signBroadcast).not.toHaveBeenCalled();
  });

  it('sign returns 400 with the analysis reason for a foreign input', async () => {
    const c = await cluster();
    const tv = await writeShares(c);
    const { urls, transports } = await c.boot();
    const broadcast = vi.spyOn(transports[0]!, 'broadcast');

    const foreign = makeProposal(tv.vaultKey, NET, { inputs: [{ amount: 100_000, script: `5120${'22'.repeat(32)}` }] });
    const res = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-foreign', proposal: foreign });
    expect(res).toEqual({ status: 400, json: { error: 'Input 0 does not spend a coin of this vault' } });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sign returns 403 when the gate rejects', async () => {
    const c = await cluster({ gates: { 0: '[gate]\nstrategy = "policy"\nmax_sats_per_tx = 1' } });
    const tv = await writeShares(c);
    const { urls, transports } = await c.boot();
    const broadcast = vi.spyOn(transports[0]!, 'broadcast');

    const res = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-gated', proposal: makeProposal(tv.vaultKey, NET) });
    expect(res).toEqual({ status: 403, json: { error: 'gate rejected', decision: 'reject', ceremonyId: 'pay-gated' } });
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('Daemon address book', () => {
  const TREASURY = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const OTHER = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
  const BOOK_GATE = '[gate]\nstrategy = "policy"\nallowed_recipients = "address-book"';

  const pay = (tv: ReturnType<typeof testVault>, address: string): SendProposal =>
    makeProposal(tv.vaultKey, NET, { outputs: [{ address, amount: 50_000 }] });

  const gateRejected = (ceremonyId: string) => ({
    status: 403,
    json: { error: 'gate rejected', decision: 'reject', ceremonyId },
  });

  it('allowed_recipients = "address-book" signs for a listed recipient and rejects the others, reading the book at each request', async () => {
    const c = await cluster({ gates: { 0: BOOK_GATE } });
    const tv = await writeShares(c);
    const { urls, transports } = await c.boot();
    const broadcast = vi.spyOn(transports[0]!, 'broadcast');

    await writeAddressBook(c.nodes[0]!.addressBookPath, NET, [{ label: 'treasury', address: TREASURY }]);
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-unlisted', proposal: pay(tv, OTHER) })).toEqual(
      gateRejected('pay-unlisted'),
    );
    expect(broadcast).not.toHaveBeenCalled();

    const listed = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-listed', proposal: pay(tv, TREASURY) });
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({ ceremonyId: 'pay-listed', status: 'done' });

    // An edit takes effect without a restart.
    await writeAddressBook(c.nodes[0]!.addressBookPath, NET, [{ label: 'other', address: OTHER }]);
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-edited', proposal: pay(tv, TREASURY) })).toEqual(
      gateRejected('pay-edited'),
    );
    const edited = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-edited-ok', proposal: pay(tv, OTHER) });
    expect(edited.status).toBe(200);
    expect(c.transcript.filter(l => l.startsWith('warn') && /address book/i.test(l))).toEqual([]);
  });

  it('allowed_recipients = "address-book" rejects every signing spec on a node without a book, and warns', async () => {
    const c = await cluster({ gates: { 0: BOOK_GATE } });
    const tv = await writeShares(c);
    const { urls, transports } = await c.boot();
    const broadcast = vi.spyOn(transports[0]!, 'broadcast');

    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-nobook', proposal: pay(tv, TREASURY) })).toEqual(
      gateRejected('pay-nobook'),
    );
    // Even a transaction that pays only the vault back to itself.
    const consolidation = makeProposal(tv.vaultKey, NET, { outputs: [], change: 99_000 });
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-consolidate', proposal: consolidation })).toEqual(
      gateRejected('pay-consolidate'),
    );
    expect(broadcast).not.toHaveBeenCalled();

    const warnings = c.transcript.filter(l => l.startsWith('warn') && /address book/i.test(l));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.every(l => l.includes('ENOENT'))).toBe(true);
  });

  it('allowed_recipients = "address-book" rejects when the book file is invalid, and warns with the reason', async () => {
    const c = await cluster({ gates: { 0: BOOK_GATE } });
    const tv = await writeShares(c);
    const { urls } = await c.boot();

    const file = c.nodes[0]!.addressBookPath;
    await writeFile(file, '{ not json');
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-garbage', proposal: pay(tv, TREASURY) })).toEqual(
      gateRejected('pay-garbage'),
    );
    await writeFile(file, JSON.stringify({ kind: 'otzi-address-book', version: 1, network: 'mainnet', entries: [] }));
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-mainnet', proposal: pay(tv, TREASURY) })).toEqual(
      gateRejected('pay-mainnet'),
    );

    const warnings = c.transcript.filter(l => l.startsWith('warn') && /address book/i.test(l));
    expect(warnings.some(l => l.includes('not valid JSON') && l.includes(file))).toBe(true);
    expect(warnings.some(l => l.includes('Address book is for mainnet'))).toBe(true);
  });

  it('gate specs carry the labels of the leader\'s own book', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otzi-daemon-spec-'));
    const specFile = join(dir, 'spec.json');
    try {
      const c = await cluster({
        gates: { 0: `[gate]\nstrategy = "exec"\ncommand = ["sh", "-c", "cat > ${specFile}; echo approve"]\ntimeout_sec = 10` },
      });
      const tv = await writeShares(c);
      const { urls } = await c.boot();
      await writeAddressBook(c.nodes[0]!.addressBookPath, NET, [{ label: 'treasury', address: TREASURY }]);

      const res = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-labelled', proposal: pay(tv, TREASURY) });
      expect(res.status).toBe(200);

      const spec = JSON.parse(await readFile(specFile, 'utf8')) as {
        outputs: Array<{ address: string; isChange: boolean; label?: string }>;
      };
      expect(spec.outputs.find(o => !o.isChange)).toMatchObject({ address: TREASURY, label: 'treasury' });
      expect(spec.outputs.find(o => o.isChange)?.label).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an exec gate command inherits neither the share password nor the HTTP trigger token', async () => {
    const tokenVar = 'OTZI_TEST_HTTP_TRIGGER_TOKEN';
    const passwordVar = 'OTZI_SHARE_PASSWORD';
    const saved = { token: process.env[tokenVar], password: process.env[passwordVar] };
    process.env[tokenVar] = 'trigger-token-must-not-leak';
    process.env[passwordVar] = PASSWORD;
    try {
      const probe = `if [ -n "\${${tokenVar}+x}" ] || [ -n "\${${passwordVar}+x}" ]; then echo reject; else echo approve; fi`;
      const c = await cluster({
        gates: { 0: `[gate]\nstrategy = "exec"\ncommand = ["sh", "-c", ${JSON.stringify(probe)}]\ntimeout_sec = 10` },
        triggers: `${HTTP_TRIGGER}\nauth_token_env = "${tokenVar}"`,
      });
      const tv = await writeShares(c);
      const { urls } = await c.boot();

      const res = await fetch(urls[0]!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[tokenVar]}` },
        body: JSON.stringify({ op: 'sign', ceremonyId: 'pay-env', proposal: pay(tv, TREASURY) }),
      });
      expect(res.status).toBe(200);
    } finally {
      for (const [name, value] of [[tokenVar, saved.token], [passwordVar, saved.password]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('a missing or invalid book only means unlabelled specs for a gate that does not use it', async () => {
    const c = await cluster({ gates: { 0: '[gate]\nstrategy = "policy"\nmax_sats_per_tx = 100000' } });
    const tv = await writeShares(c);
    const { urls } = await c.boot();

    const absent = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-absent', proposal: pay(tv, TREASURY) });
    expect(absent.status).toBe(200);

    await writeFile(c.nodes[0]!.addressBookPath, 'garbage');
    const invalid = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-invalid', proposal: pay(tv, TREASURY) });
    expect(invalid.status).toBe(200);
  });
});

describe('Daemon allowed_recipients list', () => {
  const TREASURY = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const OTHER = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
  const MAINNET = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const gateWith = (...entries: string[]) =>
    `[gate]\nstrategy = "policy"\nallowed_recipients = [${entries.map(e => JSON.stringify(e)).join(', ')}]`;

  it('refuses to start when an entry is not an address of the configured network', async () => {
    const mainnet = await cluster({ gates: { 1: gateWith(TREASURY, MAINNET) } });
    await expect(mainnet.boot()).rejects.toThrow(/gate\.allowed_recipients\[1\].*'bc1q.*not a valid testnet4 address/);

    const typo = await cluster({ gates: { 2: gateWith('tb1qa0000000000000000000000000000000000000') } });
    await expect(typo.boot()).rejects.toThrow(/gate\.allowed_recipients\[0\].*not a valid testnet4 address/);
  });

  it('matches an all-uppercase entry against the lowercase output of the analysis', async () => {
    const c = await cluster({ gates: { 0: gateWith(TREASURY.toUpperCase()) } });
    const tv = await writeShares(c);
    const { urls } = await c.boot();
    const pay = (address: string) => makeProposal(tv.vaultKey, NET, { outputs: [{ address, amount: 50_000 }] });

    const listed = await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-upper', proposal: pay(TREASURY) });
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({ ceremonyId: 'pay-upper', status: 'done' });
    expect(await post(urls[0]!, { op: 'sign', ceremonyId: 'pay-other', proposal: pay(OTHER) })).toEqual({
      status: 403,
      json: { error: 'gate rejected', decision: 'reject', ceremonyId: 'pay-other' },
    });
  });
});

describe('Daemon lifecycle', () => {
  it('double start and double stop are idempotent', async () => {
    const c = await cluster();
    const { daemons } = await c.boot();
    await expect(daemons[0]!.start()).resolves.toBeUndefined();
    await daemons[0]!.stop();
    await expect(daemons[0]!.stop()).resolves.toBeUndefined();
  });

  it('logs the gate strategy at startup', async () => {
    const c = await cluster({ gates: { 1: '[gate]\nstrategy = "policy"\nmax_sats_per_tx = 5000' } });
    await c.boot();
    const lines = c.transcript.filter(l => l.includes('gate strategy'));
    expect(lines).toHaveLength(N);
    expect(lines.filter(l => /^info daemon: gate strategy auto /.test(l))).toHaveLength(N - 1);
    expect(lines.filter(l => /^info daemon: gate strategy policy /.test(l))).toHaveLength(1);
  });

  it('throws when a cron trigger job_name has no registered handler', async () => {
    const c = await cluster({ triggers: '[[triggers]]\nkind = "cron"\nschedule = "0 0 * * *"\njob_name = "heartbeat"' });
    await expect(c.boot()).rejects.toThrow(/job_name='heartbeat' has no registered handler/);
  });
});
