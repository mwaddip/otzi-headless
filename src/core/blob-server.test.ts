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
