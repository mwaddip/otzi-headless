import { request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookGate } from '../../src/gate/webhook';
import type { CeremonySpec } from '../../src/gate/types';
import { legacyMessageHash } from '../../src/otzi/backend/btc-message';
import { createApprover, isLoopbackHost, type Approver, type ApproverOptions } from './approver';

/** A legacy signmessage / BIP-137 signature (compressed P2WPKH header) over `message`. */
function signMessage(message: string, priv: Uint8Array): string {
  const sig = secp256k1.sign(legacyMessageHash(message), priv, { prehash: false, format: 'recovered' });
  return base64.encode(Uint8Array.from([27 + 4 + 8 + sig[0]!, ...sig.slice(1)]));
}

const SIGNING_SPEC = {
  kind: 'signing',
  ceremonyId: 'withdrawal-0042',
  leader: 'peer-0',
  role: 'participant',
  network: 'testnet4',
  txid: 'ab'.repeat(32),
  inputs: [{ txid: 'cd'.repeat(32), vout: 0, amount: 100_000 }],
  outputs: [
    { address: 'tb1ptreasury', amount: 50_000, isChange: false, label: 'treasury' },
    { address: 'tb1pvault', amount: 49_230, isChange: true },
  ],
  amount: 50_000,
  totalIn: 100_000,
  totalOut: 99_230,
  fee: 770,
  vsize: 154,
  feeRate: 5,
};

interface PendingItem {
  nonce: string;
  ceremonyId: string;
  spec: Record<string, unknown>;
  messages: { approve: string; reject: string };
}

const running: Approver[] = [];

async function start(opts: Partial<ApproverOptions> = {}, bindHost = '127.0.0.1') {
  const priv = secp256k1.utils.randomSecretKey();
  const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true), btc.TEST_NETWORK).address!;
  const approver = createApprover({ address, host: bindHost, log: () => {}, ...opts });
  running.push(approver);
  await new Promise<void>((resolve) => approver.server.listen(0, bindHost, resolve));
  const port = (approver.server.address() as AddressInfo).port;
  return { priv, address, approver, port, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const approver of running.splice(0)) {
    approver.shutdown();
    approver.server.closeAllConnections();
    await new Promise((resolve) => approver.server.once('close', resolve));
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function listPending(base: string): Promise<{ address: string; pending: PendingItem[] }> {
  return (await (await fetch(`${base}/pending`)).json()) as { address: string; pending: PendingItem[] };
}

async function waitForPending(base: string, count: number): Promise<PendingItem[]> {
  await waitFor(async () => (await listPending(base)).pending.length === count, `${count} pending`);
  return (await listPending(base)).pending;
}

/** The daemon's side: the real webhook gate against the approver. */
function daemonGate(base: string, timeoutSec = 10, bearerTokenEnv?: string): WebhookGate {
  return new WebhookGate({ url: `${base}/webhook`, timeoutSec, ...(bearerTokenEnv ? { bearerTokenEnv } : {}) });
}

function decide(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** An HTTP request with exact control of the headers (fetch owns Host and Origin). */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('approver', () => {
  it('holds a webhook POST and lists it in /pending with the messages to sign', async () => {
    const { base, address } = await start();
    const held = daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec);

    const [item] = await waitForPending(base, 1);
    expect((await listPending(base)).address).toBe(address);
    expect(item!.ceremonyId).toBe('withdrawal-0042');
    expect(item!.spec).toEqual(SIGNING_SPEC);
    expect(item!.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(item!.messages.approve).toBe(`otzi-gate:approve:withdrawal-0042:${item!.nonce}`);
    expect(item!.messages.reject).toBe(`otzi-gate:reject:withdrawal-0042:${item!.nonce}`);
    // Nothing is answered to the daemon yet.
    const early = await Promise.race([held.then(() => 'answered'), sleep(150).then(() => 'still held')]);
    expect(early).toBe('still held');
  });

  it('gives each held request its own nonce, even for the same ceremony id', async () => {
    const { base } = await start();
    void daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec).catch(() => {});
    void daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec).catch(() => {});
    const items = await waitForPending(base, 2);
    expect(items[0]!.nonce).not.toBe(items[1]!.nonce);
  });

  it('answers a wrong signature with 403 and leaves the request pending', async () => {
    const { base, priv } = await start();
    void daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec).catch(() => {});
    const [item] = await waitForPending(base, 1);

    const stranger = secp256k1.utils.randomSecretKey();
    for (const signature of [
      signMessage(item!.messages.approve, stranger), // another key
      signMessage(item!.messages.reject, priv), // the other decision's message
      signMessage(`otzi-gate:approve:other-ceremony:${item!.nonce}`, priv), // another ceremony
      'AAAA', // garbage
    ]) {
      const res = await decide(base, { nonce: item!.nonce, decision: 'approve', signature });
      expect(res.status).toBe(403);
    }
    expect((await listPending(base)).pending).toHaveLength(1);
  });

  it('resolves the held webhook response with the decision once a valid signature arrives', async () => {
    const { base, priv } = await start();
    const approveHeld = daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec);
    const [item] = await waitForPending(base, 1);

    const res = await decide(base, { nonce: item!.nonce, decision: 'approve', signature: signMessage(item!.messages.approve, priv) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ceremonyId: 'withdrawal-0042', decision: 'approve' });
    await expect(approveHeld).resolves.toBe('approve');
    expect((await listPending(base)).pending).toHaveLength(0);

    const rejectHeld = daemonGate(base).approve({ ...SIGNING_SPEC, ceremonyId: 'withdrawal-0043' } as unknown as CeremonySpec);
    const [second] = await waitForPending(base, 1);
    const res2 = await decide(base, { nonce: second!.nonce, decision: 'reject', signature: signMessage(second!.messages.reject, priv) });
    expect(res2.status).toBe(200);
    await expect(rejectHeld).resolves.toBe('reject');
  });

  it('accepts a DKG spec and shows it', async () => {
    const { base, priv } = await start();
    const dkg = { kind: 'dkg', ceremonyId: 'setup-1', leader: 'peer-1', role: 'participant', threshold: 3, parties: 3, network: 'testnet4', peerIds: ['a', 'b', 'c'] };
    const held = daemonGate(base).approve(dkg as unknown as CeremonySpec);
    const [item] = await waitForPending(base, 1);
    expect(item!.spec).toEqual(dkg);
    await decide(base, { nonce: item!.nonce, decision: 'approve', signature: signMessage(item!.messages.approve, priv) });
    await expect(held).resolves.toBe('approve');
  });

  it('answers a replay of a used nonce with 404', async () => {
    const { base, priv } = await start();
    const held = daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec);
    const [item] = await waitForPending(base, 1);
    const body = { nonce: item!.nonce, decision: 'approve', signature: signMessage(item!.messages.approve, priv) };

    expect((await decide(base, body)).status).toBe(200);
    await held;
    expect((await decide(base, body)).status).toBe(404);
    // A signature for the other decision of the used nonce does not revive it either.
    const reject = { nonce: item!.nonce, decision: 'reject', signature: signMessage(item!.messages.reject, priv) };
    expect((await decide(base, reject)).status).toBe(404);
  });

  it('answers malformed /decide bodies with 400 and keeps the request pending', async () => {
    const { base } = await start();
    void daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec).catch(() => {});
    const [item] = await waitForPending(base, 1);
    const sig = 'AAAA';
    for (const body of [
      'not json',
      '[]',
      'null',
      {},
      { decision: 'approve', signature: sig },
      { nonce: 'zz', decision: 'approve', signature: sig },
      { nonce: item!.nonce.toUpperCase(), decision: 'approve', signature: sig },
      { nonce: item!.nonce, decision: 'maybe', signature: sig },
      { nonce: item!.nonce, signature: sig },
      { nonce: item!.nonce, decision: 'approve' },
      { nonce: item!.nonce, decision: 'approve', signature: '' },
      { nonce: item!.nonce, decision: 'approve', signature: 42 },
      { nonce: item!.nonce, decision: 'approve', signature: 'A'.repeat(5000) },
    ]) {
      expect((await decide(base, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await decide(base, { nonce: '00'.repeat(16), decision: 'approve', signature: sig })).status).toBe(404);
    expect((await listPending(base)).pending).toHaveLength(1);
  });

  it('answers a malformed webhook spec with 400 and holds nothing', async () => {
    const { base } = await start();
    const post = (body: string) => fetch(`${base}/webhook`, { method: 'POST', body });
    expect((await post('nope')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    expect((await post(JSON.stringify({ kind: 'signing' }))).status).toBe(400);
    expect((await post(JSON.stringify({ kind: 'signing', ceremonyId: 'bad id' }))).status).toBe(400);
    expect((await post(JSON.stringify({ kind: 'signing', ceremonyId: 'a/../b' }))).status).toBe(400);
    expect((await post(JSON.stringify({ kind: 'other', ceremonyId: 'x' }))).status).toBe(400);
    expect((await listPending(base)).pending).toHaveLength(0);
  });

  it('answers a request target that is not a URL with 400 and keeps running', async () => {
    const { base, port } = await start();
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET http://a:b:c/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (d) => (data += String(d)));
      socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    expect(status).toBe('HTTP/1.1 400 Bad Request');
    // Still serving.
    expect((await listPending(base)).pending).toEqual([]);
  });

  it('requires the bearer token on /webhook when one is configured', async () => {
    const { base, priv } = await start({ token: 's3cret' });
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/webhook`, { method: 'POST', headers, body: JSON.stringify(SIGNING_SPEC), signal: AbortSignal.timeout(300) });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post({ authorization: 's3cret' })).status).toBe(401);
    expect((await listPending(base)).pending).toHaveLength(0);

    // The daemon's gate sends the token from its env var.
    process.env.OTZI_TEST_APPROVER_TOKEN = 's3cret';
    try {
      const held = daemonGate(base, 10, 'OTZI_TEST_APPROVER_TOKEN').approve(SIGNING_SPEC as unknown as CeremonySpec);
      const [item] = await waitForPending(base, 1);
      await decide(base, { nonce: item!.nonce, decision: 'approve', signature: signMessage(item!.messages.approve, priv) });
      await expect(held).resolves.toBe('approve');
    } finally {
      delete process.env.OTZI_TEST_APPROVER_TOKEN;
    }
  });

  it('drops the entry when the daemon disconnects', async () => {
    const { base, priv } = await start();
    // The gate's own deadline passes and it destroys the request.
    const gone = daemonGate(base, 0.3).approve(SIGNING_SPEC as unknown as CeremonySpec);
    await waitForPending(base, 1);
    await expect(gone).rejects.toThrow(/timed out/);
    await waitFor(async () => (await listPending(base)).pending.length === 0, 'the entry to be dropped');

    // A decision for the dropped request finds nothing.
    const dropped = new AbortController();
    const held = fetch(`${base}/webhook`, { method: 'POST', body: JSON.stringify(SIGNING_SPEC), signal: dropped.signal }).catch(() => null);
    const [item] = await waitForPending(base, 1);
    dropped.abort();
    await held;
    await waitFor(async () => (await listPending(base)).pending.length === 0, 'the aborted entry to be dropped');
    const res = await decide(base, { nonce: item!.nonce, decision: 'approve', signature: signMessage(item!.messages.approve, priv) });
    expect(res.status).toBe(404);
  });

  it('answers held requests with 503 on shutdown', async () => {
    const { base, approver } = await start();
    const held = fetch(`${base}/webhook`, { method: 'POST', body: JSON.stringify(SIGNING_SPEC) });
    await waitForPending(base, 1);
    approver.shutdown();
    expect((await held).status).toBe(503);
  });

  it('serves the operator page with a restrictive content security policy', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('Ötzi Gate Approver');
  });

  it('refuses an address that is not a Bitcoin address', () => {
    expect(() => createApprover({ address: 'not-an-address' })).toThrow(/not a valid Bitcoin address/);
  });

  describe('browser boundary', () => {
    it('on a loopback bind refuses a Host header that is not a loopback name for the port', async () => {
      const { port } = await start();
      for (const host of ['evil.example', `evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1:${port + 1}`, 'localhost']) {
        const res = await rawRequest(port, 'GET', '/pending', { host });
        expect(res.status, host).toBe(403);
        expect(res.body).not.toContain('"pending"');
      }
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
        expect((await rawRequest(port, 'GET', '/pending', { host })).status, host).toBe(200);
      }
    });

    // The Host check must never switch itself off because a loopback bind was spelled unusually.
    it('recognises every spelling of a loopback address', () => {
      for (const host of [
        '127.0.0.1', '127.1.2.3', '127.255.255.254',
        'localhost', 'LOCALHOST', 'localhost.',
        '::1', '[::1]', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::0001', '0::1', '::1%lo',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:127.1.2.3', '[::ffff:127.0.0.1]',
      ]) {
        expect(isLoopbackHost(host), host).toBe(true);
      }
      for (const host of [
        '', '0.0.0.0', '::', '10.0.0.5', '192.168.1.1', '128.0.0.1', '126.255.255.255', '8.8.8.8',
        '::2', '::ffff:10.0.0.1', '::ffff:0a00:1', '::ffff:128.0.0.1', 'fe80::1', '2001:db8::1',
        'example.com', 'localhost.evil.example', '127.0.0.1.evil.example', 'my-localhost',
      ]) {
        expect(isLoopbackHost(host), host).toBe(false);
      }
    });

    it('keeps the Host check on for a loopback bind spelled as a long IPv6 form or an IPv4-mapped address', async () => {
      // Listening happens on 127.0.0.1 (this sandbox may lack IPv6); the spelling is what the check reads.
      for (const spelled of ['0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::1]']) {
        const { port } = await start({ host: spelled });
        expect((await rawRequest(port, 'GET', '/pending', { host: 'evil.example' })).status, spelled).toBe(403);
        expect((await rawRequest(port, 'GET', '/pending', { host: `localhost:${port}` })).status, spelled).toBe(200);
      }
    });

    it('keeps the Host check on when the address it actually bound is loopback, whatever it was called', async () => {
      // The caller names a host the classifier does not know, but the OS binds 127.0.0.1.
      const { port } = await start({ host: 'not-a-known-spelling' }, '127.0.0.1');
      expect((await rawRequest(port, 'GET', '/pending', { host: 'evil.example' })).status).toBe(403);
    });

    it('on a non-loopback bind leaves the Host header alone', async () => {
      const { port } = await start({}, '0.0.0.0');
      const res = await rawRequest(port, 'GET', '/pending', { host: 'approver.internal:8181' });
      expect(res.status).toBe(200);
    });

    it('refuses any request that carries a foreign Origin, and the operator page still works', async () => {
      const { base, port, priv } = await start();
      void daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec).catch(() => {});
      const [item] = await waitForPending(base, 1);
      const valid = JSON.stringify({ nonce: item!.nonce, decision: 'approve', signature: signMessage(item!.messages.approve, priv) });
      const own = `127.0.0.1:${port}`;

      // A cross-site page can send these without a preflight (text/plain POST).
      for (const origin of ['http://evil.example', 'https://evil.example', `http://evil.example:${port}`, 'null', 'not a url', `http://127.0.0.1:${port + 1}`]) {
        const decideRes = await rawRequest(port, 'POST', '/decide', { host: own, origin, 'content-type': 'text/plain' }, valid);
        expect(decideRes.status, origin).toBe(403);
        const webhookRes = await rawRequest(port, 'POST', '/webhook', { host: own, origin, 'content-type': 'text/plain' }, JSON.stringify({ ...SIGNING_SPEC, ceremonyId: 'planted' }));
        expect(webhookRes.status, origin).toBe(403);
        const readRes = await rawRequest(port, 'GET', '/pending', { host: own, origin });
        expect(readRes.status, origin).toBe(403);
      }
      // Nothing was decided or planted.
      expect((await listPending(base)).pending.map((p) => p.ceremonyId)).toEqual(['withdrawal-0042']);

      // The page's own same-origin POST carries its own origin and goes through.
      const ok = await rawRequest(port, 'POST', '/decide', { host: own, origin: `http://${own}`, 'content-type': 'application/json' }, valid);
      expect(ok.status).toBe(200);
    });

    it('treats the daemon, which sends no Origin, as before', async () => {
      const { base } = await start();
      void daemonGate(base).approve(SIGNING_SPEC as unknown as CeremonySpec).catch(() => {});
      await waitForPending(base, 1);
    });
  });
});
