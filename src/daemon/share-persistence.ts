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
import type { CombinedDkgResult } from '../core/ceremony-runner';
import { getKL } from '../wire/dkg';
import { toHex } from '../wire/hex';
import { encryptShareV3 } from '../wire/share-write';

export interface PersistDkgShareArgs {
  result: CombinedDkgResult;
  threshold: number;
  parties: number;
  level: number;
  path: string;
  password: string;
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
  await mkdir(dirname(args.path), { recursive: true });
  await writeFile(args.path, JSON.stringify(fileObj, null, 2), { mode: 0o600 });
  // Explicit chmod after write: belt-and-suspenders against umask interference
  // and against the case where the file already existed with looser perms.
  await chmod(args.path, 0o600);
}
