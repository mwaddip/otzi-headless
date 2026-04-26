/**
 * `otzi backup` — produce a single password-protected archive of full daemon
 * state (config + manifest + share + identity + pubkey-book + bootstrap-secret
 * + meta) so an operator who loses their host can recover into a fresh `.deb`
 * install via `otzi restore`.
 *
 * The archive layout is a versioned, magic-prefixed binary file:
 *
 *   0..32     "OTZI-BACKUP-V1\0\0\0..."  (32B magic, NUL-padded)
 *   32..48    salt                        (16B random; PBKDF2 input)
 *   48..60    iv                          (12B random; AES-GCM IV)
 *   60..76    auth tag                    (16B; written after encryption)
 *   76..end   ciphertext                  (AES-256-GCM(gzip(tar(file set))))
 *
 * KDF: PBKDF2-SHA256, 600,000 iterations (OWASP 2026), 32B → AES-256 key.
 * Cipher: AES-256-GCM (authenticated; tampering → decrypt fails cleanly).
 *
 * Password: 32 chars from base62 (`[A-Za-z0-9]`, ~190 bits entropy), generated
 * here — operators don't choose, so we don't have to police weak passwords.
 *
 * This function returns the archive path + password; the CLI wrapper in
 * `src/daemon/entrypoint.ts` is responsible for the operator-facing banner.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { hostname, homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { create as tarCreate } from 'tar';
import { parseDaemonConfigToml } from '../../config/parse';

export const DEFAULT_DAEMON_CONFIG_PATH = '/etc/otzi/daemon.toml';
export const DEFAULT_MANIFEST_PATH = '/etc/otzi/manifest.otzi.json';
export const DEFAULT_SHARE_PATH = '/var/lib/otzi/share.json';
export const DEFAULT_IDENTITY_PATH = '/var/lib/otzi/identity.json';
export const DEFAULT_PUBKEY_BOOK_PATH = '/var/lib/otzi/pubkeys.json';
export const DEFAULT_VAULT_PUBKEY_PATH = '/var/lib/otzi/vault-pubkey.json';
export const DEFAULT_BOOTSTRAP_SECRET_PATH = '/var/lib/otzi/bootstrap-secret';

export const BACKUP_MAGIC = 'OTZI-BACKUP-V1';
export const BACKUP_MAGIC_LEN = 32;
export const BACKUP_SALT_LEN = 16;
export const BACKUP_IV_LEN = 12;
export const BACKUP_TAG_LEN = 16;
export const BACKUP_HEADER_LEN =
  BACKUP_MAGIC_LEN + BACKUP_SALT_LEN + BACKUP_IV_LEN + BACKUP_TAG_LEN; // 76
export const BACKUP_PBKDF2_ITERATIONS = 600_000;

const BASE62_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 32 chars from base62 → 62^32 ≈ 190 bits entropy. The mod-62 reduction over
 * uniform 0-255 bytes gives a marginal bias on 8/62 of the alphabet (256 % 62
 * = 8); residual entropy is still ≈ 189.7 bits. Acceptable; not worth
 * rejection sampling.
 */
function generatePassword(): string {
  const bytes = randomBytes(32);
  let out = '';
  for (let i = 0; i < 32; i++) out += BASE62_ALPHABET[bytes[i]! % 62];
  return out;
}

/** Filesystem-safe ISO-8601 timestamp (colons + dots → dashes). */
function safeIsoTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

interface FileEntry {
  /** Tar path inside the archive (RELATIVE — no leading slash). */
  tarPath: string;
  /** Absolute source path on the install host. */
  sourcePath: string;
  /** If true, missing source → fail backup. If false, missing → skip silently. */
  required: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export interface BackupOptions {
  /** Defaults to `/etc/otzi/daemon.toml`. */
  configPath?: string;
  /** Defaults to `os.homedir()` (operator-facing). Test seam. */
  outputDir?: string;
  /**
   * Test seam: if set, skips random password generation and uses this verbatim.
   * Production callers should never set this — operators don't pick passwords.
   */
  passwordOverride?: string;
  /** Test seam for filename ISO. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Test seam: override the "fixed" file paths that aren't derived from
   * daemon.toml. Production callers leave these alone; tests point them at a
   * tmpdir-rooted layout so we don't read /etc/otzi/* during a unit test.
   */
  pathOverrides?: {
    manifest?: string;
    vaultPubkey?: string;
    bootstrapSecret?: string;
  };
}

export interface BackupResult {
  /** Absolute path to the written archive. */
  path: string;
  /** Generated (or override) password. The CLI wrapper prints the banner. */
  password: string;
  /** Tar paths that ended up in the archive (skipped optionals omitted). */
  filesIncluded: string[];
}

export async function runBackup(opts: BackupOptions = {}): Promise<BackupResult> {
  const configPath = opts.configPath ?? DEFAULT_DAEMON_CONFIG_PATH;
  const outputDir = opts.outputDir ?? homedir();
  const now = (opts.now ?? (() => new Date()))();

  // --- Step 1: read daemon.toml to learn the actual share / identity / pubkey
  // paths. The other paths are fixed.
  let configText: string;
  try {
    configText = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `cannot back up: required file missing: ${configPath}. ` +
          'This looks like a fresh / pre-bootstrap install; nothing meaningful to back up yet.',
      );
    throw err;
  }
  const config = parseDaemonConfigToml(configText);
  const sharePath = config.share.path;
  const identityPath = config.node.identityKeyFile ?? DEFAULT_IDENTITY_PATH;
  const pubkeyBookPath = config.node.pubkeyBookFile ?? DEFAULT_PUBKEY_BOOK_PATH;
  const partyId = config.node.partyId;

  const manifestSource = opts.pathOverrides?.manifest ?? DEFAULT_MANIFEST_PATH;
  const vaultPubkeySource =
    opts.pathOverrides?.vaultPubkey ?? DEFAULT_VAULT_PUBKEY_PATH;
  const bootstrapSecretSource =
    opts.pathOverrides?.bootstrapSecret ?? DEFAULT_BOOTSTRAP_SECRET_PATH;

  // --- Step 2: assemble the file table. Tar paths are RELATIVE (no leading
  // slash) so restore can `chroot`-style place them back at the corresponding
  // absolute paths.
  const fileSet: FileEntry[] = [
    { tarPath: 'etc/otzi/daemon.toml', sourcePath: configPath, required: true },
    {
      tarPath: 'etc/otzi/manifest.otzi.json',
      sourcePath: manifestSource,
      required: false,
    },
    { tarPath: stripLeadingSlash(sharePath), sourcePath: sharePath, required: true },
    {
      tarPath: stripLeadingSlash(pubkeyBookPath),
      sourcePath: pubkeyBookPath,
      required: true,
    },
    {
      tarPath: stripLeadingSlash(identityPath),
      sourcePath: identityPath,
      required: true,
    },
    {
      tarPath: 'var/lib/otzi/vault-pubkey.json',
      sourcePath: vaultPubkeySource,
      required: false,
    },
    {
      tarPath: 'var/lib/otzi/bootstrap-secret',
      sourcePath: bootstrapSecretSource,
      required: false,
    },
  ];

  // --- Step 3: required-file existence pre-flight. Fail loudly if any is
  // missing (no useless half-empty archive).
  const missingRequired: string[] = [];
  for (const e of fileSet) {
    if (!e.required) continue;
    if (!(await pathExists(e.sourcePath))) missingRequired.push(e.sourcePath);
  }
  if (missingRequired.length > 0) {
    throw new Error(
      `cannot back up: required file(s) missing: ${missingRequired.join(', ')}. ` +
        'This looks like a fresh / pre-bootstrap install; nothing meaningful to back up yet.',
    );
  }

  // --- Step 4: stage files into a tmpdir under their tar-relative paths so
  // `tar.create({ cwd: staging, ... })` produces the correct in-archive layout.
  const staging = await mkdtemp(join(tmpdir(), 'otzi-backup-stage-'));
  const filesIncluded: string[] = [];
  try {
    for (const e of fileSet) {
      if (!e.required && !(await pathExists(e.sourcePath))) continue;
      const dest = join(staging, e.tarPath);
      await mkdir(dirname(dest), { recursive: true });
      await cp(e.sourcePath, dest, { preserveTimestamps: true });
      filesIncluded.push(e.tarPath);
    }

    // meta.json is generated, not copied.
    const meta = {
      version: 1,
      createdAt: now.toISOString(),
      hostname: hostname(),
      partyId,
    };
    const metaPath = join(staging, 'meta.json');
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    filesIncluded.push('meta.json');

    // --- Step 5: produce gzipped tar in memory.
    const tarChunks: Buffer[] = [];
    const stream = tarCreate(
      { cwd: staging, gzip: true, portable: true, prefix: '' },
      filesIncluded,
    );
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      tarChunks.push(chunk);
    }
    const plaintext = Buffer.concat(tarChunks);

    // --- Step 6: encrypt.
    const password = opts.passwordOverride ?? generatePassword();
    const salt = randomBytes(BACKUP_SALT_LEN);
    const iv = randomBytes(BACKUP_IV_LEN);
    const key = pbkdf2Sync(
      Buffer.from(password, 'utf8'),
      salt,
      BACKUP_PBKDF2_ITERATIONS,
      32,
      'sha256',
    );
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    if (authTag.length !== BACKUP_TAG_LEN)
      throw new Error(
        `internal: GCM auth tag length ${authTag.length} != ${BACKUP_TAG_LEN}`,
      );

    // --- Step 7: assemble wire-format buffer.
    const magic = Buffer.alloc(BACKUP_MAGIC_LEN, 0);
    magic.write(BACKUP_MAGIC, 0, 'ascii');
    const out = Buffer.concat([magic, salt, iv, authTag, ciphertext]);

    // --- Step 8: write to disk (atomic via .tmp + rename, mode 0600).
    await mkdir(outputDir, { recursive: true });
    const outName = `otzi-backup-${safeIsoTimestamp(now)}.otzi-backup`;
    const outPath = join(outputDir, outName);
    const tmpPath = `${outPath}.tmp`;
    await writeFile(tmpPath, out, { mode: 0o600 });
    await rename(tmpPath, outPath);

    return { path: outPath, password, filesIncluded };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Convert an absolute path to a tar-relative path. Exported so `restore.ts`
 * can reverse the mapping without duplicating the helper.
 */
export function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}
