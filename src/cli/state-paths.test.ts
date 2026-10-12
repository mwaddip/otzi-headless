import { describe, it, expect } from 'vitest';
import { CONFIG_DIR, DATA_DIR, FIXED_STATE_FILES, FIXED_TAR_PATHS, STATE_DIRS, resolveStatePaths } from './state-paths';

const FIXED = FIXED_TAR_PATHS;

/** The failure as `refuse` reports it: `<key>|<path>|<why>`. */
const refusing = (key: string, path: string, why: string): Error => new Error(`${key}|${path}|${why}`);

const resolve = (named: { key: string; path: string }[]) => resolveStatePaths(named, FIXED, refusing);

describe('resolveStatePaths', () => {
  it('names the two directories, tar-relative', () => {
    expect([...STATE_DIRS]).toEqual(['etc/otzi', 'var/lib/otzi']);
  });

  it('names each directory: the config directory and the data directory the daemon user owns files in', () => {
    expect(CONFIG_DIR).toBe('etc/otzi');
    expect(DATA_DIR).toBe('var/lib/otzi');
    expect([...STATE_DIRS]).toEqual([CONFIG_DIR, DATA_DIR]);
  });

  it('returns the tar path of each path directly inside either directory, in order', () => {
    expect(
      resolve([
        { key: 'a', path: '/var/lib/otzi/share.json' },
        { key: 'b', path: '/etc/otzi/identity.json' },
        { key: 'c', path: '/var/lib/otzi/./pubkeys.json' },
        { key: 'd', path: '/var/lib/otzi/../otzi//book.json' },
      ]),
    ).toEqual(['var/lib/otzi/share.json', 'etc/otzi/identity.json', 'var/lib/otzi/pubkeys.json', 'var/lib/otzi/book.json']);
  });

  it.each([
    ['a relative path', 'share.json'],
    ['a relative path that looks right', 'var/lib/otzi/share.json'],
    ['an empty path', ''],
    ['a path outside both', '/srv/share.json'],
    ['a path that climbs out', '/var/lib/otzi/../../../srv/share.json'],
    ['a path that climbs to a sibling', '/var/lib/otzi-evil/share.json'],
    ['the parent of the directories', '/var/lib'],
    ['a directory itself', '/var/lib/otzi'],
    ['a directory itself with a trailing slash', '/etc/otzi/'],
    ['the root', '/'],
  ])('refuses %s as outside', (_name, path) => {
    expect(() => resolve([{ key: '[share].path', path }])).toThrow(
      `[share].path|${path}|is outside /etc/otzi and /var/lib/otzi`,
    );
  });

  it.each([
    ['/var/lib/otzi/keys/share.json'],
    ['/etc/otzi/keys/identity.json'],
    ['/var/lib/otzi/a/b/c.json'],
    ['/var/lib/otzi/keys/../keys/share.json'],
  ])('refuses %s as below a subdirectory', path => {
    expect(() => resolve([{ key: '[node].pubkey_book_file', path }])).toThrow(
      `[node].pubkey_book_file|${path}|is not a direct child of /etc/otzi or /var/lib/otzi`,
    );
  });

  it('refuses a path that names the file of an earlier path, naming the later one', () => {
    expect(() =>
      resolve([
        { key: '[share].path', path: '/var/lib/otzi/share.json' },
        { key: '[node].identity_key_file', path: '/var/lib/otzi/./share.json' },
      ]),
    ).toThrow('[node].identity_key_file|/var/lib/otzi/./share.json|names a file another key also names');
  });

  it.each(FIXED)('refuses a path that names the fixed file %s', fixed => {
    expect(() => resolve([{ key: '[share].path', path: `/${fixed}` }])).toThrow(
      `[share].path|/${fixed}|names a file another key also names`,
    );
  });

  it('reports the first offending path', () => {
    expect(() =>
      resolve([
        { key: 'a', path: '/var/lib/otzi/ok.json' },
        { key: 'b', path: '/srv/b.json' },
        { key: 'c', path: '/srv/c.json' },
      ]),
    ).toThrow(/^b\|/);
  });

  it('returns the error refuse built, unchanged', () => {
    const mine = new TypeError('mine');
    expect(() => resolveStatePaths([{ key: 'k', path: '/srv/x' }], FIXED, () => mine)).toThrow(mine);
  });
});

describe('FIXED_STATE_FILES', () => {
  it('names the files whose place daemon.toml does not choose, as tar paths', () => {
    expect(FIXED_STATE_FILES).toEqual({
      daemonConfig: 'etc/otzi/daemon.toml',
      addressBook: 'etc/otzi/address-book.otzi.json',
      vaultPubkey: 'var/lib/otzi/vault-pubkey.json',
    });
    expect([...FIXED_TAR_PATHS]).toEqual(Object.values(FIXED_STATE_FILES));
  });

  it('puts each directly inside a state directory, so a named path can collide with it', () => {
    for (const tarPath of FIXED_TAR_PATHS) {
      expect(() => resolveStatePaths([{ key: 'k', path: `/${tarPath}` }], [], refusing)).not.toThrow();
      expect(() => resolveStatePaths([{ key: 'k', path: `/${tarPath}` }], FIXED_TAR_PATHS, refusing)).toThrow(
        `k|/${tarPath}|names a file another key also names`,
      );
    }
  });
});
