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

import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CombinedDkgResult } from '../core/ceremony-runner';
import { getKL } from '../wire/dkg';
import { toHex } from '../wire/hex';
import { encryptShareV3 } from '../wire/share-write';

const BOOTSTRAP_SECRET_PATH = '/var/lib/otzi/bootstrap-secret';

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

  // Wipe the bootstrap secret now that the share is durably written. Phase 9c
  // control-plane verifies operator HMAC against this file; once DKG is done
  // the federation switches to share-based auth and the secret is no longer
  // needed. ENOENT on unlink is silently ignored (idempotent on retries /
  // repeat DKG); other errors are logged but don't fail persistence (share is
  // already on disk; secret-wipe failure is a soft error operators can clean
  // up out-of-band).
  try {
    await unlink(BOOTSTRAP_SECRET_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `share-persistence: failed to unlink bootstrap-secret: ${(err as Error).message}`,
      );
    }
  }
}
