/**
 * `otzi vault [--json]` — print the vault metadata (facts/daemon.md,
 * `vault.ts`).
 *
 * Reads `vault-pubkey.json`, which the daemon writes at startup (whenever a
 * share is loaded) and when a DKG commits. Works without the daemon.
 */

import { readVaultPubkeyFile } from '../../daemon/vault-pubkey';

export interface VaultOptions {
  vaultPath?: string;
  json?: boolean;
}

export async function vault(opts: VaultOptions = {}): Promise<string> {
  const file = await readVaultPubkeyFile(opts.vaultPath);
  if (opts.json) return JSON.stringify(file, null, 2);
  return [
    `network:   ${file.network}`,
    `address:   ${file.address}`,
    `threshold: ${file.threshold}-of-${file.parties}`,
  ].join('\n');
}
