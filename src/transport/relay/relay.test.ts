import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PartyId } from '../../core/types';
import { generateIdentity, type IdentityKeyPair } from '../identity';
import { initiatorBegin } from '../handshake';
import { WebSocket, WebSocketServer } from 'ws';
import { encodePullResponse } from '../peer-mesh/wire';
import { BlobPuller } from '../../core/blob-puller';
import { BlobStore } from '../../core/blob-store';
import type { Logger } from '../../orchestrator/types';
import { RelayServer } from './server';
import { RelayTransport, type RelayTransportOptions } from './relay-transport';

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

interface RelayTestNode {
  partyId: PartyId;
  identity: IdentityKeyPair;
  transport: RelayTransport;
}

async function buildRelayRing(
  n: number,
  relayUrl: string,
  ringId: string,
  opts: Pick<RelayTransportOptions, 'reconnect' | 'logger'> = {},
): Promise<RelayTestNode[]> {
  const identities = await Promise.all(Array.from({ length: n }, () => generateIdentity()));
  const nodes: RelayTestNode[] = [];
  for (let i = 0; i < n; i++) {
    const peers = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      peers.push({ partyId: j, publicKey: identities[j]!.publicKeyRaw });
    }
    const transport = new RelayTransport({
      self: { partyId: i, identity: identities[i]! },
      relayUrl,
      ringId,
      peers,
      pullTimeoutMs: 5_000,
      ...opts,
    });
    nodes.push({ partyId: i, identity: identities[i]!, transport });
  }
  return nodes;
}

async function waitUntilConnected(
  node: RelayTestNode,
  peerPartyId: PartyId,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = (node.transport as unknown as {
      peerStates: Map<PartyId, { status: string }>;
    }).peerStates.get(peerPartyId);
    if (state?.status === 'connected') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`node ${node.partyId} not connected to ${peerPartyId} within ${timeoutMs}ms`);
}

async function waitForRing(nodes: RelayTestNode[]): Promise<void> {
  for (const node of nodes) {
    for (const peer of nodes) {
      if (peer.partyId === node.partyId) continue;
      await waitUntilConnected(node, peer.partyId);
    }
  }
}

/** `p`'s value, or 'still pending' after `ms` (the guard timer is cleared either way). */
async function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | 'still pending'> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'still pending'>((r) => {
    timer = setTimeout(() => r('still pending'), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer);
  }
}

describe('RelayServer — roster + routing', () => {
  let server: RelayServer | null = null;
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  it('starts + stops cleanly on an ephemeral port', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();
    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(addr!.port).toBe(port);
  });

  it('rejects bind with empty host', () => {
    expect(() => new RelayServer({ listen: ':9999' })).toThrow(/invalid listen|host required/);
  });

  it('stop() while start() is still binding leaves nothing listening and no heartbeat', async () => {
    const port = await freePort();
    const racing = new RelayServer({ listen: `127.0.0.1:${port}`, heartbeatMs: 20 });
    const starting = racing.start(); // binding: the listen completes on a later tick
    await racing.stop();
    await starting;

    expect(racing.address()).toBeNull();
    expect((racing as unknown as { heartbeat: unknown }).heartbeat).toBeNull();
    expect(await acceptsConnections(port)).toBe(false);
  });
});

/** Whether anything accepts a TCP connection on this loopback port. */
async function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

describe('RelayTransport — 2-peer', () => {
  let server: RelayServer | null = null;
  let nodes: RelayTestNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
    if (server) await server.stop();
    server = null;
  });

  it('two peers establish via relay; broadcast delivers through the Noise record layer', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    nodes = await buildRelayRing(2, `ws://127.0.0.1:${port}`, 'ring-alpha');
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const received: Array<{ from: PartyId; msg: string }> = [];
    nodes[1]!.transport.onBroadcast((from, msg) => {
      received.push({ from, msg: new TextDecoder().decode(msg) });
    });

    await nodes[0]!.transport.broadcast(new TextEncoder().encode('hello via relay'));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ from: 0, msg: 'hello via relay' }]);
  }, 15_000);

  it('pull round-trips via servePulls handler through the relay', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    nodes = await buildRelayRing(2, `ws://127.0.0.1:${port}`, 'ring-beta');
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    nodes[1]!.transport.servePulls((from, key) => {
      if (from === 0 && key.ceremonyId === 'c' && key.round === 'r1' && key.from === 1) return blob;
      return null;
    });

    const pulled = await nodes[0]!.transport.pull({
      ceremonyId: 'c',
      round: 'r1',
      from: 1,
    });
    expect(pulled).toEqual(blob);
  }, 15_000);

  it('pull returns null when servePulls returns null', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    nodes = await buildRelayRing(2, `ws://127.0.0.1:${port}`, 'ring-null');
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    nodes[1]!.transport.servePulls(() => null);
    const pulled = await nodes[0]!.transport.pull({
      ceremonyId: 'c',
      round: 'r1',
      from: 1,
    });
    expect(pulled).toBeNull();
  }, 15_000);

  it('pull on a peer not yet handshake-connected returns null (transient)', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    nodes = await buildRelayRing(2, `ws://127.0.0.1:${port}`, 'ring-offline');
    // Start only node 0; don't start node 1.
    await nodes[0]!.transport.start();
    await new Promise((r) => setTimeout(r, 100));

    const res = await nodes[0]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 });
    expect(res).toBeNull();

    // Cleanup: no need to stop node 1 since it never started.
    await nodes[0]!.transport.stop();
    nodes = [];
  }, 10_000);
});

describe('RelayTransport — 3-peer mesh via relay', () => {
  let server: RelayServer | null = null;
  let nodes: RelayTestNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
    if (server) await server.stop();
    server = null;
  });

  it('all 3 peers complete pairwise handshakes; broadcast + pull routing works', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    nodes = await buildRelayRing(3, `ws://127.0.0.1:${port}`, 'ring-tri');
    // `peers` is the whole ring, self included.
    for (const n of nodes) expect(n.transport.peers).toEqual([0, 1, 2]);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const received0: string[] = [];
    const received2: string[] = [];
    nodes[0]!.transport.onBroadcast((_from, msg) => received0.push(new TextDecoder().decode(msg)));
    nodes[2]!.transport.onBroadcast((_from, msg) => received2.push(new TextDecoder().decode(msg)));

    await nodes[1]!.transport.broadcast(new TextEncoder().encode('from-middle'));
    await new Promise((r) => setTimeout(r, 200));
    expect(received0).toEqual(['from-middle']);
    expect(received2).toEqual(['from-middle']);

    const blobFromNode0 = new Uint8Array([0xaa]);
    const blobFromNode2 = new Uint8Array([0xcc]);
    nodes[0]!.transport.servePulls(() => blobFromNode0);
    nodes[2]!.transport.servePulls(() => blobFromNode2);

    const [a, c] = await Promise.all([
      nodes[1]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 0 }),
      nodes[1]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 2 }),
    ]);
    expect(a).toEqual(blobFromNode0);
    expect(c).toEqual(blobFromNode2);
  }, 20_000);

  it('duplicate partyId in same ring gets rejected on hello', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    const me = await generateIdentity();
    const other = await generateIdentity();
    const transport = new RelayTransport({
      self: { partyId: 0, identity: me },
      relayUrl: `ws://127.0.0.1:${port}`,
      ringId: 'ring-dup',
      peers: [{ partyId: 1, publicKey: other.publicKeyRaw }],
    });
    await transport.start();

    // Second transport with the same partyId in same ring.
    const imposter = await generateIdentity();
    const dup = new RelayTransport({
      self: { partyId: 0, identity: imposter },
      relayUrl: `ws://127.0.0.1:${port}`,
      ringId: 'ring-dup',
      peers: [{ partyId: 1, publicKey: other.publicKeyRaw }],
    });
    await dup.start();
    // The server refuses dup's hello: a failed attempt, so dup drops the
    // socket and retries with backoff, holding no session meanwhile. Its
    // broadcast reaches nobody (a no-op).
    await dup.broadcast(new Uint8Array([1]));

    await transport.stop();
    await dup.stop();
  }, 10_000);

  it('peer-left notification tears down that peer\'s record session', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();

    nodes = await buildRelayRing(2, `ws://127.0.0.1:${port}`, 'ring-leave');
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    await nodes[1]!.transport.stop();
    // Give the relay a moment to broadcast peer-left.
    await new Promise((r) => setTimeout(r, 200));

    const state = (nodes[0]!.transport as unknown as {
      peerStates: Map<PartyId, { status: string }>;
    }).peerStates.get(1);
    expect(state?.status).toBe('disconnected');

    // Remove the stopped node from the cleanup list so afterEach doesn't
    // double-stop it.
    nodes = [nodes[0]!];
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Send ordering, transient failures and recovery (facts/transport.md, relay-transport.ts)
// ─────────────────────────────────────────────────────────────────────────

type RelayInternals = {
  ws: { send: (data: unknown, cb?: (err?: Error) => void) => void } | null;
  pullTimeoutMs: number;
  peerStates: Map<PartyId, { status: string; session: { seal(p: Uint8Array): Promise<Uint8Array> } | null }>;
};
const relayInternals = (t: RelayTransport) => t as unknown as RelayInternals;

describe('RelayTransport — send ordering, transient failures and recovery', () => {
  let server: RelayServer | null = null;
  let nodes: RelayTestNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
    if (server) await server.stop();
    server = null;
  });

  async function ring(n: number, ringId: string): Promise<RelayTestNode[]> {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();
    nodes = await buildRelayRing(n, `ws://127.0.0.1:${port}`, ringId);
    await Promise.all(nodes.map((x) => x.transport.start()));
    await waitForRing(nodes);
    return nodes;
  }

  it('large and small messages sent concurrently to one peer arrive in send order', async () => {
    const [a, b] = await ring(2, 'ring-order');
    const received: number[] = [];
    b!.transport.onBroadcast((_from, msg) => received.push(msg[0]!));
    const msgs = Array.from({ length: 12 }, (_, i) => {
      const m = new Uint8Array(i % 2 === 0 ? 1_000_000 : 200);
      m[0] = i;
      return m;
    });
    await Promise.all(msgs.map((m) => a!.transport.broadcast(m)));

    await vi.waitFor(() => expect(received).toHaveLength(msgs.length), { timeout: 10_000, interval: 20 });
    expect(received).toEqual(msgs.map((_, i) => i));
    expect(relayInternals(b!.transport).peerStates.get(0)!.status).toBe('connected');
  }, 30_000);

  it('pull returns null when sending the request fails', async () => {
    const [a] = await ring(2, 'ring-sendfail');
    relayInternals(a!.transport).ws!.send = (_data, cb) => cb?.(new Error('socket write failed'));

    await expect(a!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 })).resolves.toBeNull();
  }, 15_000);

  it('a pending pull resolves null as soon as its peer leaves', async () => {
    const [a, b] = await ring(2, 'ring-left');
    relayInternals(a!.transport).pullTimeoutMs = 120_000;
    // Node 1 never answers pulls: it drops every frame it receives.
    (b!.transport as unknown as { onIncoming: () => Promise<void> }).onIncoming = async () => {};

    const pending = a!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 });
    await new Promise((r) => setTimeout(r, 100));
    await b!.transport.stop();
    nodes = [a!];

    expect(await settledWithin(pending, 10_000)).toBeNull();
  }, 30_000);

  it.each([
    ['the responder', 0, 1],
    ['the initiator', 1, 0],
  ])('recovers after %s tears its session down on a record failure', async (_name, sender, receiver) => {
    const all = await ring(2, `ring-recover-${sender}`);
    const from = all[sender]!;
    const to = all[receiver]!;
    to.transport.servePulls((_who, key) => (key.round === 'r' ? new Uint8Array([7, 7]) : null));
    from.transport.servePulls((_who, key) => (key.round === 'r' ? new Uint8Array([9]) : null));
    const heard: number[] = [];
    to.transport.onBroadcast((_f, msg) => heard.push(msg[0]!));

    // A sealed frame that never reaches the wire: the receiver's next open fails.
    const before = relayInternals(to.transport).peerStates.get(sender)!.session;
    await relayInternals(from.transport).peerStates.get(receiver)!.session!.seal(new Uint8Array([0]));
    await from.transport.broadcast(new Uint8Array([1]));
    await vi.waitFor(
      () => expect(relayInternals(to.transport).peerStates.get(sender)!.session).not.toBe(before),
      { timeout: 5_000, interval: 10 },
    );

    // The pair re-handshakes: broadcasts and pulls flow again in both directions.
    await vi.waitFor(
      async () => {
        await from.transport.broadcast(new Uint8Array([2]));
        expect(heard).toContain(2);
      },
      { timeout: 15_000, interval: 100 },
    );
    await vi.waitFor(
      async () => {
        expect(await to.transport.pull({ ceremonyId: 'c', round: 'r', from: sender })).toEqual(new Uint8Array([9]));
        expect(await from.transport.pull({ ceremonyId: 'c', round: 'r', from: receiver })).toEqual(
          new Uint8Array([7, 7]),
        );
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 40_000);
});

describe('RelayTransport / RelayServer — frame size and response binding', () => {
  let server: RelayServer | null = null;
  let nodes: RelayTestNode[] = [];
  let extra: WebSocketServer | null = null;
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
    if (server) await server.stop();
    server = null;
    if (extra) await new Promise<void>((r) => extra!.close(() => r()));
    extra = null;
  });

  it('the relay server drops a client that sends a frame over 4 MiB', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r, j) => {
      ws.once('open', () => r());
      ws.once('error', j);
    });
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.on('error', () => {});
    ws.send(JSON.stringify({ kind: 'hello', ringId: 'big', partyId: 0 }));
    ws.send('x'.repeat(4 * 1024 * 1024 + 1));
    expect(await closed).toBe(1009);
  }, 20_000);

  it('the relay client drops a relay that sends a message over 4 MiB', async () => {
    const port = await freePort();
    extra = new WebSocketServer({ host: '127.0.0.1', port });
    extra.on('connection', (sock) => {
      sock.on('error', () => {});
      sock.once('message', () => sock.send('x'.repeat(4 * 1024 * 1024 + 1)));
    });
    await new Promise<void>((r) => extra!.once('listening', () => r()));
    const identity = await generateIdentity();
    const peer = await generateIdentity();
    const transport = new RelayTransport({
      self: { partyId: 0, identity },
      relayUrl: `ws://127.0.0.1:${port}`,
      ringId: 'big',
      peers: [{ partyId: 1, publicKey: peer.publicKeyRaw }],
    });
    nodes = [{ partyId: 0, identity, transport }];
    await transport.start();
    await vi.waitFor(() => expect(relayInternals(transport).ws).toBeNull(), { timeout: 10_000, interval: 20 });
  }, 20_000);

  it('ignores a pull response that comes from another peer than the one pulled', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();
    nodes = await buildRelayRing(3, `ws://127.0.0.1:${port}`, 'ring-bind');
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    // Node 1 never answers pulls.
    (nodes[1]!.transport as unknown as { onIncoming: () => Promise<void> }).onIncoming = async () => {};
    relayInternals(nodes[0]!.transport).pullTimeoutMs = 2_000;

    const pending = nodes[0]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 });
    const pulls = (nodes[0]!.transport as unknown as { pendingPulls: Map<string, unknown> }).pendingPulls;
    await vi.waitFor(() => expect(pulls.size).toBe(1), { timeout: 5_000, interval: 5 });
    const [requestId] = [...pulls.keys()];
    // Node 2 answers in node 1's place, over its own authenticated session with node 0.
    const t2 = nodes[2]!.transport as unknown as {
      peerStates: Map<PartyId, unknown>;
      sendAppMessage(peer: unknown, bytes: Uint8Array): Promise<void>;
    };
    await t2.sendAppMessage(t2.peerStates.get(0), encodePullResponse(requestId!, new TextEncoder().encode('forged')));

    await expect(pending).resolves.toBeNull();
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Reconnect (facts/transport.md, relay-transport.ts; spec §3.2, §4)
// ─────────────────────────────────────────────────────────────────────────

type LogLine = { msg: string; extra?: Record<string, unknown> };
function capturingLogger(): { logger: Logger; infos: LogLine[]; warns: LogLine[]; debugs: LogLine[] } {
  const infos: LogLine[] = [];
  const warns: LogLine[] = [];
  const debugs: LogLine[] = [];
  const logger: Logger = {
    debug: (msg, extra) => debugs.push({ msg, extra }),
    info: (msg, extra) => infos.push({ msg, extra }),
    warn: (msg, extra) => warns.push({ msg, extra }),
    error: () => {},
  };
  return { logger, infos, warns, debugs };
}

/** The delays of the scheduled reconnects, in order (each failed attempt is a warn naming its next delay). */
const reconnectDelays = (warns: LogLine[]): number[] =>
  warns.flatMap((w) => (typeof w.extra?.delayMs === 'number' ? [w.extra.delayMs] : []));

const REGISTERED = 'relay-transport: registered with the relay';

/** Small backoff values: tests see several attempts quickly. */
const FAST = { initialMs: 50, maxMs: 400 };

/** A one-peer ring member with `FAST` backoff. */
async function soloTransport(
  url: string,
  partyId: PartyId,
  ringId: string,
  extra: Partial<RelayTransportOptions> = {},
): Promise<RelayTransport> {
  const [identity, other] = await Promise.all([generateIdentity(), generateIdentity()]);
  return new RelayTransport({
    self: { partyId, identity },
    relayUrl: url,
    ringId,
    peers: [{ partyId: partyId === 0 ? 1 : 0, publicKey: other.publicKeyRaw }],
    reconnect: FAST,
    ...extra,
  });
}

/** A listener that accepts TCP but never answers the WebSocket upgrade; `held` collects its sockets. */
async function silentTcp(held: net.Socket[]): Promise<{ server: net.Server; url: string }> {
  const server = net.createServer((sock) => {
    held.push(sock);
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as net.AddressInfo;
  return { server, url: `ws://127.0.0.1:${port}` };
}

describe('RelayTransport — reconnect', () => {
  let server: RelayServer | null = null;
  let nodes: RelayTestNode[] = [];
  let transports: RelayTransport[] = [];
  let tcp: net.Server | null = null;
  const held: net.Socket[] = [];
  afterEach(async () => {
    await Promise.all([...nodes.map((n) => n.transport), ...transports].map((t) => t.stop()));
    nodes = [];
    transports = [];
    if (server) await server.stop();
    server = null;
    for (const s of held.splice(0)) s.destroy();
    if (tcp) await new Promise<void>((r) => tcp!.close(() => r()));
    tcp = null;
  });

  async function solo(
    url: string,
    partyId: PartyId,
    ringId: string,
    extra: Partial<RelayTransportOptions> = {},
  ): Promise<RelayTransport> {
    const transport = await soloTransport(url, partyId, ringId, extra);
    transports.push(transport);
    return transport;
  }

  async function broadcastArrives(from: RelayTestNode, to: RelayTestNode, tag: number): Promise<void> {
    const heard: number[] = [];
    const off = to.transport.onBroadcast((_f, msg) => heard.push(msg[0]!));
    try {
      await vi.waitFor(
        async () => {
          await from.transport.broadcast(new Uint8Array([tag]));
          expect(heard).toContain(tag);
        },
        { timeout: 15_000, interval: 100 },
      );
    } finally {
      off();
    }
  }

  it('reconnects after the relay server restarts and re-handshakes with peers', async () => {
    const port = await freePort();
    const listen = `127.0.0.1:${port}`;
    server = new RelayServer({ listen });
    await server.start();
    nodes = await buildRelayRing(2, `ws://${listen}`, 'ring-restart', { reconnect: FAST });
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    await broadcastArrives(nodes[0]!, nodes[1]!, 1);

    await server.stop();
    server = null;
    for (const n of nodes) {
      await vi.waitFor(() => expect(relayInternals(n.transport).peerStates.get(1 - n.partyId)!.status).toBe('disconnected'), {
        timeout: 10_000,
        interval: 20,
      });
    }

    // A new relay on the same address: both nodes come back without a restart.
    server = new RelayServer({ listen });
    await server.start();
    await waitForRing(nodes);
    await broadcastArrives(nodes[0]!, nodes[1]!, 2);
    await broadcastArrives(nodes[1]!, nodes[0]!, 3);
  }, 40_000);

  it('start() succeeds when the relay is down and connects once it comes up', async () => {
    const port = await freePort();
    const listen = `127.0.0.1:${port}`;
    const { logger, warns } = capturingLogger();
    nodes = await buildRelayRing(2, `ws://${listen}`, 'ring-late', { reconnect: FAST, logger });

    // Nothing listens yet: start() resolves anyway, warning that it will retry.
    await Promise.all(nodes.map((n) => n.transport.start()));
    expect(reconnectDelays(warns).length).toBeGreaterThanOrEqual(1);

    server = new RelayServer({ listen });
    await server.start();
    await waitForRing(nodes);
    await broadcastArrives(nodes[0]!, nodes[1]!, 1);
  }, 40_000);

  it('start() still rejects a malformed relay URL (a config error, not an outage)', async () => {
    const transport = await solo('relay.example:7100', 0, 'ring-badurl');
    await expect(transport.start()).rejects.toThrow(SyntaxError);
  });

  it('backoff doubles to the cap and resets after a successful hello', async () => {
    const port = await freePort();
    const listen = `127.0.0.1:${port}`;
    const { logger, infos, warns } = capturingLogger();
    const transport = await solo(`ws://${listen}`, 0, 'ring-backoff', { logger });
    await transport.start();

    // Each failed attempt logs its next delay: initialMs · 2^attempt, capped at maxMs, plus up to 10 % jitter.
    await vi.waitFor(() => expect(reconnectDelays(warns).length).toBeGreaterThanOrEqual(6), {
      timeout: 20_000,
      interval: 20,
    });
    const bases = [50, 100, 200, 400, 400, 400];
    reconnectDelays(warns)
      .slice(0, bases.length)
      .forEach((delay, i) => {
        expect(delay).toBeGreaterThanOrEqual(bases[i]!);
        expect(delay).toBeLessThanOrEqual(bases[i]! * 1.1);
      });

    // The relay comes up; its ack to our hello resets the backoff.
    server = new RelayServer({ listen });
    await server.start();
    await vi.waitFor(() => expect(infos.map((l) => l.msg)).toContain(REGISTERED), { timeout: 10_000, interval: 20 });
    const before = reconnectDelays(warns).length;

    // The next drop starts again at initialMs.
    await server.stop();
    server = null;
    await vi.waitFor(() => expect(reconnectDelays(warns).length).toBeGreaterThan(before), {
      timeout: 10_000,
      interval: 20,
    });
    const next = reconnectDelays(warns)[before]!;
    expect(next).toBeGreaterThanOrEqual(50);
    expect(next).toBeLessThanOrEqual(55);
  }, 40_000);

  it('stop() cancels a pending reconnect', async () => {
    const port = await freePort();
    let dials = 0;
    class CountingWebSocket extends WebSocket {
      constructor(...args: unknown[]) {
        super(...(args as ConstructorParameters<typeof WebSocket>));
        dials += 1;
      }
    }
    const { logger, warns } = capturingLogger();
    const transport = await solo(`ws://127.0.0.1:${port}`, 0, 'ring-cancel', {
      wsCtor: CountingWebSocket,
      reconnect: { initialMs: 100, maxMs: 100 },
      logger,
    });
    await transport.start();
    expect(dials).toBe(1);
    const [delay] = reconnectDelays(warns);
    expect(delay).toBeDefined(); // the first attempt failed; the next one is scheduled

    await transport.stop();
    // Well past the scheduled delay: no further attempt.
    await new Promise((r) => setTimeout(r, 4 * delay!));
    expect(dials).toBe(1);
    expect((transport as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
  }, 20_000);

  it('stop() during a connection attempt aborts it, and start() resolves', async () => {
    const silent = await silentTcp(held);
    tcp = silent.server;
    const { logger, infos } = capturingLogger();
    const transport = await solo(silent.url, 0, 'ring-abort', { logger });

    const started = transport.start();
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 5_000, interval: 10 });
    await transport.stop();
    await expect(started).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 4 * FAST.maxMs));
    expect(held).toHaveLength(1);
    // A start that stop() cut short is not reported as started.
    expect(infos.map((l) => l.msg)).not.toContain('relay-transport: started');
  }, 20_000);

  it('a refused hello is a failed attempt: the client retries until its partyId slot frees', async () => {
    const port = await freePort();
    const listen = `127.0.0.1:${port}`;
    server = new RelayServer({ listen });
    await server.start();
    const holder = await solo(`ws://${listen}`, 0, 'ring-slot');
    await holder.start();

    const { logger, infos, warns } = capturingLogger();
    const late = await solo(`ws://${listen}`, 0, 'ring-slot', { logger });
    await late.start();
    await vi.waitFor(
      () => expect(warns.some((w) => /refused/.test(w.msg) && typeof w.extra?.delayMs === 'number')).toBe(true),
      { timeout: 10_000, interval: 20 },
    );
    expect(infos.map((l) => l.msg)).not.toContain(REGISTERED);

    await holder.stop();
    await vi.waitFor(() => expect(infos.map((l) => l.msg)).toContain(REGISTERED), { timeout: 10_000, interval: 20 });
  }, 20_000);

  it('pulls during an outage return null and succeed after the reconnect', async () => {
    const port = await freePort();
    const listen = `127.0.0.1:${port}`;
    server = new RelayServer({ listen });
    await server.start();
    nodes = await buildRelayRing(2, `ws://${listen}`, 'ring-outage', { reconnect: FAST });
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    const [a, b] = nodes;
    const key = { ceremonyId: 'c', round: 'r1', from: 1 };
    const blob = new Uint8Array([0xb1, 0x0b]);
    b!.transport.servePulls((_who, k) => (k.ceremonyId === 'c' && k.round === 'r1' ? blob : null));
    expect(await a!.transport.pull(key)).toEqual(blob);

    // A pull in flight when the relay drops resolves null at once, not at its timeout.
    relayInternals(a!.transport).pullTimeoutMs = 120_000;
    const bIncoming = b!.transport as unknown as { onIncoming: unknown };
    bIncoming.onIncoming = async () => {}; // node 1 does not answer this one
    const inFlight = a!.transport.pull(key);
    const pulls = (a!.transport as unknown as { pendingPulls: Map<string, unknown> }).pendingPulls;
    await vi.waitFor(() => expect(pulls.size).toBe(1), { timeout: 5_000, interval: 5 });
    await server.stop();
    server = null;
    expect(await settledWithin(inFlight, 10_000)).toBeNull();
    delete bIncoming.onIncoming; // node 1 answers again

    // During the outage a pull returns null; the puller retries until the relay is back.
    expect(await a!.transport.pull(key)).toBeNull();
    const store = new BlobStore();
    const pulling = new BlobPuller(a!.transport, store).pullAll([key], {
      maxAttempts: 1_000,
      initialDelayMs: 50,
      maxDelayMs: 200,
      deadlineMs: 30_000,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(store.has(key)).toBe(false);

    server = new RelayServer({ listen });
    await server.start();
    await pulling;
    expect(store.get(key)).toEqual(blob);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Liveness: connect / ack timeouts, client keepalive, server heartbeat
// (facts/transport.md relay-transport.ts and server.ts)
// ─────────────────────────────────────────────────────────────────────────

describe('RelayTransport / RelayServer — liveness', () => {
  let server: RelayServer | null = null;
  let fake: WebSocketServer | null = null;
  let tcp: net.Server | null = null;
  const held: net.Socket[] = [];
  let transports: RelayTransport[] = [];
  const raws: WebSocket[] = [];
  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
    transports = [];
    for (const r of raws.splice(0)) r.terminate();
    if (server) await server.stop();
    server = null;
    if (fake) {
      for (const c of fake.clients) c.terminate();
      await new Promise<void>((r) => fake!.close(() => r()));
    }
    fake = null;
    for (const s of held.splice(0)) s.destroy();
    if (tcp) await new Promise<void>((r) => tcp!.close(() => r()));
    tcp = null;
  });

  async function solo(url: string, ringId: string, extra: Partial<RelayTransportOptions>): Promise<RelayTransport> {
    const transport = await soloTransport(url, 0, ringId, extra);
    transports.push(transport);
    return transport;
  }

  /** A relay stand-in: it acks every hello with an empty roster (or never answers), and pongs (or not). */
  async function fakeRelay(opts: { ack: boolean; autoPong: boolean }): Promise<{ url: string; connections: () => number }> {
    let connections = 0;
    fake = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: opts.autoPong });
    fake.on('connection', (sock) => {
      connections += 1;
      sock.on('error', () => {});
      if (opts.ack) sock.once('message', () => sock.send(JSON.stringify({ kind: 'ack', roster: [] })));
    });
    await new Promise<void>((r) => fake!.once('listening', () => r()));
    const { port } = fake.address() as net.AddressInfo;
    return { url: `ws://127.0.0.1:${port}`, connections: () => connections };
  }

  type ServerMsg = { kind: string; partyId?: number; roster?: number[]; message?: string };
  async function rawClient(
    url: string,
    hello: { ringId: string; partyId: number },
    opts: { autoPong?: boolean } = {},
  ): Promise<{ ws: WebSocket; msgs: ServerMsg[]; closed: Promise<void> }> {
    const ws = new WebSocket(url, { autoPong: opts.autoPong ?? true });
    raws.push(ws);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
    ws.on('error', () => {});
    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    await new Promise<void>((r, j) => {
      ws.once('open', () => r());
      ws.once('error', j);
    });
    ws.send(JSON.stringify({ kind: 'hello', ...hello }));
    await vi.waitFor(() => expect(msgs.length).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 5 });
    return { ws, msgs, closed };
  }

  const warnsMatching = (warns: LogLine[], re: RegExp) => warns.filter((w) => re.test(w.msg));

  it.each([
    ['reconnect.initialMs 0', { reconnect: { initialMs: 0 } }],
    ['reconnect.initialMs NaN', { reconnect: { initialMs: Number.NaN } }],
    ['reconnect.maxMs Infinity', { reconnect: { maxMs: Number.POSITIVE_INFINITY } }],
    ['reconnect.maxMs below initialMs', { reconnect: { initialMs: 500, maxMs: 100 } }],
    ['liveness.pongMs 0', { liveness: { pongMs: 0 } }],
    ['liveness.pingIntervalMs -1', { liveness: { pingIntervalMs: -1 } }],
  ] as Array<[string, Partial<RelayTransportOptions>]>)('the constructor refuses %s', async (_label, bad) => {
    await expect(soloTransport('ws://127.0.0.1:1', 0, 'ring-bad', bad)).rejects.toThrow(/RelayTransport: /);
  });

  it('an upgrade that never completes is abandoned after connectMs and retried', async () => {
    const silent = await silentTcp(held);
    tcp = silent.server;
    const { logger, warns } = capturingLogger();
    const transport = await solo(silent.url, 'ring-noupgrade', { logger, liveness: { connectMs: 100 } });

    // start() returns once the first attempt times out.
    await transport.start();
    expect(warnsMatching(warns, /attempt failed/)[0]?.extra?.err).toMatch(/timed out/);
    await vi.waitFor(() => expect(held.length).toBeGreaterThanOrEqual(3), { timeout: 15_000, interval: 20 });
  }, 20_000);

  it('a relay that never acks the hello is dropped after ackMs and retried with growing backoff', async () => {
    const relay = await fakeRelay({ ack: false, autoPong: true });
    const { logger, warns } = capturingLogger();
    const transport = await solo(relay.url, 'ring-noack', { logger, liveness: { ackMs: 100 } });
    await transport.start();

    await vi.waitFor(() => expect(warnsMatching(warns, /did not acknowledge/).length).toBeGreaterThanOrEqual(3), {
      timeout: 15_000,
      interval: 20,
    });
    // A missing ack is a failed attempt: the backoff is not reset.
    const delays = reconnectDelays(warnsMatching(warns, /did not acknowledge/));
    [50, 100, 200].forEach((base, i) => {
      expect(delays[i]).toBeGreaterThanOrEqual(base);
      expect(delays[i]).toBeLessThanOrEqual(base * 1.1);
    });
    expect(relay.connections()).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('a relay that stops answering pings is dropped after pongMs and redialled', async () => {
    const relay = await fakeRelay({ ack: true, autoPong: false });
    const { logger, infos, warns } = capturingLogger();
    const transport = await solo(relay.url, 'ring-nopong', { logger, liveness: { pingIntervalMs: 50, pongMs: 100 } });
    await transport.start();
    await vi.waitFor(() => expect(infos.map((l) => l.msg)).toContain(REGISTERED), { timeout: 5_000, interval: 10 });

    await vi.waitFor(() => expect(warnsMatching(warns, /did not answer a ping/).length).toBeGreaterThanOrEqual(1), {
      timeout: 10_000,
      interval: 20,
    });
    await vi.waitFor(() => expect(relay.connections()).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 20 });
  }, 20_000);

  it('keepalive pings leave a live relay connection up', async () => {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();
    const { logger, infos, warns } = capturingLogger();
    const transport = await solo(`ws://127.0.0.1:${port}`, 'ring-alive', {
      logger,
      liveness: { pingIntervalMs: 20, pongMs: 300 },
    });
    await transport.start();
    await vi.waitFor(() => expect(infos.map((l) => l.msg)).toContain(REGISTERED), { timeout: 5_000, interval: 10 });

    // Five pong deadlines' worth of pings: each pong clears its deadline, so nothing drops.
    await new Promise((r) => setTimeout(r, 5 * 300));
    expect(reconnectDelays(warns)).toEqual([]);
    expect(infos.filter((l) => l.msg === REGISTERED)).toHaveLength(1);
  }, 20_000);

  it('the relay server evicts a client that stops answering pings: peers see peer-left and the slot frees', async () => {
    const port = await freePort();
    const url = `ws://127.0.0.1:${port}`;
    server = new RelayServer({ listen: `127.0.0.1:${port}`, heartbeatMs: 200 });
    await server.start();

    const mute = await rawClient(url, { ringId: 'ring-hb', partyId: 0 }, { autoPong: false });
    expect(mute.msgs[0]).toEqual({ kind: 'ack', roster: [] });
    const live = await rawClient(url, { ringId: 'ring-hb', partyId: 1 });
    expect(live.msgs[0]).toEqual({ kind: 'ack', roster: [0] });

    await vi.waitFor(() => expect(live.msgs).toContainEqual({ kind: 'peer-left', partyId: 0 }), {
      timeout: 10_000,
      interval: 20,
    });
    await mute.closed;
    const again = await rawClient(url, { ringId: 'ring-hb', partyId: 0 });
    expect(again.msgs[0]).toEqual({ kind: 'ack', roster: [1] });

    // A client that answers its pings stays through several heartbeats.
    await new Promise((r) => setTimeout(r, 5 * 200));
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Re-handshake recovery (facts/transport.md, relay-transport.ts; spec §3.7)
// ─────────────────────────────────────────────────────────────────────────

type HandshakeInternals = {
  ws: unknown;
  peerStates: Map<
    PartyId,
    {
      status: string;
      session: unknown;
      handshakeAttempt: number;
      handshakeStartedAt: number;
      lastRestartAt: number;
      deferredRestart: NodeJS.Timeout | null;
    }
  >;
  onIncoming(from: PartyId, payload: Uint8Array): Promise<void>;
  onPeerLeft(partyId: PartyId): void;
  requestRehandshake(peer: unknown): void;
  startInitiatorHandshake(peer: unknown, opts?: { restart?: boolean }): Promise<void>;
  completeResponderHandshake(peer: unknown, message1: Uint8Array): Promise<void>;
  dropSocket(ws: unknown, reason: string, details: Record<string, unknown>): void;
};
const hsInternals = (t: RelayTransport) => t as unknown as HandshakeInternals;

const DEFERRED = 'relay-transport: re-handshake request deferred (rate limit)';
const EMPTY_FRAME = new Uint8Array(0);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('RelayTransport — re-handshake recovery', () => {
  let server: RelayServer | null = null;
  let nodes: RelayTestNode[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
    if (server) await server.stop();
    server = null;
  });

  /** A connected two-node ring: node 0 initiates, node 1 responds. */
  async function pair(ringId: string, opts: Pick<RelayTransportOptions, 'logger'> = {}): Promise<[RelayTestNode, RelayTestNode]> {
    const port = await freePort();
    server = new RelayServer({ listen: `127.0.0.1:${port}` });
    await server.start();
    nodes = await buildRelayRing(2, `ws://127.0.0.1:${port}`, ringId, opts);
    await Promise.all(nodes.map((x) => x.transport.start()));
    await waitForRing(nodes);
    return [nodes[0]!, nodes[1]!];
  }

  /** Make `node` drop the next `count` frames it receives (a lost hs1), then behave normally. */
  function dropIncoming(node: RelayTestNode, count: number): { dropped: () => number } {
    const t = node.transport as unknown as { onIncoming: (from: PartyId, payload: Uint8Array) => Promise<void> };
    const original = t.onIncoming.bind(node.transport);
    let dropped = 0;
    t.onIncoming = async (from, payload) => {
      if (dropped < count) {
        dropped += 1;
        return;
      }
      await original(from, payload);
    };
    return { dropped: () => dropped };
  }

  it('a failed responder handshake asks the initiator to restart, and the pair recovers', async () => {
    const { logger, warns } = capturingLogger();
    const [a, b] = await pair('ring-rehs-failed', { logger });
    const heard: number[] = [];
    a.transport.onBroadcast((_from, msg) => heard.push(msg[0]!));

    // Shaped like an hs1 (65 bytes, 0x04 prefix) but not a point on the curve: the responder's handshake throws.
    const bogusHs1 = new Uint8Array(65).fill(1);
    bogusHs1[0] = 0x04;
    await hsInternals(b.transport).onIncoming(0, bogusHs1);
    expect(warns.map((w) => w.msg)).toContain('relay-transport: responder handshake failed');

    // The initiator sends nothing from here on: only the responder's request can bring the pair back
    // (it may wait out the initiator's rate-limit window, under a second).
    await vi.waitFor(
      async () => {
        await b.transport.broadcast(new Uint8Array([42]));
        expect(heard).toContain(42);
      },
      { timeout: 10_000, interval: 50 },
    );
  }, 30_000);

  it('a re-handshake request in waiting-for-hs2 restarts the handshake', async () => {
    const [a, b] = await pair('ring-rehs-hs2');
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    const responder = hsInternals(b.transport).peerStates.get(0)!;

    // The responder loses the initiator's next hs1: the initiator waits for an hs2 that cannot come.
    const lost = dropIncoming(b, 1);
    void hsInternals(a.transport).startInitiatorHandshake(initiator, { restart: true });
    await vi.waitFor(() => expect(lost.dropped()).toBe(1), { timeout: 10_000, interval: 10 });
    expect(initiator.status).toBe('waiting-for-hs2');
    const attempt = initiator.handshakeAttempt;

    // The initiator's last restart is over a second old, and the responder asks again: the handshake is
    // restarted at once, though it is only moments old (waiting for the hs2 cannot succeed).
    initiator.lastRestartAt -= 5_000;
    hsInternals(b.transport).requestRehandshake(responder);
    await vi.waitFor(
      () => {
        expect(initiator.status).toBe('connected');
        expect(responder.status).toBe('connected');
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(initiator.handshakeAttempt).toBe(attempt + 1);

    const heard: number[] = [];
    b.transport.onBroadcast((_from, msg) => heard.push(msg[0]!));
    await a.transport.broadcast(new Uint8Array([7]));
    await vi.waitFor(() => expect(heard).toContain(7), { timeout: 10_000, interval: 20 });
  }, 30_000);

  it('restarts are limited to one per peer per second', async () => {
    const { logger, debugs } = capturingLogger();
    const [a] = await pair('ring-rehs-rate', { logger });
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    const request = () => hsInternals(a.transport).onIncoming(1, EMPTY_FRAME);
    const base = initiator.handshakeAttempt;

    // Only the clock is faked: the handshakes and the deferred timer still run for real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(1_100); // the window opened by the initial handshake is over
    await request();
    expect(initiator.handshakeAttempt).toBe(base + 1);
    // Let the restart finish, so the limit (not a handshake under way) is what holds the next request off.
    for (let i = 0; i < 500 && initiator.status !== 'connected'; i++) await sleep(20);
    expect(initiator.status).toBe('connected');

    // A second request 100 ms later does not restart now: it is deferred to the end of the window ...
    vi.advanceTimersByTime(100);
    await request();
    expect(initiator.handshakeAttempt).toBe(base + 1);
    expect(debugs.filter((d) => d.msg === DEFERRED)).toHaveLength(1);
    expect(debugs.find((d) => d.msg === DEFERRED)!.extra?.delayMs).toBe(900);

    // ... where it restarts once.
    await vi.waitFor(() => expect(initiator.handshakeAttempt).toBe(base + 2), { timeout: 10_000, interval: 20 });
    expect(initiator.deferredRestart).toBeNull();
  }, 30_000);

  it('requests inside the window merge into one deferred restart', async () => {
    const { logger, debugs } = capturingLogger();
    const [a] = await pair('ring-rehs-merge', { logger });
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    const request = () => hsInternals(a.transport).onIncoming(1, EMPTY_FRAME);
    const base = initiator.handshakeAttempt;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(1_100);
    await request();
    for (let i = 0; i < 500 && initiator.status !== 'connected'; i++) await sleep(20);
    expect(initiator.handshakeAttempt).toBe(base + 1);

    await request();
    const timer = initiator.deferredRestart;
    expect(timer).toBeTruthy();
    for (const ms of [100, 100, 100]) {
      vi.advanceTimersByTime(ms);
      await request();
      expect(initiator.deferredRestart).toBe(timer); // merged: still the first timer
    }
    expect(debugs.filter((d) => d.msg === DEFERRED)).toHaveLength(4);
    expect(initiator.handshakeAttempt).toBe(base + 1);

    // Exactly one restart at the end of the window, and none after it.
    await vi.waitFor(() => expect(initiator.handshakeAttempt).toBe(base + 2), { timeout: 10_000, interval: 20 });
    for (let i = 0; i < 500 && initiator.status !== 'connected'; i++) await sleep(20);
    await sleep(500);
    expect(initiator.handshakeAttempt).toBe(base + 2);
    expect(initiator.status).toBe('connected');
  }, 30_000);

  it('a request inside the window while connected is deferred, and the pair recovers with no initiator traffic', async () => {
    const { logger, debugs } = capturingLogger();
    const [a, b] = await pair('ring-rehs-defer-connected', { logger });
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    const heard: number[] = [];
    a.transport.onBroadcast((_from, msg) => heard.push(msg[0]!));
    const session = initiator.session;
    const attempt = initiator.handshakeAttempt;

    // The initiator restarted a moment ago, so the window is open when the responder's request arrives.
    initiator.lastRestartAt = Date.now();
    const bogusHs1 = new Uint8Array(65).fill(1);
    bogusHs1[0] = 0x04;
    await hsInternals(b.transport).onIncoming(0, bogusHs1); // the responder's handshake fails: it asks for a restart
    await vi.waitFor(() => expect(debugs.map((d) => d.msg)).toContain(DEFERRED), { timeout: 10_000, interval: 10 });

    // The initiator sends nothing: the deferred restart alone brings the pair back (within ~2 s).
    await vi.waitFor(
      async () => {
        await b.transport.broadcast(new Uint8Array([42]));
        expect(heard).toContain(42);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(initiator.session).not.toBe(session);
    expect(initiator.handshakeAttempt).toBe(attempt + 1);
  }, 30_000);

  it('a request inside the window while waiting for hs2 is deferred, and the pair recovers', async () => {
    const { logger, debugs } = capturingLogger();
    const [a, b] = await pair('ring-rehs-defer-hs2', { logger });
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    const responder = hsInternals(b.transport).peerStates.get(0)!;

    // The responder loses the initiator's hs1; the restart that sent it opened the window.
    const lost = dropIncoming(b, 1);
    void hsInternals(a.transport).startInitiatorHandshake(initiator, { restart: true });
    await vi.waitFor(() => expect(lost.dropped()).toBe(1), { timeout: 10_000, interval: 10 });
    expect(initiator.status).toBe('waiting-for-hs2');
    const attempt = initiator.handshakeAttempt;

    hsInternals(b.transport).requestRehandshake(responder);
    await vi.waitFor(() => expect(debugs.map((d) => d.msg)).toContain(DEFERRED), { timeout: 10_000, interval: 10 });
    await vi.waitFor(
      () => {
        expect(initiator.status).toBe('connected');
        expect(responder.status).toBe('connected');
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(initiator.handshakeAttempt).toBe(attempt + 1);

    const fromB: number[] = [];
    a.transport.onBroadcast((_from, msg) => fromB.push(msg[0]!));
    await vi.waitFor(
      async () => {
        await b.transport.broadcast(new Uint8Array([9]));
        expect(fromB).toContain(9);
      },
      { timeout: 10_000, interval: 50 },
    );
  }, 30_000);

  it('a request that crosses an initiator restart in flight is absorbed: one handshake, no record lost', async () => {
    const [a, b] = await pair('ring-rehs-cross');
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    const attempt = initiator.handshakeAttempt;
    const atB: number[] = [];
    const atA: number[] = [];
    b.transport.onBroadcast((_from, msg) => atB.push(msg[0]!));
    a.transport.onBroadcast((_from, msg) => atA.push(msg[0]!));

    // The initiator restarts for its own reasons, while a request the responder sent for the old session arrives.
    void hsInternals(a.transport).startInitiatorHandshake(initiator, { restart: true });
    await hsInternals(a.transport).onIncoming(1, EMPTY_FRAME);
    await vi.waitFor(() => expect(initiator.status).toBe('connected'), { timeout: 10_000, interval: 10 });

    // Traffic in both directions through the end of the window (about a second): nothing may be lost.
    const sent = Array.from({ length: 16 }, (_, i) => i);
    for (const i of sent) {
      await a.transport.broadcast(new Uint8Array([i]));
      await b.transport.broadcast(new Uint8Array([i]));
      await sleep(100);
    }
    await vi.waitFor(
      () => {
        expect(atB).toEqual(sent);
        expect(atA).toEqual(sent);
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(initiator.handshakeAttempt).toBe(attempt + 1);
  }, 30_000);

  it('stop() clears a pending deferred restart', async () => {
    const [a] = await pair('ring-rehs-stop');
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    initiator.lastRestartAt = Date.now();
    await hsInternals(a.transport).onIncoming(1, EMPTY_FRAME);
    const timer = initiator.deferredRestart;
    expect(timer).toBeTruthy();

    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await a.transport.stop();
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      clear.mockRestore();
    }
    expect(initiator.deferredRestart).toBeNull();
  }, 30_000);

  it.each([
    ['a relay drop', (t: HandshakeInternals) => t.dropSocket(t.ws, 'test drop', {})],
    ['peer-left', (t: HandshakeInternals) => t.onPeerLeft(1)],
  ])('%s clears a pending deferred restart', async (_name, trigger) => {
    const [a] = await pair(`ring-rehs-clear-${_name.replace(/\W/g, '')}`);
    const initiator = hsInternals(a.transport).peerStates.get(1)!;
    initiator.lastRestartAt = Date.now();
    await hsInternals(a.transport).onIncoming(1, EMPTY_FRAME);
    const timer = initiator.deferredRestart;
    expect(timer).toBeTruthy();

    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      trigger(hsInternals(a.transport));
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      clear.mockRestore();
    }
    expect(initiator.deferredRestart).toBeNull();
  }, 30_000);

  it('a stray record while waiting for hs2 triggers the stale check, not a silent drop', async () => {
    const [a, b] = await pair('ring-rehs-stray');
    const initiator = hsInternals(a.transport).peerStates.get(1)!;

    // The responder never answers: the initiator's handshake stays in waiting-for-hs2.
    const lost = dropIncoming(b, 100);
    void hsInternals(a.transport).startInitiatorHandshake(initiator, { restart: true });
    await vi.waitFor(() => expect(lost.dropped()).toBe(1), { timeout: 10_000, interval: 10 });
    expect(initiator.status).toBe('waiting-for-hs2');
    const attempt = initiator.handshakeAttempt;
    const stray = new Uint8Array(40).fill(7); // not hs2-shaped: a record sealed under the old session

    // A handshake that is only moments old is left alone ...
    await hsInternals(a.transport).onIncoming(1, stray);
    expect(initiator.handshakeAttempt).toBe(attempt);

    // ... a stale one is restarted.
    initiator.handshakeStartedAt -= 11_000;
    await hsInternals(a.transport).onIncoming(1, stray);
    expect(initiator.handshakeAttempt).toBe(attempt + 1);
    await vi.waitFor(() => expect(lost.dropped()).toBe(2), { timeout: 10_000, interval: 10 });
  }, 30_000);

  it('a responder handshake in flight when the relay drops ends quietly, with the peer disconnected', async () => {
    const { logger, warns } = capturingLogger();
    const [a, b] = await pair('ring-rehs-drop', { logger });
    const responder = hsInternals(b.transport).peerStates.get(0)!;
    const { message1 } = await initiatorBegin(a.identity);

    // The relay socket drops while the responder is still computing its answer.
    const inFlight = hsInternals(b.transport).completeResponderHandshake(responder, message1);
    hsInternals(b.transport).dropSocket(hsInternals(b.transport).ws, 'test drop', {});
    await inFlight;

    expect(responder.status).toBe('disconnected');
    expect(responder.session).toBeNull();
    expect(warns.map((w) => w.msg)).not.toContain('relay-transport: re-handshake request send failed');
  }, 30_000);

  it('a responder handshake whose relay socket is already gone does nothing', async () => {
    const { logger, warns } = capturingLogger();
    const [a, b] = await pair('ring-rehs-gone', { logger });
    const responder = hsInternals(b.transport).peerStates.get(0)!;
    const { message1 } = await initiatorBegin(a.identity);

    hsInternals(b.transport).dropSocket(hsInternals(b.transport).ws, 'test drop', {});
    await hsInternals(b.transport).completeResponderHandshake(responder, message1);

    expect(responder.status).toBe('disconnected');
    expect(responder.session).toBeNull();
    expect(warns.map((w) => w.msg)).not.toContain('relay-transport: re-handshake request send failed');
  }, 30_000);
});
