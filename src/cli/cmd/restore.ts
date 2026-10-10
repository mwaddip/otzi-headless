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
 * Restore runs as root, and an archive can come from a compromised host. So
 * after decryption the tar members are read in memory and validated before
 * anything is written: only the fixed paths and the three paths the archived
 * daemon.toml names are written, each strictly inside /etc/otzi or
 * /var/lib/otzi; `..`, absolute names, links, devices and FIFOs are refused;
 * other members are skipped with a warning. Restore only creates files: it
 * refuses when any target exists, never writes through a symlink, and on a
 * failure removes only the files it created.
 *
 * Wrong password and tampered ciphertext both surface as the same friendly
 * message — leaking which one happened gives an attacker an oracle.
 */

import { execFile as execFileCb } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Parser as TarParser } from 'tar';
import { parse as parseToml } from 'smol-toml';
import {
  BACKUP_HEADER_LEN,
  BACKUP_IV_LEN,
  BACKUP_MAGIC,
  BACKUP_MAGIC_LEN,
  BACKUP_PBKDF2_ITERATIONS,
  BACKUP_SALT_LEN,
  DEFAULT_IDENTITY_PATH,
  DEFAULT_PUBKEY_BOOK_PATH,
  DEFAULT_SHARE_PATH,
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
  'etc/otzi/address-book.otzi.json': 0o640,
  'var/lib/otzi/vault-pubkey.json': 0o644,
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

/** The only directories restore writes into (under `rootOverride` in tests). */
const ALLOWED_DIRS = ['etc/otzi', 'var/lib/otzi'] as const;

/** Tar types that are regular files. */
const REGULAR_TYPES: ReadonlySet<string> = new Set(['File', 'OldFile', 'ContiguousFile']);

/** Tar types never found in a backup, and refused wherever they appear. */
const REFUSED_TYPES: Readonly<Record<string, string>> = {
  SymbolicLink: 'symlink',
  Link: 'hardlink',
  CharacterDevice: 'character device',
  BlockDevice: 'block device',
  FIFO: 'FIFO',
};

interface ArchiveMember {
  /** The name as stored in the tar header. */
  rawName: string;
  /** Normalized relative name (no trailing slash). */
  name: string;
  type: string;
  data: Buffer;
}

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
  /** Tar member names that are not part of a backup; skipped, never written. */
  skippedEntries: string[];
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
  // Magic is exactly BACKUP_MAGIC ('OTZI-BACKUP-V1') followed by NUL padding
  // out to BACKUP_MAGIC_LEN. Compare the prefix directly, then enforce that
  // the remaining bytes are all NUL (defends against future format-versioning
  // ambiguity — e.g. a hypothetical 'OTZI-BACKUP-V1XXX' should be rejected,
  // not silently treated as V1).
  const expectedMagic = Buffer.from(BACKUP_MAGIC, 'ascii');
  const actualPrefix = magicBytes.subarray(0, expectedMagic.length);
  if (!actualPrefix.equals(expectedMagic)) {
    throw new Error('not an otzi backup archive (magic mismatch)');
  }
  for (let i = expectedMagic.length; i < BACKUP_MAGIC_LEN; i++) {
    if (magicBytes[i] !== 0) {
      throw new Error('not an otzi backup archive (magic mismatch)');
    }
  }

  // --- Pre-flight check 2: refuse if /etc/otzi/daemon.toml exists.
  if (await configExists()) {
    const configPath =
      root === '/'
        ? '/etc/otzi/daemon.toml'
        : join(root, 'etc/otzi/daemon.toml');
    throw new Error(`config already present at ${configPath}; remove it first`);
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

  // --- Read the tar members in memory. Nothing from the archive touches the
  // disk until every member and every target path has been validated.
  const members = await readArchiveMembers(plaintext);

  // --- Member names and types.
  const files = new Map<string, ArchiveMember>();
  const directories: ArchiveMember[] = [];
  for (const m of members) {
    checkMemberName(m.rawName);
    const refused = REFUSED_TYPES[m.type];
    if (refused) throw new Error(`archive entry ${m.rawName}: ${refused} refused`);
    if (m.type === 'Directory') {
      directories.push(m);
      continue;
    }
    if (!REGULAR_TYPES.has(m.type)) throw new Error(`archive entry ${m.rawName}: tar type ${m.type} refused`);
    if (files.has(m.name)) throw new Error(`archive entry ${m.rawName}: the archive holds this file more than once`);
    files.set(m.name, m);
  }

  // --- meta.json (helps the operator confirm host).
  let metaPartyId: number | undefined;
  let metaCreatedAt: string | undefined;
  let metaHostname: string | undefined;
  const metaMember = files.get(META_TAR_PATH);
  if (metaMember) {
    try {
      const meta = JSON.parse(metaMember.data.toString('utf8')) as MetaShape;
      metaPartyId = meta.partyId;
      metaCreatedAt = meta.createdAt;
      metaHostname = meta.hostname;
    } catch {
      // meta.json malformed isn't fatal — operators just lose the banner.
    }
  }

  // --- The targets: the fixed paths, plus the three paths the archived
  // daemon.toml names, each strictly inside /etc/otzi or /var/lib/otzi.
  const targets = targetModes(files.get('etc/otzi/daemon.toml'));
  for (const d of directories) {
    if (targets.has(d.name)) {
      throw new Error(`archive entry ${d.rawName}: directory where a regular file is expected refused`);
    }
  }

  // --- Everything else is skipped and reported.
  const placements: { member: ArchiveMember; dest: string; mode: number }[] = [];
  const skippedEntries: string[] = [];
  for (const m of members) {
    if (m.name === META_TAR_PATH && REGULAR_TYPES.has(m.type)) continue;
    const mode = REGULAR_TYPES.has(m.type) ? targets.get(m.name) : undefined;
    if (mode === undefined) {
      skippedEntries.push(m.rawName);
      continue;
    }
    placements.push({ member: m, dest: resolve(root, m.name), mode });
  }

  // --- The host side: no symlink on the way to a target, and no target exists.
  for (const p of placements) await checkNoSymlinkOnTheWay(root, p.dest);
  const existing: string[] = [];
  for (const p of placements) if (await entryExists(p.dest)) existing.push(p.dest);
  if (existing.length > 0) {
    throw new Error(
      `restore would replace existing files: ${existing.join(', ')}; move them aside and run restore again`,
    );
  }

  // --- Create each target. Only files this call created are tracked, so a
  // rollback never touches a file that existed before.
  // We deliberately do NOT track or remove parent directories: they may
  // have existed before restore (postinst sets them up), and mkdir with
  // recursive:true is idempotent — undoing it can't be done safely.
  const restoredFiles: { path: string; mode: number }[] = [];
  const created: string[] = [];
  try {
    for (const { member, dest, mode } of placements) {
      await mkdir(dirname(dest), { recursive: true });
      // 'wx': fails if anything appeared at `dest` meanwhile, and never
      // follows a symlink there.
      const handle = await open(dest, 'wx', mode);
      created.push(dest);
      try {
        await handle.writeFile(member.data);
        // The umask may have narrowed the creation mode.
        await handle.chmod(mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      restoredFiles.push({ path: dest, mode });
    }
  } catch (err) {
    // Best-effort rollback of what this call created. Individual rm failures
    // are swallowed so a transient unlink error can't shadow the original
    // cause the caller actually needs to see.
    console.error(
      `otzi restore: placement failed; removing the ${created.length} file(s) this restore created`,
    );
    for (const p of [...created].reverse()) {
      try {
        await rm(p, { force: true });
      } catch {
        // Swallow — the original error is what the caller needs.
      }
    }
    throw err;
  }

  return {
    restoredFiles,
    skippedEntries,
    ...(metaPartyId !== undefined ? { metaPartyId } : {}),
    ...(metaCreatedAt !== undefined ? { metaCreatedAt } : {}),
    ...(metaHostname !== undefined ? { metaHostname } : {}),
  };
}

/** Every tar member with its content, read from the gzipped tar in memory. */
async function readArchiveMembers(tgz: Buffer): Promise<ArchiveMember[]> {
  const members: ArchiveMember[] = [];
  const parser = new TarParser({ strict: true });
  await new Promise<void>((resolveParse, rejectParse) => {
    parser.on('entry', (entry) => {
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        const rawName = entry.path;
        members.push({
          rawName,
          name: posix.normalize(rawName).replace(/\/+$/, ''),
          type: entry.type,
          data: Buffer.concat(chunks),
        });
      });
    });
    parser.on('error', (err: Error) => rejectParse(new Error(`archive is not a valid tar: ${err.message}`)));
    parser.on('end', () => resolveParse());
    parser.end(tgz);
  });
  return members;
}

/** A member name must be relative and must not climb out with `..`. */
function checkMemberName(rawName: string): void {
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    throw new Error(`archive entry ${rawName}: absolute path refused`);
  }
  if (rawName.split(/[\\/]/).includes('..')) throw new Error(`archive entry ${rawName}: '..' refused`);
  if (rawName === '' || posix.normalize(rawName) === '.') throw new Error(`archive entry '${rawName}': empty name refused`);
}

/**
 * The tar paths restore writes, with their modes: the fixed ones and the
 * three the archived daemon.toml names. Throws when daemon.toml is missing or
 * unreadable, or names a path outside /etc/otzi and /var/lib/otzi.
 */
function targetModes(daemonToml: ArchiveMember | undefined): Map<string, number> {
  let rawConfig: Record<string, unknown>;
  try {
    if (!daemonToml) throw new Error('etc/otzi/daemon.toml is not in the archive');
    // Loose TOML parse — restore must work even if the backed-up daemon.toml
    // wouldn't pass full validation (e.g. mid-bootstrap, missing peers).
    rawConfig = parseToml(daemonToml.data.toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`archive missing or malformed daemon.toml: ${(err as Error).message}`);
  }
  const shareTable = (rawConfig.share ?? {}) as Record<string, unknown>;
  const nodeTable = (rawConfig.node ?? {}) as Record<string, unknown>;
  const named = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

  const targets = new Map<string, number>(Object.entries(FIXED_FILE_MODES));
  const dynamic: [string, string, number][] = [
    ['[share].path', named(shareTable.path, DEFAULT_SHARE_PATH), SHARE_MODE],
    ['[node].identity_key_file', named(nodeTable.identity_key_file, DEFAULT_IDENTITY_PATH), IDENTITY_MODE],
    ['[node].pubkey_book_file', named(nodeTable.pubkey_book_file, DEFAULT_PUBKEY_BOOK_PATH), PUBKEYS_MODE],
  ];
  for (const [key, path, mode] of dynamic) {
    const tarPath = allowedTarPath(key, path);
    if (targets.has(tarPath)) {
      throw new Error(`daemon.toml in the archive: ${key} = ${path} names a file another key also names; refused`);
    }
    targets.set(tarPath, mode);
  }
  return targets;
}

/** The tar path of an absolute path that lies strictly inside an allowed directory. */
function allowedTarPath(key: string, path: string): string {
  const outside = () =>
    new Error(`daemon.toml in the archive: ${key} = ${path} is outside /etc/otzi and /var/lib/otzi; refused`);
  if (!path.startsWith('/')) throw outside();
  const tarPath = stripLeadingSlash(posix.resolve(path));
  if (!ALLOWED_DIRS.some(dir => tarPath.startsWith(`${dir}/`))) throw outside();
  return tarPath;
}

/**
 * Every existing directory between the allowed directory and `dest` must be a
 * real directory: a symlink there (the data dir is group-writable) would send
 * the write elsewhere.
 */
async function checkNoSymlinkOnTheWay(root: string, dest: string): Promise<void> {
  const base = ALLOWED_DIRS.map(dir => resolve(root, dir)).find(b => dest.startsWith(`${b}${sep}`));
  if (!base) throw new Error(`internal: restore target ${dest} is outside the allowed directories`);
  let current = base;
  for (const part of relative(base, dirname(dest)).split(sep).filter(Boolean)) {
    current = join(current, part);
    let st;
    try {
      st = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // created below, by restore
      throw err;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to restore through a symlink at ${current}`);
    if (!st.isDirectory()) throw new Error(`refusing to restore: ${current} is not a directory`);
  }
}

/** True iff any file system entry (a dangling symlink included) exists at `p`. */
async function entryExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
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
