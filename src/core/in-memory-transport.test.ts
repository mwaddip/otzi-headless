import { describe, it, expect } from 'vitest';
import { createInMemoryRing, setInMemoryPartition } from './in-memory-transport';
import type { Transport } from './transport';
import type { BlobKey, PartyId } from './types';

function ring(n: number) {
  const peers = Array.from({ length: n }, (_, i) => i);
  return { peers, transports: createInMemoryRing(peers) };
}

describe('InMemoryTransport', () => {
  it('delivers a broadcast to every peer except the sender', async () => {
    const { transports } = ring(3);
    const received = new Map<PartyId, Array<{ from: PartyId; msg: string }>>();
    for (const [id, t] of transports) {
      received.set(id, []);
      t.onBroadcast((from, msg) => received.get(id)!.push({ from, msg: new TextDecoder().decode(msg) }));
    }

    await transports.get(0)!.broadcast(new TextEncoder().encode('hello'));

    expect(received.get(0)).toEqual([]);
    expect(received.get(1)).toEqual([{ from: 0, msg: 'hello' }]);
    expect(received.get(2)).toEqual([{ from: 0, msg: 'hello' }]);
  });

  it('serves pulls from the producer via its registered handler', async () => {
    const { transports } = ring(2);
    const blob = new Uint8Array([1, 2, 3]);
    transports.get(1)!.servePulls((_from, key) =>
      key.round === 'r1' && key.from === 1 ? blob : null,
    );

    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };
    const got = await transports.get(0)!.pull(key);
    expect(got).toEqual(blob);
  });

  it('returns null when the producer has not yet generated the blob', async () => {
    const { transports } = ring(2);
    transports.get(1)!.servePulls(() => null);

    const got = await transports.get(0)!.pull({ ceremonyId: 'c', round: 'r1', from: 1 });
    expect(got).toBeNull();
  });

  it('returns null when the producer has no handler registered', async () => {
    const { transports } = ring(2);
    const got = await transports.get(0)!.pull({ ceremonyId: 'c', round: 'r1', from: 1 });
    expect(got).toBeNull();
  });

  it('throws when pulling from a party not in the ring', async () => {
    const { transports } = ring(2);
    await expect(
      transports.get(0)!.pull({ ceremonyId: 'c', round: 'r1', from: 99 }),
    ).rejects.toThrow(/Unknown peer 99/);
  });

  it('rejects double-registration of a pull handler', () => {
    const { transports } = ring(2);
    const t = transports.get(0)!;
    t.servePulls(() => null);
    expect(() => t.servePulls(() => null)).toThrow(/already registered/);
  });

  it('stops delivering after unsubscribe', async () => {
    const { transports } = ring(2);
    const received: Array<{ from: PartyId; msg: Uint8Array }> = [];
    const off = transports.get(1)!.onBroadcast((from, msg) => received.push({ from, msg }));

    await transports.get(0)!.broadcast(new Uint8Array([1]));
    off();
    await transports.get(0)!.broadcast(new Uint8Array([2]));

    expect(received).toHaveLength(1);
    expect(received[0]!.msg).toEqual(new Uint8Array([1]));
  });

  it('passes the authenticated `from` partyId to pull handlers', async () => {
    const { transports } = ring(3);
    let seenFrom: PartyId | null = null;
    transports.get(2)!.servePulls((from) => {
      seenFrom = from;
      return new Uint8Array([42]);
    });

    await transports.get(0)!.pull({ ceremonyId: 'c', round: 'r1', from: 2 });
    expect(seenFrom).toBe(0);

    await transports.get(1)!.pull({ ceremonyId: 'c', round: 'r1', from: 2 });
    expect(seenFrom).toBe(1);
  });

  it('reports every ring member connected, self included, and a party outside the ring not', () => {
    const { transports } = ring(3);
    const t = transports.get(0)!;
    expect([0, 1, 2].map(p => t.isConnected(p))).toEqual([true, true, true]);
    expect(t.isConnected(99)).toBe(false);
  });

  it('a partition cuts one pair both ways: not connected, no broadcast, null pulls; healing restores it', async () => {
    const { transports } = ring(3);
    const received = new Map<PartyId, PartyId[]>([[0, []], [1, []], [2, []]]);
    for (const [id, t] of transports) t.onBroadcast(from => received.get(id)!.push(from));
    for (const [id, t] of transports) t.servePulls(() => new Uint8Array([id]));
    const t0 = transports.get(0)!;
    const t2 = transports.get(2)!;

    setInMemoryPartition(t0, 2, true);
    expect(t0.isConnected(2)).toBe(false);
    expect(t2.isConnected(0)).toBe(false);
    // Every other pair is untouched.
    expect(t0.isConnected(1)).toBe(true);
    expect(t2.isConnected(1)).toBe(true);
    expect(t0.isConnected(0)).toBe(true);

    await t0.broadcast(new Uint8Array([1]));
    await t2.broadcast(new Uint8Array([2]));
    expect(received.get(1)).toEqual([0, 2]);
    expect(received.get(2)).toEqual([]);
    expect(received.get(0)).toEqual([]);
    expect(await t0.pull({ ceremonyId: 'c', round: 'r', from: 2 })).toBeNull();
    expect(await t2.pull({ ceremonyId: 'c', round: 'r', from: 0 })).toBeNull();
    expect(await t0.pull({ ceremonyId: 'c', round: 'r', from: 1 })).toEqual(new Uint8Array([1]));

    setInMemoryPartition(t2, 0, false);
    expect(t0.isConnected(2)).toBe(true);
    expect(t2.isConnected(0)).toBe(true);
    await t0.broadcast(new Uint8Array([3]));
    expect(received.get(2)).toEqual([0]);
    expect(await t0.pull({ ceremonyId: 'c', round: 'r', from: 2 })).toEqual(new Uint8Array([2]));
  });

  it('the partition hook refuses self, a party outside the ring and a transport that is not in-memory', () => {
    const { transports } = ring(2);
    const t0 = transports.get(0)!;
    expect(() => setInMemoryPartition(t0, 0, true)).toThrow(/self/);
    expect(() => setInMemoryPartition(t0, 99, true)).toThrow(/not in the ring/);
    const other: Transport = {
      partyId: 0,
      peers: [0, 1],
      broadcast: async () => {},
      onBroadcast: () => () => {},
      pull: async () => null,
      servePulls: () => () => {},
      isConnected: () => true,
    };
    expect(() => setInMemoryPartition(other, 1, true)).toThrow(/in-memory/);
  });
});
