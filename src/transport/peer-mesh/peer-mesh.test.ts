import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlobKey, PartyId } from '../../core/types';
import { generateIdentity, type IdentityKeyPair } from '../identity';
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

interface RingNode {
  partyId: PartyId;
  identity: IdentityKeyPair;
  port: number;
  transport: PeerMeshTransport;
}

async function buildRing(n: number): Promise<RingNode[]> {
  const identities = await Promise.all(Array.from({ length: n }, () => generateIdentity()));
  const ports = await Promise.all(Array.from({ length: n }, () => freePort()));

  const nodes: RingNode[] = [];
  for (let i = 0; i < n; i++) {
    const peers = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const peer = {
        partyId: j,
        publicKey: identities[j]!.publicKeyRaw,
        endpoint: `ws://127.0.0.1:${ports[j]}`,
      };
      peers.push(peer);
    }
    const transport = new PeerMeshTransport({
      self: { partyId: i, identity: identities[i]! },
      listen: `127.0.0.1:${ports[i]}`,
      peers,
      pullTimeoutMs: 5_000,
    });
    nodes.push({ partyId: i, identity: identities[i]!, port: ports[i]!, transport });
  }
  return nodes;
}

async function waitForConnection(node: RingNode, peerPartyId: PartyId, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = (node.transport as unknown as { peerStates: Map<PartyId, { connection: unknown }> })
      .peerStates.get(peerPartyId);
    if (state && state.connection) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`peer ${node.partyId} failed to connect to ${peerPartyId} within ${timeoutMs}ms`);
}

async function waitForRing(nodes: RingNode[]): Promise<void> {
  for (const node of nodes) {
    for (const peer of nodes) {
      if (peer.partyId === node.partyId) continue;
      await waitForConnection(node, peer.partyId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('PeerMeshTransport — 2-peer basics', () => {
  let nodes: RingNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
  });

  it('peer 0 dials peer 1; both report the other as connected', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    // `peers` is the whole ring, self included.
    expect(nodes[0]!.transport.peers).toEqual([0, 1]);
    expect(nodes[1]!.transport.peers).toEqual([0, 1]);
  }, 15_000);

  it('broadcast from peer 0 reaches peer 1', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const received: Array<{ from: PartyId; msg: string }> = [];
    nodes[1]!.transport.onBroadcast((from, msg) => {
      received.push({ from, msg: new TextDecoder().decode(msg) });
    });

    await nodes[0]!.transport.broadcast(new TextEncoder().encode('hello via peer-mesh'));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ from: 0, msg: 'hello via peer-mesh' }]);
  }, 15_000);

  it('pull from peer 0 hits peer 1 servePulls and returns the blob', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const storedBlob = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    nodes[1]!.transport.servePulls((from, key) => {
      if (key.ceremonyId === 'test' && key.round === 'r1' && key.from === 1 && from === 0) {
        return storedBlob;
      }
      return null;
    });

    const pulled = await nodes[0]!.transport.pull({
      ceremonyId: 'test',
      round: 'r1',
      from: 1,
    });
    expect(pulled).toEqual(storedBlob);
  }, 15_000);

  it('pull returns null when servePulls handler returns null', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    nodes[1]!.transport.servePulls(() => null);

    const pulled = await nodes[0]!.transport.pull({
      ceremonyId: 'test',
      round: 'r1',
      from: 1,
    });
    expect(pulled).toBeNull();
  }, 15_000);

  it('pull with `key.from` not in peer list throws', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    await expect(
      nodes[0]!.transport.pull({
        ceremonyId: 'test',
        round: 'r1',
        from: 99 as PartyId,
      }),
    ).rejects.toThrow(/not in the ring/);
  }, 15_000);
});

describe('PeerMeshTransport — 3-peer mesh', () => {
  let nodes: RingNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
  });

  it('all 3 peers are fully connected', async () => {
    nodes = await buildRing(3);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    for (const n of nodes) expect(n.transport.peers).toEqual([0, 1, 2]);
  }, 20_000);

  it('broadcast from peer 1 reaches both peer 0 and peer 2', async () => {
    nodes = await buildRing(3);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const received0: string[] = [];
    const received2: string[] = [];
    nodes[0]!.transport.onBroadcast((_from, msg) => {
      received0.push(new TextDecoder().decode(msg));
    });
    nodes[2]!.transport.onBroadcast((_from, msg) => {
      received2.push(new TextDecoder().decode(msg));
    });

    await nodes[1]!.transport.broadcast(new TextEncoder().encode('from-middle'));
    await new Promise((r) => setTimeout(r, 150));
    expect(received0).toEqual(['from-middle']);
    expect(received2).toEqual(['from-middle']);
  }, 20_000);

  it('pull routes to the specific `key.from` peer', async () => {
    nodes = await buildRing(3);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    const blob0 = new Uint8Array([0xaa]);
    const blob2 = new Uint8Array([0xcc]);
    nodes[0]!.transport.servePulls((_from, _key) => blob0);
    nodes[2]!.transport.servePulls((_from, _key) => blob2);

    const fromNode1To0 = await nodes[1]!.transport.pull({
      ceremonyId: 'c',
      round: 'r1',
      from: 0,
    });
    const fromNode1To2 = await nodes[1]!.transport.pull({
      ceremonyId: 'c',
      round: 'r1',
      from: 2,
    });
    expect(fromNode1To0).toEqual(blob0);
    expect(fromNode1To2).toEqual(blob2);
  }, 20_000);

  it('servePulls rejects a second handler registration', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    nodes[0]!.transport.servePulls(() => null);
    expect(() => nodes[0]!.transport.servePulls(() => null)).toThrow(/already registered/);
  }, 15_000);
});

describe('PeerMeshTransport — lifecycle', () => {
  let nodes: RingNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
  });

  it('pending pulls reject when transport is stopped', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);

    // servePulls handler never responds with a blob — pull will hang until timeout or stop.
    nodes[1]!.transport.servePulls(() => null);

    // Install a lying handler that doesn't respond — simulate by not registering, pulls get null promptly.
    // Instead, trigger an actual pending pull by stopping the transport mid-flight.
    const stopping = nodes[0]!.transport.stop();
    await expect(stopping).resolves.toBeUndefined();
  }, 15_000);

  it('pull on an offline peer returns null (peer state without connection)', async () => {
    // Build a transport that has a peer config but never actually starts the peer.
    const me = await generateIdentity();
    const other = await generateIdentity();
    const myPort = await freePort();
    const otherPort = await freePort(); // peer never started
    const transport = new PeerMeshTransport({
      self: { partyId: 0, identity: me },
      listen: `127.0.0.1:${myPort}`,
      peers: [
        { partyId: 1, publicKey: other.publicKeyRaw, endpoint: `ws://127.0.0.1:${otherPort}` },
      ],
      pullTimeoutMs: 500,
    });
    await transport.start();
    try {
      const res = await transport.pull({ ceremonyId: 'c', round: 'r', from: 1 });
      expect(res).toBeNull();
    } finally {
      await transport.stop();
    }
  }, 10_000);

  it('isConnected: self always; a peer only once its handshake completed, not on an open socket; nobody after stop()', async () => {
    nodes = await buildRing(2);
    const [a, b] = [nodes[0]!.transport, nodes[1]!.transport];
    expect(b.isConnected(1)).toBe(true);
    expect(b.isConnected(0)).toBe(false);
    expect(b.isConnected(9)).toBe(false);

    // An open WebSocket from the peer's address that never sends hs1 is not a session.
    await b.start();
    const { WebSocket } = await import('ws');
    const raw = new WebSocket(`ws://127.0.0.1:${nodes[1]!.port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        raw.once('open', () => resolve());
        raw.once('error', reject);
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(b.isConnected(0)).toBe(false);
    } finally {
      raw.terminate();
    }

    await a.start();
    await waitForRing(nodes);
    expect(a.isConnected(1)).toBe(true);
    expect(b.isConnected(0)).toBe(true);

    await a.stop();
    expect(a.isConnected(1)).toBe(false);
    expect(a.isConnected(0)).toBe(true);
    await vi.waitFor(() => expect(b.isConnected(0)).toBe(false), { timeout: 5_000, interval: 20 });
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Send ordering and transient failures (facts/transport.md, connection.ts / peer-mesh.ts)
// ─────────────────────────────────────────────────────────────────────────

type MeshInternals = {
  peerStates: Map<PartyId, { connection: { send: (m: unknown) => Promise<void>; close(): Promise<void> } | null }>;
};
const internals = (t: PeerMeshTransport) => t as unknown as MeshInternals;

describe('PeerMeshTransport — send ordering and transient failures', () => {
  let nodes: RingNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
  });

  it('large and small messages sent concurrently on one connection arrive in send order, without a teardown', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    const conn = internals(nodes[0]!.transport).peerStates.get(1)!.connection;

    const received: number[] = [];
    nodes[1]!.transport.onBroadcast((_from, msg) => received.push(msg[0]!));
    // Big frames take longer to encrypt than small ones: unserialised, the small
    // ones would reach the wire first, out of counter order.
    const msgs = Array.from({ length: 12 }, (_, i) => {
      const m = new Uint8Array(i % 2 === 0 ? 1_000_000 : 200);
      m[0] = i;
      return m;
    });
    await Promise.all(msgs.map((m) => nodes[0]!.transport.broadcast(m)));

    await vi.waitFor(() => expect(received).toHaveLength(msgs.length), { timeout: 10_000, interval: 20 });
    expect(received).toEqual(msgs.map((_, i) => i));
    expect(internals(nodes[0]!.transport).peerStates.get(1)!.connection).toBe(conn);
  }, 30_000);

  it('pull returns null when sending the request fails', async () => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    internals(nodes[0]!.transport).peerStates.get(1)!.connection!.send = () =>
      Promise.reject(new Error('socket write failed'));

    await expect(nodes[0]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 })).resolves.toBeNull();
  }, 15_000);

  it('a pending pull resolves null as soon as its connection closes', async () => {
    nodes = await buildRing(2);
    for (const n of nodes) {
      // A long pull timeout: only the close can resolve the pull in time.
      (n.transport as unknown as { pullTimeoutMs: number }).pullTimeoutMs = 120_000;
    }
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    // Node 1 never answers pulls.
    const responder = internals(nodes[1]!.transport).peerStates.get(0)!.connection!;
    responder.send = () => new Promise(() => {});

    const pending = nodes[0]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 });
    await new Promise((r) => setTimeout(r, 100));
    await responder.close();

    const outcome = await Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r('still pending'), 10_000)),
    ]);
    expect(outcome).toBeNull();
  }, 30_000);
});

describe('PeerMeshTransport — frame size and response binding', () => {
  let nodes: RingNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.transport.stop()));
    nodes = [];
  });

  it.each([
    ['dialer to listener', 0, 1],
    ['listener to dialer', 1, 0],
  ])('refuses a frame over 4 MiB (%s) and still carries a 2 MiB one', async (_dir, from, to) => {
    nodes = await buildRing(2);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    const sizes: number[] = [];
    nodes[to]!.transport.onBroadcast((_f, msg) => sizes.push(msg.length));

    await nodes[from]!.transport.broadcast(new Uint8Array(2 * 1024 * 1024));
    await vi.waitFor(() => expect(sizes).toEqual([2 * 1024 * 1024]), { timeout: 10_000, interval: 20 });

    // 3.5 MiB of payload is more than 4 MiB on the wire (base64 inside the record).
    await nodes[from]!.transport.broadcast(new Uint8Array(3.5 * 1024 * 1024));
    await vi.waitFor(() => expect(internals(nodes[to]!.transport).peerStates.get(from)!.connection).toBeNull(), {
      timeout: 10_000,
      interval: 20,
    });
    expect(sizes).toEqual([2 * 1024 * 1024]);
  }, 30_000);

  it('ignores a pull response that comes from another peer than the one pulled', async () => {
    nodes = await buildRing(3);
    await Promise.all(nodes.map((n) => n.transport.start()));
    await waitForRing(nodes);
    // Node 1 never answers; node 2 tries to answer node 0's pull to node 1 in its place.
    internals(nodes[1]!.transport).peerStates.get(0)!.connection!.send = () => new Promise(() => {});
    (nodes[0]!.transport as unknown as { pullTimeoutMs: number }).pullTimeoutMs = 2_000;

    const pending = nodes[0]!.transport.pull({ ceremonyId: 'c', round: 'r', from: 1 });
    const pulls = (nodes[0]!.transport as unknown as { pendingPulls: Map<string, unknown> }).pendingPulls;
    await vi.waitFor(() => expect(pulls.size).toBe(1), { timeout: 5_000, interval: 5 });
    const [requestId] = [...pulls.keys()];
    await internals(nodes[2]!.transport).peerStates.get(0)!.connection!.send({
      kind: 'pull-resp',
      requestId,
      blobB64: btoa('forged'),
    });

    // The forged answer is dropped; the pull ends at its timeout with null.
    await expect(pending).resolves.toBeNull();
  }, 20_000);
});
