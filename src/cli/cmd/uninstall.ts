/**
 * `otzi uninstall` — remove the installed manifest. Idempotent.
 */

import { unlink } from 'node:fs/promises';
import { DEFAULT_MANIFEST_PATH } from './install';

export interface UninstallOptions {
  manifestPath?: string;
}

export interface UninstallResult {
  removed: boolean;
}

export async function uninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const path = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  try {
    await unlink(path);
    return { removed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false };
    throw err;
  }
}
