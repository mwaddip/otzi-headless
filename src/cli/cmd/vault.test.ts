import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vault } from './vault';

describe('vault command', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-vault-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const samplePayload = {
    network: 'testnet',
    btcAddress: 'opt1pmocked',
    opnetAddress: '0x' + 'aa'.repeat(32),
    frostUntweakedPubKey: '02' + 'bb'.repeat(32),
    frostTweakedPubKey: 'cc'.repeat(32),
    mldsaPubKeyHex: 'dd'.repeat(1312),
  };

  it('prints network + btc + opnet addresses by default', async () => {
    const path = join(tmp, 'vault.json');
    await writeFile(path, JSON.stringify(samplePayload));
    const out = await vault({ vaultPath: path });
    expect(out).toContain('network:        testnet');
    expect(out).toContain('btc address:    opt1pmocked');
    expect(out).toContain(`opnet address:  ${samplePayload.opnetAddress}`);
  });

  it('emits raw JSON when --json is set', async () => {
    const path = join(tmp, 'vault.json');
    await writeFile(path, JSON.stringify(samplePayload));
    const out = await vault({ vaultPath: path, json: true });
    expect(JSON.parse(out)).toEqual(samplePayload);
  });

  it('errors with a useful hint when missing', async () => {
    await expect(vault({ vaultPath: join(tmp, 'absent.json') })).rejects.toThrow(
      /no vault metadata.*otzi generate/,
    );
  });
});
