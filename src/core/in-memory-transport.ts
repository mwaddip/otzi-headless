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
  /** Peers the test cut this node off from (`setInMemoryPartition`), both ways. */
  private readonly partitioned = new Set<PartyId>();

  constructor(partyId: PartyId, peers: readonly PartyId[], ring: Map<PartyId, InMemoryTransport>) {
    this.partyId = partyId;
    this.peers = peers;
    this.ring = ring;
  }

  async broadcast(msg: Uint8Array): Promise<void> {
    for (const [id, peer] of this.ring) {
      if (id === this.partyId || this.partitioned.has(id)) continue;
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
    if (this.partitioned.has(key.from)) return null;
    return peer.servePull(this.partyId, key);
  }

  servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe {
    if (this.pullHandler) throw new Error('Pull handler already registered for this transport');
    this.pullHandler = handler;
    return () => { this.pullHandler = null; };
  }

  isConnected(partyId: PartyId): boolean {
    if (partyId === this.partyId) return true;
    return this.ring.has(partyId) && !this.partitioned.has(partyId);
  }

  /** @internal — called by peer transports in the same ring. */
  deliverBroadcast(from: PartyId, msg: Uint8Array): void {
    for (const h of this.broadcastHandlers) h(from, msg);
  }

  /** @internal — called by peer transports in the same ring. */
  servePull(from: PartyId, key: BlobKey): Uint8Array | null {
    return this.pullHandler ? this.pullHandler(from, key) : null;
  }

  /** @internal — `setInMemoryPartition`. */
  setPartition(peer: PartyId, partitioned: boolean): void {
    if (peer === this.partyId) throw new Error(`setInMemoryPartition: party ${peer} is self`);
    const other = this.ring.get(peer);
    if (!other) throw new Error(`setInMemoryPartition: party ${peer} is not in the ring`);
    for (const [a, b] of [[this, peer], [other, this.partyId]] as const) {
      if (partitioned) a.partitioned.add(b);
      else a.partitioned.delete(b);
    }
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

/**
 * Test hook (facts/core.md, `in-memory-transport.ts`): cut (`partitioned`
 * true) or restore the link between `transport` and `peer`, both ways. While
 * cut, each reports the other not connected, broadcasts between them are
 * dropped and pulls between them return `null`; every other pair is untouched.
 */
export function setInMemoryPartition(transport: Transport, peer: PartyId, partitioned: boolean): void {
  if (!(transport instanceof InMemoryTransport))
    throw new Error('setInMemoryPartition: not an in-memory transport (createInMemoryRing)');
  transport.setPartition(peer, partitioned);
}
