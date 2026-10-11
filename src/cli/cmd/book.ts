/**
 * `otzi book list|add|remove|import|export` (facts/daemon.md, `book.ts`):
 * manage this node's address book (facts/address-book.md).
 *
 * The verbs work on the file directly and need no daemon; the daemon reads the
 * book at each use, so an edit takes effect without a restart. Reading needs
 * `otzi` group membership, writing the privilege of editing `daemon.toml`
 * (the book can widen a policy allowlist).
 */

import { chmod, writeFile } from 'node:fs/promises';
import { DEFAULT_ADDRESS_BOOK_PATH, readAddressBook, writeAddressBook } from '../../address-book/store';
import { loadDaemonConfig } from '../../config/load';
import type { NetworkName } from '../../config/types';
import { addressBookFile, mergeAddressBooks, validateEntries } from '../../otzi/lib/address-book';
import type { AddressBookEntry } from '../../otzi/lib/vault-types';
import { displayText, errorReason } from '../../util/text';

/** `book export <path>` files get the book's own mode. */
const BOOK_FILE_MODE = 0o640;

export interface BookOpts {
  /** The daemon config: the network comes from it. */
  configPath: string;
  /** Default: `DEFAULT_ADDRESS_BOOK_PATH`. */
  bookPath?: string;
}

interface Book {
  network: NetworkName;
  path: string;
  entries: AddressBookEntry[];
}

const networkOf = async (o: BookOpts): Promise<NetworkName> => (await loadDaemonConfig(o.configPath)).network.name;

async function loadBook(o: BookOpts, network?: NetworkName): Promise<Book> {
  const net = network ?? (await networkOf(o));
  const path = o.bookPath ?? DEFAULT_ADDRESS_BOOK_PATH;
  return { network: net, path, entries: await readAddressBook(path, net) };
}

export async function bookList(o: BookOpts): Promise<string> {
  const { entries } = await loadBook(o);
  return entries.map(e => [displayText(e.label), e.address, displayText(e.note ?? '')].join('\t')).join('\n');
}

export async function bookAdd(o: BookOpts & { label: string; address: string; note?: string }): Promise<void> {
  const { network, path, entries } = await loadBook(o);
  const address = o.address.trim();
  const entry: AddressBookEntry =
    o.note !== undefined ? { label: o.label, address, note: o.note } : { label: o.label, address };
  try {
    validateEntries([entry], network);
  } catch (err) {
    // The entry alone, so its position in the whole list would only confuse.
    throw new Error(`cannot save '${displayText(o.label)}': ${errorReason(err).replace(/^Entry \d+: /, '')}`, { cause: err });
  }
  const at = entries.findIndex(e => e.address === address);
  const next = at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e));
  await writeAddressBook(path, network, next);
}

export async function bookRemove(o: BookOpts & { key: string }): Promise<void> {
  const { network, path, entries } = await loadBook(o);
  // Addresses are unique, so an address match is the entry; only without one is `key` read as a label.
  const byAddress = entries.filter(e => e.address === o.key);
  const matches = byAddress.length > 0 ? byAddress : entries.filter(e => e.label === o.key);
  if (matches.length === 0) throw new Error(`no address book entry matches '${o.key}'`);
  if (matches.length > 1) {
    throw new Error(`'${o.key}' matches ${matches.length} entries; remove the one you mean by its address`);
  }
  await writeAddressBook(path, network, entries.filter(e => e !== matches[0]));
}

export async function bookImport(
  o: BookOpts & { file: string; replace: boolean },
): Promise<{ added: number; updated: number; unchanged: number; removed: number }> {
  const network = await networkOf(o);
  const incoming = await readAddressBook(o.file, network, { missing: 'error' }).catch((err: unknown) => {
    throw new Error(`cannot import: ${errorReason(err)}`, { cause: err });
  });
  const { path, entries } = await loadBook(o, network);
  const merged = mergeAddressBooks(entries, incoming);
  await writeAddressBook(path, network, o.replace ? incoming : merged.entries);
  // A merge only adds and updates; a replacement drops every address the file does not have.
  const kept = new Set(incoming.map(e => e.address));
  const removed = o.replace ? entries.filter(e => !kept.has(e.address)).length : 0;
  return { added: merged.added, updated: merged.updated, unchanged: merged.unchanged, removed };
}

export async function bookExport(o: BookOpts & { out?: string }): Promise<string> {
  const { network, entries } = await loadBook(o);
  const text = JSON.stringify(addressBookFile(entries, network), null, 2);
  if (o.out !== undefined) {
    // Same mode as the book itself: it lists the node's recipients.
    await writeFile(o.out, `${text}\n`, { mode: BOOK_FILE_MODE });
    await chmod(o.out, BOOK_FILE_MODE); // an existing file keeps its mode through writeFile
  }
  return text;
}
