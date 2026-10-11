import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddressBookFile, mergeAddressBooks, addressBookFile, validateEntries } from './address-book';

const A = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const B = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const C = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

test('exported files parse back', () => {
  const entries = [{ label: 'Cold', address: A }, { label: 'Exchange', address: B, note: 'monthly' }];
  const file = JSON.parse(JSON.stringify(addressBookFile(entries, 'mainnet')));
  assert.deepEqual(parseAddressBookFile(file, 'mainnet'), entries);
});

test('files for another network or kind are rejected', () => {
  const file = addressBookFile([{ label: 'Cold', address: A }], 'mainnet');
  assert.throws(() => parseAddressBookFile(file, 'signet'), /is for mainnet/);
  assert.throws(() => parseAddressBookFile({ ...file, kind: 'manifest' }, 'mainnet'), /Not an Ötzi address book/);
  assert.throws(() => parseAddressBookFile({ ...file, version: 2 }, 'mainnet'), /Unsupported/);
  assert.throws(() => parseAddressBookFile({ ...file, entries: [{ label: 'x', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }] }, 'mainnet'), /Entry 1: not a valid mainnet address/);
  assert.throws(() => validateEntries([{ label: 'a', address: A }, { label: 'b', address: A }], 'mainnet'), /Entry 2: duplicate/);
});

test('merge updates labels by address, keeps the rest, appends new', () => {
  const current = [{ label: 'Cold', address: A }, { label: 'Old exchange', address: B }];
  const incoming = [{ label: 'Exchange', address: B, note: 'new' }, { label: 'Friend', address: C }, { label: 'Cold', address: A }];
  const r = mergeAddressBooks(current, incoming);
  assert.deepEqual(r.entries, [
    { label: 'Cold', address: A },
    { label: 'Exchange', address: B, note: 'new' },
    { label: 'Friend', address: C },
  ]);
  assert.deepEqual({ added: r.added, updated: r.updated, unchanged: r.unchanged }, { added: 1, updated: 1, unchanged: 1 });
});
