/**
 * Loads the daemon TOML config, the share password and the v4 share (if
 * present) into `LoadedDaemonState` (facts/daemon.md, `config-merge.ts`).
 *
 * Two startup modes:
 *  - **Share present.** The file is decrypted and checked against the
 *    configured network; the daemon can sign. `vault-pubkey.json` is
 *    rewritten from it so the CLI always reads what the loaded share says.
 *  - **No share** (no file at `[share].path`). The daemon comes up without a
 *    vault and can run the run-once DKG; signing is refused until the
 *    operator restarts after `otzi generate`.
 *
 * Both modes need the password env var: it decrypts an existing share or
 * encrypts the one a DKG produces. A share that fails any check refuses
 * startup; it is never treated as "no vault".
 */

import { loadDaemonConfig } from '../config/load';
import type { DaemonConfig } from '../config/types';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import type { DecryptedShare } from '../otzi/lib/share-file';
import {
  DEFAULT_VAULT_PUBKEY_PATH,
  vaultPubkeyFromPackage,
  writeVaultPubkeyFile,
} from './vault-pubkey';
import { loadVaultShare, warnOnPendingShare } from './vault-share';

export interface LoadedDaemonState {
  config: DaemonConfig;
  /** The decrypted v4 share; undefined on a node without a vault. */
  share?: DecryptedShare;
  /** Kept in memory so a DKG on this node can encrypt its new share with it. */
  password: string;
}

export interface LoadOptions {
  /** Env source for the password. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where `vault-pubkey.json` is rewritten. Defaults to `DEFAULT_VAULT_PUBKEY_PATH`. */
  vaultPubkeyPath?: string;
  /** Receives the stale-`.pending` warning and a failed `vault-pubkey.json` write. Defaults to `NOOP_LOGGER`. */
  logger?: Logger;
}

export async function loadAndValidate(
  configPath: string,
  options: LoadOptions = {},
): Promise<LoadedDaemonState> {
  const env = options.env ?? process.env;
  const vaultPubkeyPath = options.vaultPubkeyPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  const logger = options.logger ?? NOOP_LOGGER;

  const config = await loadDaemonConfig(configPath);
  const password = env[config.share.passwordEnv];
  if (!password)
    throw new Error(
      `daemon: env var '${config.share.passwordEnv}' not set — it must be set both to decrypt an existing share and to encrypt the share a DKG produces`,
    );

  const share = await loadVaultShare(config.share.path, password, config.network.name);

  if (share) {
    // Best-effort: the daemon must start even when the metadata directory is
    // not writable. CLI verbs that need the file tell the operator how to
    // recover.
    try {
      await writeVaultPubkeyFile(
        vaultPubkeyFromPackage(share.publicKeyPackage, config.network.name),
        vaultPubkeyPath,
      );
    } catch (err) {
      logger.warn(`failed to write vault-pubkey.json to ${vaultPubkeyPath}; continuing without it`, {
        path: vaultPubkeyPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await warnOnPendingShare(config.share.path, logger);

  return { config, ...(share ? { share } : {}), password };
}
