/**
 * `otzi restore` — reverse of `otzi backup`. Given a password-protected
 * archive produced by `runBackup`, decrypts, untars, and places each file at
 * its canonical absolute path with the per-file mode the daemon expects.
 *
 * Usable both as a standalone CLI verb (operator runs it after a fresh
 * install with throwaway prompts) and as the engine the debconf postinst
 * pipes the password into via stdin.
 *
 * Ownership: files are created by the running user, in directories postinst
 * made setgid root:otzi. When restore runs as root (postinst, or `sudo otzi
 * restore`) and a system user `otzi` exists, each file placed in /var/lib/otzi
 * is also `fchown`ed to that user and group on its open handle, because a
 * root-owned 0600 share would leave the daemon (User=otzi) with EACCES. Files in
 * /etc/otzi stay root:otzi (the setgid directory gives the group). Without root
 * or without a user `otzi` (a dev machine) nothing is chowned.
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
 * daemon.toml names are written, each a direct child of /etc/otzi or
 * /var/lib/otzi (so no directory between those and a target can be swapped for
 * a symlink while restore runs); `..`, absolute names, links, devices and
 * FIFOs are refused; other members are skipped with a warning. Restore only
 * creates files: it refuses when any target exists, never writes through a
 * symlink, and on a failure removes only the files it created. Names taken
 * from the archive are shown through `displayText` in every refusal.
 *
 * Wrong password and tampered ciphertext both surface as the same friendly
 * message — leaking which one happened gives an attacker an oracle.
 */

import { execFile as execFileCb } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Parser as TarParser } from 'tar';
import { parse as parseToml } from 'smol-toml';
import { displayText } from '../../util/text';
import { resolveStatePaths } from '../state-paths';
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

/** The directory whose files belong to the daemon's user (the share is read there). */
const STATE_DIR = 'var/lib/otzi';

/** The system user and group the daemon runs as (`User=otzi`). */
const OTZI_NAME = 'otzi';

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

/** The uid and gid restore gives the files in /var/lib/otzi to. */
export interface OtziOwner {
  uid: number;
  gid: number;
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
  /**
   * Test seam: whether the process runs as root. Defaults to
   * `process.getuid?.() === 0`. Files are only chowned when it is true.
   */
  isRoot?: boolean;
  /**
   * Test seam: look up the system user `otzi`. Defaults to reading
   * `<rootOverride>/etc/passwd` and `<rootOverride>/etc/group`
   * (`/etc/passwd` and `/etc/group` in production). `undefined` means there is
   * no such user, and nothing is chowned.
   */
  lookupOtziOwner?: () => Promise<OtziOwner | undefined>;
  /**
   * Test seam: give the file open on `handle` (at `path`) to `owner`. Defaults
   * to `handle.chown(owner.uid, owner.gid)`. Called before the handle is closed.
   */
  chownFile?: (handle: FileHandle, path: string, owner: OtziOwner) => Promise<void>;
}

export interface RestoreResult {
  /**
   * Absolute paths after extraction, with the mode each file was chmod'd to
   * and, for a file given to the `otzi` user, its owner.
   */
  restoredFiles: { path: string; mode: number; owner?: OtziOwner }[];
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
  const isRoot = opts.isRoot ?? process.getuid?.() === 0;
  const lookupOwner = opts.lookupOtziOwner ?? (() => readOtziOwner(root));
  const chownFile =
    opts.chownFile ?? ((handle: FileHandle, _path: string, owner: OtziOwner) => handle.chown(owner.uid, owner.gid));

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
    throw new Error(`config already present at ${configPath}; move it aside first`);
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
    if (refused) throw new Error(`archive entry ${displayText(m.rawName)}: ${refused} refused`);
    if (m.type === 'Directory') {
      directories.push(m);
      continue;
    }
    if (!REGULAR_TYPES.has(m.type)) throw new Error(`archive entry ${displayText(m.rawName)}: tar type ${displayText(m.type)} refused`);
    if (files.has(m.name)) throw new Error(`archive entry ${displayText(m.rawName)}: the archive holds this file more than once`);
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
  // daemon.toml names, each a direct child of /etc/otzi or /var/lib/otzi.
  const targets = targetModes(files.get('etc/otzi/daemon.toml'));
  for (const d of directories) {
    if (targets.has(d.name)) {
      throw new Error(`archive entry ${displayText(d.rawName)}: directory where a regular file is expected refused`);
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

  // --- The host side: no target exists. Every target is a direct child of an
  // allowed directory, so there is no directory in between that could be swapped
  // for a symlink between this check and the write below.
  const existing: string[] = [];
  for (const p of placements) if (await entryExists(p.dest)) existing.push(displayText(p.dest));
  if (existing.length > 0) {
    throw new Error(
      `restore would replace existing files: ${existing.join(', ')}; move them aside and run restore again`,
    );
  }

  // --- Who gets the files in /var/lib/otzi: the user `otzi`, when running as
  // root and there is one. Looked up before anything is written, so a failing
  // lookup leaves no partial restore behind.
  const owner = isRoot ? await lookupOwner() : undefined;

  // --- Create each target. Only files this call created are tracked, so a
  // rollback never touches a file that existed before.
  // We deliberately do NOT track or remove parent directories: they may
  // have existed before restore (postinst sets them up), and mkdir with
  // recursive:true is idempotent — undoing it can't be done safely.
  const restoredFiles: { path: string; mode: number; owner?: OtziOwner }[] = [];
  const created: string[] = [];
  try {
    for (const { member, dest, mode } of placements) {
      await mkdir(dirname(dest), { recursive: true });
      // 'wx': fails if anything appeared at `dest` meanwhile, and never
      // follows a symlink there.
      const handle = await open(dest, 'wx', mode);
      created.push(dest);
      const fileOwner = owner !== undefined && posix.dirname(member.name) === STATE_DIR ? owner : undefined;
      try {
        // Right after creation and on the handle: the owner is set before the
        // file is closed, and it cannot have been swapped for another entry.
        if (fileOwner) await chownFile(handle, dest, fileOwner);
        await handle.writeFile(member.data);
        // The umask may have narrowed the creation mode.
        await handle.chmod(mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      restoredFiles.push({ path: dest, mode, ...(fileOwner ? { owner: fileOwner } : {}) });
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

/**
 * The uid and gid of the system user `otzi`, from the text of a passwd and a
 * group file: the uid of the user, and the gid of the group `otzi` (the
 * primary gid of the user when the group file has no such group). `undefined`
 * when there is no user `otzi` or a field is not a non-negative integer.
 */
export function findOtziOwner(passwd: string, group: string): OtziOwner | undefined {
  const fields = (text: string, name: string): string[] | undefined =>
    text
      .split('\n')
      .map(line => line.split(':'))
      .find(f => f[0] === name);
  // A uid or gid chown accepts: 0 to 2^32 - 2 (2^32 - 1 means "leave unchanged").
  const wholeNumber = (value: string | undefined): number | undefined =>
    value !== undefined && /^\d{1,10}$/.test(value) && Number(value) <= 0xfffffffe ? Number(value) : undefined;

  const user = fields(passwd, OTZI_NAME);
  const uid = wholeNumber(user?.[2]);
  const primaryGid = wholeNumber(user?.[3]);
  if (uid === undefined || primaryGid === undefined) return undefined;
  return { uid, gid: wholeNumber(fields(group, OTZI_NAME)?.[2]) ?? primaryGid };
}

/** `findOtziOwner` over `<root>/etc/passwd` and `<root>/etc/group`; a missing file counts as empty. */
async function readOtziOwner(root: string): Promise<OtziOwner | undefined> {
  const read = async (name: string): Promise<string> => {
    try {
      return await readFile(join(root, 'etc', name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  };
  return findOtziOwner(await read('passwd'), await read('group'));
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
    parser.on('error', (err: Error) => rejectParse(new Error(`archive is not a valid tar: ${displayText(err.message)}`)));
    parser.on('end', () => resolveParse());
    parser.end(tgz);
  });
  return members;
}

/** A member name must be relative and must not climb out with `..`. */
function checkMemberName(rawName: string): void {
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    throw new Error(`archive entry ${displayText(rawName)}: absolute path refused`);
  }
  if (rawName.split(/[\\/]/).includes('..')) throw new Error(`archive entry ${displayText(rawName)}: '..' refused`);
  if (rawName === '' || posix.normalize(rawName) === '.') throw new Error(`archive entry '${displayText(rawName)}': empty name refused`);
}

/**
 * The tar paths restore writes, with their modes: the fixed ones and the
 * three the archived daemon.toml names. Throws when daemon.toml is missing or
 * unreadable, or names a path that is not a direct child of /etc/otzi or
 * /var/lib/otzi.
 */
function targetModes(daemonToml: ArchiveMember | undefined): Map<string, number> {
  let rawConfig: Record<string, unknown>;
  try {
    if (!daemonToml) throw new Error('etc/otzi/daemon.toml is not in the archive');
    // Loose TOML parse — restore must work even if the backed-up daemon.toml
    // wouldn't pass full validation (e.g. mid-bootstrap, missing peers).
    rawConfig = parseToml(daemonToml.data.toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`archive missing or malformed daemon.toml: ${displayText((err as Error).message)}`);
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
  const tarPaths = resolveStatePaths(
    dynamic.map(([key, path]) => ({ key, path })),
    [...targets.keys()],
    (key, path, why) => new Error(`daemon.toml in the archive: ${key} = ${displayText(path)} ${why}; refused`),
  );
  dynamic.forEach(([, , mode], i) => targets.set(tarPaths[i]!, mode));
  return targets;
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
