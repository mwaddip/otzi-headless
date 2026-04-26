/**
 * `otzi install <path>` — copy a `.otzi.json` manifest into the system
 * install location, validating against headless-manifest-v1.
 *
 * Refuses if a manifest already exists (require explicit `otzi uninstall`).
 *
 * Writes are atomic (write to .tmp + rename). chmod 0o660 owner:group; the
 * parent dir's setgid bit (set by postinst) makes the group `otzi`.
 */

import { readFile, writeFile, rename, access, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { validateManifest } from '../manifest-validate';

export const DEFAULT_MANIFEST_PATH = '/etc/otzi/manifest.otzi.json';

export interface InstallOptions {
  /** Source manifest path (`<path>` arg). */
  source: string;
  /** Defaults to `/etc/otzi/manifest.otzi.json`. Tests pass a tmpdir. */
  destination?: string;
}

export async function install(opts: InstallOptions): Promise<void> {
  const dest = opts.destination ?? DEFAULT_MANIFEST_PATH;

  let exists = false;
  try {
    await access(dest);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (exists)
    throw new Error(
      `manifest already installed at ${dest}; run \`otzi uninstall\` first`,
    );

  let raw: string;
  try {
    raw = await readFile(resolvePath(opts.source), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`no such file: ${opts.source}`);
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${opts.source}: not valid JSON`);
  }
  const result = validateManifest(parsed);
  if (!result.ok)
    throw new Error(
      `${opts.source}: schema validation failed:\n  ` + result.errors.join('\n  '),
    );

  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, raw, { mode: 0o660 });
  await rename(tmp, dest);
}
