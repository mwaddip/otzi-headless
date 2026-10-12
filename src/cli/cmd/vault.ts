/**
 * `otzi vault [--json] [--config <path>]` — print the vault metadata, checked
 * against the daemon (facts/daemon.md, `vault.ts`).
 *
 * `vault-pubkey.json` is written by the daemon, but any member of the `otzi`
 * group can rewrite it, so the CLI asks the daemon's in-memory share
 * (`vault-info`) and compares. A file that disagrees is refused rather than
 * shown: it would put a wrong funding address in front of the operator. With no
 * daemon to ask, or a daemon that has not loaded a vault yet (a DKG just ran and
 * the daemon has not restarted), the file is shown with a note that it was not
 * verified.
 */

import { access } from 'node:fs/promises';
import { DEFAULT_VAULT_PUBKEY_PATH, readVaultPubkeyFile, type VaultPubkeyFile } from '../../daemon/vault-pubkey';
import { DaemonClient } from '../daemon-client';
import {
  NO_VAULT_NOTE,
  askDaemon,
  notVerifiedNote,
  unusableFile,
  vaultMismatch,
  type VaultInfoSource,
} from '../vault-check';

export interface VaultOptions {
  /** The daemon config the client takes its socket from. */
  configPath: string;
  vaultPath?: string;
  json?: boolean;
}

/** Test seams: the CLI's connection to the daemon and its stderr writer. */
export interface VaultDeps {
  /** Default: `DaemonClient` from the config. */
  client?: VaultInfoSource;
  /** Receives the notes (not verified, no `vaultKey`). Default: stderr. */
  warn?: (text: string) => void;
}

export async function vault(opts: VaultOptions, deps: VaultDeps = {}): Promise<string> {
  const path = opts.vaultPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  const warn = deps.warn ?? console.error;
  const json = opts.json === true;
  const answer = await askDaemon(() => deps.client ?? DaemonClient.fromConfig(opts.configPath));

  if (answer.kind === 'unreachable') {
    // Nothing to check against: the file as it is, with a note that says so.
    const file = await readVaultPubkeyFile(path);
    warn(notVerifiedNote(answer.reason));
    return render(file, json);
  }

  const present = await exists(path);
  if (answer.kind === 'no-vault') {
    if (!present)
      throw new Error("the daemon has no vault loaded — run 'otzi generate' to create one, then restart every daemon");
    // A DKG committed this node's share but the daemon has not restarted to load it (the
    // recovery of a partly failed DKG reads the vault from here). Unreadable or invalid still throws.
    const file = await readVaultPubkeyFile(path);
    warn(NO_VAULT_NOTE);
    return render(file, json);
  }

  const { info } = answer;
  let file: VaultPubkeyFile | undefined;
  if (present) {
    try {
      file = await readVaultPubkeyFile(path);
    } catch (err) {
      throw unusableFile(path, err);
    }
    const mismatch = vaultMismatch(path, file, info);
    if (mismatch) throw mismatch;
    if (json) {
      warn(`the per-party values of vaultKey.verifyingShares come from ${path} and are not checked against the daemon`);
    }
  } else if (json) {
    warn(`${path} not found: the JSON has no vaultKey (restart the daemon to rewrite the file)`);
  }

  // Every compared field of the file equals the daemon's, so printing the
  // daemon's values and the file's `vaultKey` shows exactly what the file holds.
  return render(
    {
      network: info.network,
      address: info.address,
      internalKey: info.internalKey,
      outputKey: info.outputKey,
      threshold: info.threshold,
      parties: info.parties,
      ...(file ? { vaultKey: file.vaultKey } : {}),
    },
    json,
  );
}

function render(v: Omit<VaultPubkeyFile, 'vaultKey'> & { vaultKey?: VaultPubkeyFile['vaultKey'] }, json: boolean): string {
  if (json) return JSON.stringify(v, null, 2);
  return [`network:   ${v.network}`, `address:   ${v.address}`, `threshold: ${v.threshold}-of-${v.parties}`].join('\n');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return false;
    throw err;
  }
}
