import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  runBackup,
  BACKUP_MAGIC,
  BACKUP_MAGIC_LEN,
  BACKUP_SALT_LEN,
  BACKUP_IV_LEN,
  BACKUP_HEADER_LEN,
  BACKUP_PBKDF2_ITERATIONS,
} from './backup';

interface Fixture {
  configPath: string;
  manifestPath: string;
  sharePath: string;
  identityPath: string;
  pubkeyBookPath: string;
  vaultPubkeyPath: string;
  bootstrapSecretPath: string;
  expectedShareTar: string;
  expectedIdTar: string;
  expectedPubTar: string;
}

interface FixtureOpts {
  /** Skip writing the manifest file (test optional skip). */
  skipManifest?: boolean;
  /** Skip writing the share file (test required-file failure). */
  skipShare?: boolean;
  /** Skip writing the identity file (test required-file failure). */
  skipIdentity?: boolean;
  /** Skip writing the pubkey-book file (test required-file failure). */
  skipPubkeys?: boolean;
  /** Skip writing the vault-pubkey cache (test optional skip). */
  skipVaultPubkey?: boolean;
  /** Skip writing the bootstrap-secret (test optional skip). */
  skipBootstrapSecret?: boolean;
}

/**
 * Materialize a fake daemon install layout under `root`. The share / identity
 * / pubkey-book paths are encoded into the daemon.toml so backup discovers
 * them via the real config-parsing path. The "fixed" paths (manifest,
 * vault-pubkey, bootstrap-secret) are tmpdir-rooted and have to be passed via
 * `pathOverrides` to runBackup — those paths aren't in the config.
 */
async function buildFixture(root: string, opts: FixtureOpts = {}): Promise<Fixture> {
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
identity_key_file = "${identityPath}"
pubkey_book_file = "${pubkeyBookPath}"

[network]
name = "regtest"
opnet_rpc = "https://example/rpc"

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"

[[peers]]
endpoint = "127.0.0.1:8801"

[gate]
strategy = "auto"
`;
  const configPath = join(etcDir, 'daemon.toml');
  await writeFile(configPath, tomlText);

  if (!opts.skipManifest) {
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, name: 'fixture', contracts: [] }),
    );
  }
  if (!opts.skipShare) {
    await writeFile(sharePath, JSON.stringify({ version: 3, partyId: 7 }), {
      mode: 0o600,
    });
  }
  if (!opts.skipIdentity) {
    await writeFile(identityPath, '----- IDENTITY -----', { mode: 0o600 });
  }
  if (!opts.skipPubkeys) {
    await writeFile(pubkeyBookPath, JSON.stringify({ peers: ['node-a', 'node-b'] }));
  }
  if (!opts.skipVaultPubkey) {
    await writeFile(vaultPubkeyPath, JSON.stringify({ p2tr: 'bc1p...' }));
  }
  if (!opts.skipBootstrapSecret) {
    await writeFile(bootstrapSecretPath, 'super-secret-bootstrap-token\n', {
      mode: 0o660,
    });
  }

  return {
    configPath,
    manifestPath,
    sharePath,
    identityPath,
    pubkeyBookPath,
    vaultPubkeyPath,
    bootstrapSecretPath,
    expectedShareTar: stripLead(sharePath),
    expectedIdTar: stripLead(identityPath),
    expectedPubTar: stripLead(pubkeyBookPath),
  };
}

function stripLead(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

/**
 * Decrypt the given backup buffer with the given password and return the
 * decompressed plaintext. Throws on auth-tag mismatch (i.e. wrong password OR
 * tampered ciphertext OR tampered header).
 */
function decryptBackup(buf: Buffer, password: string): Buffer {
  const magic = buf.subarray(0, BACKUP_MAGIC_LEN);
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

  expect(magic.toString('ascii').replace(/\0+$/, '')).toBe(BACKUP_MAGIC);

  const key = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    BACKUP_PBKDF2_ITERATIONS,
    32,
    'sha256',
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const gz = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return gunzipSync(gz);
}

/** Build the `pathOverrides` block from a fixture. */
function overridesFrom(f: Fixture) {
  return {
    manifest: f.manifestPath,
    vaultPubkey: f.vaultPubkeyPath,
    bootstrapSecret: f.bootstrapSecretPath,
  };
}

describe('runBackup', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-backup-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('happy path: round-trips all files, returns base62 password', async () => {
    const f = await buildFixture(tmp);
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
    });

    // Archive file exists.
    const buf = await readFile(result.path);
    expect(buf.length).toBeGreaterThan(BACKUP_HEADER_LEN);

    // Password shape: 32 chars from base62.
    expect(result.password).toMatch(/^[A-Za-z0-9]{32}$/);

    // filesIncluded: the FIXED entries keep their canonical relative tar
    // paths regardless of the override source. The dynamic entries (share,
    // identity, pubkey-book) take their tar paths from the source path with
    // the leading slash stripped.
    expect(new Set(result.filesIncluded)).toEqual(
      new Set([
        'etc/otzi/daemon.toml',
        'etc/otzi/manifest.otzi.json',
        f.expectedShareTar,
        f.expectedPubTar,
        f.expectedIdTar,
        'var/lib/otzi/vault-pubkey.json',
        'var/lib/otzi/bootstrap-secret',
        'meta.json',
      ]),
    );

    // Round-trip decrypt + gunzip works (proves the wire format is valid).
    const plaintext = decryptBackup(buf, result.password);
    expect(plaintext.length).toBeGreaterThan(0);
  });

  it('skips missing optional files silently', async () => {
    const f = await buildFixture(tmp, {
      skipManifest: true,
      skipVaultPubkey: true,
      skipBootstrapSecret: true,
    });
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
    });

    expect(result.filesIncluded).toContain('etc/otzi/daemon.toml');
    expect(result.filesIncluded).toContain(f.expectedShareTar);
    expect(result.filesIncluded).toContain(f.expectedIdTar);
    expect(result.filesIncluded).toContain(f.expectedPubTar);
    expect(result.filesIncluded).toContain('meta.json');

    expect(result.filesIncluded).not.toContain('etc/otzi/manifest.otzi.json');
    expect(result.filesIncluded).not.toContain('var/lib/otzi/vault-pubkey.json');
    expect(result.filesIncluded).not.toContain('var/lib/otzi/bootstrap-secret');
  });

  it('fails clearly when a required file (share) is missing', async () => {
    const f = await buildFixture(tmp, { skipShare: true });
    await expect(
      runBackup({
        configPath: f.configPath,
        outputDir: join(tmp, 'out'),
        pathOverrides: overridesFrom(f),
      }),
    ).rejects.toThrow(
      /share\.json.*This looks like a fresh \/ pre-bootstrap install; nothing meaningful to back up yet\.$/s,
    );
  });

  it('fails clearly when a required file (identity) is missing', async () => {
    const f = await buildFixture(tmp, { skipIdentity: true });
    await expect(
      runBackup({
        configPath: f.configPath,
        outputDir: join(tmp, 'out'),
        pathOverrides: overridesFrom(f),
      }),
    ).rejects.toThrow(
      /identity\.json.*This looks like a fresh \/ pre-bootstrap install; nothing meaningful to back up yet\.$/s,
    );
  });

  it('fails clearly when a required file (pubkeys) is missing', async () => {
    const f = await buildFixture(tmp, { skipPubkeys: true });
    await expect(
      runBackup({
        configPath: f.configPath,
        outputDir: join(tmp, 'out'),
        pathOverrides: overridesFrom(f),
      }),
    ).rejects.toThrow(
      /pubkeys\.json.*This looks like a fresh \/ pre-bootstrap install; nothing meaningful to back up yet\.$/s,
    );
  });

  it('fails clearly when daemon.toml itself is missing', async () => {
    const f = await buildFixture(tmp);
    await rm(f.configPath);
    await expect(
      runBackup({
        configPath: f.configPath,
        outputDir: join(tmp, 'out'),
        pathOverrides: overridesFrom(f),
      }),
    ).rejects.toThrow(
      /daemon\.toml.*This looks like a fresh \/ pre-bootstrap install; nothing meaningful to back up yet\.$/s,
    );
  });

  it('defaults outputDir to os.homedir() when omitted', async () => {
    // End-to-end check: omit outputDir → archive lands under os.homedir().
    // We write to homedir and immediately delete to keep $HOME clean.
    const f = await buildFixture(tmp);
    const before = new Set(await safeReaddir(homedir()));
    let result;
    try {
      result = await runBackup({
        configPath: f.configPath,
        pathOverrides: overridesFrom(f),
      });
      expect(result.path.startsWith(homedir() + '/')).toBe(true);
      const after = new Set(await safeReaddir(homedir()));
      const added = [...after].filter((n) => !before.has(n));
      expect(added).toContain(result.path.split('/').pop());
    } finally {
      if (result) await rm(result.path, { force: true });
    }
  });

  it('tampering invalidates the archive (auth-tag mismatch on decrypt)', async () => {
    const f = await buildFixture(tmp);
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
    });

    const buf = await readFile(result.path);
    // Flip 1 byte mid-ciphertext (well after the header).
    const flipIdx =
      BACKUP_HEADER_LEN + Math.floor((buf.length - BACKUP_HEADER_LEN) / 2);
    buf[flipIdx] = buf[flipIdx]! ^ 0xff;
    await writeFile(result.path, buf);

    expect(() => decryptBackup(buf, result.password)).toThrow();
  });

  it('uses a filesystem-safe ISO filename (colons and dots replaced)', async () => {
    const f = await buildFixture(tmp);
    const out = join(tmp, 'out');
    const fixed = new Date('2026-04-26T12:34:56.789Z');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
      now: () => fixed,
    });

    const filename = result.path.split('/').pop()!;
    expect(filename).toBe('otzi-backup-2026-04-26T12-34-56-789Z.otzi-backup');
    const stem = filename.replace(/\.otzi-backup$/, '');
    expect(stem).not.toMatch(/[:]/);
    // No inner dots in the stem.
    expect(stem.split('.').length).toBe(1);
  });

  it('honors passwordOverride (no random generation)', async () => {
    const f = await buildFixture(tmp);
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
      passwordOverride: 'OperatorChosenPassword12345!@#$',
    });
    expect(result.password).toBe('OperatorChosenPassword12345!@#$');

    const buf = await readFile(result.path);
    const plaintext = decryptBackup(buf, result.password);
    expect(plaintext.length).toBeGreaterThan(0);
  });

  it('produces an archive with the correct magic header', async () => {
    const f = await buildFixture(tmp);
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
    });
    const buf = await readFile(result.path);
    const magicBytes = buf.subarray(0, BACKUP_MAGIC_LEN);
    expect(magicBytes.subarray(0, BACKUP_MAGIC.length).toString('ascii')).toBe(
      BACKUP_MAGIC,
    );
    for (let i = BACKUP_MAGIC.length; i < BACKUP_MAGIC_LEN; i++) {
      expect(magicBytes[i]).toBe(0);
    }
  });

  it('writes the output file with mode 0600', async () => {
    const f = await buildFixture(tmp);
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      pathOverrides: overridesFrom(f),
    });
    const st = await stat(result.path);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
