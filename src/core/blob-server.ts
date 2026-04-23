import type { Transport } from './transport';
import type { BlobStore } from './blob-store';
import type { Unsubscribe } from './types';

/**
 * Long-lived bridge from `Transport.servePulls` to a `BlobStore`.
 *
 * Serves any blob present in the store. Intended to be constructed at daemon
 * startup and closed at shutdown — its lifetime is the daemon's, not a
 * ceremony's. This decouples blob availability from ceremony completion: a
 * peer that finishes its own ceremony keeps serving its stored blobs so
 * lagging peers can still complete.
 */
export class BlobServer {
  private readonly off: Unsubscribe;

  constructor(transport: Transport, store: BlobStore) {
    this.off = transport.servePulls((_from, key) => store.get(key) ?? null);
  }

  close(): void {
    this.off();
  }
}
