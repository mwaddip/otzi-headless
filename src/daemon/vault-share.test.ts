import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../orchestrator/types';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { toHex } from '../otzi/lib/hex';
import { decryptShareFile, encryptShareFile, type ShareFile } from '../otzi/lib/share-file';
import { testVault, type TestVault } from '../testing/proposal';
import { readVaultPubkeyFile } from './vault-pubkey';
import {
  createShareStager,
  loadVaultShare,
  pendingPath,
  vaultFileExists,
  warnOnPendingShare,
} from './vault-share';

const PASSWORD = 'correct horse battery staple';

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  extra?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (msg: string, extra?: Record<string, unknown>) => {
    lines.push({ level, msg, extra });
  };
  return {
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    lines,
  };
}

let vault: TestVault;
let goodShare: ShareFile;

beforeAll(async () => {
  vault = testVault(3, 3);
  goodShare = await encryptShareFile(
    vault.keyPackages[0]!,
    vault.publicKeyPackage,
    'testnet4',
    0,
    PASSWORD,
  );
});

describe('vault-share', () => {
  let dir: string;
  let path: string;
  let vaultPubkeyPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-share-test-'));
    path = join(dir, 'state', 'share.json');
    vaultPubkeyPath = join(dir, 'meta', 'vault-pubkey.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeShare(file: unknown = goodShare, mode = 0o600): Promise<void> {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(path, JSON.stringify(file), { mode });
  }

  describe('pendingPath / vaultFileExists', () => {
    it('appends .pending', () => {
      expect(pendingPath('/var/lib/otzi/share.json')).toBe('/var/lib/otzi/share.json.pending');
    });

    it('reports whether an entry exists at the path', async () => {
      expect(await vaultFileExists(path)).toBe(false);
      await writeShare();
      expect(await vaultFileExists(path)).toBe(true);
    });

    it('rethrows stat errors other than ENOENT', async () => {
      await writeFile(join(dir, 'plain-file'), 'x');
      await expect(vaultFileExists(join(dir, 'plain-file', 'child'))).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });
  });

  describe('createShareStager', () => {
    it('stage then commit writes a share otzi can decrypt and a matching vault-pubkey.json', async () => {
      const { keyPackages: kps, publicKeyPackage: pkp } = vault;
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: kps[0]!, publicKeyPackage: pkp });
      expect(existsSync(pendingPath(path))).toBe(true);
      expect(existsSync(path)).toBe(false);
      await stager.commit();
      expect(existsSync(pendingPath(path))).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const share = await decryptShareFile(JSON.parse(readFileSync(path, 'utf8')), 'pw');
      expect(toHex(share.publicKeyPackage.verifyingKey)).toBe(toHex(pkp.verifyingKey));
      expect(share.partyId).toBe(0);
      expect(share.network).toBe('testnet4');
      expect(share.keyPackage.signingShare).toBe(kps[0]!.signingShare);
      const vp = await readVaultPubkeyFile(vaultPubkeyPath);
      expect(vp.address).toBe(vaultPayment(toVaultKey(pkp), 'testnet4').address);
      expect(vp.address.startsWith('tb1p')).toBe(true);
      expect(statSync(vaultPubkeyPath).mode & 0o777).toBe(0o644);
    });

    it('stages the pending file with mode 0600, creating the parent directory', async () => {
      const stager = createShareStager({ path, password: 'pw', network: 'signet', partyId: 1, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[1]!, publicKeyPackage: vault.publicKeyPackage });
      expect(statSync(pendingPath(path)).mode & 0o777).toBe(0o600);
      const file = JSON.parse(readFileSync(pendingPath(path), 'utf8')) as ShareFile;
      expect(file).toMatchObject({ version: 4, network: 'signet', partyId: 1, threshold: 3, parties: 3 });
    });

    it('stage overwrites an earlier .pending and forces mode 0600', async () => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(pendingPath(path), 'stale leftover', { mode: 0o644 });
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      expect(statSync(pendingPath(path)).mode & 0o777).toBe(0o600);
      expect((JSON.parse(readFileSync(pendingPath(path), 'utf8')) as ShareFile).version).toBe(4);
    });

    it('stage rejects a key package that does not belong to partyId', async () => {
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 1, vaultPubkeyPath });
      await expect(
        stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage }),
      ).rejects.toThrow('Key package does not belong to this party');
      expect(existsSync(pendingPath(path))).toBe(false);
    });

    it('commit refuses when a share already exists', async () => {
      await writeShare();
      const before = readFileSync(path, 'utf8');
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      await expect(stager.commit()).rejects.toThrow(`share path already exists: ${path}`);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(pendingPath(path))).toBe(true);
      expect(existsSync(vaultPubkeyPath)).toBe(false);
    });

    it('commit before stage throws and touches nothing', async () => {
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await expect(stager.commit()).rejects.toThrow(/commit called before stage/);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(vaultPubkeyPath)).toBe(false);
    });

    it('commit succeeds with a warning when vault-pubkey.json cannot be written', async () => {
      // The parent of the vault-pubkey path is a regular file, so mkdir fails.
      await writeFile(join(dir, 'blocker'), 'x');
      const blocked = join(dir, 'blocker', 'vault-pubkey.json');
      const { logger, lines } = capturingLogger();
      const stager = createShareStager({
        path,
        password: 'pw-secret-9d3f',
        network: 'testnet4',
        partyId: 0,
        vaultPubkeyPath: blocked,
        logger,
      });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      await expect(stager.commit()).resolves.toBeUndefined();
      // The share is in place and decryptable.
      expect(existsSync(pendingPath(path))).toBe(false);
      const share = await decryptShareFile(JSON.parse(readFileSync(path, 'utf8')), 'pw-secret-9d3f');
      expect(share.partyId).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe('warn');
      expect(lines[0]!.msg).toMatch(/share committed to .*share\.json, but vault-pubkey\.json was not written/);
      expect(lines[0]!.msg).toContain(blocked);
      expect(lines[0]!.msg).toMatch(/rewrites it on its next start/);
      expect(lines[0]!.msg).not.toContain('pw-secret-9d3f');
    });

    it('commit never replaces an entry at the share path, a dangling symlink included', async () => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await symlink(join(dir, 'nowhere.json'), path);
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      await expect(stager.commit()).rejects.toThrow(`share path already exists: ${path}`);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(existsSync(join(dir, 'nowhere.json'))).toBe(false);
      expect(existsSync(pendingPath(path))).toBe(true);
      expect(existsSync(vaultPubkeyPath)).toBe(false);
    });

    it('names its share and staging paths', () => {
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      expect(stager.sharePath).toBe(path);
      expect(stager.stagedPath).toBe(pendingPath(path));
    });

    it('commit leaves one file at the share path and none at the staging path', async () => {
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      const staged = statSync(pendingPath(path));
      await stager.commit();
      const committed = statSync(path);
      // The same file, moved: one link, same inode, mode 0600.
      expect(committed.ino).toBe(staged.ino);
      expect(committed.nlink).toBe(1);
      expect(committed.mode & 0o777).toBe(0o600);
      expect(await readdir(join(dir, 'state'))).toEqual(['share.json']);
    });

    it('discard removes the pending file', async () => {
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      expect(existsSync(pendingPath(path))).toBe(true);
      await stager.discard();
      expect(existsSync(pendingPath(path))).toBe(false);
      expect(existsSync(path)).toBe(false);
    });

    it('discard is idempotent and works when nothing was staged', async () => {
      const stager = createShareStager({ path, password: 'pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await expect(stager.discard()).resolves.toBeUndefined();
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      await stager.discard();
      await expect(stager.discard()).resolves.toBeUndefined();
    });

    it('discard rethrows errors other than ENOENT', async () => {
      await writeFile(join(dir, 'blocker'), 'x');
      const stager = createShareStager({
        path: join(dir, 'blocker', 'share.json'),
        password: 'pw',
        network: 'testnet4',
        partyId: 0,
        vaultPubkeyPath,
      });
      await expect(stager.discard()).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('does not leave the password in the files it writes', async () => {
      const stager = createShareStager({ path, password: 'hunter2-unique-pw', network: 'testnet4', partyId: 0, vaultPubkeyPath });
      await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
      await stager.commit();
      expect(await readFile(path, 'utf8')).not.toContain('hunter2-unique-pw');
      expect(await readFile(vaultPubkeyPath, 'utf8')).not.toContain('hunter2-unique-pw');
    });
  });

  describe('loadVaultShare', () => {
    it('returns undefined when no file exists', async () => {
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).resolves.toBeUndefined();
    });

    it('does not treat the .pending file as a share', async () => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(pendingPath(path), JSON.stringify(goodShare), { mode: 0o600 });
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).resolves.toBeUndefined();
    });

    it('returns the decrypted share', async () => {
      await writeShare();
      const share = await loadVaultShare(path, PASSWORD, 'testnet4');
      expect(share).toBeDefined();
      expect(share!.partyId).toBe(0);
      expect(share!.threshold).toBe(3);
      expect(share!.parties).toBe(3);
      expect(share!.network).toBe('testnet4');
      expect(toHex(share!.publicKeyPackage.verifyingKey)).toBe(toHex(vault.publicKeyPackage.verifyingKey));
      expect(share!.keyPackage.signingShare).toBe(vault.keyPackages[0]!.signingShare);
    });

    it('names a wrong password', async () => {
      await writeShare();
      const err = await loadVaultShare(path, 'not the password', 'testnet4').then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe(`cannot decrypt share file ${path}: wrong password or corrupted file`);
      expect(err!.cause).toBeDefined();
      expect(err!.message).not.toContain('not the password');
      expect(String(err!.cause)).not.toContain('not the password');
    });

    it('maps undecodable ciphertext to the same wrong-password error', async () => {
      await writeShare({ ...goodShare, encrypted: '%%% not base64 %%%' });
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).rejects.toThrow(
        `cannot decrypt share file ${path}: wrong password or corrupted file`,
      );
      await writeShare({ ...goodShare, encrypted: 'AAAA' });
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).rejects.toThrow(
        `cannot decrypt share file ${path}: wrong password or corrupted file`,
      );
    });

    it('rejects a share for another network', async () => {
      await writeShare();
      await expect(loadVaultShare(path, PASSWORD, 'mainnet')).rejects.toThrow(
        'This share file belongs to a different vault',
      );
      await expect(loadVaultShare(path, PASSWORD, 'signet')).rejects.toThrow(
        'This share file belongs to a different vault',
      );
    });

    it("passes otzi's own validation messages through", async () => {
      await writeShare({ ...goodShare, version: 3 });
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).rejects.toThrow(
        /^Unsupported share file version$/,
      );
      await writeShare({ ...goodShare, threshold: undefined });
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).rejects.toThrow(
        /^Share file is corrupted$/,
      );
      // Header tampered after encryption: decrypts, then fails otzi's consistency checks.
      await writeShare({ ...goodShare, partyId: 1 });
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).rejects.toThrow(
        /^Share file is corrupted$/,
      );
    });

    it('names the path when the file is not valid JSON', async () => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(path, '{ definitely not json', { mode: 0o600 });
      const err = await loadVaultShare(path, PASSWORD, 'testnet4').then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err!.message).toBe(`share file ${path} is not valid JSON`);
      expect(err!.cause).toBeInstanceOf(SyntaxError);
    });

    it('rethrows read errors other than ENOENT instead of treating them as no vault', async () => {
      await mkdir(path, { recursive: true }); // a directory where the file should be
      await expect(loadVaultShare(path, PASSWORD, 'testnet4')).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  describe('warnOnPendingShare', () => {
    it('logs a warning for a leftover pending file and loads nothing', async () => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(pendingPath(path), JSON.stringify(goodShare), { mode: 0o600 });
      const { logger, lines } = capturingLogger();
      await warnOnPendingShare(path, logger);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe('warn');
      expect(lines[0]!.msg).toContain(pendingPath(path));
      expect(lines[0]!.msg).toMatch(/unfinished DKG/);
      expect(lines[0]!.msg).toMatch(/not loaded/);
      expect(lines[0]!.msg).toMatch(/next DKG overwrites/);
      // The recovery: check the other nodes, then move the file into place.
      expect(lines[0]!.msg).toMatch(/otzi vault/);
      expect(lines[0]!.msg).toContain(`rename ${pendingPath(path)} to ${path}`);
      // The vault comes from the file's plaintext header; the file is not decrypted.
      const address = vaultPayment(toVaultKey(vault.publicKeyPackage), 'testnet4').address;
      expect(lines[0]!.msg).toContain(address);
      // It neither loads nor removes the file.
      expect(existsSync(pendingPath(path))).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it('still warns when the pending file does not read as a share file', async () => {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(pendingPath(path), 'not json', { mode: 0o600 });
      const { logger, lines } = capturingLogger();
      await warnOnPendingShare(path, logger);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.msg).toContain(pendingPath(path));
      expect(lines[0]!.msg).toMatch(/next DKG overwrites/);
    });

    it('does nothing when there is no pending file', async () => {
      const { logger, lines } = capturingLogger();
      await warnOnPendingShare(path, logger);
      await writeShare();
      await warnOnPendingShare(path, logger);
      expect(lines).toEqual([]);
    });
  });
});
