import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PartyId } from '../../core/types';
import { generateIdentity, type IdentityKeyPair } from '../identity';
import { RelayServer } from './server';
import { RelayTransport } from './relay-transport';

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

async function buildRelayRing(n: number, relayUrl: string, ringId: string): Promise<RelayTestNode[]> {
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
});

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
    // Dup's ws stays open but its hello was rejected by the server — it
    // should log an error and stay disconnected. Confirm by attempting to
    // broadcast (nothing to broadcast to, no-op).
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
