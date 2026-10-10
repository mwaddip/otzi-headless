/**
 * Persistence path for combined-DKG results.
 *
 * Both the leader (after `runCombinedDkg`) and each participant (after
 * `participateInCombinedDkg` settles in the orchestrator) call this to write
 * their own party's share to disk as an Ötzi-compatible encrypted V3 file.
 *
 * File mode is forced to 0o600 (owner read/write only). Parent directory is
 * created if missing — supports operator workflows that point at e.g.
 * `/etc/otzi/share.json` on a fresh box.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NetworkName } from '../config/types';
import type { CombinedDkgResult } from '../core/ceremony-runner';
import { getKL } from '../wire/dkg';
import { toHex } from '../wire/hex';
import { encryptShareV3 } from '../wire/share-write';
import { writeVaultPubkeyFile } from './vault-pubkey';

export interface PersistDkgShareArgs {
  result: CombinedDkgResult;
  threshold: number;
  parties: number;
  level: number;
  path: string;
  password: string;
  /**
   * Optional network. When set, also refresh the operator-facing vault
   * metadata cache (`/var/lib/otzi/vault-pubkey.json`) so the CLI can read
   * the new addresses without waiting for daemon restart. When unset
   * (e.g. test fixtures), skip the cache write — it's a non-essential
   * artifact for vault discovery.
   */
  network?: NetworkName;
}

export async function persistCombinedDkgShare(args: PersistDkgShareArgs): Promise<void> {
  const { K, L } = getKL(args.level);
  const fileObj = await encryptShareV3(
    args.result.mldsa.share,
    args.result.frost.keyPackage,
    toHex(args.result.mldsa.publicKey),
    toHex(args.result.frost.keyPackage.verifyingKey),
    args.threshold,
    args.parties,
    args.level,
    K,
    L,
    args.password,
  );
  // `frostLegacySig` is piggy-backed on the V3 envelope as an extra top-level
  // field — Ötzi's share-file decoder tolerates unknown keys, and our own
  // load path (`config-merge`) reads it back via an intersection type. Kept
  // outside `encryptShareV3`'s typed contract because the sig isn't part of
  // the byte-compat V3 serialization; it's a daemon-side add-on.
  const completeFileObj = args.result.frostLegacySig
    ? { ...fileObj, frostLegacySig: toHex(args.result.frostLegacySig) }
    : fileObj;
  await mkdir(dirname(args.path), { recursive: true });
  await writeFile(args.path, JSON.stringify(completeFileObj, null, 2), { mode: 0o600 });
  // Explicit chmod after write: belt-and-suspenders against umask interference
  // and against the case where the file already existed with looser perms.
  await chmod(args.path, 0o600);

  // Refresh the operator-facing vault metadata cache so a CLI invocation
  // immediately after DKG sees the new addresses (without waiting for a
  // daemon restart). The share is already durable, so a cache refresh failure
  // is a soft error: logged, never thrown.
  if (args.network) {
    try {
      await writeVaultPubkeyFile({
        network: args.network,
        frostUntweakedPubKey: args.result.frost.keyPackage.untweakedVerifyingKey,
        frostTweakedPubKey: args.result.frost.keyPackage.verifyingKey,
        mldsaPubKey: args.result.mldsa.publicKey,
      });
    } catch (err) {
      console.error(
        `share-persistence: failed to refresh vault-pubkey cache: ${(err as Error).message}`,
      );
    }
  }
}
