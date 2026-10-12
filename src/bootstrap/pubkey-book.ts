/**
 * Pubkey book — the output of the bootstrap phase.
 *
 * Every daemon ends up with the same book after bootstrap. Entries are sorted
 * by `partyId` (canonical order) so all nodes compute byte-identical
 * fingerprints. The fingerprint is what operators eyeball across nodes to
 * confirm no silent MitM of the bootstrap exchange — truncated SHA-256 over
 * the raw pubkey bytes in partyId order, rendered as 96 bits in the form
 * `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`.
 *
 * `advertisedEndpoint` is optional: relay nodes have none. The fingerprint
 * hashes pubkeys only, so it does not depend on endpoints.
 *
 * On-disk format: pretty-printed JSON, operator-readable.
 */

import { createHash } from 'node:crypto';
import type { PartyId } from '../core/types';
import { fromHex, toHex } from '../otzi/lib/hex';

export interface PubkeyBookEntry {
  partyId: PartyId;
  /** 130-char hex; the raw 65-byte uncompressed P-256 point. */
  publicKeyHex: string;
  /**
   * Canonical `host:port` form (use `canonicalizeEndpoint`). Absent for relay
   * nodes, which are reached through the relay and have no dialable address;
   * peer-mesh requires it on every peer. When present it is non-empty.
   */
  advertisedEndpoint?: string;
}

export interface PubkeyBook {
  /** Sorted ascending by partyId. Callers must not mutate. */
  readonly entries: readonly PubkeyBookEntry[];
}

const PUBKEY_HEX_LEN = 65 * 2;

export function buildBook(entries: Iterable<PubkeyBookEntry>): PubkeyBook {
  const sorted = [...entries].sort((a, b) => a.partyId - b.partyId);
  for (const e of sorted) validateEntry(e, '<buildBook>');
  assertUniquePartyIds(sorted);
  assertUniquePublicKeys(sorted);
  return { entries: sorted };
}

export function serializeBook(book: PubkeyBook): string {
  return JSON.stringify(book, null, 2);
}

export function parseBook(text: string): PubkeyBook {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries))
    throw new Error("parseBook: top-level object must have an 'entries' array");
  const entries = (raw as { entries: unknown[] }).entries.map((item, i) => {
    if (!item || typeof item !== 'object')
      throw new Error(`parseBook: entries[${i}] is not an object`);
    const o = item as Record<string, unknown>;
    if ('nodeId' in o)
      throw new Error(
        `parseBook: entries[${i}].nodeId is no longer supported — re-run 'otzi setup' to regenerate the book`,
      );
    if (typeof o.partyId !== 'number' || !Number.isInteger(o.partyId) || o.partyId < 0)
      throw new Error(`parseBook: entries[${i}].partyId must be a non-negative integer`);
    if (typeof o.publicKeyHex !== 'string')
      throw new Error(`parseBook: entries[${i}].publicKeyHex must be a string`);
    if (o.advertisedEndpoint !== undefined && typeof o.advertisedEndpoint !== 'string')
      throw new Error(`parseBook: entries[${i}].advertisedEndpoint must be a string`);
    // An absent endpoint stays absent: the entry gets no `advertisedEndpoint` key.
    const entry: PubkeyBookEntry = {
      partyId: o.partyId,
      publicKeyHex: o.publicKeyHex,
      ...(o.advertisedEndpoint !== undefined ? { advertisedEndpoint: o.advertisedEndpoint } : {}),
    };
    validateEntry(entry, `entries[${i}]`);
    return entry;
  });
  return buildBook(entries);
}

/**
 * 96-bit fingerprint — first 12 bytes of SHA-256 over the raw pubkey bytes in
 * book order (ascending partyId), as lowercase hex in six groups of 4 joined
 * by `-`. Operators compare this across all nodes after bootstrap; mismatch =
 * abort + redo.
 */
export async function computeFingerprint(book: PubkeyBook): Promise<string> {
  let total = 0;
  const bytes: Uint8Array[] = [];
  for (const e of book.entries) {
    const raw = fromHex(e.publicKeyHex);
    bytes.push(raw);
    total += raw.length;
  }
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const b of bytes) {
    concat.set(b, offset);
    offset += b.length;
  }
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(concat).buffer as ArrayBuffer,
  );
  const hex = toHex(new Uint8Array(hashBuf).slice(0, 12));
  return Array.from({ length: 6 }, (_, i) => hex.slice(i * 4, i * 4 + 4)).join('-');
}

/** Hex characters in a key id: 64 bits. */
const KEY_ID_HEX_LEN = 16;

/**
 * Key id — the first 16 lowercase hex characters (64 bits) of SHA-256 over the
 * raw 65-byte pubkey. A short per-key label for operators to confirm that every
 * entry in the book belongs to one of their own nodes. The fingerprint proves
 * all nodes hold the same book; key ids prove the book holds only your keys.
 * 64 bits keep a key ground to match an operator's id out of reach (Ruling P15).
 */
export function keyId(publicKeyHex: string): string {
  if (publicKeyHex.length !== PUBKEY_HEX_LEN)
    throw new Error(
      `keyId: publicKeyHex must be ${PUBKEY_HEX_LEN} chars (65 bytes), got ${publicKeyHex.length}`,
    );
  if (!/^[0-9a-f]+$/i.test(publicKeyHex)) throw new Error('keyId: publicKeyHex must be hex');
  return createHash('sha256').update(fromHex(publicKeyHex)).digest('hex').slice(0, KEY_ID_HEX_LEN);
}

function validateEntry(e: PubkeyBookEntry, path: string): void {
  if (e.publicKeyHex.length !== PUBKEY_HEX_LEN)
    throw new Error(
      `${path}.publicKeyHex must be ${PUBKEY_HEX_LEN} chars (65 bytes), got ${e.publicKeyHex.length}`,
    );
  if (!/^[0-9a-f]+$/i.test(e.publicKeyHex))
    throw new Error(`${path}.publicKeyHex must be lowercase hex`);
  const first = parseInt(e.publicKeyHex.slice(0, 2), 16);
  if (first !== 0x04)
    throw new Error(`${path}.publicKeyHex must start with 0x04 (uncompressed P-256)`);
  if (e.partyId < 0 || !Number.isInteger(e.partyId))
    throw new Error(`${path}.partyId must be a non-negative integer`);
  if (e.advertisedEndpoint !== undefined && e.advertisedEndpoint.length === 0)
    throw new Error(`${path}.advertisedEndpoint must be non-empty`);
}

function assertUniquePartyIds(entries: PubkeyBookEntry[]): void {
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.partyId))
      throw new Error(`pubkey book: duplicate partyId ${e.partyId}`);
    seen.add(e.partyId);
  }
}

function assertUniquePublicKeys(entries: PubkeyBookEntry[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    const key = e.publicKeyHex.toLowerCase();
    if (seen.has(key))
      throw new Error(`pubkey book: duplicate publicKey ${key.slice(0, 16)}…`);
    seen.add(key);
  }
}
