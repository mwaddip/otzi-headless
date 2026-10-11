/**
 * `otzi vault [--json] [--config <path>]` — print the vault metadata, checked
 * against the daemon (facts/daemon.md, `vault.ts`).
 *
 * `vault-pubkey.json` is written by the daemon, but any member of the `otzi`
 * group can rewrite it, so the CLI asks the daemon's in-memory share
 * (`vault-info`) and compares. A file that disagrees is refused rather than
 * shown: it would put a wrong funding address in front of the operator. With no
 * daemon to ask, the file is shown with a note that it was not verified.
 */

import { access } from 'node:fs/promises';
import { NETWORK_NAMES } from '../../config/types';
import { DEFAULT_VAULT_PUBKEY_PATH, readVaultPubkeyFile, type VaultPubkeyFile } from '../../daemon/vault-pubkey';
import { displayText, errorReason } from '../../util/text';
import { DaemonClient, DaemonClientError, type VaultInfo } from '../daemon-client';

export interface VaultOptions {
  /** The daemon config the client takes its socket from. */
  configPath: string;
  vaultPath?: string;
  json?: boolean;
}

/** Test seams: the CLI's connection to the daemon and its stderr writer. */
export interface VaultDeps {
  /** Default: `DaemonClient` from the config. */
  client?: Pick<DaemonClient, 'vaultInfo'>;
  /** Receives the notes (not verified, no `vaultKey`). Default: stderr. */
  warn?: (text: string) => void;
}

/** What asking the daemon came to. */
type DaemonAnswer =
  | { kind: 'vault'; info: VaultInfo }
  | { kind: 'no-vault' }
  | { kind: 'unreachable'; reason: string };

export async function vault(opts: VaultOptions, deps: VaultDeps = {}): Promise<string> {
  const path = opts.vaultPath ?? DEFAULT_VAULT_PUBKEY_PATH;
  const warn = deps.warn ?? console.error;
  const answer = await askDaemon(opts.configPath, deps.client);

  if (answer.kind === 'unreachable') {
    // Nothing to check against: the file as it is, with a note that says so.
    const file = await readVaultPubkeyFile(path);
    warn(`not verified against the daemon (${answer.reason})`);
    return render(file, opts.json === true);
  }

  const present = await exists(path);
  if (answer.kind === 'no-vault') {
    if (!present)
      throw new Error("the daemon has no vault loaded — run 'otzi generate' to create one, then restart every daemon");
    throw new Error(
      `the daemon has no vault loaded, so the vault metadata ${path} does not match a loaded vault — ` +
        `if a DKG has just completed, restart the daemon to load its share; otherwise run 'otzi generate'`,
    );
  }

  const { info } = answer;
  let file: VaultPubkeyFile | undefined;
  if (present) {
    try {
      file = await readVaultPubkeyFile(path);
    } catch (err) {
      throw mismatch(path, [`cannot be used: ${displayText(errorReason(err))}`]);
    }
    const differing = differences(file, info);
    if (differing.length > 0) throw mismatch(path, differing);
  } else if (opts.json) {
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
    opts.json === true,
  );
}

function render(v: Omit<VaultPubkeyFile, 'vaultKey'> & { vaultKey?: VaultPubkeyFile['vaultKey'] }, json: boolean): string {
  if (json) return JSON.stringify(v, null, 2);
  return [`network:   ${v.network}`, `address:   ${v.address}`, `threshold: ${v.threshold}-of-${v.parties}`].join('\n');
}

/**
 * Ask the daemon for its vault. A daemon that answers 409 holds no vault. A
 * config the client cannot be built from, or a system error while asking (no
 * socket, connection refused, socket not readable), means nothing could be
 * asked. Anything else (another status, a reply that is not JSON) is a daemon
 * that answered badly and is thrown.
 */
async function askDaemon(configPath: string, injected: VaultDeps['client']): Promise<DaemonAnswer> {
  let client: Pick<DaemonClient, 'vaultInfo'>;
  try {
    client = injected ?? (await DaemonClient.fromConfig(configPath));
  } catch (err) {
    return { kind: 'unreachable', reason: displayText(errorReason(err)) };
  }
  let info: unknown;
  try {
    info = await client.vaultInfo();
  } catch (err) {
    if (err instanceof DaemonClientError) {
      if (err.status === 409) return { kind: 'no-vault' };
      throw err;
    }
    if (typeof (err as { code?: unknown } | null)?.code === 'string')
      return { kind: 'unreachable', reason: displayText(errorReason(err)) };
    throw err;
  }
  return { kind: 'vault', info: checkInfo(info) };
}

function checkInfo(info: unknown): VaultInfo {
  const o = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
  const strings = ['address', 'internalKey', 'outputKey'].every((f) => typeof o[f] === 'string' && o[f] !== '');
  const numbers = ['threshold', 'parties'].every((f) => Number.isInteger(o[f]) && (o[f] as number) >= 1);
  if (!strings || !numbers || !(NETWORK_NAMES as readonly string[]).includes(o.network as string))
    throw new Error("daemon reply to 'vault-info' has no vault (network, address, internalKey, outputKey, threshold, parties)");
  return o as unknown as VaultInfo;
}

/** The fields of the file that differ from the daemon's, one line each. */
function differences(file: VaultPubkeyFile, info: VaultInfo): string[] {
  const out: string[] = [];
  const compare = (field: string, fromFile: string | number, fromDaemon: string | number, unit = '') => {
    if (fromFile !== fromDaemon)
      out.push(`${field}: file ${displayText(String(fromFile))}${unit}, daemon ${displayText(String(fromDaemon))}`);
  };
  compare('network', file.network, info.network);
  compare('address', file.address, info.address);
  compare('internalKey', file.internalKey, info.internalKey);
  compare('outputKey', file.outputKey, info.outputKey);
  compare('threshold', file.threshold, info.threshold);
  compare('parties', file.parties, info.parties);
  // `--json` prints the file's `vaultKey`, which the daemon does not send; what
  // it must agree with is what the daemon does send.
  compare('vaultKey.untweakedVerifyingKey', file.vaultKey.untweakedVerifyingKey, info.internalKey);
  compare('vaultKey.minSigners', file.vaultKey.minSigners, info.threshold);
  compare('vaultKey.verifyingShares', Object.keys(file.vaultKey.verifyingShares).length, info.parties, ' entries');
  return out;
}

function mismatch(path: string, lines: string[]): Error {
  return new Error(
    [
      `the vault metadata ${path} does not match the daemon's loaded share:`,
      ...lines.map((l) => `  ${l}`),
      `The file may have been changed by another member of the otzi group; do not use its address.`,
      `Restart the daemon to rewrite ${path} from the loaded share.`,
    ].join('\n'),
  );
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
