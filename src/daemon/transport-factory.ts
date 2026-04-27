/**
 * Transport factory — reads identity + pubkey book, identifies self by pubkey
 * match in the book, validates that the local `[[peers]]` dial table agrees
 * with the book on canonical endpoints (peer-mesh only), computes the
 * deterministic ringId, and constructs the requested `Transport`.
 *
 * Identity file format (JSON):
 *   {
 *     "pkcs8Hex": "<hex-encoded PKCS#8 DER privkey>",
 *     "publicKeyHex": "<130-char hex uncompressed P-256>"
 *   }
 *
 * Pubkey book format: `src/bootstrap/pubkey-book.ts` (Phase B+ shape).
 *
 * Cross-validation:
 *   - Self entry = the book entry whose publicKeyHex matches loaded identity.
 *   - For peer-mesh: every `[[peers]].endpoint` (canonical) must match a
 *     non-self book entry's `advertisedEndpoint` (canonical), and vice versa.
 *   - For relay: peer endpoint matching is skipped (relay routes by partyId).
 */

import { readFile } from 'node:fs/promises';
import { parseBook, type PubkeyBook, type PubkeyBookEntry } from '../bootstrap/pubkey-book';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import type { Logger } from '../orchestrator/types';
import { PeerMeshTransport } from '../transport/peer-mesh/peer-mesh';
import { RelayTransport } from '../transport/relay/relay-transport';
import { importIdentity, type IdentityKeyPair } from '../transport/identity';
import { fromHex, toHex } from '../wire/hex';
import type { LoadedDaemonState } from './config-merge';

export interface TransportBundle {
  transport: Transport;
  identity: IdentityKeyPair;
  pubkeyBook: PubkeyBook;
  /** Self's partyId, resolved from the book by pubkey match. Authoritative. */
  selfPartyId: number;
  /** Self's book entry. */
  selfEntry: PubkeyBookEntry;
  /**
   * Logging-label map: `partyId → "peer-${partyId}"` for non-self entries,
   * `selfPartyId → config.node.id` for self. Built from the book at startup;
   * the operator's local `node.id` label is used only for self.
   */
  peersById: ReadonlyMap<PartyId, string>;
  /** SHA-256 hex of concatenated pubkeys — same on every peer. */
  ringId: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BuildTransportOptions {
  logger?: Logger;
}

export async function buildTransportFromFiles(
  state: LoadedDaemonState,
  options: BuildTransportOptions = {},
): Promise<TransportBundle> {
  const { config } = state;
  if (!config.node.identityKeyFile)
    throw new Error('buildTransport: node.identity_key_file is required for real transports');
  if (!config.node.pubkeyBookFile)
    throw new Error('buildTransport: node.pubkey_book_file is required for real transports');

  const identity = await loadIdentityFile(config.node.identityKeyFile);
  const pubkeyBook = await loadPubkeyBook(config.node.pubkeyBookFile);

  const selfEntry = resolveSelfFromBook(identity, pubkeyBook);
  if (state.share && state.share.partyId !== selfEntry.partyId) {
    throw new Error(
      `buildTransport: share.partyId (${state.share.partyId}) does not match book self entry partyId (${selfEntry.partyId})`,
    );
  }

  const ringId = await computeRingId(pubkeyBook);

  return buildFromState({
    state,
    identity,
    pubkeyBook,
    selfPartyId: selfEntry.partyId,
    selfEntry,
    ringId,
    options,
  });
}

/** Programmatic variant for tests — skips disk I/O. */
export async function buildTransportFromMemory(
  state: LoadedDaemonState,
  identity: IdentityKeyPair,
  pubkeyBook: PubkeyBook,
  options: BuildTransportOptions = {},
): Promise<TransportBundle> {
  const selfEntry = resolveSelfFromBook(identity, pubkeyBook);
  if (state.share && state.share.partyId !== selfEntry.partyId) {
    throw new Error(
      `buildTransport: share.partyId (${state.share.partyId}) does not match book self entry partyId (${selfEntry.partyId})`,
    );
  }
  const ringId = await computeRingId(pubkeyBook);
  return buildFromState({
    state,
    identity,
    pubkeyBook,
    selfPartyId: selfEntry.partyId,
    selfEntry,
    ringId,
    options,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

interface BuildFromStateArgs {
  state: LoadedDaemonState;
  identity: IdentityKeyPair;
  pubkeyBook: PubkeyBook;
  selfPartyId: number;
  selfEntry: PubkeyBookEntry;
  ringId: string;
  options: BuildTransportOptions;
}

async function buildFromState(args: BuildFromStateArgs): Promise<TransportBundle> {
  const { state, identity, pubkeyBook, selfPartyId, selfEntry, ringId, options } = args;
  const { config } = state;

  // Filter book to non-self peers; this is the authoritative source for
  // the partyId + publicKey of every peer.
  const bookPeers = pubkeyBook.entries.filter((e) => e.partyId !== selfPartyId);

  // peersById is the daemon-wide logging-label map. Operator-supplied
  // `[[peers]].id` is gone post-Phase-F, so non-self labels are synthetic.
  // Self uses `config.node.id` (the operator's local label, free-form).
  const peersById = new Map<PartyId, string>();
  for (const e of pubkeyBook.entries) {
    peersById.set(
      e.partyId,
      e.partyId === selfPartyId ? config.node.id : `peer-${e.partyId}`,
    );
  }

  if (config.transport.kind === 'peer-mesh') {
    const advertised = config.transport.advertisedEndpoint;
    if (!advertised) {
      throw new Error(
        'buildTransport: transport.advertised_endpoint required when transport.kind = "peer-mesh"',
      );
    }
    validatePeersAgainstBook(pubkeyBook, config.peers, selfPartyId);

    // peer-mesh expects ws:// URLs (PeerConnection.dial uses `new URL`).
    // Book carries canonical host:port; prepend ws:// here so peer-mesh
    // internals don't change.
    const peers = bookPeers.map((e) => ({
      partyId: e.partyId,
      publicKey: fromHex(e.publicKeyHex),
      endpoint: `ws://${e.advertisedEndpoint}`,
    }));
    const transport = new PeerMeshTransport({
      self: { partyId: selfPartyId, identity },
      listen: advertised,
      peers,
      logger: options.logger,
    });
    return {
      transport,
      identity,
      pubkeyBook,
      selfPartyId,
      selfEntry,
      peersById,
      ringId,
      start: () => transport.start(),
      stop: () => transport.stop(),
    };
  }

  if (config.transport.kind === 'relay') {
    if (!config.transport.url)
      throw new Error('buildTransport: transport.url required when transport.kind = "relay"');
    const peers = bookPeers.map((e) => ({
      partyId: e.partyId,
      publicKey: fromHex(e.publicKeyHex),
    }));
    const transport = new RelayTransport({
      self: { partyId: selfPartyId, identity },
      relayUrl: config.transport.url,
      ringId,
      peers,
      logger: options.logger,
    });
    return {
      transport,
      identity,
      pubkeyBook,
      selfPartyId,
      selfEntry,
      peersById,
      ringId,
      start: () => transport.start(),
      stop: () => transport.stop(),
    };
  }

  const kind: string = (config.transport as { kind: string }).kind;
  throw new Error(`buildTransport: unknown transport.kind '${kind}'`);
}

async function loadIdentityFile(path: string): Promise<IdentityKeyPair> {
  const text = await readFile(path, 'utf8');
  let parsed: { pkcs8Hex?: unknown; publicKeyHex?: unknown };
  try {
    parsed = JSON.parse(text) as { pkcs8Hex?: unknown; publicKeyHex?: unknown };
  } catch (err) {
    throw new Error(
      `identity file '${path}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed.pkcs8Hex !== 'string' || typeof parsed.publicKeyHex !== 'string')
    throw new Error(`identity file '${path}' must have 'pkcs8Hex' + 'publicKeyHex' string fields`);
  return importIdentity(fromHex(parsed.pkcs8Hex), fromHex(parsed.publicKeyHex));
}

async function loadPubkeyBook(path: string): Promise<PubkeyBook> {
  const text = await readFile(path, 'utf8');
  return parseBook(text);
}

function resolveSelfFromBook(identity: IdentityKeyPair, book: PubkeyBook): PubkeyBookEntry {
  const selfPubkeyHex = toHex(identity.publicKeyRaw).toLowerCase();
  const entry = book.entries.find((e) => e.publicKeyHex.toLowerCase() === selfPubkeyHex);
  if (!entry) {
    throw new Error(
      `transport-factory: identity pubkey not found in pubkey book — re-run 'otzi setup' if the book is stale`,
    );
  }
  return entry;
}

function validatePeersAgainstBook(
  book: PubkeyBook,
  configPeers: ReadonlyArray<{ endpoint: string }>,
  selfPartyId: number,
): void {
  const bookEndpoints = new Set<string>();
  for (const e of book.entries) {
    if (e.partyId === selfPartyId) continue;
    bookEndpoints.add(e.advertisedEndpoint);
  }
  const configEndpoints = new Set<string>();
  for (const p of configPeers) {
    configEndpoints.add(p.endpoint);
  }
  for (const ep of configEndpoints) {
    if (!bookEndpoints.has(ep)) {
      throw new Error(
        `transport-factory: [[peers]] endpoint '${ep}' not found in pubkey book`,
      );
    }
  }
  for (const ep of bookEndpoints) {
    if (!configEndpoints.has(ep)) {
      throw new Error(
        `transport-factory: book peer endpoint '${ep}' not found in [[peers]] — config + book disagree`,
      );
    }
  }
}

async function computeRingId(book: PubkeyBook): Promise<string> {
  let total = 0;
  const parts: Uint8Array[] = [];
  for (const e of book.entries) {
    const b = fromHex(e.publicKeyHex);
    parts.push(b);
    total += b.length;
  }
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    concat.set(p, offset);
    offset += p.length;
  }
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(concat).buffer as ArrayBuffer);
  return toHex(new Uint8Array(hash));
}
