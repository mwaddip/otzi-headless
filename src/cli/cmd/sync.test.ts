import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UdsTrigger } from '../../triggers/uds';
import { sync } from './sync';

const VALID_MANIFEST = JSON.stringify({
  version: 1,
  name: 'X',
  contracts: [
    { name: 'C', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
  ],
});

function buildToml(socketPath: string): string {
  return `
[share]
path = "/tmp/x"
password_env = "X"
[node]
id = "a"
[network]
name = "regtest"
opnet_rpc = "http://x"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "127.0.0.1:8801"
[gate]
strategy = "auto"
[[triggers]]
kind = "uds"
path = "${socketPath}"
`;
}

describe('otzi sync', () => {
  let tmp: string;
  let socketPath: string;
  let configPath: string;
  let secretPath: string;
  let manifestPath: string;
  let trigger: UdsTrigger | null = null;
  let received: Array<{ op: string; manifest: string; hmac: string }> = [];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-sync-cli-'));
    socketPath = join(tmp, 'sock');
    configPath = join(tmp, 'daemon.toml');
    secretPath = join(tmp, 'secret');
    manifestPath = join(tmp, 'manifest.json');
    await writeFile(configPath, buildToml(socketPath));
    received = [];
  });

  afterEach(async () => {
    if (trigger) await trigger.stop();
    trigger = null;
    await rm(tmp, { recursive: true, force: true });
  });

  function startFakeDaemon(
    behavior: (
      body: { op?: string; manifest?: string; hmac?: string },
    ) => { status: number; body: Record<string, unknown> },
  ): Promise<void> {
    trigger = new UdsTrigger({
      path: socketPath,
      handler: async (req) => {
        const body = req.body as { op?: string; manifest?: string; hmac?: string };
        if (body.op === 'sync' && typeof body.manifest === 'string' && typeof body.hmac === 'string') {
          received.push({ op: body.op, manifest: body.manifest, hmac: body.hmac });
        }
        return behavior(body);
      },
    });
    return trigger.start();
  }

  it('reads manifest, HMACs against secret, POSTs op:sync, returns peersNotified', async () => {
    await writeFile(manifestPath, VALID_MANIFEST);
    await writeFile(secretPath, 'shared-bootstrap-secret');

    await startFakeDaemon(() => ({
      status: 200,
      body: { ceremonyId: 'sync-abc', status: 'done', peersNotified: 2 },
    }));

    const result = await sync({ configPath, source: manifestPath, secretPath });

    expect(result).toEqual({ ceremonyId: 'sync-abc', peersNotified: 2 });
    expect(received).toHaveLength(1);
    expect(received[0]!.manifest).toBe(VALID_MANIFEST);
    const expectedHmac = createHmac('sha256', 'shared-bootstrap-secret')
      .update(VALID_MANIFEST, 'utf8')
      .digest('hex');
    expect(received[0]!.hmac).toBe(expectedHmac);
  });

  it('errors with a clear message when the bootstrap secret is absent', async () => {
    await writeFile(manifestPath, VALID_MANIFEST);
    // No secret file written.
    await startFakeDaemon(() => ({ status: 200, body: { peersNotified: 0 } }));
    await expect(
      sync({ configPath, source: manifestPath, secretPath }),
    ).rejects.toThrow(/control plane closed/);
    expect(received).toHaveLength(0);
  });

  it('errors when the bootstrap secret file is empty', async () => {
    await writeFile(manifestPath, VALID_MANIFEST);
    await writeFile(secretPath, '   \n');
    await startFakeDaemon(() => ({ status: 200, body: {} }));
    await expect(
      sync({ configPath, source: manifestPath, secretPath }),
    ).rejects.toThrow(/empty/);
  });

  it('translates daemon 410 into a friendly control-plane-closed message', async () => {
    await writeFile(manifestPath, VALID_MANIFEST);
    await writeFile(secretPath, 'shared');
    await startFakeDaemon(() => ({
      status: 410,
      body: { error: 'control plane closed' },
    }));
    await expect(
      sync({ configPath, source: manifestPath, secretPath }),
    ).rejects.toThrow(/control plane closed.*no longer accepted/);
  });

  it('rejects schema-invalid manifests before contacting the daemon', async () => {
    await writeFile(manifestPath, JSON.stringify({ version: 99 }));
    await writeFile(secretPath, 'shared');
    await startFakeDaemon(() => ({ status: 200, body: {} }));
    await expect(
      sync({ configPath, source: manifestPath, secretPath }),
    ).rejects.toThrow(/schema validation failed/);
    expect(received).toHaveLength(0);
  });

  it('rejects malformed JSON before contacting the daemon', async () => {
    await writeFile(manifestPath, '{ not json');
    await writeFile(secretPath, 'shared');
    await startFakeDaemon(() => ({ status: 200, body: {} }));
    await expect(
      sync({ configPath, source: manifestPath, secretPath }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('errors when the source manifest does not exist', async () => {
    await writeFile(secretPath, 'shared');
    await startFakeDaemon(() => ({ status: 200, body: {} }));
    await expect(
      sync({ configPath, source: join(tmp, 'nonexistent.json'), secretPath }),
    ).rejects.toThrow(/no such file/);
  });
});
