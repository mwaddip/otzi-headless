import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createInMemoryRing } from './in-memory-transport';
import { BlobStore } from './blob-store';
import { BlobServer } from './blob-server';
import type { Transport } from './transport';
import type { PartyId } from './types';

describe('BlobServer', () => {
  let ring: Map<PartyId, Transport>;
  let stores: BlobStore[];
  let servers: BlobServer[];

  beforeEach(() => {
    ring = createInMemoryRing([0, 1, 2]);
    stores = [0, 1, 2].map(() => new BlobStore());
    servers = [0, 1, 2].map(i => new BlobServer(ring.get(i)!, stores[i]));
  });

  afterEach(() => {
    for (const s of servers) s.close();
  });

  it('serves an addressed blob only to its recipient', async () => {
    const key = { ceremonyId: 'c1', round: 'dkg-r2', from: 0, to: 1 };
    stores[0].put(key, new Uint8Array([7]));
    expect(await ring.get(1)!.pull(key)).toEqual(new Uint8Array([7]));
    expect(await ring.get(2)!.pull(key)).toBeNull();
  });

  it('serves broadcast blobs to every ring member', async () => {
    const key = { ceremonyId: 'c1', round: 'dkg-r1', from: 0 };
    stores[0].put(key, new Uint8Array([9]));
    expect(await ring.get(1)!.pull(key)).toEqual(new Uint8Array([9]));
    expect(await ring.get(2)!.pull(key)).toEqual(new Uint8Array([9]));
  });
});

describe('BlobServer — own blobs only', () => {
  it('never serves a blob another party produced, even when it is in the store', async () => {
    const ring = createInMemoryRing([0, 1, 2]);
    const stores = [0, 1, 2].map(() => new BlobStore());
    const servers = [0, 1, 2].map(i => new BlobServer(ring.get(i)!, stores[i]!));
    try {
      // Node 0 holds node 2's round-1 blob (it pulled it) and its own.
      const theirs = { ceremonyId: 'c1', round: 'dkg-r1', from: 2 };
      const mine = { ceremonyId: 'c1', round: 'dkg-r1', from: 0 };
      stores[0]!.put(theirs, new Uint8Array([2]));
      stores[0]!.put(mine, new Uint8Array([0]));
      // A pull is addressed to the producer; asking node 0 for node 2's blob is a forged route.
      const ask = (key: typeof theirs) => (ring.get(1)! as unknown as { ring: Map<number, { servePull(from: number, k: unknown): unknown }> }).ring.get(0)!.servePull(1, key);
      expect(ask(theirs)).toBeNull();
      expect(ask(mine)).toEqual(new Uint8Array([0]));
    } finally {
      for (const s of servers) s.close();
    }
  });
});
