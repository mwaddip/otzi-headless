/**
 * `otzi vault [--json]` — print the operator-facing vault metadata.
 *
 * Reads /var/lib/otzi/vault-pubkey.json (written by the daemon at startup
 * post share-decrypt and post-DKG). Two outputs:
 *   - Default: human-readable network + addresses.
 *   - --json:  the raw JSON file contents (for scripts).
 */

import { readFile } from 'node:fs/promises';
import { DEFAULT_VAULT_PUBKEY_PATH } from '../../daemon/vault-pubkey';

export interface VaultOptions {
  vaultPath?: string;
  json?: boolean;
}

export interface VaultPubkey {
  network: string;
  btcAddress: string;
  opnetAddress: string;
  frostUntweakedPubKey: string;
  frostTweakedPubKey: string;
  mldsaPubKeyHex: string;
}

export async function vault(opts: VaultOptions = {}): Promise<string> {
  const path = opts.vaultPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `no vault metadata at ${path}; run \`otzi generate\` to complete DKG, or restart the daemon if DKG already happened.`,
      );
    throw err;
  }
  const data = JSON.parse(raw) as VaultPubkey;
  if (opts.json) return JSON.stringify(data, null, 2);
  return [
    `network:        ${data.network}`,
    `btc address:    ${data.btcAddress}`,
    `opnet address:  ${data.opnetAddress}`,
  ].join('\n');
}
