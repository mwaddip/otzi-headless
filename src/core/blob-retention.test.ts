import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_RETENTION_MS, scheduleClear } from './blob-retention';
import { BlobStore } from './blob-store';
import type { BlobKey } from './types';

const mine: BlobKey = { ceremonyId: 'c1', round: 'dkg-r1', from: 0 };
const other: BlobKey = { ceremonyId: 'c2', round: 'dkg-r1', from: 0 };

describe('blob-retention', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retains signing blobs for 5 minutes and DKG blobs for 15 minutes', () => {
    expect(BLOB_RETENTION_MS).toEqual({ signing: 300_000, dkg: 900_000 });
  });

  it('clears the ceremony after the delay, and only that ceremony', () => {
    vi.useFakeTimers();
    const store = new BlobStore();
    store.put(mine, new Uint8Array([1]));
    store.put(other, new Uint8Array([2]));

    scheduleClear(store, 'c1', 1000);
    vi.advanceTimersByTime(999);
    expect(store.has(mine)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(store.has(mine)).toBe(false);
    expect(store.has(other)).toBe(true);
  });

  it('never keeps the process alive (the timer is unref\'d)', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    scheduleClear(new BlobStore(), 'c1', BLOB_RETENTION_MS.dkg);

    expect(spy).toHaveBeenCalledTimes(1);
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    clearTimeout(handle);
  });
});
