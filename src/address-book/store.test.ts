/**
 * The per-node address book file (facts/address-book.md, `store.ts`): Ötzi's
 * `AddressBookFile` format, atomic writes at mode 0640, recipient resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressBookEntry } from '../otzi/lib/vault-types';
import { DEFAULT_ADDRESS_BOOK_PATH, readAddressBook, resolveRecipient, writeAddressBook } from './store';

const NETWORK = 'testnet4' as const;
const ADDR_A = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const ADDR_B = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
const ADDR_C = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
const MAINNET_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const ENTRIES: AddressBookEntry[] = [
  { label: 'treasury', address: ADDR_A, note: 'cold storage' },
  { label: 'exchange', address: ADDR_B },
];

describe('address book store', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'otzi-book-store-'));
    path = join(dir, 'address-book.otzi.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to /etc/otzi/address-book.otzi.json', () => {
    expect(DEFAULT_ADDRESS_BOOK_PATH).toBe('/etc/otzi/address-book.otzi.json');
  });

  describe('writeAddressBook', () => {
    it('writes the book atomically with mode 0640 in otzi format', async () => {
      await writeAddressBook(path, NETWORK, ENTRIES);

      const text = await readFile(path, 'utf8');
      expect(JSON.parse(text)).toEqual({ kind: 'otzi-address-book', version: 1, network: NETWORK, entries: ENTRIES });
      expect(text).toContain('\n  '); // pretty-printed
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      // The temporary file was renamed away: the directory holds only the book.
      expect(await readdir(dir)).toEqual(['address-book.otzi.json']);
    });

    it('lands at mode 0640 under a restrictive umask and over an existing looser file', async () => {
      await writeFile(path, '{}', { mode: 0o666 });
      const before = process.umask(0o077);
      try {
        await writeAddressBook(path, NETWORK, ENTRIES);
      } finally {
        process.umask(before);
      }
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect(await readAddressBook(path, NETWORK)).toEqual(ENTRIES);
    });

    it('replaces the previous book as a whole', async () => {
      await writeAddressBook(path, NETWORK, ENTRIES);
      await writeAddressBook(path, NETWORK, [{ label: 'only', address: ADDR_C }]);
      expect(await readAddressBook(path, NETWORK)).toEqual([{ label: 'only', address: ADDR_C }]);
    });

    it('writes the validated entries: trimmed labels, notes and addresses', async () => {
      await writeAddressBook(path, NETWORK, [{ label: '  padded  ', address: ` ${ADDR_A} `, note: ' n ' }]);
      expect(await readAddressBook(path, NETWORK)).toEqual([{ label: 'padded', address: ADDR_A, note: 'n' }]);
    });

    it('writes nothing for an invalid entry, and leaves the old book alone', async () => {
      await writeAddressBook(path, NETWORK, ENTRIES);
      const before = await readFile(path, 'utf8');

      await expect(writeAddressBook(path, NETWORK, [...ENTRIES, { label: 'bad', address: 'nope' }])).rejects.toThrow(
        /Entry 3: not a valid testnet4 address/,
      );
      await expect(writeAddressBook(path, NETWORK, [{ label: 'm', address: MAINNET_ADDR }])).rejects.toThrow(
        /not a valid testnet4 address/,
      );
      await expect(writeAddressBook(path, NETWORK, [ENTRIES[0]!, { label: 'again', address: ADDR_A }])).rejects.toThrow(
        /Entry 2: duplicate address/,
      );

      expect(await readFile(path, 'utf8')).toBe(before);
      expect(await readdir(dir)).toEqual(['address-book.otzi.json']);
    });

    it('writes nothing to a fresh path for an invalid entry', async () => {
      await expect(writeAddressBook(path, NETWORK, [{ label: '', address: ADDR_A }])).rejects.toThrow(/label required/);
      expect(await readdir(dir)).toEqual([]);
    });

    it('removes the temporary file when the replace fails', async () => {
      // A non-empty directory at the target makes the final rename fail.
      await mkdir(join(path, 'occupied'), { recursive: true });
      await expect(writeAddressBook(path, NETWORK, ENTRIES)).rejects.toThrow();
      expect(await readdir(dir)).toEqual(['address-book.otzi.json']);
      expect(await readdir(path)).toEqual(['occupied']);
    });
  });

  describe('readAddressBook', () => {
    it('returns the validated entries of a book it wrote', async () => {
      await writeAddressBook(path, NETWORK, ENTRIES);
      expect(await readAddressBook(path, NETWORK)).toEqual(ENTRIES);
    });

    it('returns [] when the file does not exist', async () => {
      expect(await readAddressBook(join(dir, 'absent.json'), NETWORK)).toEqual([]);
      expect(await readAddressBook(join(dir, 'absent.json'), NETWORK, { missing: 'empty' })).toEqual([]);
    });

    it("throws for a missing file with missing: 'error', naming the file", async () => {
      const absent = join(dir, 'absent.json');
      const err = await readAddressBook(absent, NETWORK, { missing: 'error' }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain(absent);
      expect(err?.message).toContain('ENOENT');
    });

    it('reads an existing file the same with either missing mode', async () => {
      await writeAddressBook(path, NETWORK, ENTRIES);
      expect(await readAddressBook(path, NETWORK, { missing: 'error' })).toEqual(ENTRIES);
      expect(await readAddressBook(path, NETWORK, { missing: 'empty' })).toEqual(ENTRIES);
    });

    it('reads an Ötzi address-book file as web Ötzi exports it', async () => {
      const exported = { kind: 'otzi-address-book', version: 1, network: NETWORK, entries: [{ label: 'x', address: ADDR_A }] };
      await writeFile(path, JSON.stringify(exported, null, 2));
      expect(await readAddressBook(path, NETWORK)).toEqual([{ label: 'x', address: ADDR_A }]);
    });

    it('rejects a book for another network, naming the file', async () => {
      await writeAddressBook(path, NETWORK, ENTRIES);
      const err = await readAddressBook(path, 'mainnet').then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain(path);
      expect(err?.message).toContain('Address book is for testnet4, this vault is on mainnet');
    });

    it('shows a hostile network or version value without control characters', async () => {
      for (const file of [
        { kind: 'otzi-address-book', version: 1, network: 'main\u001b[2Jnet\nFORGED LINE', entries: [] },
        { kind: 'otzi-address-book', version: 'v\u001b]0;pwned\u0007\r\n2', network: NETWORK, entries: [] },
      ]) {
        await writeFile(path, JSON.stringify(file));
        const err = await readAddressBook(path, NETWORK).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err?.message).toContain(path);
        expect(err?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
    });

    it('rejects a book for another network even when it holds no entries', async () => {
      await writeFile(path, JSON.stringify({ kind: 'otzi-address-book', version: 1, network: 'mainnet', entries: [] }));
      await expect(readAddressBook(path, NETWORK)).rejects.toThrow(/Address book is for mainnet, this vault is on testnet4/);
    });

    it('rejects invalid JSON, a wrong kind or version, and invalid entries, each naming the file', async () => {
      const cases: Array<[string, RegExp]> = [
        ['{ not json', /not valid JSON/],
        [JSON.stringify([]), /Not an Ötzi address book file/],
        [JSON.stringify({ kind: 'something-else', version: 1, network: NETWORK, entries: [] }), /Not an Ötzi address book file/],
        [JSON.stringify({ kind: 'otzi-address-book', version: 2, network: NETWORK, entries: [] }), /Unsupported address book version: 2/],
        [
          JSON.stringify({ kind: 'otzi-address-book', version: 1, network: NETWORK, entries: [{ label: 'x', address: 'nope' }] }),
          /Entry 1: not a valid testnet4 address/,
        ],
      ];
      for (const [content, message] of cases) {
        await writeFile(path, content);
        const err = await readAddressBook(path, NETWORK).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err?.message, content).toMatch(message);
        expect(err?.message, content).toContain(path);
      }
    });

    it('throws on an unreadable path other than a missing file', async () => {
      // A directory is not a readable file.
      await expect(readAddressBook(dir, NETWORK)).rejects.toThrow();
    });
  });

  describe('resolveRecipient', () => {
    it('resolves a label to its address, matching exactly', () => {
      expect(resolveRecipient(ENTRIES, 'treasury', NETWORK)).toBe(ADDR_A);
      expect(resolveRecipient(ENTRIES, 'exchange', NETWORK)).toBe(ADDR_B);
      expect(() => resolveRecipient(ENTRIES, 'Treasury', NETWORK)).toThrow('unknown label or invalid address: Treasury');
      expect(() => resolveRecipient(ENTRIES, 'treasur', NETWORK)).toThrow('unknown label or invalid address: treasur');
    });

    it('takes the first entry when a label repeats', () => {
      const dup: AddressBookEntry[] = [
        { label: 'ops', address: ADDR_B },
        { label: 'ops', address: ADDR_A },
      ];
      expect(resolveRecipient(dup, 'ops', NETWORK)).toBe(ADDR_B);
    });

    it('passes through an address valid for the network, listed or not', () => {
      expect(resolveRecipient(ENTRIES, ADDR_A, NETWORK)).toBe(ADDR_A);
      expect(resolveRecipient([], ADDR_C, NETWORK)).toBe(ADDR_C);
    });

    it('refuses an address-shaped label that points to another address, naming both', () => {
      const redirect: AddressBookEntry[] = [{ label: ADDR_A, address: ADDR_B }];
      const err = (() => {
        try {
          return resolveRecipient(redirect, ADDR_A, NETWORK);
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`'${ADDR_A}' is both an address and the label of ${ADDR_B}`);
    });

    it('refuses an address-shaped label whatever network the address is for', () => {
      // A mainnet address as the label of a testnet4 entry: the input is not valid on testnet4, but it is an address.
      const redirect: AddressBookEntry[] = [{ label: MAINNET_ADDR, address: ADDR_B }];
      expect(() => resolveRecipient(redirect, MAINNET_ADDR, NETWORK)).toThrow(
        `'${MAINNET_ADDR}' is both an address and the label of ${ADDR_B}`,
      );
    });

    it('accepts an address-shaped label that points to that same address', () => {
      const same: AddressBookEntry[] = [{ label: ADDR_A, address: ADDR_A, note: 'listed under its own name' }];
      expect(resolveRecipient(same, ADDR_A, NETWORK)).toBe(ADDR_A);
    });

    it('only looks at the label that resolves: a later entry does not matter', () => {
      const entries: AddressBookEntry[] = [
        { label: ADDR_A, address: ADDR_A },
        { label: ADDR_A, address: ADDR_B },
      ];
      expect(resolveRecipient(entries, ADDR_A, NETWORK)).toBe(ADDR_A);
    });

    it('does not mistake an ordinary label for an address', () => {
      const entries: AddressBookEntry[] = [{ label: 'tb1-not-an-address', address: ADDR_B }];
      expect(resolveRecipient(entries, 'tb1-not-an-address', NETWORK)).toBe(ADDR_B);
    });

    it('rejects an address of another network and anything that is neither label nor address', () => {
      for (const x of [MAINNET_ADDR, 'not-an-address', '']) {
        expect(() => resolveRecipient(ENTRIES, x, NETWORK)).toThrow(`unknown label or invalid address: ${x}`);
      }
    });
  });
});
