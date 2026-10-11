/**
 * This node's address book (facts/address-book.md, `store.ts`): Ötzi's
 * `AddressBookFile` at `/etc/otzi/address-book.otzi.json`, one per node.
 *
 * The book labels recipients in gate specs and CLI output, resolves
 * `otzi btc send <label>`, and can be the policy recipient allowlist
 * (`allowed_recipients = "address-book"`). Because it can widen that allowlist,
 * writing it takes the privilege of editing `daemon.toml`: the file is
 * `root:otzi`, mode 0640.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { NETWORK_NAMES } from '../otzi/backend/types';
import { addressBookFile, parseAddressBookFile, validateEntries } from '../otzi/lib/address-book';
import { isValidAddress } from '../otzi/lib/bitcoin';
import type { AddressBookEntry, NetworkName } from '../otzi/lib/vault-types';
import { displayText, errorReason } from '../util/text';

export const DEFAULT_ADDRESS_BOOK_PATH = '/etc/otzi/address-book.otzi.json';

const BOOK_MODE = 0o640;

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * The validated entries of the book at `path`: the one reader of an address-book
 * file. A missing file is an empty book, or with `missing: 'error'` an error like
 * any other unreadable file. Anything else wrong with it (unreadable, not JSON,
 * not an Ötzi address book, an invalid entry, another network) throws an error
 * that names the file.
 */
export async function readAddressBook(
  path: string,
  network: NetworkName,
  opts: { missing?: 'empty' | 'error' } = {},
): Promise<AddressBookEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err) && opts.missing !== 'error') return [];
    throw new Error(`address book ${path}: cannot be read: ${errorReason(err)}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`address book ${path}: not valid JSON`, { cause: err });
  }
  try {
    return parseAddressBookFile(json, network);
  } catch (err) {
    // The reason can quote the file's own `network` / `version` values: untrusted text.
    throw new Error(`address book ${path}: ${displayText(errorReason(err))}`, { cause: err });
  }
}

/**
 * Replaces the book at `path` with `entries`. The whole list is validated first
 * (nothing is written when an entry is invalid); the file is then written to a
 * temporary file beside `path` at mode 0640 and renamed over it, so a reader
 * sees the old book or the new one and never a partial file.
 */
export async function writeAddressBook(
  path: string,
  network: NetworkName,
  entries: AddressBookEntry[],
): Promise<void> {
  const file = addressBookFile(validateEntries(entries, network), network);
  const data = `${JSON.stringify(file, null, 2)}\n`;
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', BOOK_MODE);
    try {
      await handle.writeFile(data);
      // The umask may have narrowed the creation mode.
      await handle.chmod(BOOK_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (err) {
    // A failed cleanup must not hide the failure that caused it.
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The address a `btc send` recipient names: the first entry whose label equals
 * `labelOrAddress` exactly, else `labelOrAddress` itself when it is a valid
 * address for `network`. A label that is itself an address (on any supported
 * network) must name that same address: otherwise sending to the address would
 * pay somewhere else, so the call fails.
 */
export function resolveRecipient(entries: AddressBookEntry[], labelOrAddress: string, network: NetworkName): string {
  const entry = entries.find(e => e.label === labelOrAddress);
  if (entry) {
    if (entry.address !== labelOrAddress && NETWORK_NAMES.some(n => isValidAddress(labelOrAddress, n))) {
      throw new Error(
        `'${labelOrAddress}' is both an address and the label of ${entry.address}; rename or remove that label to send to the address`,
      );
    }
    return entry.address;
  }
  if (isValidAddress(labelOrAddress, network)) return labelOrAddress;
  throw new Error(`unknown label or invalid address: ${labelOrAddress}`);
}
