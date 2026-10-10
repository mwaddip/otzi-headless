import type { BlobStore } from './blob-store';

/**
 * How long a ceremony's blobs stay in the store after the ceremony ends on
 * this node (facts/core.md, `blob-retention.ts`): the default ceremony
 * deadlines, so a peer that is behind can still pull until then.
 */
export const BLOB_RETENTION_MS = { signing: 300_000, dkg: 900_000 } as const;

/**
 * Clears `ceremonyId` from `store` after `delayMs`. The timer is unref'd: it
 * never keeps the process alive.
 */
export function scheduleClear(store: BlobStore, ceremonyId: string, delayMs: number): void {
  const timer = setTimeout(() => store.clear(ceremonyId), delayMs);
  timer.unref();
}
