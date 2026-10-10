import type { BlobPuller, PullOpts } from './blob-puller';
import type { BlobStore } from './blob-store';
import type { Transport } from './transport';

/**
 * The I/O bundle every ceremony runs on (facts/core.md, `ceremony-io.ts`).
 * `store` is the store this daemon's `BlobServer` serves; `puller` wraps the
 * same `transport` and `store`. Self is `transport.partyId`; the ring is
 * `transport.peers`.
 */
export interface CeremonyIo {
  transport: Transport;
  store: BlobStore;
  puller: BlobPuller;
  pullOpts: PullOpts;
}
