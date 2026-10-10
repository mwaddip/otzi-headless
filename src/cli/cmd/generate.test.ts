import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UdsTrigger } from '../../triggers/uds';
import { DaemonClientError } from '../daemon-client';
import { generate } from './generate';

const DKG_REPLY = {
  ceremonyId: 'dkg-fixed',
  status: 'done',
  address: 'tb1pexampleexampleexampleexampleexampleexampleexampleexample00',
  internalKey: `02${'ab'.repeat(32)}`,
  network: 'testnet4',
};

function fakeClient(reply: unknown = DKG_REPLY) {
  const requests: unknown[] = [];
  return {
    requests,
    async request<T>(body: unknown): Promise<T> {
      requests.push(body);
      if (reply instanceof Error) throw reply;
      return reply as T;
    },
  };
}

describe('generate', () => {
  it('generate sends op dkg and returns the address', async () => {
    const client = fakeClient();
    const r = await generate({ configPath: '/nonexistent/daemon.toml' }, { client });
    expect(client.requests).toEqual([{ op: 'dkg' }]);
    expect(r).toEqual({ ceremonyId: 'dkg-fixed', address: DKG_REPLY.address, network: 'testnet4' });
  });

  it('passes a ceremony id through', async () => {
    const client = fakeClient();
    await generate({ configPath: '/nonexistent/daemon.toml', ceremonyId: 'setup-1' }, { client });
    expect(client.requests).toEqual([{ op: 'dkg', ceremonyId: 'setup-1' }]);
  });

  it('passes a daemon refusal through', async () => {
    const client = fakeClient(new DaemonClientError(409, 'this node already holds a vault'));
    await expect(generate({ configPath: '/nonexistent/daemon.toml' }, { client })).rejects.toMatchObject({
      status: 409,
      message: 'this node already holds a vault',
    });
  });

  it('rejects a reply without an address', async () => {
    const client = fakeClient({ ceremonyId: 'dkg-x', status: 'done' });
    await expect(generate({ configPath: '/nonexistent/daemon.toml' }, { client })).rejects.toThrow(/daemon reply/);
  });

  describe('through the daemon client', () => {
    let tmp: string;
    let trigger: UdsTrigger;
    let seen: unknown[];
    let configPath: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'otzi-generate-test-'));
      const socketPath = join(tmp, 'sock');
      seen = [];
      trigger = new UdsTrigger({
        path: socketPath,
        handler: async req => {
          seen.push(req.body);
          return { status: 200, body: DKG_REPLY };
        },
      });
      await trigger.start();
      configPath = join(tmp, 'daemon.toml');
      await writeFile(
        configPath,
        `
[share]
path = "/tmp/x"
password_env = "X"
[node]
id = "a"
[network]
name = "testnet4"
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
`,
      );
    });

    afterEach(async () => {
      await trigger.stop();
      await rm(tmp, { recursive: true, force: true });
    });

    it('reaches the daemon over its UDS from the config, with no http trigger', async () => {
      const r = await generate({ configPath, ceremonyId: 'setup-2' });
      expect(seen).toEqual([{ op: 'dkg', ceremonyId: 'setup-2' }]);
      expect(r.address).toBe(DKG_REPLY.address);
    });
  });
});
