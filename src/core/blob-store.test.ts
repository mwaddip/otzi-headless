import { describe, it, expect } from 'vitest';
import { BlobStore } from './blob-store';
import type { BlobKey } from './types';

const K = (ceremonyId: string, round: string, from: number, to?: number): BlobKey =>
  to === undefined ? { ceremonyId, round, from } : { ceremonyId, round, from, to };

describe('BlobStore', () => {
  it('stores and retrieves a blob by key', () => {
    const store = new BlobStore();
    const key = K('c', 'r1', 1);
    const blob = new Uint8Array([1, 2, 3]);
    store.put(key, blob);
    expect(store.get(key)).toEqual(blob);
    expect(store.has(key)).toBe(true);
  });

  it('returns undefined for missing keys', () => {
    const store = new BlobStore();
    expect(store.get(K('c', 'r1', 1))).toBeUndefined();
    expect(store.has(K('c', 'r1', 1))).toBe(false);
  });

  it('idempotent put: same key + same bytes is a no-op', () => {
    const store = new BlobStore();
    const key = K('c', 'r1', 1);
    store.put(key, new Uint8Array([1, 2, 3]));
    expect(() => store.put(key, new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it('throws on conflicting bytes for the same key', () => {
    const store = new BlobStore();
    const key = K('c', 'r1', 1);
    store.put(key, new Uint8Array([1, 2, 3]));
    expect(() => store.put(key, new Uint8Array([1, 2, 4]))).toThrow(/Conflicting/);
  });

  it('distinguishes broadcast vs private-to-peer keys', () => {
    const store = new BlobStore();
    const broadcast = K('c', 'r1', 1);
    const privateTo0 = K('c', 'r1', 1, 0);
    store.put(broadcast, new Uint8Array([1]));
    store.put(privateTo0, new Uint8Array([2]));
    expect(store.get(broadcast)).toEqual(new Uint8Array([1]));
    expect(store.get(privateTo0)).toEqual(new Uint8Array([2]));
  });

  it('lists all blobs for a ceremony', () => {
    const store = new BlobStore();
    store.put(K('a', 'r1', 0), new Uint8Array([1]));
    store.put(K('a', 'r2', 0), new Uint8Array([2]));
    store.put(K('b', 'r1', 0), new Uint8Array([3]));
    const rounds = store.list('a').map(e => e.key.round).sort();
    expect(rounds).toEqual(['r1', 'r2']);
  });

  it('filters list by round', () => {
    const store = new BlobStore();
    store.put(K('a', 'r1', 0), new Uint8Array([1]));
    store.put(K('a', 'r1', 1), new Uint8Array([2]));
    store.put(K('a', 'r2', 0), new Uint8Array([3]));
    const froms = store.list('a', 'r1').map(e => e.key.from).sort();
    expect(froms).toEqual([0, 1]);
  });

  it('fires onPut after each successful put', () => {
    const store = new BlobStore();
    const seen: BlobKey[] = [];
    store.onPut(key => seen.push(key));
    store.put(K('c', 'r1', 0), new Uint8Array([1]));
    store.put(K('c', 'r1', 1), new Uint8Array([2]));
    expect(seen.map(k => k.from)).toEqual([0, 1]);
  });

  it('does not fire onPut for idempotent re-puts', () => {
    const store = new BlobStore();
    const seen: BlobKey[] = [];
    store.onPut(key => seen.push(key));
    const key = K('c', 'r1', 0);
    store.put(key, new Uint8Array([1]));
    store.put(key, new Uint8Array([1]));
    expect(seen).toHaveLength(1);
  });

  it('unsubscribes from onPut', () => {
    const store = new BlobStore();
    const seen: BlobKey[] = [];
    const off = store.onPut(key => seen.push(key));
    store.put(K('c', 'r1', 0), new Uint8Array([1]));
    off();
    store.put(K('c', 'r1', 1), new Uint8Array([2]));
    expect(seen).toHaveLength(1);
  });

  it('clear removes all blobs for one ceremony, leaves others', () => {
    const store = new BlobStore();
    store.put(K('a', 'r1', 0), new Uint8Array([1]));
    store.put(K('a', 'r2', 1), new Uint8Array([2]));
    store.put(K('b', 'r1', 0), new Uint8Array([3]));
    store.clear('a');
    expect(store.list('a')).toEqual([]);
    expect(store.list('b')).toHaveLength(1);
  });
});
