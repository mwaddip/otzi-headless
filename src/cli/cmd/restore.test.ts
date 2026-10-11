/**
 * Tests for `otzi restore` — the round-trip is the most load-bearing case
 * (proves byte-for-byte symmetry with backup.ts), then per-error-path
 * coverage to make sure the friendly messages survive refactors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { create as tarCreate } from 'tar';
import {
  runBackup,
  BACKUP_HEADER_LEN,
  BACKUP_IV_LEN,
  BACKUP_MAGIC,
  BACKUP_MAGIC_LEN,
  BACKUP_PBKDF2_ITERATIONS,
  BACKUP_SALT_LEN,
} from './backup';
import { runRestore } from './restore';

// A test can make `open` fail for one file name, to break a restore part-way.
const failOpen = vi.hoisted(() => ({ suffix: undefined as string | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (failOpen.suffix !== undefined && String(args[0]).endsWith(failOpen.suffix)) {
        throw Object.assign(new Error('EIO: simulated write failure'), { code: 'EIO' });
      }
      return actual.open(...args);
    },
  };
});

interface Fixture {
  /** The install root the fixture lives under (backup's `rootOverride`). */
  root: string;
  configPath: string;
  sharePath: string;
  identityPath: string;
  pubkeyBookPath: string;
  vaultPubkeyPath: string;
  addressBookPath: string;
}

/** The fixed paths backup reads that daemon.toml does not name. */
function overridesFrom(f: Fixture) {
  return { vaultPubkey: f.vaultPubkeyPath, addressBook: f.addressBookPath };
}

const ADDRESS_BOOK_TAR = 'etc/otzi/address-book.otzi.json';
const SHARE_TAR = 'var/lib/otzi/share.json';
const IDENTITY_TAR = 'var/lib/otzi/identity.json';
const PUBKEYS_TAR = 'var/lib/otzi/pubkeys.json';
const ADDRESS_BOOK_JSON = JSON.stringify({
  kind: 'otzi-address-book',
  version: 1,
  network: 'testnet4',
  entries: [{ label: 'treasury', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }],
});

interface FixtureOpts {
  skipVaultPubkey?: boolean;
  skipAddressBook?: boolean;
  /**
   * If set, encode the share/identity/pubkeys at relative paths under this
   * tar-encoded prefix. The fixture writes the actual files under the root
   * but the daemon.toml records these paths as absolute (matching prod).
   */
  layoutRoot?: string;
}

async function buildBackupFixture(
  root: string,
  opts: FixtureOpts = {},
): Promise<Fixture> {
  const etcDir = join(root, 'etc', 'otzi');
  const varDir = join(root, 'var', 'lib', 'otzi');
  await mkdir(etcDir, { recursive: true });
  await mkdir(varDir, { recursive: true });

  const sharePath = join(varDir, 'share.json');
  const identityPath = join(varDir, 'identity.json');
  const pubkeyBookPath = join(varDir, 'pubkeys.json');
  const vaultPubkeyPath = join(varDir, 'vault-pubkey.json');
  const addressBookPath = join(etcDir, 'address-book.otzi.json');

  // daemon.toml names the production paths, as on a real install; backup reads
  // them under `root` (its rootOverride seam).
  const tomlText = `
[share]
path = "/${SHARE_TAR}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"
identity_key_file = "/${IDENTITY_TAR}"
pubkey_book_file = "/${PUBKEYS_TAR}"

[network]
name = "testnet4"

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"

[[peers]]
endpoint = "127.0.0.1:8801"

[gate]
strategy = "auto"
`;
  const configPath = join(etcDir, 'daemon.toml');
  await writeFile(configPath, tomlText, { mode: 0o640 });

  await writeFile(sharePath, JSON.stringify({ version: 3, partyId: 7 }), {
    mode: 0o600,
  });
  await writeFile(identityPath, '----- IDENTITY -----', { mode: 0o660 });
  await writeFile(pubkeyBookPath, JSON.stringify({ peers: ['a', 'b'] }), {
    mode: 0o644,
  });
  if (!opts.skipVaultPubkey) {
    await writeFile(vaultPubkeyPath, JSON.stringify({ p2tr: 'bc1p...' }), {
      mode: 0o644,
    });
  }
  if (!opts.skipAddressBook) {
    // Looser than the restored mode, to show restore sets the mode itself.
    await writeFile(addressBookPath, ADDRESS_BOOK_JSON);
    await chmod(addressBookPath, 0o666);
  }

  return {
    root,
    configPath,
    sharePath,
    identityPath,
    pubkeyBookPath,
    vaultPubkeyPath,
    addressBookPath,
  };
}

/** stat with mode mask to get just permission bits. */
async function modeOf(p: string): Promise<number> {
  const st = await stat(p);
  return st.mode & 0o777;
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

/**
 * Build a valid encrypted archive from an explicit entry table, bypassing
 * `runBackup`. Lets a test hand `runRestore` an archive whose entries differ
 * from what the current `runBackup` writes (e.g. one from an older daemon).
 * Same wire format as backup.ts: magic | salt | iv | tag | AES-256-GCM(tgz).
 */
async function craftArchive(
  dir: string,
  entries: Record<string, string>,
): Promise<{ path: string; password: string }> {
  const staging = await mkdtemp(join(dir, 'craft-stage-'));
  const names = Object.keys(entries);
  for (const name of names) {
    const dest = join(staging, name);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, entries[name]!);
  }
  const chunks: Buffer[] = [];
  const tarStream = tarCreate({ cwd: staging, gzip: true, portable: true }, names);
  for await (const chunk of tarStream as AsyncIterable<Buffer>) chunks.push(chunk);

  const password = 'crafted-archive-password';
  const salt = randomBytes(BACKUP_SALT_LEN);
  const iv = randomBytes(BACKUP_IV_LEN);
  const key = pbkdf2Sync(password, salt, BACKUP_PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat(chunks)), cipher.final()]);
  const magic = Buffer.alloc(BACKUP_MAGIC_LEN, 0);
  magic.write(BACKUP_MAGIC, 0, 'ascii');

  const path = join(dir, 'crafted.otzi-backup');
  await writeFile(path, Buffer.concat([magic, salt, iv, cipher.getAuthTag(), ciphertext]));
  await rm(staging, { recursive: true, force: true });
  return { path, password };
}

/**
 * Default test seams: no daemon running, no config present. Tests that
 * exercise the pre-flight refusals override these.
 */
const NEVER_RUNNING = (): Promise<boolean> => Promise.resolve(false);
const NEVER_EXISTS = (): Promise<boolean> => Promise.resolve(false);

describe('runRestore', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-restore-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('round-trip: backup then restore reproduces all files with correct content + modes', async () => {
    // Build a fake daemon install + back it up.
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const outDir = join(tmp, 'archive');
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: outDir,
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    // Restore into a fresh root.
    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    // Every file in the backup (sans meta.json) is restored.
    const restoredPaths = new Set(result.restoredFiles.map((r) => r.path));

    // Helper: tar-relative paths get joined with restoreRoot to match
    // the runRestore output paths.
    const restored = (rel: string): string => resolve(restoreRoot, rel);
    expect(restoredPaths.has(restored('etc/otzi/daemon.toml'))).toBe(true);
    // Share file lives at the same relative path the backup recorded.
    const shareRel = SHARE_TAR;
    expect(restoredPaths.has(restored(shareRel))).toBe(true);
    const identityRel = IDENTITY_TAR;
    expect(restoredPaths.has(restored(identityRel))).toBe(true);
    const pubkeysRel = PUBKEYS_TAR;
    expect(restoredPaths.has(restored(pubkeysRel))).toBe(true);
    expect(restoredPaths.has(restored('var/lib/otzi/vault-pubkey.json'))).toBe(true);

    expect(restoredPaths.has(restored(ADDRESS_BOOK_TAR))).toBe(true);

    // Exactly the vault's file set, nothing else.
    expect(restoredPaths.size).toBe(6);

    // meta.json is NOT restored to disk.
    expect(restoredPaths.has(restored('meta.json'))).toBe(false);
    expect(await pathExists(join(restoreRoot, 'meta.json'))).toBe(false);

    // Content matches source byte-for-byte.
    expect(await readFile(restored('etc/otzi/daemon.toml'), 'utf8')).toBe(
      await readFile(f.configPath, 'utf8'),
    );
    expect(await readFile(restored(shareRel), 'utf8')).toBe(
      await readFile(f.sharePath, 'utf8'),
    );
    expect(await readFile(restored(identityRel), 'utf8')).toBe(
      await readFile(f.identityPath, 'utf8'),
    );

    // meta surfaced into result.
    expect(result.metaPartyId).toBe(7);
    expect(typeof result.metaCreatedAt).toBe('string');
    expect(typeof result.metaHostname).toBe('string');
  });

  it('restored files have the canonical mode from the table', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const outDir = join(tmp, 'archive');
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: outDir,
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    // Build a quick lookup: real path → expected mode from result.
    const got = new Map<string, number>();
    for (const r of result.restoredFiles) got.set(r.path, r.mode);

    // Verify modes against the on-disk stat (separate from the result map
    // so we catch bugs where we report one mode but write another).
    const restored = (rel: string): string => resolve(restoreRoot, rel);
    expect(await modeOf(restored('etc/otzi/daemon.toml'))).toBe(0o640);

    const shareRel = SHARE_TAR;
    expect(await modeOf(restored(shareRel))).toBe(0o600); // share — by elimination
    const identityRel = IDENTITY_TAR;
    expect(await modeOf(restored(identityRel))).toBe(0o660);
    const pubkeysRel = PUBKEYS_TAR;
    expect(await modeOf(restored(pubkeysRel))).toBe(0o644);
    expect(await modeOf(restored('var/lib/otzi/vault-pubkey.json'))).toBe(0o644);
    expect(await modeOf(restored(ADDRESS_BOOK_TAR))).toBe(0o640);

    // Result-reported modes match on-disk modes.
    expect(got.get(restored('etc/otzi/daemon.toml'))).toBe(0o640);
    expect(got.get(restored(shareRel))).toBe(0o600);
    expect(got.get(restored(ADDRESS_BOOK_TAR))).toBe(0o640);
  });

  it('backup includes the address book and restore sets 0640', async () => {
    const f = await buildBackupFixture(join(tmp, 'src'));
    expect(await modeOf(f.addressBookPath)).toBe(0o666);

    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });
    expect(backup.filesIncluded).toContain(ADDRESS_BOOK_TAR);

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    const restoredBook = resolve(restoreRoot, ADDRESS_BOOK_TAR);
    expect(result.restoredFiles).toContainEqual({ path: restoredBook, mode: 0o640 });
    expect(await modeOf(restoredBook)).toBe(0o640);
    expect(await readFile(restoredBook, 'utf8')).toBe(ADDRESS_BOOK_JSON);
  });

  it('restores a backup that holds no address book without one', async () => {
    const f = await buildBackupFixture(join(tmp, 'src'), { skipAddressBook: true });
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });
    expect(backup.filesIncluded).not.toContain(ADDRESS_BOOK_TAR);

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });
    expect(result.restoredFiles).toHaveLength(5);
    expect(await pathExists(resolve(restoreRoot, ADDRESS_BOOK_TAR))).toBe(false);
  });

  it('wrong password → friendly error', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    await expect(
      runRestore({
        archivePath: backup.path,
        password: 'definitely-not-the-password',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('wrong password or corrupted archive');
  });

  it('tampered archive → same friendly error (no leak between cases)', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    // Flip 1 byte mid-ciphertext (well after the magic + header).
    const buf = await readFile(backup.path);
    const flipIdx = BACKUP_HEADER_LEN + Math.floor((buf.length - BACKUP_HEADER_LEN) / 2);
    buf[flipIdx] = buf[flipIdx]! ^ 0xff;
    await writeFile(backup.path, buf);

    await expect(
      runRestore({
        archivePath: backup.path,
        password: backup.password,
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('wrong password or corrupted archive');
  });

  it('bad magic → "not an otzi backup archive" before any decryption attempt', async () => {
    const bogusPath = join(tmp, 'bogus.otzi-backup');
    // 76 bytes of garbage — same length as a valid header so we exercise the
    // magic check, not the length check.
    const garbage = Buffer.alloc(BACKUP_HEADER_LEN + 32, 0xab);
    garbage.write('NOPE-NOT-OTZI', 0, 'ascii');
    await writeFile(bogusPath, garbage);

    await expect(
      runRestore({
        archivePath: bogusPath,
        password: 'whatever',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('not an otzi backup archive (magic mismatch)');
  });

  it('truncated archive (shorter than header) → "not an otzi backup archive"', async () => {
    const tinyPath = join(tmp, 'tiny.otzi-backup');
    await writeFile(tinyPath, Buffer.alloc(8, 0));

    await expect(
      runRestore({
        archivePath: tinyPath,
        password: 'whatever',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('not an otzi backup archive (magic mismatch)');
  });

  it('refuses to restore over an existing daemon.toml (rootOverride: error message names the override-prefixed path)', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const dstRoot = join(tmp, 'dst');
    const expectedConfigPath = join(dstRoot, 'etc/otzi/daemon.toml');
    await expect(
      runRestore({
        archivePath: backup.path,
        password: backup.password,
        rootOverride: dstRoot,
        configExistsCheck: () => Promise.resolve(true),
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow(
      `config already present at ${expectedConfigPath}; move it aside first`,
    );
  });

  it('refuses to restore over an existing daemon.toml (production default path: no rootOverride)', async () => {
    // No rootOverride → root === '/' → error message uses the canonical
    // production path. Uses a stub archive that passes the magic check and
    // a configExistsCheck that asserts true — we never reach the decryption
    // path.
    const fakeArchive = join(tmp, 'fake.otzi-backup');
    const buf = Buffer.alloc(BACKUP_HEADER_LEN + 16, 0);
    buf.write('OTZI-BACKUP-V1', 0, 'ascii');
    await writeFile(fakeArchive, buf);

    await expect(
      runRestore({
        archivePath: fakeArchive,
        password: 'whatever',
        // NO rootOverride — exercise the production code path.
        configExistsCheck: () => Promise.resolve(true),
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow(
      'config already present at /etc/otzi/daemon.toml; move it aside first',
    );
  });

  it('refuses to restore while the daemon is running', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    await expect(
      runRestore({
        archivePath: backup.path,
        password: backup.password,
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: () => Promise.resolve(true),
      }),
    ).rejects.toThrow('daemon is running; stop it with `systemctl stop otzi` first');
  });

  it('default configExistsCheck respects rootOverride (does not see /etc/otzi/daemon.toml on the test host)', async () => {
    // Don't pass configExistsCheck — use the default. With a fresh
    // rootOverride, the default should report false.
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: join(tmp, 'dst-default'),
      // Override only daemonStatusCheck (leave config probe at default).
      daemonStatusCheck: NEVER_RUNNING,
    });

    expect(result.restoredFiles.length).toBeGreaterThan(0);
  });

  it('restores an archive built without the optional vault-pubkey file', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot, { skipVaultPubkey: true, skipAddressBook: true });
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    // vault-pubkey.json was not in the archive, so it is not in the restored set.
    const restoredPaths = new Set(result.restoredFiles.map((r) => r.path));
    expect(
      restoredPaths.has(resolve(restoreRoot, 'var/lib/otzi/vault-pubkey.json')),
    ).toBe(false);
    // But required files are still there.
    expect(restoredPaths.has(resolve(restoreRoot, 'etc/otzi/daemon.toml'))).toBe(true);
    expect(restoredPaths.size).toBe(4);
  });

  it('skips an entry outside the file set, with a warning, and writes nothing for it', async () => {
    // Only the fixed paths and the three paths daemon.toml names are restored;
    // anything else in an archive (an older daemon's leftovers, or planted
    // entries) is skipped and reported.
    const archive = await craftArchive(tmp, {
      'etc/otzi/daemon.toml': '[share]\npath = "/var/lib/otzi/share.json"\n',
      'var/lib/otzi/share.json': '{}',
      'var/lib/otzi/extra-entry': 'leftover\n',
      'etc/cron.d/evil': '* * * * * root sh -c id\n',
      'root/.ssh/authorized_keys': 'ssh-ed25519 AAAA attacker\n',
    });

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: archive.path,
      password: archive.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    expect(result.restoredFiles.map((r) => r.path).sort()).toEqual(
      [resolve(restoreRoot, 'etc/otzi/daemon.toml'), resolve(restoreRoot, SHARE_TAR)].sort(),
    );
    expect(result.skippedEntries).toEqual(['var/lib/otzi/extra-entry', 'etc/cron.d/evil', 'root/.ssh/authorized_keys']);
    for (const planted of ['var/lib/otzi/extra-entry', 'etc/cron.d/evil', 'root/.ssh/authorized_keys']) {
      expect(await pathExists(resolve(restoreRoot, planted)), planted).toBe(false);
    }
  });

  it('extraction never escapes rootOverride even if a tar entry has a leading slash (paranoid check)', async () => {
    // tar's default behavior strips leading slashes from absolute path
    // entries. backup.ts never produces such entries (it uses
    // stripLeadingSlash before adding to the archive), but this test
    // confirms the safety property end-to-end: every file we restore
    // resolves under restoreRoot.
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    const resolvedRoot = resolve(restoreRoot);
    for (const r of result.restoredFiles) {
      expect(r.path.startsWith(resolvedRoot + '/')).toBe(true);
    }
  });

  it('returns metaPartyId from meta.json when present', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: join(tmp, 'dst'),
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    // partyId is read from the share file's top-level field (= 7 in fixture).
    expect(result.metaPartyId).toBe(7);
  });

  it('atomicity (I-1, superseded by R47): an existing target, even a directory, refuses before anything is written', async () => {
    // Build a real archive, then arrange for a mid-loop placement to throw
    // by pre-creating one of the destination paths as a DIRECTORY. writeFile
    // against an existing directory yields EISDIR, which propagates out of
    // the placement loop and triggers the rollback path.
    //
    // The loop places files in tar entry order (see backup.ts fileSet):
    // `etc/otzi/daemon.toml` first, then the share, pubkeys and identity,
    // `var/lib/otzi/vault-pubkey.json`, the address book, and the generated
    // meta.json last (never written). Sabotage vault-pubkey.json; assert that
    // everything placed before it was rolled back (no file at
    // `<restoreRoot>/etc/otzi/daemon.toml`, share, identity or pubkeys) and
    // that nothing after it was placed, so NO files anywhere under
    // restoreRoot survive.
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const restoreRoot = join(tmp, 'dst-rollback');
    // Pre-create the vault-pubkey *path* as a directory so writeFile() will
    // throw EISDIR when the loop reaches it.
    const sabotagePath = join(restoreRoot, 'var/lib/otzi/vault-pubkey.json');
    await mkdir(sabotagePath, { recursive: true });

    const daemonTomlDest = join(restoreRoot, 'etc/otzi/daemon.toml');

    await expect(
      runRestore({
        archivePath: backup.path,
        password: backup.password,
        rootOverride: restoreRoot,
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow(`restore would replace existing files: ${sabotagePath}`);

    // Nothing was written: the refusal comes before placement.
    expect(await pathExists(daemonTomlDest)).toBe(false);

    // The sabotage directory itself should remain (it predates the call —
    // we don't touch parent directories).
    expect(await pathExists(sabotagePath)).toBe(true);

    // No other restored files should survive either. Walk the var-tree
    // dest paths the fixture would have produced.
    const shareRel = SHARE_TAR;
    const identityRel = IDENTITY_TAR;
    const pubkeysRel = PUBKEYS_TAR;
    expect(await pathExists(resolve(restoreRoot, shareRel))).toBe(false);
    expect(await pathExists(resolve(restoreRoot, identityRel))).toBe(false);
    expect(await pathExists(resolve(restoreRoot, pubkeysRel))).toBe(false);
    expect(await pathExists(resolve(restoreRoot, ADDRESS_BOOK_TAR))).toBe(false);
  });

  it('magic mismatch error fires before pre-flight checks against existing config (cheap precheck order)', async () => {
    // Both pre-flight checks would refuse — but magic check should run
    // first to give the clearest error to the operator.
    const bogusPath = join(tmp, 'bogus.otzi-backup');
    const garbage = Buffer.alloc(BACKUP_HEADER_LEN + 32, 0xff);
    garbage.write('NOT-AN-OTZI-FILE', 0, 'ascii');
    await writeFile(bogusPath, garbage);

    await expect(
      runRestore({
        archivePath: bogusPath,
        password: 'whatever',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: () => Promise.resolve(true), // would also refuse
        daemonStatusCheck: () => Promise.resolve(true), // would also refuse
      }),
    ).rejects.toThrow('not an otzi backup archive (magic mismatch)');
  });
});

describe('magic byte boundary', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-restore-magic-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('accepts archive with exact magic + NUL padding', async () => {
    // Spot-check: a buffer with the right magic + NUL pad makes it past
    // magic check (will fail at decrypt, but we should reach decrypt).
    const path = join(tmp, 'fake.otzi-backup');
    const buf = Buffer.alloc(BACKUP_HEADER_LEN + 16, 0); // header + minimal "ciphertext"
    buf.write('OTZI-BACKUP-V1', 0, 'ascii');
    // Leave bytes 14..32 as NUL (padding).
    await writeFile(path, buf);

    // This should reach the decrypt phase + fail with "wrong password or
    // corrupted archive" (NOT "magic mismatch").
    await expect(
      runRestore({
        archivePath: path,
        password: 'whatever',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('wrong password or corrupted archive');
  });

  it('rejects archive with magic prefix + extra trailing chars', async () => {
    const path = join(tmp, 'fake.otzi-backup');
    const buf = Buffer.alloc(BACKUP_HEADER_LEN + 16, 0);
    // 'OTZI-BACKUP-V1' is 14 chars; write 'OTZI-BACKUP-V1XXXXXX' (corrupted).
    buf.write('OTZI-BACKUP-V1XX', 0, 'ascii');
    await writeFile(path, buf);

    await expect(
      runRestore({
        archivePath: path,
        password: 'whatever',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('not an otzi backup archive (magic mismatch)');
  });

  it('rejects archive with valid magic + NUL + non-NUL bytes inside the padding region', async () => {
    // Strict-NUL-padding check (I-3): bytes 14..32 of the magic field MUST
    // all be NUL. An archive shaped like 'OTZI-BACKUP-V1\0XYZ\0...' (correct
    // magic, terminating NUL, then garbage in the padding region) was
    // accepted by the old `replace(/\0+$/, '')` check because it trimmed
    // only TRAILING NULs. The strict check rejects it — defends against
    // future format-versioning ambiguity.
    const path = join(tmp, 'fake.otzi-backup');
    const buf = Buffer.alloc(BACKUP_HEADER_LEN + 16, 0);
    buf.write('OTZI-BACKUP-V1', 0, 'ascii');
    // bytes 14..15 = NUL (already from alloc), then inject garbage at 15.
    buf.write('XYZ', 15, 'ascii');
    // bytes 18..32 stay as NUL.
    await writeFile(path, buf);

    await expect(
      runRestore({
        archivePath: path,
        password: 'whatever',
        rootOverride: join(tmp, 'dst'),
        configExistsCheck: NEVER_EXISTS,
        daemonStatusCheck: NEVER_RUNNING,
      }),
    ).rejects.toThrow('not an otzi backup archive (magic mismatch)');
  });

  it('magic field is exactly 32 bytes (predecessor invariant from backup.ts)', () => {
    // Sanity check on the constant we depend on.
    expect(BACKUP_MAGIC_LEN).toBe(32);
  });
});

describe('passwordStdin', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-restore-stdin-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads password from stdinStream until newline when passwordStdin=true', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    // Use the stdinStream seam so we don't have to monkey-patch
    // process.stdin in-process. The seam is a Readable preloaded with the
    // password + newline; runRestore's stdin reader iterates it the same
    // way it would iterate the real stdin (postinst path:
    // `echo "$PWD" | otzi restore --password-stdin <path>`).
    const fakeStdin = Readable.from([Buffer.from(backup.password + '\n', 'utf8')]);
    const result = await runRestore({
      archivePath: backup.path,
      passwordStdin: true,
      stdinStream: fakeStdin,
      rootOverride: join(tmp, 'dst'),
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });
    expect(result.restoredFiles.length).toBeGreaterThan(0);
  });

  it('stdinStream: trailing chars after newline are not consumed', async () => {
    // Defensive: if the input has 'PWD\nGARBAGE', we should still extract
    // 'PWD' (and ignore the rest, since postinst sends the password then
    // closes the pipe).
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const fakeStdin = Readable.from([
      Buffer.from(backup.password + '\nleftover-bytes', 'utf8'),
    ]);
    const result = await runRestore({
      archivePath: backup.path,
      passwordStdin: true,
      stdinStream: fakeStdin,
      rootOverride: join(tmp, 'dst'),
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });
    expect(result.restoredFiles.length).toBeGreaterThan(0);
  });

  it('stdinStream: chunked input (password split across two chunks) joins correctly', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: overridesFrom(f),
      rootOverride: f.root,
    });

    const half = Math.floor(backup.password.length / 2);
    const part1 = backup.password.slice(0, half);
    const part2 = backup.password.slice(half) + '\n';
    const fakeStdin = Readable.from([
      Buffer.from(part1, 'utf8'),
      Buffer.from(part2, 'utf8'),
    ]);
    const result = await runRestore({
      archivePath: backup.path,
      passwordStdin: true,
      stdinStream: fakeStdin,
      rootOverride: join(tmp, 'dst'),
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });
    expect(result.restoredFiles.length).toBeGreaterThan(0);
  });
});

// ─── Archive entry and path safety (R46, R47) ─────────────────────────────

/** One tar member for `rawArchive`: any name, any type flag. */
interface RawEntry {
  name: string;
  /** Tar typeflag: '0' file, '1' hardlink, '2' symlink, '3' char dev, '4' block dev, '5' dir, '6' FIFO. */
  type: '0' | '1' | '2' | '3' | '4' | '5' | '6';
  data?: string;
  linkname?: string;
}

/** A ustar header, written by hand so a test can produce names and types tar tools refuse to write. */
function tarHeader(e: RawEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  const field = (value: string, offset: number, length: number) => h.write(value, offset, length, 'utf8');
  const octal = (n: number, length: number) => n.toString(8).padStart(length - 1, '0') + '\0';
  field(e.name, 0, 100);
  field(octal(e.type === '5' ? 0o755 : 0o644, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(size, 12), 124, 12);
  field(octal(0, 12), 136, 12);
  field('        ', 148, 8);
  field(e.type, 156, 1);
  field(e.linkname ?? '', 157, 100);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** An encrypted archive whose tar members are written byte by byte from `entries`. */
async function rawArchive(dir: string, entries: RawEntry[]): Promise<{ path: string; password: string }> {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8');
    parts.push(tarHeader(e, e.type === '0' ? data.length : 0));
    if (e.type === '0' && data.length > 0) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  const tgz = gzipSync(Buffer.concat(parts));

  const password = 'raw-archive-password';
  const salt = randomBytes(BACKUP_SALT_LEN);
  const iv = randomBytes(BACKUP_IV_LEN);
  const key = pbkdf2Sync(password, salt, BACKUP_PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(tgz), cipher.final()]);
  const magic = Buffer.alloc(BACKUP_MAGIC_LEN, 0);
  magic.write(BACKUP_MAGIC, 0, 'ascii');
  const path = join(dir, `raw-${randomBytes(4).toString('hex')}.otzi-backup`);
  await writeFile(path, Buffer.concat([magic, salt, iv, cipher.getAuthTag(), ciphertext]));
  return { path, password };
}

/** Every regular file under `dir`, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const out: string[] = [];
  for (const name of await readdir(dir, { recursive: true })) {
    if ((await lstat(join(dir, name))).isFile()) out.push(name);
  }
  return out.sort();
}

describe('runRestore — entry and path safety', () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-restore-safety-'));
    root = join(tmp, 'dst');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const TOML = '[share]\npath = "/var/lib/otzi/share.json"\n';
  const restore = (archive: { path: string; password: string }) =>
    runRestore({
      archivePath: archive.path,
      password: archive.password,
      rootOverride: root,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

  it.each<[string, RawEntry, RegExp]>([
    ['a .. entry', { name: 'var/lib/otzi/../../../etc/cron.d/evil', type: '0', data: 'x' }, /'\.\.'/],
    ['an absolute entry', { name: '/etc/cron.d/evil', type: '0', data: 'x' }, /absolute/],
    ['a symlink', { name: 'var/lib/otzi/link', type: '2', linkname: '/etc/shadow' }, /symlink/],
    ['a symlink at a target path', { name: 'var/lib/otzi/identity.json', type: '2', linkname: '/etc/shadow' }, /symlink/],
    ['a hardlink', { name: 'var/lib/otzi/pubkeys.json', type: '1', linkname: 'etc/otzi/daemon.toml' }, /hardlink/],
    ['a character device', { name: 'var/lib/otzi/tty', type: '3' }, /device/],
    ['a block device', { name: 'var/lib/otzi/sda', type: '4' }, /device/],
    ['a FIFO', { name: 'var/lib/otzi/fifo', type: '6' }, /FIFO/],
    ['a directory where a file is expected', { name: 'var/lib/otzi/vault-pubkey.json/', type: '5' }, /directory/],
  ])('refuses an archive with %s and writes nothing', async (_name, bad, message) => {
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: TOML },
      { name: 'var/lib/otzi/share.json', type: '0', data: '{}' },
      bad,
    ]);
    const err = await restore(archive).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(message);
    expect(err!.message).toContain(bad.name);
    expect(await filesUnder(root)).toEqual([]);
    expect(await pathExists(join(tmp, 'etc'))).toBe(false);
  });

  it.each([
    ['[share].path', '[share]\npath = "/etc/cron.d/evil"\n', 'etc/cron.d/evil'],
    ['[node].identity_key_file', '[node]\nidentity_key_file = "/root/.ssh/authorized_keys"\n', 'root/.ssh/authorized_keys'],
    ['[node].pubkey_book_file', '[node]\npubkey_book_file = "/var/lib/otzi/../../../etc/passwd"\n', 'etc/passwd'],
    ['[share].path (the data dir itself)', '[share]\npath = "/var/lib/otzi"\n', 'var/lib/otzi'],
    ['[share].path (relative)', '[share]\npath = "var/lib/otzi/share.json"\n', 'var/lib/otzi/share.json'],
    ['[share].path (nested)', '[share]\npath = "/var/lib/otzi/keys/share.json"\n', 'var/lib/otzi/keys/share.json'],
    ['[node].identity_key_file (nested)', '[node]\nidentity_key_file = "/etc/otzi/keys/identity.json"\n', 'etc/otzi/keys/identity.json'],
  ])('refuses a daemon.toml whose %s is not a direct child of /etc/otzi or /var/lib/otzi', async (key, toml, tarPath) => {
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: toml },
      { name: tarPath, type: '0', data: 'payload' },
    ]);
    const err = await restore(archive).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(key.split(' ')[0]!);
    expect(err!.message).toMatch(/\/etc\/otzi.*\/var\/lib\/otzi/);
    expect(await filesUnder(root)).toEqual([]);
  });

  it('refuses a target below a subdirectory of the data dir, so no symlinked directory can redirect a write', async () => {
    const outside = join(tmp, 'outside');
    await mkdir(outside, { recursive: true });
    await mkdir(join(root, 'var/lib/otzi'), { recursive: true });
    await symlink(outside, join(root, 'var/lib/otzi/sub'));
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: '[share]\npath = "/var/lib/otzi/sub/share.json"\n' },
      { name: 'var/lib/otzi/sub/share.json', type: '0', data: 'payload' },
    ]);
    await expect(restore(archive)).rejects.toThrow(
      /\[share\]\.path = \/var\/lib\/otzi\/sub\/share\.json is not a direct child of \/etc\/otzi or \/var\/lib\/otzi; refused/,
    );
    expect(await filesUnder(outside)).toEqual([]);
    expect(await pathExists(join(root, 'etc/otzi/daemon.toml'))).toBe(false);
  });

  it('places the share, identity and pubkey book as direct children of either allowed directory', async () => {
    const toml =
      '[share]\npath = "/var/lib/otzi/share.json"\n[node]\nidentity_key_file = "/etc/otzi/identity.json"\npubkey_book_file = "/var/lib/otzi/./pubkeys.json"\n';
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: toml },
      { name: 'var/lib/otzi/share.json', type: '0', data: 'share' },
      { name: 'etc/otzi/identity.json', type: '0', data: 'identity' },
      { name: 'var/lib/otzi/pubkeys.json', type: '0', data: 'book' },
    ]);
    const result = await restore(archive);
    expect(result.restoredFiles.map(f => f.path).sort()).toEqual(
      ['etc/otzi/daemon.toml', 'etc/otzi/identity.json', 'var/lib/otzi/pubkeys.json', 'var/lib/otzi/share.json'].map(p =>
        join(root, p),
      ),
    );
    expect(await filesUnder(root)).toEqual([
      'etc/otzi/daemon.toml',
      'etc/otzi/identity.json',
      'var/lib/otzi/pubkeys.json',
      'var/lib/otzi/share.json',
    ]);
  });

  it('shows archive-derived names without control characters in its refusals', async () => {
    const hostile = 'var/lib/otzi/evil\u001b[2J\nfake line';
    const entry = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: TOML },
      { name: hostile, type: '2', linkname: '/etc/shadow' },
    ]);
    const err1 = await restore(entry).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err1!.message).toBe('archive entry var/lib/otzi/evil[2J fake line: symlink refused');

    // The same for a path the archived daemon.toml names (TOML escapes carry the control characters).
    const path = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: '[share]\npath = "/etc/evil\\u001b[2J\\nfake line"\n' },
    ]);
    const err2 = await restore(path).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err2!.message).toBe(
      'daemon.toml in the archive: [share].path = /etc/evil[2J fake line is outside /etc/otzi and /var/lib/otzi; refused',
    );
    expect(await filesUnder(root)).toEqual([]);
  });

  it('refuses an archive that names the same file twice', async () => {
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: TOML },
      { name: 'var/lib/otzi/share.json', type: '0', data: 'one' },
      { name: 'var/lib/otzi/share.json', type: '0', data: 'two' },
    ]);
    await expect(restore(archive)).rejects.toThrow(/var\/lib\/otzi\/share\.json: the archive holds this file more than once/);
    expect(await filesUnder(root)).toEqual([]);
  });

  it('refuses when any target already exists, lists them, and leaves every file untouched', async () => {
    await mkdir(join(root, 'var/lib/otzi'), { recursive: true });
    await mkdir(join(root, 'etc/otzi'), { recursive: true });
    await writeFile(join(root, 'var/lib/otzi/share.json'), 'EXISTING SHARE', { mode: 0o600 });
    await symlink(join(tmp, 'nowhere'), join(root, 'etc/otzi/address-book.otzi.json'));
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: TOML },
      { name: 'var/lib/otzi/share.json', type: '0', data: 'BACKED-UP SHARE' },
      { name: 'etc/otzi/address-book.otzi.json', type: '0', data: '{}' },
    ]);

    const err = await restore(archive).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(join(root, 'var/lib/otzi/share.json'));
    expect(err!.message).toContain(join(root, 'etc/otzi/address-book.otzi.json'));
    expect(err!.message).toMatch(/move them aside/);
    expect(await readFile(join(root, 'var/lib/otzi/share.json'), 'utf8')).toBe('EXISTING SHARE');
    expect(await pathExists(join(root, 'etc/otzi/daemon.toml'))).toBe(false);
    expect((await lstat(join(root, 'etc/otzi/address-book.otzi.json'))).isSymbolicLink()).toBe(true);
  });

  it('a failure in the middle removes only the files restore created; pre-existing files stay', async () => {
    await mkdir(join(root, 'var/lib/otzi'), { recursive: true });
    await mkdir(join(root, 'etc/otzi'), { recursive: true });
    await writeFile(join(root, 'var/lib/otzi/keep.txt'), 'keep me');
    await writeFile(join(root, 'etc/otzi/otzi.env'), 'OTZI_SHARE_PASSWORD=x');
    const toml =
      '[share]\npath = "/var/lib/otzi/share.json"\n[node]\nidentity_key_file = "/var/lib/otzi/id"\npubkey_book_file = "/var/lib/otzi/book.json"\n';
    const archive = await rawArchive(tmp, [
      { name: 'etc/otzi/daemon.toml', type: '0', data: toml },
      { name: 'var/lib/otzi/share.json', type: '0', data: 'share' },
      { name: 'var/lib/otzi/id', type: '0', data: 'identity' },
      { name: 'var/lib/otzi/book.json', type: '0', data: 'book' },
    ]);

    // The last file cannot be written: the three before it must go, the two that were there stay.
    failOpen.suffix = 'var/lib/otzi/book.json';
    try {
      await expect(restore(archive)).rejects.toThrow(/EIO: simulated write failure/);
    } finally {
      failOpen.suffix = undefined;
    }
    expect(await filesUnder(root)).toEqual(['etc/otzi/otzi.env', 'var/lib/otzi/keep.txt']);
    expect(await readFile(join(root, 'var/lib/otzi/keep.txt'), 'utf8')).toBe('keep me');
  });
});
