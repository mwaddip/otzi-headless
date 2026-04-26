/**
 * `otzi sync <path>` — distribute a manifest to all peers via the daemon's
 * control plane.
 *
 * Bootstrap-window-only: requires `/var/lib/otzi/bootstrap-secret` to be
 * present (locally and on every peer — the secret was set up at debconf
 * install time and shared between operators out of band). Post-DKG, the
 * daemon returns 410 "control plane closed" and this command exits with a
 * clear message; operators must run `otzi install` on each node instead.
 */

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { validateManifest } from '../manifest-validate';
import { DaemonClient, DaemonClientError } from '../daemon-client';

const DEFAULT_SECRET_PATH = '/var/lib/otzi/bootstrap-secret';

export interface SyncOptions {
  configPath: string;
  source: string;
  /** Defaults to `/var/lib/otzi/bootstrap-secret`. Tests override. */
  secretPath?: string;
}

export interface SyncResult {
  ceremonyId: string;
  peersNotified: number;
}

export async function sync(opts: SyncOptions): Promise<SyncResult> {
  // Step 1: read + validate the manifest locally so the operator gets a
  // clear schema error before we touch the daemon or any peers.
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
  const validation = validateManifest(parsed);
  if (!validation.ok)
    throw new Error(
      `${opts.source}: schema validation failed:\n  ` + validation.errors.join('\n  '),
    );

  // Step 2: read the bootstrap secret. Absent → control plane closed.
  const secretPath = opts.secretPath ?? DEFAULT_SECRET_PATH;
  let secret: string;
  try {
    secret = (await readFile(secretPath, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `control plane closed: ${secretPath} is absent (post-DKG). Use \`otzi install\` on each node instead.`,
      );
    throw err;
  }
  if (secret.length === 0) throw new Error(`bootstrap secret at ${secretPath} is empty`);

  // Step 3: HMAC over the verbatim manifest text — no canonicalization.
  const hmac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(raw, 'utf8')
    .digest('hex');

  // Step 4: POST op:'sync' to the local daemon. Daemon installs locally then
  // broadcasts to peers.
  const client = await DaemonClient.fromConfig(opts.configPath);
  try {
    const response = await client.request<{
      ceremonyId: string;
      status: string;
      peersNotified: number;
    }>({
      op: 'sync',
      manifest: raw,
      hmac,
    });
    return { ceremonyId: response.ceremonyId, peersNotified: response.peersNotified };
  } catch (err) {
    if (err instanceof DaemonClientError && err.status === 410) {
      throw new Error('control plane closed (post-DKG); manifest sync is no longer accepted');
    }
    throw err;
  }
}
