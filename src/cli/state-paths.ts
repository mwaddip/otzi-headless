/**
 * Where a node's operator-configurable state files may live.
 *
 * The share, identity and pubkey-book paths come from daemon.toml. `otzi
 * restore` runs as root and writes them, so it confines them to the two
 * directories the .deb creates, `/etc/otzi` and `/var/lib/otzi`, and only
 * directly inside them: with no directory in between, no symlink can redirect a
 * write. `otzi backup` applies the same rule, so it never writes an archive that
 * restore would refuse. The rule lives here because restore imports from
 * backup, and neither can import the other.
 *
 * The messages are the callers' own: each passes a `refuse` function that
 * builds its `Error` from the key, the path and a neutral reason.
 */

import { posix } from 'node:path';

/** The directories a node's state lives in, as tar paths (no leading slash). */
export const STATE_DIRS = ['etc/otzi', 'var/lib/otzi'] as const;

/**
 * The tar paths of the files whose place is fixed: daemon.toml does not name
 * them. `otzi backup` packs them and `otzi restore` writes them (with the mode
 * it gives each), and neither of them may be the file a named path resolves to.
 */
export const FIXED_STATE_FILES = {
  daemonConfig: 'etc/otzi/daemon.toml',
  addressBook: 'etc/otzi/address-book.otzi.json',
  vaultPubkey: 'var/lib/otzi/vault-pubkey.json',
} as const;

/** `FIXED_STATE_FILES` as a list, for `resolveStatePaths`'s `fixed` argument. */
export const FIXED_TAR_PATHS: readonly string[] = Object.values(FIXED_STATE_FILES);

const OUTSIDE = 'is outside /etc/otzi and /var/lib/otzi';
const NESTED = 'is not a direct child of /etc/otzi or /var/lib/otzi';
const DUPLICATE = 'names a file another key also names';

/**
 * The tar path of each of `named`, in order: the absolute path resolved
 * (`.` and `..` segments applied) without its leading slash, a direct child of
 * one of `STATE_DIRS`. Throws what `refuse(key, path, why)` returns for the
 * first path that is relative or resolves outside both directories, resolves
 * below a subdirectory of them, or resolves to the file of an earlier path or
 * of one of the `fixed` tar paths.
 */
export function resolveStatePaths(
  named: readonly { key: string; path: string }[],
  fixed: readonly string[],
  refuse: (key: string, path: string, why: string) => Error,
): string[] {
  const taken = new Set(fixed);
  return named.map(({ key, path }) => {
    if (!path.startsWith('/')) throw refuse(key, path, OUTSIDE);
    const tarPath = posix.resolve(path).slice(1);
    if (!(STATE_DIRS as readonly string[]).includes(posix.dirname(tarPath))) {
      throw refuse(key, path, STATE_DIRS.some(dir => tarPath.startsWith(`${dir}/`)) ? NESTED : OUTSIDE);
    }
    if (taken.has(tarPath)) throw refuse(key, path, DUPLICATE);
    taken.add(tarPath);
    return tarPath;
  });
}
