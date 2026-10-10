import { stat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullOpts } from '../core/blob-puller';
import { createInMemoryRing } from '../core/in-memory-transport';
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

describe('Daemon lifecycle', () => {
  it('double start and double stop are idempotent', async () => {
    const c = await cluster();
    const { daemons } = await c.boot();
    await expect(daemons[0]!.start()).resolves.toBeUndefined();
    await daemons[0]!.stop();
    await expect(daemons[0]!.stop()).resolves.toBeUndefined();
  });

  it('throws when a cron trigger job_name has no registered handler', async () => {
    const c = await cluster({ triggers: '[[triggers]]\nkind = "cron"\nschedule = "0 0 * * *"\njob_name = "heartbeat"' });
    await expect(c.boot()).rejects.toThrow(/job_name='heartbeat' has no registered handler/);
  });
});
