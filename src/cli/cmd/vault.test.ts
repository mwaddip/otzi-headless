import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultPubkeyFromPackage, writeVaultPubkeyFile } from '../../daemon/vault-pubkey';
import { makeTestVault } from '../../otzi/backend/test-vault.fixture';
import { fromVaultKey } from '../../otzi/lib/dkg';
import { vault } from './vault';

describe('vault command', () => {
  let tmp: string;
  let vaultPath: string;
  const file = vaultPubkeyFromPackage(fromVaultKey(makeTestVault(2, 3).vault), 'testnet4');

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-vault-test-'));
    vaultPath = join(tmp, 'vault-pubkey.json');
    await writeVaultPubkeyFile(file, vaultPath);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('vault prints network, address and threshold', async () => {
    const out = await vault({ vaultPath });
    expect(out.split('\n')).toEqual([
      'network:   testnet4',
      `address:   ${file.address}`,
      'threshold: 2-of-3',
    ]);
  });

  it('prints the whole file as pretty JSON with --json', async () => {
    const out = await vault({ vaultPath, json: true });
    expect(JSON.parse(out)).toEqual(file);
    expect(out).toBe(JSON.stringify(JSON.parse(await readFile(vaultPath, 'utf8')), null, 2));
    expect(JSON.parse(out).vaultKey.minSigners).toBe(2);
  });

  it('points at otzi generate when the file is missing', async () => {
    await expect(vault({ vaultPath: join(tmp, 'absent.json') })).rejects.toThrow(/otzi generate/);
  });

  it('rejects a malformed file', async () => {
    await writeFile(vaultPath, JSON.stringify({ network: 'testnet4' }));
    await expect(vault({ vaultPath })).rejects.toThrow(/vault metadata/);
  });
});
