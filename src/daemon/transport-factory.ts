/**
 * Transport factory — reads the identity key file + pubkey book from disk,
 * derives the deterministic `ringId`, and constructs the right `Transport`
 * based on `DaemonConfig.transport.kind`.
 *
 * Identity file format (JSON):
 *   {
 *     "pkcs8Hex": "<hex-encoded PKCS#8 DER privkey>",
 *     "publicKeyHex": "<130-char hex uncompressed P-256>"
 *   }
 *
 * Pubkey book format: produced by bootstrap (phase 3c) — see
 * `src/bootstrap/pubkey-book.ts`.
 *
 * Cross-validation:
 *   - Identity's public key must match self's entry in the pubkey book.
 *   - Every `config.peers[].partyId` must have a pubkey book entry.
 *   - Every peer's book `nodeId` must match `config.peers[].id`.
 */

import { readFile } from 'node:fs/promises';
import { parseBook, type PubkeyBook } from '../bootstrap/pubkey-book';
import type { Transport } from '../core/transport';
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

  validateIdentityMatchesBook(identity, pubkeyBook, config.node.partyId, config.node.id);
  validatePeersInBook(pubkeyBook, config.peers);

  const ringId = await computeRingId(pubkeyBook);

  return buildFromState({ state, identity, pubkeyBook, ringId, options });
}

/** Programmatic variant for tests — skips disk I/O, takes pre-built identity + book. */
export async function buildTransportFromMemory(
  state: LoadedDaemonState,
  identity: IdentityKeyPair,
  pubkeyBook: PubkeyBook,
  options: BuildTransportOptions = {},
): Promise<TransportBundle> {
  validateIdentityMatchesBook(identity, pubkeyBook, state.config.node.partyId, state.config.node.id);
  validatePeersInBook(pubkeyBook, state.config.peers);
  const ringId = await computeRingId(pubkeyBook);
  return buildFromState({ state, identity, pubkeyBook, ringId, options });
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

async function buildFromState(args: {
  state: LoadedDaemonState;
  identity: IdentityKeyPair;
  pubkeyBook: PubkeyBook;
  ringId: string;
  options: BuildTransportOptions;
}): Promise<TransportBundle> {
  const { state, identity, pubkeyBook, ringId, options } = args;
  const { config } = state;

  if (config.transport.kind === 'peer-mesh') {
    if (!config.transport.listen)
      throw new Error('buildTransport: transport.listen required when transport.kind = "peer-mesh"');
    const peers = config.peers.map((p) => {
      const entry = pubkeyBook.entries.find((e) => e.partyId === p.partyId)!;
      const peer: { partyId: number; publicKey: Uint8Array; endpoint?: string } = {
        partyId: p.partyId,
        publicKey: fromHex(entry.publicKeyHex),
      };
      if (p.endpoint !== undefined) peer.endpoint = p.endpoint;
      return peer;
    });
    const transport = new PeerMeshTransport({
      self: { partyId: config.node.partyId, identity },
      listen: config.transport.listen,
      peers,
      logger: options.logger,
    });
    return {
      transport,
      identity,
      pubkeyBook,
      ringId,
      start: () => transport.start(),
      stop: () => transport.stop(),
    };
  }

  if (config.transport.kind === 'relay') {
    if (!config.transport.url)
      throw new Error('buildTransport: transport.url required when transport.kind = "relay"');
    const peers = config.peers.map((p) => {
      const entry = pubkeyBook.entries.find((e) => e.partyId === p.partyId)!;
      return { partyId: p.partyId, publicKey: fromHex(entry.publicKeyHex) };
    });
    const transport = new RelayTransport({
      self: { partyId: config.node.partyId, identity },
      relayUrl: config.transport.url,
      ringId,
      peers,
      logger: options.logger,
    });
    return {
      transport,
      identity,
      pubkeyBook,
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

function validateIdentityMatchesBook(
  identity: IdentityKeyPair,
  book: PubkeyBook,
  partyId: number,
  nodeId: string,
): void {
  const selfEntry = book.entries.find((e) => e.partyId === partyId);
  if (!selfEntry) throw new Error(`pubkey book missing entry for self (partyId=${partyId})`);
  if (selfEntry.publicKeyHex.toLowerCase() !== toHex(identity.publicKeyRaw).toLowerCase())
    throw new Error("identity pubkey does not match self's entry in pubkey book");
  if (selfEntry.nodeId !== nodeId)
    throw new Error(
      `pubkey book self entry nodeId='${selfEntry.nodeId}' does not match config node.id='${nodeId}'`,
    );
}

function validatePeersInBook(
  book: PubkeyBook,
  peers: ReadonlyArray<{ id: string; partyId: number }>,
): void {
  for (const p of peers) {
    const entry = book.entries.find((e) => e.partyId === p.partyId);
    if (!entry) throw new Error(`pubkey book missing entry for peer partyId=${p.partyId}`);
    if (entry.nodeId !== p.id)
      throw new Error(
        `peer partyId=${p.partyId} book nodeId='${entry.nodeId}' != config '${p.id}'`,
      );
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
