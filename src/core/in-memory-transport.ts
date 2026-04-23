import type { Transport } from './transport';
import type { BlobKey, PartyId, Unsubscribe } from './types';

/**
 * In-memory Transport for tests. Simulates a ring of N peers in a single
 * process, dispatching broadcasts and pull requests synchronously via shared
 * references. No wire, no encryption — test harness only.
 */
class InMemoryTransport implements Transport {
  readonly partyId: PartyId;
  readonly peers: readonly PartyId[];

  private readonly ring: Map<PartyId, InMemoryTransport>;
  private readonly broadcastHandlers = new Set<(from: PartyId, msg: Uint8Array) => void>();
  private pullHandler: ((from: PartyId, key: BlobKey) => Uint8Array | null) | null = null;

  constructor(partyId: PartyId, peers: readonly PartyId[], ring: Map<PartyId, InMemoryTransport>) {
    this.partyId = partyId;
    this.peers = peers;
    this.ring = ring;
  }

  async broadcast(msg: Uint8Array): Promise<void> {
    for (const [id, peer] of this.ring) {
      if (id === this.partyId) continue;
      peer.deliverBroadcast(this.partyId, msg);
    }
  }

  onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void): Unsubscribe {
    this.broadcastHandlers.add(handler);
    return () => { this.broadcastHandlers.delete(handler); };
  }

  async pull(key: BlobKey): Promise<Uint8Array | null> {
    const peer = this.ring.get(key.from);
    if (!peer) throw new Error(`Unknown peer ${key.from}`);
    return peer.servePull(this.partyId, key);
  }

  servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe {
    if (this.pullHandler) throw new Error('Pull handler already registered for this transport');
    this.pullHandler = handler;
    return () => { this.pullHandler = null; };
  }

  /** @internal — called by peer transports in the same ring. */
  deliverBroadcast(from: PartyId, msg: Uint8Array): void {
    for (const h of this.broadcastHandlers) h(from, msg);
  }

  /** @internal — called by peer transports in the same ring. */
  servePull(from: PartyId, key: BlobKey): Uint8Array | null {
    return this.pullHandler ? this.pullHandler(from, key) : null;
  }
}

/**
 * Create a ring of N in-memory transports that communicate with each other.
 * Returns a Map from partyId to transport. Intended for tests.
 */
export function createInMemoryRing(peers: readonly PartyId[]): Map<PartyId, Transport> {
  const ring = new Map<PartyId, InMemoryTransport>();
  for (const id of peers) {
    ring.set(id, new InMemoryTransport(id, peers, ring));
  }
  return ring as Map<PartyId, Transport>;
}
