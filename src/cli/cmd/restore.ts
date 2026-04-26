/**
 * `otzi restore` — reverse of `otzi backup`. Given a password-protected
 * archive produced by `runBackup`, decrypts, untars, and places each file at
 * its canonical absolute path with the per-file mode the daemon expects.
 *
 * Usable both as a standalone CLI verb (operator runs it after a fresh
 * install with throwaway prompts) and as the engine the debconf postinst
 * pipes the password into via stdin.
 *
 * Files are restored with `chmod` only; the daemon user/group is set by
 * postinst (Phase 9a) and inherited from the parent dir's setgid bit. If
 * extracting as root, files land as `root:otzi`; as a regular user, they
 * land as that user. Either way, ownership is determined by the runtime
 * uid + setgid parent dir, not by anything we set here.
 *
 * The per-file mode table is hard-coded and mirrors the postinst's chmod
 * choices. It is the security-relevant invariant: changing it widens or
 * narrows access to share material, which is mnemonic-equivalent.
 *
 * Pre-flight refuses to clobber an existing install:
 *   1. magic byte check (cheap precheck before decryption)
 *   2. /etc/otzi/daemon.toml must NOT already exist
 *   3. systemctl is-active otzi must NOT report running
 *
 * Wrong password and tampered ciphertext both surface as the same friendly
 * message — leaking which one happened gives an attacker an oracle.
 */

import { execFile as execFileCb } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { extract as tarExtract } from 'tar';
import { parseDaemonConfigToml } from '../../config/parse';
import {
  BACKUP_HEADER_LEN,
  BACKUP_IV_LEN,
  BACKUP_MAGIC,
  BACKUP_MAGIC_LEN,
  BACKUP_PBKDF2_ITERATIONS,
  BACKUP_SALT_LEN,
  BACKUP_TAG_LEN,
  DEFAULT_IDENTITY_PATH,
  DEFAULT_PUBKEY_BOOK_PATH,
  stripLeadingSlash,
} from './backup';

const execFile = promisify(execFileCb);

/**
 * Hard-coded mode table for the FIXED tar paths produced by backup.ts.
 * These paths are constants in backup.ts (not derived from daemon.toml), so
 * exact match works. Mirrors the postinst's chmod choices.
 */
const FIXED_FILE_MODES: Record<string, number> = {
  'etc/otzi/daemon.toml': 0o640,
  'etc/otzi/manifest.otzi.json': 0o660,
  'var/lib/otzi/vault-pubkey.json': 0o644,
  'var/lib/otzi/bootstrap-secret': 0o660,
};

/**
 * Modes for the OPERATOR-CONFIGURABLE files (share / identity / pubkeys).
 * Their tar paths come from daemon.toml — matched at runtime by parsing the
 * staged daemon.toml and looking up `[share].path`, `node.identity_key_file`,
 * and `node.pubkey_book_file`.
 */
const SHARE_MODE = 0o600;
const IDENTITY_MODE = 0o660;
const PUBKEYS_MODE = 0o644;

/** meta.json lives only inside the archive — never written to disk. */
const META_TAR_PATH = 'meta.json';

/**
 * Default daemon-running probe — `systemctl is-active otzi` exit code 0
 * means the unit is active. Any other exit (or systemctl absent) → false.
 */
async function defaultDaemonStatusCheck(): Promise<boolean> {
  try {
    const { stdout } = await execFile('systemctl', ['is-active', 'otzi']);
    return stdout.trim() === 'active';
  } catch {
    // Non-zero exit (inactive/failed/missing) OR systemctl absent → not running.
    return false;
  }
}

/** Default config-exists probe — checks for /etc/otzi/daemon.toml. */
function defaultConfigExistsCheck(rootOverride?: string): () => Promise<boolean> {
  return async () => {
    const p = rootOverride
      ? join(rootOverride, 'etc/otzi/daemon.toml')
      : '/etc/otzi/daemon.toml';
    try {
      await stat(p);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  };
}

export interface RestoreOptions {
  /** Positional CLI arg — absolute path to the .otzi-backup file. */
  archivePath: string;
  /**
   * Password (test path or `--password` arg). If unset, falls back to
   * `passwordStdin` then to interactive prompt. NEVER pass via command-line
   * flag in production: leaks via /proc/<pid>/cmdline + ps.
   */
  password?: string;
  /**
   * Read password from stdin until newline — the postinst path.
   * postinst pipes `echo "$PWD" | otzi restore --password-stdin <path>`.
   */
  passwordStdin?: boolean;
  /**
   * Test seam: prefix all extraction targets under this dir. In production
   * the cwd is `/`. Also threaded into the default config-exists check.
   */
  rootOverride?: string;
  /**
   * Test seam: override the daemon-running probe. Production default uses
   * `systemctl is-active otzi`.
   */
  daemonStatusCheck?: () => Promise<boolean>;
  /**
   * Test seam: override the config-exists probe. Production default checks
   * `<rootOverride>/etc/otzi/daemon.toml` (or `/etc/otzi/daemon.toml` if
   * rootOverride is unset).
   */
  configExistsCheck?: () => Promise<boolean>;
  /**
   * Test seam: alternate readable stream for `passwordStdin`. Defaults to
   * `process.stdin`. Tests pass a Readable preloaded with the password +
   * newline so the stdin path is exercised without monkey-patching globals.
   */
  stdinStream?: Readable;
}

export interface RestoreResult {
  /** Absolute paths after extraction, with the mode each file was chmod'd to. */
  restoredFiles: { path: string; mode: number }[];
  /**
   * `partyId` from meta.json. Surfaced so the operator can confirm "yes,
   * this archive is for the right host" in the CLI banner.
   */
  metaPartyId?: number;
  /** ISO timestamp from meta.json. */
  metaCreatedAt?: string;
  /** hostname from meta.json. */
  metaHostname?: string;
}

interface MetaShape {
  version: number;
  createdAt: string;
  hostname: string;
  partyId?: number;
}

export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  const archivePath = opts.archivePath;
  const root = opts.rootOverride ?? '/';
  const configExists =
    opts.configExistsCheck ?? defaultConfigExistsCheck(opts.rootOverride);
  const daemonRunning = opts.daemonStatusCheck ?? defaultDaemonStatusCheck;

  // --- Pre-flight check 1: magic byte (cheap precheck before decryption).
  const buf = await readFile(archivePath);
  if (buf.length < BACKUP_HEADER_LEN) {
    throw new Error('not an otzi backup archive (magic mismatch)');
  }
  const magicBytes = buf.subarray(0, BACKUP_MAGIC_LEN);
  // Magic is NUL-padded ASCII; trim trailing NULs before comparing.
  const magicStr = magicBytes.toString('ascii').replace(/\0+$/, '');
  if (magicStr !== BACKUP_MAGIC) {
    throw new Error('not an otzi backup archive (magic mismatch)');
  }

  // --- Pre-flight check 2: refuse if /etc/otzi/daemon.toml exists.
  if (await configExists()) {
    throw new Error('config already present at /etc/otzi/daemon.toml; remove it first');
  }

  // --- Pre-flight check 3: refuse if daemon is running.
  if (await daemonRunning()) {
    throw new Error('daemon is running; stop it with `systemctl stop otzi` first');
  }

  // --- Resolve password (precedence: explicit option > stdin > prompt).
  const password = await resolvePassword(opts);

  // --- Decrypt.
  const salt = buf.subarray(BACKUP_MAGIC_LEN, BACKUP_MAGIC_LEN + BACKUP_SALT_LEN);
  const iv = buf.subarray(
    BACKUP_MAGIC_LEN + BACKUP_SALT_LEN,
    BACKUP_MAGIC_LEN + BACKUP_SALT_LEN + BACKUP_IV_LEN,
  );
  const tag = buf.subarray(
    BACKUP_MAGIC_LEN + BACKUP_SALT_LEN + BACKUP_IV_LEN,
    BACKUP_HEADER_LEN,
  );
  const ciphertext = buf.subarray(BACKUP_HEADER_LEN);
  if (tag.length !== BACKUP_TAG_LEN) {
    // Should be impossible given the length check above, but defense in depth.
    throw new Error('not an otzi backup archive (magic mismatch)');
  }

  const key = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    BACKUP_PBKDF2_ITERATIONS,
    32,
    'sha256',
  );

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Both wrong-password and tampered-ciphertext path through here. Surface
    // the same message — distinguishing them gives an attacker an oracle.
    // Don't leak the underlying ERR_OSSL_BAD_DECRYPT (operators won't
    // recognize it; attackers will use it as confirmation).
    throw new Error('wrong password or corrupted archive');
  }

  // --- Untar.
  // Stage to a tmpdir first so we can:
  //   (a) inspect the entry list and compute modes BEFORE touching the real
  //       extraction targets, and
  //   (b) keep the entire restore atomic-ish: if extract fails midway, the
  //       real targets are untouched.
  // The tar package's defaults strip leading '/' from absolute paths in the
  // archive (warns and continues). We never produce absolute paths in
  // backup.ts, but the paranoid check at test time confirms this.
  const stageDir = await mkdtemp(join(tmpdir(), 'otzi-restore-stage-'));
  let restoredFiles: { path: string; mode: number }[];
  let metaPartyId: number | undefined;
  let metaCreatedAt: string | undefined;
  let metaHostname: string | undefined;
  try {
    const entryPaths: string[] = [];
    await new Promise<void>((resolveExtract, rejectExtract) => {
      const sink = tarExtract({
        cwd: stageDir,
        gzip: true,
        // Default behavior strips leading slashes safely. `preservePaths` is
        // explicitly false (the default) — we don't want absolute-path entries
        // to escape stageDir. Test 9 verifies this.
        onReadEntry: (entry) => {
          // entry.path is the in-archive path; record before tar resumes the
          // stream + writes the file out.
          entryPaths.push(entry.path);
        },
      }) as NodeJS.WritableStream & { on: (e: string, fn: (...args: unknown[]) => void) => void };
      sink.on('error', (err: unknown) => rejectExtract(err as Error));
      sink.on('finish', () => resolveExtract());
      sink.on('end', () => resolveExtract());
      sink.end(plaintext);
    });

    // --- Read meta.json (helps the operator confirm host).
    const metaStaged = join(stageDir, META_TAR_PATH);
    try {
      const metaText = await readFile(metaStaged, 'utf8');
      const meta = JSON.parse(metaText) as MetaShape;
      metaPartyId = meta.partyId;
      metaCreatedAt = meta.createdAt;
      metaHostname = meta.hostname;
    } catch {
      // meta.json missing or malformed isn't fatal — backups produced by
      // older / future versions might omit it. Operators just lose the
      // confirmation banner.
    }

    // --- Read the staged daemon.toml to learn the operator-configurable
    // paths (share, identity, pubkeys). These paths in the tar can differ
    // from the canonical defaults if the operator customized them; backup
    // wrote them at `stripLeadingSlash(<absolute path>)`, so we recover the
    // tar path by the same transform.
    const dynamicModes = new Map<string, number>();
    try {
      const tomlText = await readFile(
        join(stageDir, 'etc/otzi/daemon.toml'),
        'utf8',
      );
      const config = parseDaemonConfigToml(tomlText);
      const shareTar = stripLeadingSlash(config.share.path);
      const identityTar = stripLeadingSlash(
        config.node.identityKeyFile ?? DEFAULT_IDENTITY_PATH,
      );
      const pubkeyTar = stripLeadingSlash(
        config.node.pubkeyBookFile ?? DEFAULT_PUBKEY_BOOK_PATH,
      );
      dynamicModes.set(shareTar, SHARE_MODE);
      dynamicModes.set(identityTar, IDENTITY_MODE);
      dynamicModes.set(pubkeyTar, PUBKEYS_MODE);
    } catch (err) {
      // daemon.toml is required by backup.ts, so its absence here means a
      // malformed archive. Surface as the friendly error.
      throw new Error(
        `archive missing or malformed daemon.toml: ${(err as Error).message}`,
      );
    }

    // --- Categorize entries → real path + mode.
    restoredFiles = [];
    for (const entryPath of entryPaths) {
      // tar emits both directory and file entries; skip directories (paths
      // ending in '/').
      if (entryPath.endsWith('/')) continue;
      // Normalize the in-archive path: strip any leading '/' (defense in
      // depth — tar already strips, but the entryPath here might still
      // have one if preservePaths were ever flipped on).
      const normalized = stripLeadingSlash(entryPath);
      if (normalized === META_TAR_PATH) continue; // never write meta.json

      // Mode lookup precedence: dynamic (from daemon.toml) → fixed table.
      // Unknown entries (operator-injected mystery files) fall back to
      // SHARE_MODE (0o600) — most-restrictive default.
      const mode =
        dynamicModes.get(normalized) ?? FIXED_FILE_MODES[normalized] ?? SHARE_MODE;
      const stagedSrc = join(stageDir, normalized);
      const realDest = resolve(root, normalized);

      // Move staged → real path. Use rename within same FS where possible;
      // fall back to copy+remove. Since stageDir is in os.tmpdir() and real
      // dests are in /etc and /var, rename will usually fail (cross-device).
      // Always copy via readFile/writeFile to avoid that failure mode.
      const fileBuf = await readFile(stagedSrc);
      await mkdir(dirname(realDest), { recursive: true });
      await writeFile(realDest, fileBuf, { mode });
      // writeFile honors umask; chmod again to set the mode unconditionally.
      await chmod(realDest, mode);

      restoredFiles.push({ path: realDest, mode });
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }

  return {
    restoredFiles,
    ...(metaPartyId !== undefined ? { metaPartyId } : {}),
    ...(metaCreatedAt !== undefined ? { metaCreatedAt } : {}),
    ...(metaHostname !== undefined ? { metaHostname } : {}),
  };
}

/**
 * Resolve the password from the option set. Precedence:
 *   1. explicit `password` (test path or `--password` flag)
 *   2. `passwordStdin` → read from stdin until newline (postinst path)
 *   3. interactive readline prompt with `output: process.stderr`
 *
 * The interactive path does NOT mute echo (mature Node has no clean way to
 * do this without a TTY library). The CLI docs steer operators toward
 * `--password-stdin` for non-interactive flows where that matters.
 */
async function resolvePassword(opts: RestoreOptions): Promise<string> {
  if (opts.password !== undefined) return opts.password;
  if (opts.passwordStdin) {
    return readPasswordFromStream(opts.stdinStream ?? process.stdin);
  }
  return promptPasswordInteractive();
}

/**
 * Read until the first newline. Returns the chars before the newline (NOT
 * including it). On EOF without a newline, returns whatever was collected.
 *
 * Uses async iteration over the stream — works for both `process.stdin`
 * (when piped to from a parent process via `echo PWD | otzi restore
 * --password-stdin`) and for synthetic Readables in tests.
 */
async function readPasswordFromStream(stream: Readable): Promise<string> {
  let buf = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const idx = buf.indexOf('\n');
    if (idx !== -1) return buf.slice(0, idx);
  }
  // EOF without newline: take whatever we got.
  return buf;
}

async function promptPasswordInteractive(): Promise<string> {
  // Lazy import readline to keep the module import-cheap for tests that
  // never reach this branch.
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  return new Promise<string>((resolveP) => {
    rl.question('Backup password: ', (answer) => {
      rl.close();
      resolveP(answer);
    });
  });
}
