/**
 * Address book .otzi.json files: parse, merge and export.
 * Schema: docs/otzi-address-book-schema.json
 */

import { isValidAddress } from './bitcoin';
import type { AddressBookEntry, NetworkName } from './vault-types';

export const ADDRESS_BOOK_KIND = 'otzi-address-book';
export const MAX_ENTRIES = 1000;
export const MAX_LABEL = 64;
export const MAX_NOTE = 256;

export interface AddressBookFile {
  kind: typeof ADDRESS_BOOK_KIND;
  version: 1;
  network: NetworkName;
  entries: AddressBookEntry[];
}

/** Validate and normalize entries (trimmed labels/notes, unique addresses). Throws with the first problem. */
export function validateEntries(input: unknown, network: NetworkName): AddressBookEntry[] {
  if (!Array.isArray(input)) throw new Error('entries must be an array');
  if (input.length > MAX_ENTRIES) throw new Error(`At most ${MAX_ENTRIES} entries`);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const fail = (reason: string): never => { throw new Error(`Entry ${i + 1}: ${reason}`); };
    if (!raw || typeof raw !== 'object') fail('must be an object');
    const e = raw as Record<string, unknown>;
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label) fail('label required');
    if (label.length > MAX_LABEL) fail(`label longer than ${MAX_LABEL} characters`);
    const address = typeof e.address === 'string' ? e.address.trim() : '';
    if (!isValidAddress(address, network)) fail(`not a valid ${network} address`);
    if (seen.has(address)) fail('duplicate address');
    seen.add(address);
    let note: string | undefined;
    if (e.note !== undefined) {
      if (typeof e.note !== 'string') fail('note must be text');
      note = (e.note as string).trim();
      if (note.length > MAX_NOTE) fail(`note longer than ${MAX_NOTE} characters`);
    }
    return note ? { label, address, note } : { label, address };
  });
}

export function parseAddressBookFile(json: unknown, network: NetworkName): AddressBookEntry[] {
  if (!json || typeof json !== 'object') throw new Error('Not an address book file');
  const f = json as Record<string, unknown>;
  if (f.kind !== ADDRESS_BOOK_KIND) throw new Error('Not an Ötzi address book file');
  if (f.version !== 1) throw new Error(`Unsupported address book version: ${String(f.version)}`);
  if (f.network !== network) throw new Error(`Address book is for ${String(f.network)}, this vault is on ${network}`);
  return validateEntries(f.entries, network);
}

export interface MergeResult {
  entries: AddressBookEntry[];
  added: number;
  updated: number;
  unchanged: number;
}

const sameEntry = (a: AddressBookEntry, b: AddressBookEntry) => a.label === b.label && (a.note ?? '') === (b.note ?? '');

/** Merge by address: incoming labels/notes win, existing-only entries are kept in order, new ones appended. */
export function mergeAddressBooks(current: AddressBookEntry[], incoming: AddressBookEntry[]): MergeResult {
  const byAddress = new Map(incoming.map(e => [e.address, e]));
  let updated = 0;
  let unchanged = 0;
  const entries = current.map(e => {
    const next = byAddress.get(e.address);
    if (!next) return e;
    byAddress.delete(e.address);
    if (sameEntry(e, next)) { unchanged++; return e; }
    updated++;
    return next;
  });
  const added = [...byAddress.values()];
  return { entries: [...entries, ...added], added: added.length, updated, unchanged };
}

export function addressBookFile(entries: AddressBookEntry[], network: NetworkName): AddressBookFile {
  return { kind: ADDRESS_BOOK_KIND, version: 1, network, entries };
}

export function downloadAddressBook(entries: AddressBookEntry[], network: NetworkName): void {
  const blob = new Blob([JSON.stringify(addressBookFile(entries, network), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `otzi-address-book-${network}.otzi.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function labelFor(entries: AddressBookEntry[], address: string): string | undefined {
  return entries.find(e => e.address === address)?.label;
}
