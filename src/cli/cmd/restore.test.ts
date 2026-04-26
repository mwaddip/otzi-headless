/**
 * Tests for `otzi restore` — the round-trip is the most load-bearing case
 * (proves byte-for-byte symmetry with backup.ts), then per-error-path
 * coverage to make sure the friendly messages survive refactors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { runBackup, BACKUP_HEADER_LEN, BACKUP_MAGIC_LEN } from './backup';
import { runRestore } from './restore';

interface Fixture {
  configPath: string;
  manifestPath: string;
  sharePath: string;
  identityPath: string;
  pubkeyBookPath: string;
  vaultPubkeyPath: string;
  bootstrapSecretPath: string;
}

interface FixtureOpts {
  skipManifest?: boolean;
  skipVaultPubkey?: boolean;
  skipBootstrapSecret?: boolean;
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
  const bootstrapSecretPath = join(varDir, 'bootstrap-secret');
  const manifestPath = join(etcDir, 'manifest.otzi.json');

  const tomlText = `
[share]
path = "${sharePath}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"
party_id = 7
identity_key_file = "${identityPath}"
pubkey_book_file = "${pubkeyBookPath}"

[network]
name = "regtest"
opnet_rpc = "https://example/rpc"

[transport]
kind = "peer-mesh"

[[peers]]
id = "node-b"
party_id = 1

[gate]
strategy = "auto"
`;
  const configPath = join(etcDir, 'daemon.toml');
  await writeFile(configPath, tomlText, { mode: 0o640 });

  if (!opts.skipManifest) {
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, name: 'fixture', contracts: [] }),
      { mode: 0o660 },
    );
  }
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
  if (!opts.skipBootstrapSecret) {
    await writeFile(bootstrapSecretPath, 'bootstrap-token\n', { mode: 0o660 });
  }

  return {
    configPath,
    manifestPath,
    sharePath,
    identityPath,
    pubkeyBookPath,
    vaultPubkeyPath,
    bootstrapSecretPath,
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
    expect(restoredPaths.has(restored('etc/otzi/manifest.otzi.json'))).toBe(true);
    // Share file lives at the same relative path the backup recorded.
    const shareRel = f.sharePath.startsWith('/') ? f.sharePath.slice(1) : f.sharePath;
    expect(restoredPaths.has(restored(shareRel))).toBe(true);
    const identityRel = f.identityPath.startsWith('/')
      ? f.identityPath.slice(1)
      : f.identityPath;
    expect(restoredPaths.has(restored(identityRel))).toBe(true);
    const pubkeysRel = f.pubkeyBookPath.startsWith('/')
      ? f.pubkeyBookPath.slice(1)
      : f.pubkeyBookPath;
    expect(restoredPaths.has(restored(pubkeysRel))).toBe(true);
    expect(restoredPaths.has(restored('var/lib/otzi/vault-pubkey.json'))).toBe(true);
    expect(restoredPaths.has(restored('var/lib/otzi/bootstrap-secret'))).toBe(true);

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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
    expect(await modeOf(restored('etc/otzi/manifest.otzi.json'))).toBe(0o660);

    const shareRel = f.sharePath.startsWith('/') ? f.sharePath.slice(1) : f.sharePath;
    expect(await modeOf(restored(shareRel))).toBe(0o600); // share — by elimination
    const identityRel = f.identityPath.startsWith('/')
      ? f.identityPath.slice(1)
      : f.identityPath;
    expect(await modeOf(restored(identityRel))).toBe(0o660);
    const pubkeysRel = f.pubkeyBookPath.startsWith('/')
      ? f.pubkeyBookPath.slice(1)
      : f.pubkeyBookPath;
    expect(await modeOf(restored(pubkeysRel))).toBe(0o644);
    expect(await modeOf(restored('var/lib/otzi/vault-pubkey.json'))).toBe(0o644);
    expect(await modeOf(restored('var/lib/otzi/bootstrap-secret'))).toBe(0o660);

    // Result-reported modes match on-disk modes.
    expect(got.get(restored('etc/otzi/daemon.toml'))).toBe(0o640);
    expect(got.get(restored(shareRel))).toBe(0o600);
  });

  it('wrong password → friendly error', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      `config already present at ${expectedConfigPath}; remove it first`,
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
      'config already present at /etc/otzi/daemon.toml; remove it first',
    );
  });

  it('refuses to restore while the daemon is running', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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

  it('skips optional bootstrap-secret cleanly when archive omits it', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot, { skipBootstrapSecret: true });
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
    });

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    // bootstrap-secret should NOT be in the restored set (wasn't in the archive).
    const restoredPaths = new Set(result.restoredFiles.map((r) => r.path));
    expect(
      restoredPaths.has(resolve(restoreRoot, 'var/lib/otzi/bootstrap-secret')),
    ).toBe(false);
    // But required files are still there.
    expect(restoredPaths.has(resolve(restoreRoot, 'etc/otzi/daemon.toml'))).toBe(true);
  });

  it('skips optional manifest cleanly when archive omits it', async () => {
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot, { skipManifest: true });
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
    });

    const restoreRoot = join(tmp, 'dst');
    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: restoreRoot,
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    const restoredPaths = new Set(result.restoredFiles.map((r) => r.path));
    expect(restoredPaths.has(resolve(restoreRoot, 'etc/otzi/manifest.otzi.json'))).toBe(false);
    expect(restoredPaths.has(resolve(restoreRoot, 'etc/otzi/daemon.toml'))).toBe(true);
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
    });

    const result = await runRestore({
      archivePath: backup.path,
      password: backup.password,
      rootOverride: join(tmp, 'dst'),
      configExistsCheck: NEVER_EXISTS,
      daemonStatusCheck: NEVER_RUNNING,
    });

    // partyId is 7 in the fixture's daemon.toml.
    expect(result.metaPartyId).toBe(7);
  });

  it('atomicity (I-1): a placement failure mid-loop rolls back files placed before the failure', async () => {
    // Build a real archive, then arrange for a mid-loop placement to throw
    // by pre-creating one of the destination paths as a DIRECTORY. writeFile
    // against an existing directory yields EISDIR, which propagates out of
    // the placement loop and triggers the rollback path.
    //
    // The first file the loop tries to place is `etc/otzi/daemon.toml`
    // (by tar entry order — see backup.ts fileSet). The second is
    // `etc/otzi/manifest.otzi.json`. Sabotage the second to fail; assert
    // that the first was rolled back (no file at `<restoreRoot>/etc/otzi/
    // daemon.toml`) and that NO files anywhere under restoreRoot survive.
    const backupRoot = join(tmp, 'src');
    const f = await buildBackupFixture(backupRoot);
    const backup = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'archive'),
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
    });

    const restoreRoot = join(tmp, 'dst-rollback');
    // Pre-create the manifest *path* as a directory so writeFile() will
    // throw EISDIR when the loop reaches it.
    const sabotagePath = join(restoreRoot, 'etc/otzi/manifest.otzi.json');
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
    ).rejects.toThrow(/EISDIR|illegal operation on a directory/);

    // The file placed BEFORE the failure (daemon.toml) must NOT exist after
    // rollback. This is the load-bearing assertion: if rollback is broken,
    // daemon.toml will still be on disk.
    expect(await pathExists(daemonTomlDest)).toBe(false);

    // The sabotage directory itself should remain (it predates the call —
    // we don't touch parent directories).
    expect(await pathExists(sabotagePath)).toBe(true);

    // No other restored files should survive either. Walk the var-tree
    // dest paths the fixture would have produced.
    const shareRel = f.sharePath.startsWith('/') ? f.sharePath.slice(1) : f.sharePath;
    const identityRel = f.identityPath.startsWith('/')
      ? f.identityPath.slice(1)
      : f.identityPath;
    const pubkeysRel = f.pubkeyBookPath.startsWith('/')
      ? f.pubkeyBookPath.slice(1)
      : f.pubkeyBookPath;
    expect(await pathExists(resolve(restoreRoot, shareRel))).toBe(false);
    expect(await pathExists(resolve(restoreRoot, identityRel))).toBe(false);
    expect(await pathExists(resolve(restoreRoot, pubkeysRel))).toBe(false);
    expect(
      await pathExists(resolve(restoreRoot, 'var/lib/otzi/vault-pubkey.json')),
    ).toBe(false);
    expect(
      await pathExists(resolve(restoreRoot, 'var/lib/otzi/bootstrap-secret')),
    ).toBe(false);
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
      pathOverrides: {
        manifest: f.manifestPath,
        vaultPubkey: f.vaultPubkeyPath,
        bootstrapSecret: f.bootstrapSecretPath,
      },
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
