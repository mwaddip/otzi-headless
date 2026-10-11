import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDaemonConfigToml } from '../config/parse';
import { UdsTrigger } from '../triggers/uds';
import { DaemonClient, DaemonClientError } from './daemon-client';

function buildToml(socketPath: string): string {
  return `
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
`;
}

const VAULT_INFO = {
  partyIds: [0, 1, 2],
  threshold: 3,
  parties: 3,
  network: 'testnet4',
  address: 'tb1pexampleexampleexampleexampleexampleexampleexampleexample00',
  internalKey: `02${'ab'.repeat(32)}`,
  outputKey: 'cd'.repeat(32),
};

describe('DaemonClient over UDS', () => {
  let tmp: string;
  let socketPath: string;
  let trigger: UdsTrigger;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'daemon-client-test-'));
    socketPath = join(tmp, 'sock');
    trigger = new UdsTrigger({
      path: socketPath,
      handler: async (req) => {
        const body = req.body as { op?: string };
        if (body.op === 'echo') return { status: 200, body: { echoed: body } };
        if (body.op === 'fail') return { status: 400, body: { error: 'asked to fail' } };
        if (body.op === 'vault-info') return { status: 200, body: VAULT_INFO };
        return { status: 404, body: { error: 'unknown op' } };
      },
    });
    await trigger.start();
  });

  afterEach(async () => {
    await trigger.stop();
    await rm(tmp, { recursive: true, force: true });
  });

  it('makes successful requests via fromConfig', async () => {
    const tomlPath = join(tmp, 'daemon.toml');
    await writeFile(tomlPath, buildToml(socketPath));
    const client = await DaemonClient.fromConfig(tomlPath);
    const result = await client.request<{ echoed: unknown }>({ op: 'echo', hello: 1 });
    expect(result.echoed).toEqual({ op: 'echo', hello: 1 });
  });

  it('makes successful requests via fromParsed', async () => {
    const cfg = parseDaemonConfigToml(buildToml(socketPath));
    const client = DaemonClient.fromParsed(cfg);
    const result = await client.request<{ echoed: unknown }>({ op: 'echo', n: 42 });
    expect(result.echoed).toEqual({ op: 'echo', n: 42 });
  });

  it('vaultInfo returns the vault-info reply', async () => {
    const cfg = parseDaemonConfigToml(buildToml(socketPath));
    const client = DaemonClient.fromParsed(cfg);
    const info = await client.vaultInfo();
    expect(info).toEqual(VAULT_INFO);
    expect(info.address).toMatch(/^tb1p/);
  });

  it('stops waiting for a daemon that never answers when the signal aborts, and frees the socket', async () => {
    // A second daemon that accepts the request and says nothing.
    const silentPath = join(tmp, 'silent.sock');
    const silent = new UdsTrigger({ path: silentPath, handler: () => new Promise(() => {}) });
    await silent.start();
    try {
      const cfg = parseDaemonConfigToml(buildToml(silentPath));
      const client = DaemonClient.fromParsed(cfg);
      const controller = new AbortController();
      const pending = client.vaultInfo({ signal: controller.signal });
      const outcome = pending.then(
        () => undefined,
        (e: Error) => e,
      );
      setTimeout(() => controller.abort(), 50);
      const err = await outcome;
      expect(err?.name).toBe('AbortError');
      // A request aborted before it was made does not connect at all.
      await expect(client.request({ op: 'echo' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await silent.stop();
    }
  });

  it('request and vaultInfo work as before without options', async () => {
    const client = DaemonClient.fromParsed(parseDaemonConfigToml(buildToml(socketPath)));
    expect((await client.request<{ echoed: unknown }>({ op: 'echo' }, {})).echoed).toEqual({ op: 'echo' });
    expect(await client.vaultInfo({})).toEqual(VAULT_INFO);
  });

  it('throws DaemonClientError on non-200', async () => {
    const cfg = parseDaemonConfigToml(buildToml(socketPath));
    const client = DaemonClient.fromParsed(cfg);
    await expect(client.request({ op: 'fail' })).rejects.toMatchObject({
      name: 'DaemonClientError',
      status: 400,
      message: 'asked to fail',
    });
  });

  it('extracts JSON error.message when daemon returns structured error', async () => {
    const cfg = parseDaemonConfigToml(buildToml(socketPath));
    const client = DaemonClient.fromParsed(cfg);
    await expect(client.request({ op: 'unknown' })).rejects.toMatchObject({
      name: 'DaemonClientError',
      status: 404,
      message: 'unknown op',
    });
  });

  it('rejects when no uds or http trigger is configured', () => {
    const noTriggerToml = `
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
`;
    const cfg = parseDaemonConfigToml(noTriggerToml);
    expect(() => DaemonClient.fromParsed(cfg)).toThrow(/no uds or http trigger/);
  });
});

describe('DaemonClient over loopback HTTP', () => {
  it('parses host:port bind and connects', async () => {
    // Use UdsTrigger via loopback-style 'bind' to set up a tiny server… but
    // UdsTrigger only does UDS. For HTTP we use a vanilla http.createServer.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ pong: JSON.parse(body) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { address: string; port: number };
    try {
      const cfg = parseDaemonConfigToml(`
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
kind = "http"
bind = "${addr.address}:${addr.port}"
`);
      const client = DaemonClient.fromParsed(cfg);
      const result = await client.request<{ pong: { x: number } }>({ x: 7 });
      expect(result.pong).toEqual({ x: 7 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
