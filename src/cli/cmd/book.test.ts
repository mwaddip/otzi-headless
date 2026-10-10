/**
 * `otzi book list|add|remove|import|export` against a temporary book and
 * config (facts/daemon.md, `book.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import { readAddressBook, writeAddressBook } from '../../address-book/store';
import { btcNetwork } from '../../otzi/lib/bitcoin';
import type { AddressBookEntry } from '../../otzi/lib/vault-types';
import { bookAdd, bookExport, bookImport, bookList, bookRemove, type BookOpts } from './book';

const ADDR_A = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const ADDR_B = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
const ADDR_C = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
const MAINNET_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** `n` entries with distinct valid testnet4 addresses. */
function distinctEntries(n: number): AddressBookEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const secret = new Uint8Array(32);
    new DataView(secret.buffer).setUint32(0, i + 1);
    return { label: `entry ${i}`, address: btc.p2wpkh(secp256k1.getPublicKey(secret, true), btcNetwork('testnet4')).address! };
  });
}

function configToml(network: string): string {
  return `
[share]
path = "/tmp/otzi-test-share.json"
password_env = "OTZI_TEST_PASSWORD"
[node]
id = "a"
[network]
name = "${network}"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "127.0.0.1:8801"
[gate]
strategy = "auto"
`;
}

describe('otzi book', () => {
  let tmp: string;
  let o: BookOpts;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-book-test-'));
    const configPath = join(tmp, 'daemon.toml');
    await writeFile(configPath, configToml('testnet4'));
    o = { configPath, bookPath: join(tmp, 'address-book.otzi.json') };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const book = (): Promise<AddressBookEntry[]> => readAddressBook(o.bookPath!, 'testnet4');

  /** An Ötzi address-book file in the temp directory. */
  async function bookFile(name: string, entries: unknown, network = 'testnet4'): Promise<string> {
    const file = join(tmp, name);
    await writeFile(file, JSON.stringify({ kind: 'otzi-address-book', version: 1, network, entries }, null, 2));
    return file;
  }

  describe('bookList', () => {
    it('prints one tab-separated line per entry: label, address, note', async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'exchange', address: ADDR_B },
      ]);
      expect((await bookList(o)).split('\n')).toEqual([
        `treasury\t${ADDR_A}\tcold storage`,
        `exchange\t${ADDR_B}\t`,
      ]);
    });

    it('is empty for a node without a book', async () => {
      expect(await bookList(o)).toBe('');
    });

    it('keeps one line per entry whatever the label and note contain', async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [{ label: 'a\tb', address: ADDR_A, note: 'x\ny\r\nz' }]);
      const out = await bookList(o);
      expect(out.split('\n')).toHaveLength(1);
      expect(out).toBe(`a b\t${ADDR_A}\tx y z`);
    });

    it('shows no control character of a label or note, and leaves the stored book as it was', async () => {
      const label = '\u001b[2Jtreasury\u0007\u009b31m';
      const note = 'ok\u001b]0;pwned\u0007\u007f\u0085end';
      await writeAddressBook(o.bookPath!, 'testnet4', [{ label, address: ADDR_A, note }]);
      const stored = await readFile(o.bookPath!, 'utf8');

      const out = await bookList(o);

      expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(out).toBe(`[2Jtreasury31m\t${ADDR_A}\tok]0;pwnedend`);
      expect(await readFile(o.bookPath!, 'utf8')).toBe(stored);
      expect(await book()).toEqual([{ label, address: ADDR_A, note }]);
    });

    it('fails on a book for another network, naming the file', async () => {
      await writeFile(
        o.bookPath!,
        JSON.stringify({ kind: 'otzi-address-book', version: 1, network: 'mainnet', entries: [] }),
      );
      await expect(bookList(o)).rejects.toThrow(new RegExp(`${o.bookPath!}.*mainnet.*testnet4`));
    });

    it('takes the network from the config', async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [{ label: 'x', address: ADDR_A }]);
      await writeFile(o.configPath, configToml('mainnet'));
      await expect(bookList(o)).rejects.toThrow(/Address book is for testnet4, this vault is on mainnet/);
    });
  });

  describe('bookAdd', () => {
    it('creates the book on first use, in otzi format at mode 0640', async () => {
      await bookAdd({ ...o, label: 'treasury', address: ADDR_A, note: 'cold storage' });

      expect(JSON.parse(await readFile(o.bookPath!, 'utf8'))).toEqual({
        kind: 'otzi-address-book',
        version: 1,
        network: 'testnet4',
        entries: [{ label: 'treasury', address: ADDR_A, note: 'cold storage' }],
      });
      expect((await stat(o.bookPath!)).mode & 0o777).toBe(0o640);
    });

    it('appends new entries after the existing ones', async () => {
      await bookAdd({ ...o, label: 'treasury', address: ADDR_A });
      await bookAdd({ ...o, label: 'exchange', address: ADDR_B });
      expect(await book()).toEqual([
        { label: 'treasury', address: ADDR_A },
        { label: 'exchange', address: ADDR_B },
      ]);
    });

    it('updates the label and note of the entry with the same address, in place', async () => {
      await bookAdd({ ...o, label: 'treasury', address: ADDR_A, note: 'old note' });
      await bookAdd({ ...o, label: 'exchange', address: ADDR_B });
      await bookAdd({ ...o, label: 'vault', address: ADDR_A, note: 'new note' });
      expect(await book()).toEqual([
        { label: 'vault', address: ADDR_A, note: 'new note' },
        { label: 'exchange', address: ADDR_B },
      ]);

      // An update without --note clears the note.
      await bookAdd({ ...o, label: 'vault', address: ADDR_A });
      expect(await book()).toEqual([
        { label: 'vault', address: ADDR_A },
        { label: 'exchange', address: ADDR_B },
      ]);
    });

    it('refuses an invalid entry and leaves the book as it was', async () => {
      await bookAdd({ ...o, label: 'treasury', address: ADDR_A });
      const before = await readFile(o.bookPath!, 'utf8');

      await expect(bookAdd({ ...o, label: 'x', address: 'nope' })).rejects.toThrow(
        "cannot save 'x': not a valid testnet4 address",
      );
      await expect(bookAdd({ ...o, label: 'x', address: MAINNET_ADDR })).rejects.toThrow(/not a valid testnet4 address/);
      await expect(bookAdd({ ...o, label: '   ', address: ADDR_B })).rejects.toThrow(/label required/);
      await expect(bookAdd({ ...o, label: 'l'.repeat(65), address: ADDR_B })).rejects.toThrow(/label longer than 64/);
      await expect(bookAdd({ ...o, label: 'x', address: ADDR_B, note: 'n'.repeat(257) })).rejects.toThrow(
        /note longer than 256/,
      );

      expect(await readFile(o.bookPath!, 'utf8')).toBe(before);
    });

    it('refuses to extend a book for another network', async () => {
      await writeFile(
        o.bookPath!,
        JSON.stringify({ kind: 'otzi-address-book', version: 1, network: 'mainnet', entries: [] }),
      );
      await expect(bookAdd({ ...o, label: 'x', address: ADDR_A })).rejects.toThrow(/Address book is for mainnet/);
    });
  });

  describe('bookRemove', () => {
    beforeEach(async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [
        { label: 'treasury', address: ADDR_A },
        { label: 'exchange', address: ADDR_B },
      ]);
    });

    it('removes by label', async () => {
      await bookRemove({ ...o, key: 'treasury' });
      expect(await book()).toEqual([{ label: 'exchange', address: ADDR_B }]);
    });

    it('removes by address', async () => {
      await bookRemove({ ...o, key: ADDR_B });
      expect(await book()).toEqual([{ label: 'treasury', address: ADDR_A }]);
    });

    it('reads a key that is an address as that address first, even when it is also another entry\'s label', async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [
        { label: ADDR_B, address: ADDR_A }, // an address-shaped label
        { label: 'exchange', address: ADDR_B },
      ]);
      await bookRemove({ ...o, key: ADDR_B });
      expect(await book()).toEqual([{ label: ADDR_B, address: ADDR_A }]);

      // The label stays reachable through the address it points to.
      await bookRemove({ ...o, key: ADDR_A });
      expect(await book()).toEqual([]);
    });

    it('fails when nothing matches', async () => {
      const before = await readFile(o.bookPath!, 'utf8');
      await expect(bookRemove({ ...o, key: 'nobody' })).rejects.toThrow("no address book entry matches 'nobody'");
      await expect(bookRemove({ ...o, key: ADDR_C })).rejects.toThrow(`no address book entry matches '${ADDR_C}'`);
      expect(await readFile(o.bookPath!, 'utf8')).toBe(before);
    });

    it('fails on a node without a book', async () => {
      await rm(o.bookPath!);
      await expect(bookRemove({ ...o, key: 'treasury' })).rejects.toThrow("no address book entry matches 'treasury'");
    });

    it('refuses a label that matches several entries, and removes nothing', async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [
        { label: 'ops', address: ADDR_A },
        { label: 'ops', address: ADDR_B },
      ]);
      const before = await readFile(o.bookPath!, 'utf8');

      await expect(bookRemove({ ...o, key: 'ops' })).rejects.toThrow(/'ops' matches 2 entries.*address/);
      expect(await readFile(o.bookPath!, 'utf8')).toBe(before);

      await bookRemove({ ...o, key: ADDR_B });
      expect(await book()).toEqual([{ label: 'ops', address: ADDR_A }]);
    });
  });

  describe('bookImport', () => {
    beforeEach(async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'exchange', address: ADDR_B },
      ]);
    });

    it('import merges by default and reports counts', async () => {
      const file = await bookFile('incoming.otzi.json', [
        { label: 'treasury', address: ADDR_A, note: 'cold storage' }, // unchanged
        { label: 'cex', address: ADDR_B }, // updated: new label
        { label: 'savings', address: ADDR_C }, // added
      ]);

      expect(await bookImport({ ...o, file, replace: false })).toEqual({ added: 1, updated: 1, unchanged: 1 });
      expect(await book()).toEqual([
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'cex', address: ADDR_B },
        { label: 'savings', address: ADDR_C },
      ]);
    });

    it('--replace makes the file the whole book and still reports the counts against the old one', async () => {
      const file = await bookFile('incoming.otzi.json', [
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'savings', address: ADDR_C },
      ]);

      expect(await bookImport({ ...o, file, replace: true })).toEqual({ added: 1, updated: 0, unchanged: 1 });
      expect(await book()).toEqual([
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'savings', address: ADDR_C },
      ]);
    });

    it('creates the book on a node that has none', async () => {
      await rm(o.bookPath!);
      const file = await bookFile('incoming.otzi.json', [{ label: 'savings', address: ADDR_C }]);
      expect(await bookImport({ ...o, file, replace: false })).toEqual({ added: 1, updated: 0, unchanged: 0 });
      expect(await book()).toEqual([{ label: 'savings', address: ADDR_C }]);
      expect((await stat(o.bookPath!)).mode & 0o777).toBe(0o640);
    });

    it('rejects a file for another network and writes nothing', async () => {
      const before = await readFile(o.bookPath!, 'utf8');
      const file = await bookFile('mainnet.otzi.json', [{ label: 'm', address: MAINNET_ADDR }], 'mainnet');
      for (const replace of [false, true]) {
        await expect(bookImport({ ...o, file, replace })).rejects.toThrow(
          new RegExp(`^cannot import: address book ${file}: Address book is for mainnet, this vault is on testnet4`),
        );
      }
      expect(await readFile(o.bookPath!, 'utf8')).toBe(before);
    });

    it('rejects an invalid file and writes nothing', async () => {
      const before = await readFile(o.bookPath!, 'utf8');
      const notJson = join(tmp, 'garbage.json');
      await writeFile(notJson, '{ nope');
      await expect(bookImport({ ...o, file: notJson, replace: false })).rejects.toThrow(/not valid JSON/);

      const badEntry = await bookFile('bad.otzi.json', [{ label: 'x', address: 'nope' }]);
      await expect(bookImport({ ...o, file: badEntry, replace: false })).rejects.toThrow(/Entry 1: not a valid testnet4 address/);

      const absent = join(tmp, 'absent.json');
      await expect(bookImport({ ...o, file: absent, replace: false })).rejects.toThrow(
        new RegExp(`^cannot import: address book ${absent}: cannot be read: ENOENT`),
      );

      expect(await readFile(o.bookPath!, 'utf8')).toBe(before);
    });

    it('refuses a merge that would exceed the entry limit and writes nothing', async () => {
      const before = await readFile(o.bookPath!, 'utf8');
      // The file alone is within the limit; merged with the two entries already in the book it is not.
      const file = await bookFile('full.otzi.json', distinctEntries(1000));
      await expect(bookImport({ ...o, file, replace: false })).rejects.toThrow(/At most 1000 entries/);
      expect(await readFile(o.bookPath!, 'utf8')).toBe(before);

      // As a replacement the same file fits.
      expect(await bookImport({ ...o, file, replace: true })).toEqual({ added: 1000, updated: 0, unchanged: 0 });
      expect(await book()).toHaveLength(1000);
    });
  });

  describe('bookExport', () => {
    beforeEach(async () => {
      await writeAddressBook(o.bookPath!, 'testnet4', [
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'exchange', address: ADDR_B },
      ]);
    });

    it('returns the Ötzi address-book file as pretty JSON', async () => {
      const text = await bookExport(o);
      expect(JSON.parse(text)).toEqual({
        kind: 'otzi-address-book',
        version: 1,
        network: 'testnet4',
        entries: [
          { label: 'treasury', address: ADDR_A, note: 'cold storage' },
          { label: 'exchange', address: ADDR_B },
        ],
      });
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    });

    it('also writes the file when given a path, and imports back unchanged', async () => {
      const out = join(tmp, 'exported.otzi.json');
      const text = await bookExport({ ...o, out });
      expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(JSON.parse(text));

      // Another node imports what this one exported.
      const other: BookOpts = { configPath: o.configPath, bookPath: join(tmp, 'other.otzi.json') };
      expect(await bookImport({ ...other, file: out, replace: false })).toEqual({ added: 2, updated: 0, unchanged: 0 });
      expect(await readAddressBook(other.bookPath!, 'testnet4')).toEqual(await book());
    });

    it('exports an empty book for a node without one', async () => {
      await rm(o.bookPath!);
      expect(JSON.parse(await bookExport(o))).toEqual({ kind: 'otzi-address-book', version: 1, network: 'testnet4', entries: [] });
    });
  });
});
