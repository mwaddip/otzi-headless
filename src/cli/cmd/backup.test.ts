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
import * as backupModule from './backup';

interface Fixture {
  /** The install root the fixture lives under (`runBackup`'s `rootOverride`). */
  root: string;
  configPath: string;
  sharePath: string;
  identityPath: string;
  pubkeyBookPath: string;
  vaultPubkeyPath: string;
  addressBookPath: string;
  expectedShareTar: string;
  expectedIdTar: string;
  expectedPubTar: string;
}

const SHARE_TAR = 'var/lib/otzi/share.json';
const IDENTITY_TAR = 'var/lib/otzi/identity.json';
const PUBKEYS_TAR = 'var/lib/otzi/pubkeys.json';

interface FixtureOpts {
  /** Skip writing the share file (test required-file failure). */
  skipShare?: boolean;
  /** Skip writing the identity file (test required-file failure). */
  skipIdentity?: boolean;
  /** Skip writing the pubkey-book file (test required-file failure). */
  skipPubkeys?: boolean;
  /** Skip writing the vault-pubkey cache (test optional skip). */
  skipVaultPubkey?: boolean;
  /** Skip writing the address book (test optional skip). */
  skipAddressBook?: boolean;
}

/**
 * Materialize a fake daemon install layout under `root`. daemon.toml names the
 * production paths, as on a real install (backup refuses any other), so backup
 * discovers them via the real config-parsing path and reads them under `root`
 * (its `rootOverride` seam, as do the fixed paths: vault-pubkey, address book).
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
  const addressBookPath = join(etcDir, 'address-book.otzi.json');

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
  await writeFile(configPath, tomlText);

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
  if (!opts.skipAddressBook) {
    await writeFile(addressBookPath, ADDRESS_BOOK_JSON, { mode: 0o640 });
  }

  return {
    root,
    configPath,
    sharePath,
    identityPath,
    pubkeyBookPath,
    vaultPubkeyPath,
    addressBookPath,
    expectedShareTar: SHARE_TAR,
    expectedIdTar: IDENTITY_TAR,
    expectedPubTar: PUBKEYS_TAR,
  };
}

const ADDRESS_BOOK_TAR = 'etc/otzi/address-book.otzi.json';
const ADDRESS_BOOK_JSON = JSON.stringify({
  kind: 'otzi-address-book',
  version: 1,
  network: 'testnet4',
  entries: [{ label: 'treasury', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }],
});

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
      rootOverride: f.root,
    });

    // Archive file exists.
    const buf = await readFile(result.path);
    expect(buf.length).toBeGreaterThan(BACKUP_HEADER_LEN);

    // Password shape: 32 chars from base62.
    expect(result.password).toMatch(/^[A-Za-z0-9]{32}$/);

    // filesIncluded: the FIXED entries keep their canonical relative tar
    // paths. The dynamic entries (share, identity, pubkey-book) take their tar
    // paths from the paths daemon.toml names, with the leading slash stripped.
    expect(new Set(result.filesIncluded)).toEqual(
      new Set([
        'etc/otzi/daemon.toml',
        f.expectedShareTar,
        f.expectedPubTar,
        f.expectedIdTar,
        'var/lib/otzi/vault-pubkey.json',
        ADDRESS_BOOK_TAR,
        'meta.json',
      ]),
    );

    // Round-trip decrypt + gunzip works (proves the wire format is valid).
    const plaintext = decryptBackup(buf, result.password);
    expect(plaintext.length).toBeGreaterThan(0);
  });

  it('skips missing optional files silently', async () => {
    const f = await buildFixture(tmp, { skipVaultPubkey: true });
    const out = join(tmp, 'out');
    const result = await runBackup({
      configPath: f.configPath,
      outputDir: out,
      rootOverride: f.root,
    });

    expect(result.filesIncluded).toContain('etc/otzi/daemon.toml');
    expect(result.filesIncluded).toContain(f.expectedShareTar);
    expect(result.filesIncluded).toContain(f.expectedIdTar);
    expect(result.filesIncluded).toContain(f.expectedPubTar);
    expect(result.filesIncluded).toContain('meta.json');

    expect(result.filesIncluded).not.toContain('var/lib/otzi/vault-pubkey.json');
    expect(result.filesIncluded).toContain(ADDRESS_BOOK_TAR);
  });

  it('includes the address book at etc/otzi/address-book.otzi.json when present, and skips it when absent', async () => {
    const f = await buildFixture(tmp);
    const withBook = await runBackup({
      configPath: f.configPath,
      outputDir: join(tmp, 'out'),
      rootOverride: f.root,
    });
    expect(withBook.filesIncluded).toContain(ADDRESS_BOOK_TAR);

    const none = await buildFixture(join(tmp, 'bare'), { skipAddressBook: true });
    const withoutBook = await runBackup({
      configPath: none.configPath,
      outputDir: join(tmp, 'out'),
      rootOverride: none.root,
    });
    expect(withoutBook.filesIncluded).not.toContain(ADDRESS_BOOK_TAR);
    expect(withoutBook.filesIncluded).toContain('etc/otzi/daemon.toml');
  });

  it('exports default paths only for the files the vault actually has', () => {
    // facts/daemon.md "Backup file set": neither a manifest nor a
    // bootstrap-window token is in the file set, so no default path constant
    // for them exists for `runBackup` or `runRestore` to reference. The
    // address book is in the file set, and its constant is the store's.
    expect(backupModule.DEFAULT_ADDRESS_BOOK_PATH).toBe('/etc/otzi/address-book.otzi.json');
    const pathConstants = Object.keys(backupModule).filter((k) =>
      k.startsWith('DEFAULT_'),
    );
    expect(pathConstants.filter((k) => /MANIFEST|BOOTSTRAP/.test(k))).toEqual([]);
    expect(pathConstants.sort()).toEqual([
      'DEFAULT_ADDRESS_BOOK_PATH',
      'DEFAULT_DAEMON_CONFIG_PATH',
      'DEFAULT_IDENTITY_PATH',
      'DEFAULT_PUBKEY_BOOK_PATH',
      'DEFAULT_SHARE_PATH',
      'DEFAULT_VAULT_PUBKEY_PATH',
    ]);
  });

  it('fails clearly when a required file (share) is missing', async () => {
    const f = await buildFixture(tmp, { skipShare: true });
    await expect(
      runBackup({
        configPath: f.configPath,
        outputDir: join(tmp, 'out'),
        rootOverride: f.root,
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
        rootOverride: f.root,
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
        rootOverride: f.root,
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
        rootOverride: f.root,
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
        rootOverride: f.root,
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
      rootOverride: f.root,
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
      rootOverride: f.root,
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
      rootOverride: f.root,
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
      rootOverride: f.root,
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
      rootOverride: f.root,
    });
    const st = await stat(result.path);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

// ─── Paths restore would refuse (follow-up item 9) ───────────────────────

describe('runBackup — share, identity and pubkey paths', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-backup-paths-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** A daemon.toml that names the given paths for the three configurable files. */
  function tomlNaming(paths: { share?: string; identity?: string; pubkeys?: string }): string {
    return [
      '[share]',
      `path = "${paths.share ?? '/var/lib/otzi/share.json'}"`,
      '[node]',
      'id = "node-a"',
      `identity_key_file = "${paths.identity ?? '/var/lib/otzi/identity.json'}"`,
      `pubkey_book_file = "${paths.pubkeys ?? '/var/lib/otzi/pubkeys.json'}"`,
      '',
    ].join('\n');
  }

  /** The standard fixture, its daemon.toml replaced, and `extra` files (relative to the root) created. */
  async function fixtureWith(toml: string, extra: string[] = []): Promise<Fixture> {
    const f = await buildFixture(tmp);
    await writeFile(f.configPath, toml);
    for (const rel of extra) {
      await mkdir(join(f.root, rel, '..'), { recursive: true });
      await writeFile(join(f.root, rel), 'state');
    }
    return f;
  }

  it.each<[string, { share?: string; identity?: string; pubkeys?: string }, string[], RegExp]>([
    [
      'a share below a subdirectory of /var/lib/otzi',
      { share: '/var/lib/otzi/keys/share.json' },
      ['var/lib/otzi/keys/share.json'],
      /\[share\]\.path = \/var\/lib\/otzi\/keys\/share\.json is not a direct child of \/etc\/otzi or \/var\/lib\/otzi/,
    ],
    [
      'an identity below a subdirectory of /etc/otzi',
      { identity: '/etc/otzi/keys/identity.json' },
      ['etc/otzi/keys/identity.json'],
      /\[node\]\.identity_key_file = \/etc\/otzi\/keys\/identity\.json is not a direct child of \/etc\/otzi or \/var\/lib\/otzi/,
    ],
    [
      'a relative pubkey book path',
      { pubkeys: 'pubkeys.json' },
      ['pubkeys.json'],
      /\[node\]\.pubkey_book_file = pubkeys\.json is outside \/etc\/otzi and \/var\/lib\/otzi/,
    ],
    [
      'a share that climbs out with ..',
      { share: '/var/lib/otzi/../../../srv/share.json' },
      ['srv/share.json'],
      /\[share\]\.path = \/var\/lib\/otzi\/\.\.\/\.\.\/\.\.\/srv\/share\.json is outside \/etc\/otzi and \/var\/lib\/otzi/,
    ],
    [
      'an identity outside both directories',
      { identity: '/srv/otzi/identity.json' },
      ['srv/otzi/identity.json'],
      /\[node\]\.identity_key_file = \/srv\/otzi\/identity\.json is outside \/etc\/otzi and \/var\/lib\/otzi/,
    ],
    [
      'a share that is a directory',
      { share: '/var/lib/otzi' },
      [],
      /\[share\]\.path = \/var\/lib\/otzi is outside \/etc\/otzi and \/var\/lib\/otzi/,
    ],
    [
      'an identity and a share naming the same file',
      { identity: '/var/lib/otzi/./share.json' },
      [],
      /\[node\]\.identity_key_file = \/var\/lib\/otzi\/\.\/share\.json names a file another key also names/,
    ],
    [
      'a share naming daemon.toml',
      { share: '/etc/otzi/daemon.toml' },
      [],
      /\[share\]\.path = \/etc\/otzi\/daemon\.toml names a file another key also names/,
    ],
  ])('refuses %s, before writing anything', async (_name, paths, extra, message) => {
    const f = await fixtureWith(tomlNaming(paths), extra);
    const out = join(tmp, 'out');

    const err = await runBackup({ configPath: f.configPath, outputDir: out, rootOverride: f.root }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/^cannot back up: /);
    expect(err!.message).toMatch(message);
    expect(err!.message).toMatch(/; otzi restore would refuse the archive$/);
    // Nothing was written: no output directory, no archive.
    expect(await safeReaddir(out)).toEqual([]);
    await expect(stat(out)).rejects.toThrow(/ENOENT/);
  });

  it('shows a refused path without control characters', async () => {
    const f = await fixtureWith('[share]\npath = "/srv/evil\\u001b[2J\\nfake line"\n');
    await expect(
      runBackup({ configPath: f.configPath, outputDir: join(tmp, 'out'), rootOverride: f.root }),
    ).rejects.toThrow(
      'cannot back up: [share].path = /srv/evil[2J fake line is outside /etc/otzi and /var/lib/otzi; otzi restore would refuse the archive',
    );
  });

  it('archives a share, identity and pubkey book directly in either directory, under their resolved paths', async () => {
    const f = await fixtureWith(
      tomlNaming({ share: '/var/lib/otzi/./share.json', identity: '/etc/otzi/identity.json', pubkeys: '/var/lib/otzi/../otzi/pubkeys.json' }),
      ['etc/otzi/identity.json'],
    );
    const result = await runBackup({ configPath: f.configPath, outputDir: join(tmp, 'out'), rootOverride: f.root });
    expect(new Set(result.filesIncluded)).toEqual(
      new Set([
        'etc/otzi/daemon.toml',
        'var/lib/otzi/share.json',
        'etc/otzi/identity.json',
        'var/lib/otzi/pubkeys.json',
        'var/lib/otzi/vault-pubkey.json',
        ADDRESS_BOOK_TAR,
        'meta.json',
      ]),
    );
  });

  it('applies the same rule to the defaults when daemon.toml names no paths', async () => {
    const f = await fixtureWith('[node]\nid = "node-a"\n');
    const result = await runBackup({ configPath: f.configPath, outputDir: join(tmp, 'out'), rootOverride: f.root });
    expect(result.filesIncluded).toEqual(expect.arrayContaining([SHARE_TAR, IDENTITY_TAR, PUBKEYS_TAR]));
  });
});

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
