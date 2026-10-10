/**
 * v4 share files on disk (facts/daemon.md, `vault-share.ts`): load, and the
 * stage / commit / discard lifecycle the DKG ceremony drives.
 *
 * A share reaches `path` only through `commit`, after the DKG's all-N
 * confirmation. Until then it lives at `pendingPath(path)`, which is never
 * loaded. Share files are mode 0600 from the first byte written.
 *
 * The share password is never logged and never put in an error message.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NetworkName } from '../config/types';
import type { DkgCeremonyResult, ShareStager } from '../core/dkg-ceremony';
import type { PartyId } from '../core/types';
import type { Logger } from '../orchestrator/types';
import {
  assertShareMatchesVault,
  decryptShareFile,
  encryptShareFile,
  type DecryptedShare,
} from '../otzi/lib/share-file';
import {
  DEFAULT_VAULT_PUBKEY_PATH,
  vaultPubkeyFromPackage,
  writeVaultPubkeyFile,
} from './vault-pubkey';

/** Validation messages `decryptShareFile` throws itself; everything else is a decryption failure. */
const OTZI_SHARE_MESSAGES: ReadonlySet<string> = new Set([
  'Unsupported share file version',
  'Share file is corrupted',
  'This share file belongs to a different vault',
]);

/** The staging file a DKG writes before the all-N confirmation. */
export function pendingPath(path: string): string {
  return `${path}.pending`;
}

/** True iff a file system entry exists at `path`; false on ENOENT, other `stat` errors throw. */
export async function vaultFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Read, decrypt and check the share at `path` against `network`.
 * Returns `undefined` when no file exists; every other failure throws, so a
 * bad share is never mistaken for "no vault".
 */
export async function loadVaultShare(
  path: string,
  password: string,
  network: NetworkName,
): Promise<DecryptedShare | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`share file ${path} is not valid JSON`, { cause: err });
  }

  let share: DecryptedShare;
  try {
    share = await decryptShareFile(raw, password);
  } catch (err) {
    if (err instanceof Error && OTZI_SHARE_MESSAGES.has(err.message)) throw err;
    // Wrong password (AES-GCM failure) or a ciphertext that does not decode.
    throw new Error(`cannot decrypt share file ${path}: wrong password or corrupted file`, {
      cause: err,
    });
  }
  assertShareMatchesVault(share, network);
  return share;
}

/** Warn about a `.pending` file left by an unfinished DKG. It is never loaded. */
export async function warnOnPendingShare(path: string, log: Logger): Promise<void> {
  const pending = pendingPath(path);
  if (!(await vaultFileExists(pending))) return;
  log.warn(
    `leftover pending share file ${pending} from an unfinished DKG; it is not loaded, and the next DKG overwrites it`,
    { path: pending },
  );
}

export interface ShareStagerOptions {
  path: string;
  password: string;
  network: NetworkName;
  partyId: PartyId;
  /** Where `commit` writes `vault-pubkey.json`; defaults to `DEFAULT_VAULT_PUBKEY_PATH`. */
  vaultPubkeyPath?: string;
}

export function createShareStager(opts: ShareStagerOptions): ShareStager {
  const { path, password, network, partyId } = opts;
  const vaultPubkeyPath = opts.vaultPubkeyPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  const pending = pendingPath(path);
  let staged: DkgCeremonyResult | undefined;

  return {
    async stage(r: DkgCeremonyResult): Promise<void> {
      const file = await encryptShareFile(r.keyPackage, r.publicKeyPackage, network, partyId, password);
      await mkdir(dirname(path), { recursive: true });
      // Remove any earlier .pending first, so the new content is never written
      // into a file that already exists with looser permissions.
      await rm(pending, { force: true });
      await writeFile(pending, JSON.stringify(file), { mode: 0o600, flag: 'wx' });
      // Belt and braces against a restrictive umask having narrowed the mode.
      await chmod(pending, 0o600);
      staged = r;
    },

    async commit(): Promise<void> {
      if (!staged) throw new Error('commit called before stage');
      if (await vaultFileExists(path)) throw new Error(`share path already exists: ${path}`);
      await rename(pending, path);
      // From here the share is in place. A failure below must say so: the
      // caller's abort path would otherwise suggest nothing was kept.
      try {
        await writeVaultPubkeyFile(vaultPubkeyFromPackage(staged.publicKeyPackage, network), vaultPubkeyPath);
      } catch (err) {
        throw new Error(
          `share was committed to ${path} but vault-pubkey.json was not written to ${vaultPubkeyPath}: ${
            err instanceof Error ? err.message : String(err)
          }; the daemon rewrites it on its next start`,
          { cause: err },
        );
      }
    },

    async discard(): Promise<void> {
      try {
        await rm(pending);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
