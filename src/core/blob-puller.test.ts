import { describe, it, expect } from 'vitest';
import { BlobPuller } from './blob-puller';
import { BlobStore } from './blob-store';
import type { Transport } from './transport';
import type { BlobKey } from './types';

function stubTransport(pullImpl?: (key: BlobKey) => Promise<Uint8Array | null>): {
  transport: Transport;
  calls: BlobKey[];
} {
  const calls: BlobKey[] = [];
  const transport: Transport = {
    partyId: 0,
    peers: [0, 1, 2, 3],
    broadcast: async () => {},
    onBroadcast: () => () => {},
    pull: async (key) => {
      calls.push(key);
      return pullImpl ? pullImpl(key) : null;
    },
    servePulls: () => () => {},
  };
  return { transport, calls };
}

const fastOpts = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, deadlineMs: 1000 };

describe('BlobPuller', () => {
  it('resolves immediately if all expected keys are already in the store', async () => {
    const store = new BlobStore();
    const { transport, calls } = stubTransport();
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };
    store.put(key, new Uint8Array([1]));

    await new BlobPuller(transport, store).pullAll([key], fastOpts);

    expect(calls).toHaveLength(0);
  });

  it('pulls a blob and stores it', async () => {
    const store = new BlobStore();
    const blob = new Uint8Array([42]);
    const { transport } = stubTransport(async () => blob);
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };

    await new BlobPuller(transport, store).pullAll([key], fastOpts);

    expect(store.get(key)).toEqual(blob);
  });

  it('retries on null returns until the blob becomes available', async () => {
    const store = new BlobStore();
    const blob = new Uint8Array([7]);
    let n = 0;
    const { transport, calls } = stubTransport(async () => (++n >= 3 ? blob : null));
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };

    await new BlobPuller(transport, store).pullAll([key], { ...fastOpts, maxAttempts: 5 });

    expect(store.get(key)).toEqual(blob);
    expect(calls).toHaveLength(3);
  });

  it('rejects after exhausting max attempts', async () => {
    const store = new BlobStore();
    const { transport, calls } = stubTransport();
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };

    await expect(
      new BlobPuller(transport, store).pullAll([key], fastOpts),
    ).rejects.toThrow(/after 3 attempts/);
    expect(calls).toHaveLength(3);
  });

  it('rejects when the wall-clock deadline fires', async () => {
    const store = new BlobStore();
    const { transport } = stubTransport(() => new Promise(() => {})); // never resolves
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };

    await expect(
      new BlobPuller(transport, store).pullAll([key], {
        maxAttempts: 100,
        initialDelayMs: 1,
        maxDelayMs: 10,
        deadlineMs: 20,
      }),
    ).rejects.toThrow(/Deadline exceeded/);
  });

  it('short-circuits when the blob lands via an external store.put', async () => {
    const store = new BlobStore();
    const blob = new Uint8Array([1]);
    const { transport, calls } = stubTransport(); // transport always returns null
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 1 };

    setTimeout(() => store.put(key, blob), 5);

    await new BlobPuller(transport, store).pullAll([key], {
      maxAttempts: 100,
      initialDelayMs: 20,
      maxDelayMs: 50,
      deadlineMs: 1000,
    });

    expect(store.get(key)).toEqual(blob);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('pulls multiple keys concurrently', async () => {
    const store = new BlobStore();
    const blobs: Record<number, Uint8Array> = {
      1: new Uint8Array([1]),
      2: new Uint8Array([2]),
      3: new Uint8Array([3]),
    };
    const { transport } = stubTransport(
      (key) => new Promise(resolve => setTimeout(() => resolve(blobs[key.from] ?? null), 20)),
    );
    const keys: BlobKey[] = [
      { ceremonyId: 'c', round: 'r1', from: 1 },
      { ceremonyId: 'c', round: 'r1', from: 2 },
      { ceremonyId: 'c', round: 'r1', from: 3 },
    ];

    const start = Date.now();
    await new BlobPuller(transport, store).pullAll(keys, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      deadlineMs: 5000,
    });
    const elapsed = Date.now() - start;

    // Serial would be ~60ms; concurrent ~20ms. Allow slack for scheduling.
    expect(elapsed).toBeLessThan(60);
    for (const k of keys) expect(store.has(k)).toBe(true);
  });

  it('propagates transport.pull errors', async () => {
    const store = new BlobStore();
    const { transport } = stubTransport(async () => { throw new Error('unknown peer 99'); });
    const key: BlobKey = { ceremonyId: 'c', round: 'r1', from: 99 };

    await expect(
      new BlobPuller(transport, store).pullAll([key], fastOpts),
    ).rejects.toThrow(/unknown peer 99/);
  });

  it('handles an empty expected list', async () => {
    const store = new BlobStore();
    const { transport, calls } = stubTransport();

    await new BlobPuller(transport, store).pullAll([], fastOpts);

    expect(calls).toHaveLength(0);
  });
});
