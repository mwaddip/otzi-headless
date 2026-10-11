/**
 * Test helper (facts/core.md, `src/testing/ring.ts`): an in-memory ring of
 * nodes, each with its own BlobStore, BlobServer and BlobPuller. Never
 * imported by runtime code.
 */

import { BlobPuller, type PullOpts } from '../core/blob-puller';
import { BlobServer } from '../core/blob-server';
import { BlobStore } from '../core/blob-store';
import type { CeremonyIo } from '../core/ceremony-io';
import { createInMemoryRing } from '../core/in-memory-transport';
import type { PartyId } from '../core/types';

export interface RingNode {
  partyId: PartyId;
  io: CeremonyIo;
  server: BlobServer;
}

const DEFAULT_PULL_OPTS: PullOpts = { maxAttempts: 50, initialDelayMs: 5, maxDelayMs: 20, deadlineMs: 3000 };

export function makeRing(n: number, pullOpts?: Partial<PullOpts>): RingNode[] {
  const peers: PartyId[] = Array.from({ length: n }, (_, i) => i);
  const transports = createInMemoryRing(peers);
  const opts: PullOpts = { ...DEFAULT_PULL_OPTS, ...pullOpts };
  return peers.map(partyId => {
    const transport = transports.get(partyId)!;
    const store = new BlobStore();
    const server = new BlobServer(transport, store);
    const puller = new BlobPuller(transport, store);
    return { partyId, io: { transport, store, puller, pullOpts: { ...opts } }, server };
  });
}
