import type { Transport } from './transport';
import type { BlobStore } from './blob-store';
import type { Unsubscribe } from './types';

/**
 * Long-lived bridge from `Transport.servePulls` to a `BlobStore`.
 *
 * Serves a blob present in the store to an authorized requester: a blob with a
 * `to` is served only when the authenticated requester is that recipient; a
 * broadcast blob (no `to`) is served to any ring member. A refused pull returns
 * `null`, indistinguishable from "not produced yet".
 *
 * Intended to be constructed at daemon startup and closed at shutdown — its
 * lifetime is the daemon's, not a ceremony's. This decouples blob availability
 * from ceremony completion: a peer that finishes its own ceremony keeps serving
 * its stored blobs so lagging peers can still complete.
 */
export class BlobServer {
  private readonly off: Unsubscribe;

  constructor(transport: Transport, store: BlobStore) {
    this.off = transport.servePulls((from, key) => {
      // Addressed blobs are private to their recipient (facts/core.md).
      if (key.to !== undefined && from !== key.to) return null;
      return store.get(key) ?? null;
    });
  }

  close(): void {
    this.off();
  }
}
