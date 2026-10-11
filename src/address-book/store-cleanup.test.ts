/**
 * A failed cleanup of the temporary file never replaces the error that made
 * the write fail (facts/address-book.md, `writeAddressBook`). `rm` is made to
 * fail here, which needs its own module mock; the rest of the store is tested
 * in store.test.ts against the real filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
      // Only the store's temporary file fails to go; the test's own cleanup uses `rm` too.
      if (/\.tmp$/.test(path)) throw Object.assign(new Error('EPERM: cleanup refused'), { code: 'EPERM' });
      return actual.rm(path, opts);
    }),
  };
});

const { writeAddressBook } = await import('./store');

const ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('writeAddressBook when the temporary file cannot be removed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'otzi-book-cleanup-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws the error that failed the write, not the cleanup error', async () => {
    const path = join(dir, 'address-book.otzi.json');
    // A non-empty directory at the target makes the final rename fail.
    await mkdir(join(path, 'occupied'), { recursive: true });

    const err = await writeAddressBook(path, 'testnet4', [{ label: 'x', address: ADDR }]).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain('cleanup refused');
    expect((err as NodeJS.ErrnoException).code).toMatch(/ENOTEMPTY|EISDIR|EEXIST|ENOTDIR/);
    // The cleanup really was refused: the temporary file is still there.
    expect((await readdir(dir)).filter(n => n.endsWith('.tmp'))).toHaveLength(1);
  });
});
