/**
 * Control-plane handlers — bootstrap-window-only operations.
 *
 * Currently: `manifest-push` (Phase 9c).
 *
 * The daemon accepts these only while `/var/lib/otzi/bootstrap-secret`
 * exists on disk. Phase 9a's `share-persistence.persistCombinedDkgShare`
 * unlinks the secret on first DKG completion; thereafter all control-plane
 * operations are rejected with `ControlPlaneClosed`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateManifest } from '../cli/manifest-validate';
import type { Logger } from '../orchestrator/types';
import { NOOP_LOGGER } from '../orchestrator/types';

const DEFAULT_SECRET_PATH = '/var/lib/otzi/bootstrap-secret';
const DEFAULT_MANIFEST_PATH = '/etc/otzi/manifest.otzi.json';

export class ControlPlaneClosed extends Error {
  constructor() {
    super('control plane closed (post-DKG)');
    this.name = 'ControlPlaneClosed';
  }
}

export class HmacMismatch extends Error {
  constructor() {
    super('HMAC verification failed');
    this.name = 'HmacMismatch';
  }
}

export class ManifestRejected extends Error {
  constructor(reason: string) {
    super(`manifest rejected: ${reason}`);
    this.name = 'ManifestRejected';
  }
}

export class ManifestExists extends Error {
  constructor() {
    super(
      'manifest already installed (and contents differ); local operator must run `otzi uninstall` first',
    );
    this.name = 'ManifestExists';
  }
}

export interface ControlPlaneOpts {
  /** Defaults to `/var/lib/otzi/bootstrap-secret`. */
  secretPath?: string;
  /** Defaults to `/etc/otzi/manifest.otzi.json`. */
  manifestPath?: string;
  logger?: Logger;
}

export class ControlPlane {
  private readonly secretPath: string;
  private readonly manifestPath: string;
  private readonly log: Logger;

  constructor(opts: ControlPlaneOpts = {}) {
    this.secretPath = opts.secretPath ?? DEFAULT_SECRET_PATH;
    this.manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
    this.log = opts.logger ?? NOOP_LOGGER;
  }

  /**
   * Verifies HMAC, validates schema, atomically installs the manifest.
   * Throws on any failure with a typed error. Caller logs + drops.
   *
   * Idempotent on a byte-identical existing manifest (no-op write); refuses
   * with `ManifestExists` if a different manifest is already installed —
   * operator must `otzi uninstall` locally to clear the lock.
   */
  async installPushedManifest(input: { manifest: string; hmacHex: string }): Promise<void> {
    const secret = await this.readSecret();
    if (secret === null) throw new ControlPlaneClosed();

    if (!hmacEquals(secret, input.manifest, input.hmacHex)) throw new HmacMismatch();

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.manifest);
    } catch {
      throw new ManifestRejected('not valid JSON');
    }
    const validation = validateManifest(parsed);
    if (!validation.ok)
      throw new ManifestRejected('schema: ' + validation.errors.join('; '));

    let existing: string | null = null;
    try {
      existing = await readFile(this.manifestPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (existing !== null && existing.trim() !== input.manifest.trim())
      throw new ManifestExists();

    if (existing === null) {
      await mkdir(dirname(this.manifestPath), { recursive: true });
      const tmp = `${this.manifestPath}.tmp`;
      await writeFile(tmp, input.manifest, { mode: 0o660 });
      await rename(tmp, this.manifestPath);
      this.log.info('control-plane: manifest installed', { path: this.manifestPath });
    } else {
      this.log.info('control-plane: manifest unchanged (idempotent)', {
        path: this.manifestPath,
      });
    }
  }

  private async readSecret(): Promise<Buffer | null> {
    try {
      const raw = await readFile(this.secretPath, 'utf8');
      const trimmed = raw.trim();
      if (trimmed.length === 0) return null;
      return Buffer.from(trimmed, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

function hmacEquals(secret: Buffer, payload: string, hmacHex: string): boolean {
  const computed = createHmac('sha256', secret).update(payload, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== computed.length) return false;
  return timingSafeEqual(computed, provided);
}
