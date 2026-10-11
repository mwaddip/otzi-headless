/**
 * v4 share files on disk (facts/daemon.md, `vault-share.ts`): load, and the
 * stage / commit / discard lifecycle the DKG ceremony drives.
 *
 * A share reaches `path` only through `commit`, after the DKG's all-N
 * confirmation. Until then it lives at `pendingPath(path)`, which is never
 * loaded. Share files are mode 0600 from the first byte written. The staged
 * share is synced to disk before `stage` resolves (the node publishes its
 * confirmation right after), and `commit` links it into place, so it never
 * replaces an existing vault.
 *
 * The share password is never logged and never put in an error message.
 */

import { link, mkdir, open, readFile, rm, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NetworkName } from '../config/types';
import { NETWORK_NAMES } from '../config/types';
import type { DkgCeremonyResult, ShareStager } from '../core/dkg-ceremony';
import type { PartyId } from '../core/types';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import { vaultPaymentFromInternalKey } from '../otzi/lib/bitcoin';
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
  if (share.network !== network) {
    throw new Error(`share file ${path} is for ${share.network}, [network].name is ${network}`);
  }
  assertShareMatchesVault(share, network);
  return share;
}

/**
 * Warn about a `.pending` file left by an unfinished DKG. It is never loaded:
 * it may be this node's share of a vault the other nodes committed (a node
 * that published its confirmation keeps it), or a stale one the next DKG
 * overwrites.
 */
export async function warnOnPendingShare(path: string, log: Logger): Promise<void> {
  const pending = pendingPath(path);
  if (!(await vaultFileExists(pending))) return;
  const address = await pendingVaultAddress(pending);
  const vault = address ? `vault ${address}` : 'that vault';
  log.warn(
    `leftover pending share file ${pending} from an unfinished DKG; it is not loaded. ` +
      `It may be this node's share of a vault${address ? ` (${address})` : ''} the other nodes committed: ` +
      `if 'otzi vault' on another node shows ${vault}, rename ${pending} to ${path} and restart the daemon; ` +
      `otherwise the next DKG overwrites it`,
    { path: pending, ...(address ? { address } : {}) },
  );
}

/** The vault address in a share file's plaintext header, or undefined when it does not read. */
async function pendingVaultAddress(file: string): Promise<string | undefined> {
  try {
    const header = JSON.parse(await readFile(file, 'utf8')) as { network?: unknown; internalKey?: unknown };
    const { network, internalKey } = header;
    if (typeof internalKey !== 'string' || !(NETWORK_NAMES as readonly unknown[]).includes(network)) return undefined;
    return vaultPaymentFromInternalKey(internalKey, network as NetworkName).address;
  } catch {
    return undefined;
  }
}

export interface ShareStagerOptions {
  path: string;
  password: string;
  network: NetworkName;
  partyId: PartyId;
  /** Where `commit` writes `vault-pubkey.json`; defaults to `DEFAULT_VAULT_PUBKEY_PATH`. */
  vaultPubkeyPath?: string;
  /** Receives the warnings `commit` logs once the share is in place. */
  logger?: Logger;
}

export function createShareStager(opts: ShareStagerOptions): ShareStager {
  const { path, password, network, partyId } = opts;
  const vaultPubkeyPath = opts.vaultPubkeyPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  const log = opts.logger ?? NOOP_LOGGER;
  const pending = pendingPath(path);
  const dir = dirname(path);
  let staged: DkgCeremonyResult | undefined;
  /**
   * True while `pending` is a file this stager created and not yet committed.
   * `discard` removes only that file: any other `.pending` may be the share a
   * node kept after publishing its confirmation (ruling R41), and a DKG that
   * fails before it stages (the committed nodes drop its announce) must not
   * delete it.
   */
  let wrote = false;

  /** Once the share is in place, a failed step is a warning: the vault exists. */
  const afterCommit = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (err) {
      log.warn(`share committed to ${path}, but ${what}: ${errorText(err)}`, { path });
    }
  };

  return {
    sharePath: path,
    stagedPath: pending,

    async stage(r: DkgCeremonyResult): Promise<void> {
      const file = await encryptShareFile(r.keyPackage, r.publicKeyPackage, network, partyId, password);
      await mkdir(dir, { recursive: true });
      // Remove any earlier .pending first, so the new content is never written
      // into a file that already exists with looser permissions.
      await rm(pending, { force: true });
      const handle = await open(pending, 'wx', 0o600);
      wrote = true;
      try {
        await handle.writeFile(JSON.stringify(file));
        // Belt and braces against a restrictive umask having narrowed the mode.
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The directory entry too: the confirmation published next promises a durable share.
      await syncDir(dir);
      staged = r;
    },

    async commit(): Promise<void> {
      if (!staged) throw new Error('commit called before stage');
      // A link never replaces an existing entry, so a vault that appeared
      // meanwhile (or any other entry, a dangling symlink included) is kept.
      try {
        await link(pending, path);
      } catch (err) {
        if (hasCode(err, 'EEXIST')) throw new Error(`share path already exists: ${path}`, { cause: err });
        throw err;
      }
      // From here the share is in place and commit succeeds; the staging name is
      // just a second name for it, no longer a file to discard.
      wrote = false;
      const meta = vaultPubkeyFromPackage(staged.publicKeyPackage, network);
      await afterCommit(`its staging file ${pending} (the same file) was not removed`, () => unlink(pending));
      await afterCommit(`its directory ${dir} was not synced`, () => syncDir(dir));
      await afterCommit(
        `vault-pubkey.json was not written to ${vaultPubkeyPath}; the daemon rewrites it on its next start`,
        () => writeVaultPubkeyFile(meta, vaultPubkeyPath),
      );
    },

    async discard(): Promise<void> {
      // Nothing of this ceremony's on disk: whatever `.pending` exists is not ours to remove.
      if (!wrote) return;
      try {
        await rm(pending);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      wrote = false;
    },
  };
}

/** fsync a directory, so the entries created or removed in it are durable. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

function isNotFound(err: unknown): boolean {
  return hasCode(err, 'ENOENT');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
