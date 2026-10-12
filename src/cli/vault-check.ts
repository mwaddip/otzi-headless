/**
 * Checking `vault-pubkey.json` against the daemon (facts/daemon.md,
 * `vault-check.ts`).
 *
 * The file is written by the daemon but sits in a directory every member of the
 * `otzi` group can write, so a CLI verb that takes an address or a key from it
 * asks the daemon's in-memory share (`vault-info`) and compares. `otzi vault`
 * and `otzi btc balance|send|sign` share this code.
 */

import { NETWORK_NAMES } from '../config/types';
import type { VaultPubkeyFile } from '../daemon/vault-pubkey';
import { displayText, errorReason } from '../util/text';
import { DaemonClientError, type RequestOptions, type VaultInfo } from './daemon-client';

/** How long the daemon has to answer `vault-info` before it counts as unreachable. */
export const ASK_TIMEOUT_MS = 10_000;

/** The note for values taken from the file while the daemon holds no vault to check them against. */
export const NO_VAULT_NOTE = 'the daemon has not loaded a vault — restart it to load the share; values not verified';

/** What can ask `vault-info`: a `DaemonClient`, or an adapter over its `request`. */
export interface VaultInfoSource {
  vaultInfo(options?: RequestOptions): Promise<VaultInfo>;
}

/** What asking the daemon came to. */
export type DaemonAnswer =
  | { kind: 'vault'; info: VaultInfo }
  | { kind: 'no-vault' }
  | { kind: 'unreachable'; reason: string };

/** `vault-info` through a client that only has `request` (the `CliDeps.client` shape). */
export function infoFromRequest(client: {
  request<T>(body: unknown, options?: RequestOptions): Promise<T>;
}): VaultInfoSource {
  return { vaultInfo: options => client.request<VaultInfo>({ op: 'vault-info' }, options) };
}

/** The stderr note for values taken from the file while the daemon could not be asked. */
export function notVerifiedNote(reason: string): string {
  return `not verified against the daemon (${reason})`;
}

/**
 * Ask the daemon for its vault. A daemon that answers 409 holds no vault. A
 * client that cannot be built (`getClient` throws: the config is unreadable, or
 * names no way to reach the daemon), a system error while asking (no socket,
 * connection refused, socket not readable), a 401 or 403 (the daemon refuses
 * this CLI itself) and no answer within `timeoutMs` (the request is then
 * aborted, so the process can exit) all mean nothing could be asked. Anything else (another status, a reply that is not JSON or not a
 * vault-info) is a daemon that answered badly and is thrown.
 */
export async function askDaemon(
  getClient: () => VaultInfoSource | Promise<VaultInfoSource>,
  timeoutMs: number = ASK_TIMEOUT_MS,
): Promise<DaemonAnswer> {
  let client: VaultInfoSource;
  try {
    client = await getClient();
  } catch (err) {
    return { kind: 'unreachable', reason: displayText(errorReason(err)) };
  }

  const controller = new AbortController();
  const silent: DaemonAnswer = { kind: 'unreachable', reason: `no answer within ${timeoutMs / 1000} s` };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<'silent'>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('silent');
      controller.abort();
    }, timeoutMs);
  });
  let info: unknown;
  try {
    const answer = await Promise.race([client.vaultInfo({ signal: controller.signal }), silence]);
    if (answer === 'silent') return silent;
    info = answer;
  } catch (err) {
    // The request this timeout aborted fails with an AbortError; that is the silence, not an answer.
    if (timedOut) return silent;
    if (err instanceof DaemonClientError) {
      if (err.status === 409) return { kind: 'no-vault' };
      // The daemon will not answer this CLI (a token it does not send, a Host it refuses): nothing
      // could be asked, as when it is down (Ruling P17).
      if (err.status === 401 || err.status === 403)
        return { kind: 'unreachable', reason: displayText(`${err.status} ${err.message}`) };
      throw err;
    }
    if (typeof (err as { code?: unknown } | null)?.code === 'string')
      return { kind: 'unreachable', reason: displayText(errorReason(err)) };
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return { kind: 'vault', info: checkInfo(info) };
}

function checkInfo(info: unknown): VaultInfo {
  const o = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
  const strings = ['address', 'internalKey', 'outputKey'].every(f => typeof o[f] === 'string' && o[f] !== '');
  const numbers = ['threshold', 'parties'].every(f => Number.isInteger(o[f]) && (o[f] as number) >= 1);
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
  // The CLI builds transactions and prints `--json` from the file's `vaultKey`,
  // which the daemon does not send; what it must agree with is what the daemon
  // does send.
  compare('vaultKey.untweakedVerifyingKey', file.vaultKey.untweakedVerifyingKey, info.internalKey);
  compare('vaultKey.minSigners', file.vaultKey.minSigners, info.threshold);
  compare('vaultKey.verifyingShares', Object.keys(file.vaultKey.verifyingShares).length, info.parties, ' entries');
  return out;
}

function mismatchError(path: string, lines: string[]): Error {
  return new Error(
    [
      `the vault metadata ${path} does not match the daemon's loaded share:`,
      ...lines.map(l => `  ${l}`),
      `The file may have been changed by another member of the otzi group; do not use its address.`,
      `Restart the daemon to rewrite ${path} from the loaded share.`,
    ].join('\n'),
  );
}

/**
 * The error for a file that disagrees with the vault the daemon holds, naming
 * the path and each differing field; `undefined` when they agree.
 */
export function vaultMismatch(path: string, file: VaultPubkeyFile, info: VaultInfo): Error | undefined {
  const lines = differences(file, info);
  return lines.length > 0 ? mismatchError(path, lines) : undefined;
}

/** The error for a file that exists but cannot be read or validated, while the daemon holds a vault. */
export function unusableFile(path: string, err: unknown): Error {
  return mismatchError(path, [`cannot be used: ${displayText(errorReason(err))}`]);
}
