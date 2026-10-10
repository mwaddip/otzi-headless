/**
 * `otzi book list|add|remove|import|export` (facts/daemon.md, `book.ts`):
 * manage this node's address book (facts/address-book.md).
 *
 * The verbs work on the file directly and need no daemon; the daemon reads the
 * book at each use, so an edit takes effect without a restart. Reading needs
 * `otzi` group membership, writing the privilege of editing `daemon.toml`
 * (the book can widen a policy allowlist).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_ADDRESS_BOOK_PATH, readAddressBook, writeAddressBook } from '../../address-book/store';
import { loadDaemonConfig } from '../../config/load';
import type { NetworkName } from '../../config/types';
import { addressBookFile, mergeAddressBooks, parseAddressBookFile, validateEntries } from '../../otzi/lib/address-book';
import type { AddressBookEntry } from '../../otzi/lib/vault-types';

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

/** A tab or line break inside a label or note would break the one-line-per-entry listing. */
const oneLine = (text: string): string => text.replace(/[\t\r\n]+/g, ' ');

export async function bookList(o: BookOpts): Promise<string> {
  const { entries } = await loadBook(o);
  return entries.map(e => [e.label, e.address, e.note ?? ''].map(oneLine).join('\t')).join('\n');
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
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot save '${o.label}': ${why.replace(/^Entry \d+: /, '')}`, { cause: err });
  }
  const at = entries.findIndex(e => e.address === address);
  const next = at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e));
  await writeAddressBook(path, network, next);
}

export async function bookRemove(o: BookOpts & { key: string }): Promise<void> {
  const { network, path, entries } = await loadBook(o);
  const matches = entries.filter(e => e.label === o.key || e.address === o.key);
  if (matches.length === 0) throw new Error(`no address book entry matches '${o.key}'`);
  if (matches.length > 1) {
    throw new Error(`'${o.key}' matches ${matches.length} entries; remove the one you mean by its address`);
  }
  await writeAddressBook(path, network, entries.filter(e => e !== matches[0]));
}

/** The entries of an Ötzi address-book file for `network`; every error names the file. */
async function readBookFile(file: string, network: NetworkName): Promise<AddressBookEntry[]> {
  const fail = (why: string, cause: unknown): Error => new Error(`address book file ${file}: ${why}`, { cause });
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw fail(`cannot be read: ${reason(err)}`, err);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw fail('not valid JSON', err);
  }
  try {
    return parseAddressBookFile(json, network);
  } catch (err) {
    throw fail(reason(err), err);
  }
}

export async function bookImport(
  o: BookOpts & { file: string; replace: boolean },
): Promise<{ added: number; updated: number; unchanged: number }> {
  const network = await networkOf(o);
  const incoming = await readBookFile(o.file, network);
  const { path, entries } = await loadBook(o, network);
  const merged = mergeAddressBooks(entries, incoming);
  await writeAddressBook(path, network, o.replace ? incoming : merged.entries);
  return { added: merged.added, updated: merged.updated, unchanged: merged.unchanged };
}

export async function bookExport(o: BookOpts & { out?: string }): Promise<string> {
  const { network, entries } = await loadBook(o);
  const text = JSON.stringify(addressBookFile(entries, network), null, 2);
  if (o.out !== undefined) await writeFile(o.out, `${text}\n`);
  return text;
}
