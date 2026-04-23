import type { BlobKey, PartyId, Unsubscribe } from './types';

/**
 * Pull-based transport for ceremony communication between ring peers.
 *
 * Implementations MUST provide peer-authenticated, E2E-encrypted channels
 * (hybrid KEM: ECDH P-256 + ML-KEM-768, AES-256-GCM, ML-DSA-signed handshake
 * — see CLAUDE.md § Transport). Callers trust that `from: PartyId` in every
 * incoming callback is authenticated.
 *
 * Test transports (e.g. InMemoryTransport) may bypass encryption but MUST
 * preserve the authenticated-`from` contract.
 */
export interface Transport {
  /** This daemon's identity in the ring. */
  readonly partyId: PartyId;

  /** All peers in the ring (including self). Stable across the daemon's lifetime. */
  readonly peers: readonly PartyId[];

  /** Broadcast a message to all other peers. */
  broadcast(msg: Uint8Array): Promise<void>;

  /** Subscribe to broadcasts from peers. */
  onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void): Unsubscribe;

  /**
   * Pull a specific blob from its producer (`key.from`).
   *
   * Returns the blob if the producer has it, or `null` if the producer has not
   * yet generated it (the caller retries with backoff). Throws if the producer
   * is not in the ring.
   */
  pull(key: BlobKey): Promise<Uint8Array | null>;

  /**
   * Register a handler for incoming pull requests from peers. Handler returns
   * the blob if this node has produced it, or `null` if not yet. At most one
   * handler per transport.
   */
  servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe;
}
