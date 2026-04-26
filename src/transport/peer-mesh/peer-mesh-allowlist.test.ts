import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from '../../orchestrator/types';
import { generateIdentity } from '../identity';
import type { PeerAllowlist } from './allowlist';
import { PeerMeshTransport } from './peer-mesh';

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

interface CapturedLogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  extra?: Record<string, unknown>;
}

function makeLogger(): { logger: Logger; lines: CapturedLogLine[] } {
  const lines: CapturedLogLine[] = [];
  const logger: Logger = {
    debug: (msg, extra) => lines.push({ level: 'debug', msg, extra }),
    info: (msg, extra) => lines.push({ level: 'info', msg, extra }),
    warn: (msg, extra) => lines.push({ level: 'warn', msg, extra }),
    error: (msg, extra) => lines.push({ level: 'error', msg, extra }),
  };
  return { logger, lines };
}

describe('PeerMeshTransport — IP allowlist', () => {
  let stopFns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(stopFns.map((fn) => fn().catch(() => {})));
    stopFns = [];
  });

  it('drops inbound connections from non-allowlisted sources without a WS handshake', async () => {
    // Build a single transport that listens on 127.0.0.1 with one peer
    // (partyId=1) we'd otherwise accept inbound from. We then surgically
    // remove 127.0.0.1 from the resolved allowlist set so any inbound from
    // loopback is treated as "non-peer" and dropped.
    const me = await generateIdentity();
    const peer = await generateIdentity();
    const myPort = await freePort();
    const peerPort = await freePort();

    const { logger, lines } = makeLogger();

    const transport = new PeerMeshTransport({
      // self.partyId=2 so peer (partyId=1) would normally dial us — i.e. our
      // server expects inbound from peer's IP.
      self: { partyId: 2, identity: me },
      listen: `127.0.0.1:${myPort}`,
      peers: [
        { partyId: 1, publicKey: peer.publicKeyRaw, endpoint: `ws://127.0.0.1:${peerPort}` },
      ],
      logger,
    });

    await transport.start();
    stopFns.push(() => transport.stop());

    // Override the resolved IP set so 127.0.0.1 is NOT considered a peer.
    // Reaching into the private allowlist is the cleanest way to simulate a
    // non-allowlisted source on loopback (we can't easily make the test
    // connect from a different IP).
    const allowlist = (transport as unknown as { allowlist: PeerAllowlist }).allowlist;
    const originalHas = allowlist.has.bind(allowlist);
    (allowlist as unknown as { has: (ip: string) => boolean }).has = () => false;

    // Sanity check: confirm the override works.
    expect(originalHas('127.0.0.1')).toBe(true);
    expect(allowlist.has('127.0.0.1')).toBe(false);

    // Open a raw WebSocket to the server. The connection handler should
    // black-hole drop the socket before the WS-level handshake completes.
    const ws = new WebSocket(`ws://127.0.0.1:${myPort}`);

    const closed = await new Promise<{ event: 'open' | 'error' | 'close'; code?: number }>(
      (resolve) => {
        const timer = setTimeout(() => resolve({ event: 'error' }), 2_000);
        ws.on('open', () => {
          clearTimeout(timer);
          resolve({ event: 'open' });
        });
        ws.on('error', () => {
          clearTimeout(timer);
          // ws emits error on socket destroy; don't crash the test.
        });
        ws.on('close', (code) => {
          clearTimeout(timer);
          resolve({ event: 'close', code });
        });
      },
    );

    // The server destroyed the socket pre-handshake — the client either
    // never sees `open` (close fires straight away) or sees a close right
    // after open with no graceful WS-close frame. Either way, the WS
    // handshake did NOT complete cleanly with a server response.
    expect(closed.event).not.toBe('open');

    // The warn log line was emitted with the expected fields.
    const dropLines = lines.filter(
      (l) => l.level === 'warn' && l.msg.startsWith('peer-allowlist:'),
    );
    expect(dropLines).toHaveLength(1);
    expect(dropLines[0]!.extra).toMatchObject({ ip: expect.any(String) });
    expect(dropLines[0]!.extra?.port).toEqual(expect.any(Number));
    // The IP field should be loopback (raw or v4-mapped).
    const droppedIp = String(dropLines[0]!.extra!.ip);
    expect(droppedIp.endsWith('127.0.0.1')).toBe(true);
  }, 10_000);

  it('writes zero bytes to the wire when verifyClient rejects (no 401 leak)', async () => {
    // The previous test asserts the WS *client* never sees `open`, but a
    // destroyed-pre-write socket and a destroyed-after-401-write socket both
    // manifest the same way to a `WebSocket` client. The information-leak claim
    // — that scanners see nothing — only holds if `verifyClient` truly aborts
    // before any HTTP response bytes hit the kernel buffer. Verify that
    // directly with a raw TCP socket and assert zero bytes received.
    //
    // Regression scenario this guards: if someone makes `verifyClient` async
    // (returning Promise<boolean>), ws's handshake path would write the 401
    // response *before* our destroy() runs — bytes leak, this test fails.
    const me = await generateIdentity();
    const peer = await generateIdentity();
    const myPort = await freePort();
    const peerPort = await freePort();

    const { logger, lines } = makeLogger();

    const transport = new PeerMeshTransport({
      self: { partyId: 2, identity: me },
      listen: `127.0.0.1:${myPort}`,
      peers: [
        { partyId: 1, publicKey: peer.publicKeyRaw, endpoint: `ws://127.0.0.1:${peerPort}` },
      ],
      logger,
    });

    await transport.start();
    stopFns.push(() => transport.stop());

    // Same monkey-patch as the silent-drop test: force the allowlist to reject
    // loopback so any inbound from 127.0.0.1 is treated as "non-peer".
    const allowlist = (transport as unknown as { allowlist: PeerAllowlist }).allowlist;
    (allowlist as unknown as { has: (ip: string) => boolean }).has = () => false;

    // Build the byte-for-byte minimum HTTP upgrade request to trigger ws's
    // verifyClient path. ws validates `Connection: Upgrade`, `Upgrade: websocket`,
    // `Sec-WebSocket-Version: 13`, and a base64-16-byte `Sec-WebSocket-Key`
    // before invoking verifyClient — these are the required headers for the
    // handshake to even reach our reject path.
    const wsKey = randomBytes(16).toString('base64');
    const upgradeRequest =
      `GET / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${myPort}\r\n` +
      `Connection: Upgrade\r\n` +
      `Upgrade: websocket\r\n` +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;

    // Open a raw TCP connection — bypasses ws-client framing entirely so we
    // observe the exact bytes the server emits.
    const sock = net.connect({ host: '127.0.0.1', port: myPort });

    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('socket did not close within 2s — destroy() may not have run'));
      }, 2_000);

      sock.on('connect', () => {
        sock.write(upgradeRequest);
      });
      sock.on('data', (chunk) => {
        chunks.push(chunk);
      });
      sock.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      sock.on('error', () => {
        // ECONNRESET is expected when the server destroys the socket;
        // fall through to `close` for the assertion.
      });
    });

    // Core assertion: the server emitted ZERO bytes before closing. If
    // ws-server ever wrote the 401 response (e.g. async verifyClient
    // regression, race against destroy), `received.length` would be > 0 and
    // the buffer would start with `HTTP/1.1 401 ...`.
    expect(received.length).toBe(0);
    expect(received.toString('utf8').startsWith('HTTP/1.1')).toBe(false);
    expect(received.toString('utf8')).not.toContain('401');

    // The warn log line was emitted exactly once — confirms verifyClient ran
    // and rejected (the test isn't passing trivially because the connection
    // failed before reaching verifyClient).
    const dropLines = lines.filter(
      (l) => l.level === 'warn' && l.msg.startsWith('peer-allowlist:'),
    );
    expect(dropLines).toHaveLength(1);
  }, 5_000);

  it('refuses to start when a peer endpoint cannot be DNS-resolved', async () => {
    const me = await generateIdentity();
    const peer = await generateIdentity();
    const myPort = await freePort();

    const { logger } = makeLogger();
    const transport = new PeerMeshTransport({
      self: { partyId: 2, identity: me },
      listen: `127.0.0.1:${myPort}`,
      peers: [
        {
          partyId: 1,
          publicKey: peer.publicKeyRaw,
          // .invalid TLD is reserved by RFC 2606 — guaranteed not to resolve.
          endpoint: 'ws://nonexistent-host.invalid:8800',
        },
      ],
      logger,
    });

    await expect(transport.start()).rejects.toThrow(/DNS lookup failed/);
    // No server bound — nothing to stop, but call it for safety.
    stopFns.push(() => transport.stop());
  }, 10_000);

  it('admits inbound connections from allowlisted sources (sanity)', async () => {
    // Two real transports on loopback; verifying that the default allowlist
    // (which resolves 127.0.0.1 from the peer endpoint) does NOT break
    // normal operation.
    const idA = await generateIdentity();
    const idB = await generateIdentity();
    const portA = await freePort();
    const portB = await freePort();

    const { logger: loggerA } = makeLogger();
    const { logger: loggerB } = makeLogger();

    const a = new PeerMeshTransport({
      self: { partyId: 0, identity: idA },
      listen: `127.0.0.1:${portA}`,
      peers: [{ partyId: 1, publicKey: idB.publicKeyRaw, endpoint: `ws://127.0.0.1:${portB}` }],
      logger: loggerA,
    });
    const b = new PeerMeshTransport({
      self: { partyId: 1, identity: idB },
      listen: `127.0.0.1:${portB}`,
      peers: [{ partyId: 0, publicKey: idA.publicKeyRaw, endpoint: `ws://127.0.0.1:${portA}` }],
      logger: loggerB,
    });

    await Promise.all([a.start(), b.start()]);
    stopFns.push(() => a.stop());
    stopFns.push(() => b.stop());

    // Wait for the lower-partyId (a) to dial b and complete handshake.
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const stateA = (a as unknown as { peerStates: Map<number, { connection: unknown }> })
        .peerStates.get(1);
      const stateB = (b as unknown as { peerStates: Map<number, { connection: unknown }> })
        .peerStates.get(0);
      if (stateA?.connection && stateB?.connection) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const stateA = (a as unknown as { peerStates: Map<number, { connection: unknown }> })
      .peerStates.get(1);
    const stateB = (b as unknown as { peerStates: Map<number, { connection: unknown }> })
      .peerStates.get(0);
    expect(stateA?.connection).toBeTruthy();
    expect(stateB?.connection).toBeTruthy();
  }, 15_000);
});
