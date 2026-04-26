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
