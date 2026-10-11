import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { toHex } from '../otzi/lib/hex';
import { testVault } from '../testing/proposal';
import {
  DEFAULT_VAULT_PUBKEY_PATH,
  readVaultPubkeyFile,
  vaultPubkeyFromPackage,
  writeVaultPubkeyFile,
} from './vault-pubkey';

const vault = testVault(2, 3);
const pkp = vault.publicKeyPackage;

describe('vault-pubkey.json', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-pubkey-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to /var/lib/otzi/vault-pubkey.json', () => {
    expect(DEFAULT_VAULT_PUBKEY_PATH).toBe('/var/lib/otzi/vault-pubkey.json');
  });

  describe('vaultPubkeyFromPackage', () => {
    it('derives address, keys, threshold, parties and the public VaultKey', () => {
      const file = vaultPubkeyFromPackage(pkp, 'testnet4');
      const payment = vaultPayment(toVaultKey(pkp), 'testnet4');
      expect(file.network).toBe('testnet4');
      expect(file.address).toBe(payment.address);
      expect(file.address.startsWith('tb1p')).toBe(true);
      expect(file.outputKey).toBe(toHex(payment.outputKey));
      expect(file.outputKey).toMatch(/^[0-9a-f]{64}$/);
      expect(file.internalKey).toBe(toHex(pkp.untweakedVerifyingKey));
      expect(file.internalKey).toMatch(/^0[23][0-9a-f]{64}$/);
      expect(file.threshold).toBe(2);
      expect(file.parties).toBe(3);
      expect(file.vaultKey).toEqual(toVaultKey(pkp));
      expect(file.vaultKey.untweakedVerifyingKey).toBe(file.internalKey);
    });

    it('uses the network prefix: bc1p on mainnet, tb1p on signet', () => {
      expect(vaultPubkeyFromPackage(pkp, 'mainnet').address.startsWith('bc1p')).toBe(true);
      expect(vaultPubkeyFromPackage(pkp, 'signet').address.startsWith('tb1p')).toBe(true);
      expect(vaultPubkeyFromPackage(pkp, 'mainnet').address).not.toBe(
        vaultPubkeyFromPackage(pkp, 'signet').address,
      );
    });

    it('carries no private material', () => {
      const text = JSON.stringify(vaultPubkeyFromPackage(pkp, 'testnet4'));
      for (const kp of vault.keyPackages) {
        expect(text).not.toContain(kp.signingShare.toString(16).padStart(64, '0'));
        expect(text).not.toContain(kp.untweakedSigningShare.toString(16).padStart(64, '0'));
      }
    });
  });

  describe('writeVaultPubkeyFile / readVaultPubkeyFile', () => {
    it('round-trips the file as pretty-printed JSON', async () => {
      const out = join(dir, 'vault.json');
      const file = vaultPubkeyFromPackage(pkp, 'signet');
      await writeVaultPubkeyFile(file, out);
      const text = await readFile(out, 'utf8');
      expect(text).toContain('\n  "network": "signet"');
      expect(JSON.parse(text)).toEqual(file);
      expect(await readVaultPubkeyFile(out)).toEqual(file);
    });

    it('writes mode 0644', async () => {
      const out = join(dir, 'vault.json');
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'testnet4'), out);
      expect((await stat(out)).mode & 0o777).toBe(0o644);
    });

    it('applies mode 0644 when the file already exists with another mode', async () => {
      const out = join(dir, 'vault.json');
      await writeFile(out, '{}', { mode: 0o600 });
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'testnet4'), out);
      expect((await stat(out)).mode & 0o777).toBe(0o644);
    });

    it('creates the parent directory', async () => {
      const out = join(dir, 'a', 'b', 'vault.json');
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'testnet4'), out);
      expect((await readVaultPubkeyFile(out)).parties).toBe(3);
    });

    it('overwrites an earlier file', async () => {
      const out = join(dir, 'vault.json');
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'testnet4'), out);
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'mainnet'), out);
      expect((await readVaultPubkeyFile(out)).network).toBe('mainnet');
    });

    it('replaces the file by rename, never by writing into the old file', async () => {
      const out = join(dir, 'vault.json');
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'testnet4'), out);
      // A second name for the old file: an in-place write would change it too.
      const oldInode = join(dir, 'old-inode.json');
      await link(out, oldInode);
      await writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'mainnet'), out);
      expect((await readVaultPubkeyFile(out)).network).toBe('mainnet');
      expect((await readVaultPubkeyFile(oldInode)).network).toBe('testnet4');
      expect((await stat(out)).mode & 0o777).toBe(0o644);
      // No temporary file is left beside it.
      expect((await readdir(dir)).sort()).toEqual(['old-inode.json', 'vault.json']);
    });

    it('removes its temporary file when the rename fails', async () => {
      const out = join(dir, 'vault.json');
      await mkdir(out); // a directory where the file should be: rename(file, dir) fails
      await expect(writeVaultPubkeyFile(vaultPubkeyFromPackage(pkp, 'testnet4'), out)).rejects.toThrow();
      expect(await readdir(dir)).toEqual(['vault.json']);
    });

    it('points the operator at `otzi generate` when the file is missing', async () => {
      const out = join(dir, 'missing.json');
      const err = await readVaultPubkeyFile(out).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(out);
      expect((err as Error).message).toContain('otzi generate');
    });

    it('rejects malformed JSON, naming the path', async () => {
      const out = join(dir, 'bad.json');
      await writeFile(out, '{ not json');
      await expect(readVaultPubkeyFile(out)).rejects.toThrow(new RegExp(`${out}.*not valid JSON`));
    });

    it('rejects a file with missing or mistyped fields, naming the field', async () => {
      const good = vaultPubkeyFromPackage(pkp, 'testnet4');
      const cases: Array<[string, unknown]> = [
        ['network', { ...good, network: 'regtest' }],
        ['address', { ...good, address: 42 }],
        ['internalKey', { ...good, internalKey: undefined }],
        ['outputKey', { ...good, outputKey: undefined }],
        ['threshold', { ...good, threshold: '2' }],
        ['parties', { ...good, parties: undefined }],
        ['vaultKey', { ...good, vaultKey: undefined }],
        ['vaultKey', { ...good, vaultKey: { minSigners: 2 } }],
      ];
      for (const [field, value] of cases) {
        const out = join(dir, 'case.json');
        await writeFile(out, JSON.stringify(value));
        await expect(readVaultPubkeyFile(out), field).rejects.toThrow(new RegExp(`${out}.*${field}`));
      }
      const out = join(dir, 'array.json');
      await writeFile(out, '[]');
      await expect(readVaultPubkeyFile(out)).rejects.toThrow(/JSON object/);
    });
  });
});
