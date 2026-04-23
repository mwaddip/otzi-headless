import type { BlobKey, Unsubscribe } from './types';
import { blobKeyToString } from './types';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * In-memory store for ceremony blobs, indexed by BlobKey.
 *
 * A blob is produced (locally or pulled from a peer) at most once per
 * (ceremonyId, round, from, to). Re-putting identical bytes is idempotent;
 * re-putting different bytes under the same key is a protocol violation and
 * throws — the caller (runner or puller) should treat this as cause for
 * ceremony abort.
 *
 * Retrieved Uint8Arrays are references; callers MUST treat them as immutable.
 */
export class BlobStore {
  private readonly entries = new Map<string, { key: BlobKey; blob: Uint8Array }>();
  private readonly observers = new Set<(key: BlobKey) => void>();

  put(key: BlobKey, blob: Uint8Array): void {
    const id = blobKeyToString(key);
    const existing = this.entries.get(id);
    if (existing) {
      if (bytesEqual(existing.blob, blob)) return;
      throw new Error(`Conflicting blob for ${id}`);
    }
    this.entries.set(id, { key, blob });
    for (const fn of this.observers) fn(key);
  }

  get(key: BlobKey): Uint8Array | undefined {
    return this.entries.get(blobKeyToString(key))?.blob;
  }

  has(key: BlobKey): boolean {
    return this.entries.has(blobKeyToString(key));
  }

  /** Enumerate stored blobs for a ceremony, optionally filtered to a round. */
  list(ceremonyId: string, round?: string): Array<{ key: BlobKey; blob: Uint8Array }> {
    const out: Array<{ key: BlobKey; blob: Uint8Array }> = [];
    for (const entry of this.entries.values()) {
      if (entry.key.ceremonyId !== ceremonyId) continue;
      if (round !== undefined && entry.key.round !== round) continue;
      out.push(entry);
    }
    return out;
  }

  /** Fires after each successful put (excluding idempotent no-ops). */
  onPut(handler: (key: BlobKey) => void): Unsubscribe {
    this.observers.add(handler);
    return () => { this.observers.delete(handler); };
  }

  /** Drop all blobs for a ceremony. Call on ceremony terminate (done / aborted / timed out). */
  clear(ceremonyId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.key.ceremonyId === ceremonyId) {
        this.entries.delete(id);
      }
    }
  }
}
