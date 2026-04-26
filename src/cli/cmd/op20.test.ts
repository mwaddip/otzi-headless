import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';

const balanceOfMock = vi.fn(async () => ({ balance: 12_500_000n }));

// Stub the OPNet getContract so the CLI's read path is testable without
// hitting an actual RPC node. Address.fromString construction stays real
// because the SDK validates pubkey hex internally.
vi.mock('opnet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('opnet')>();
  return {
    ...actual,
    getContract: () => ({ balanceOf: balanceOfMock }),
  };
});

// Stub the OPNet provider too — getContract reaches into provider for RPC,
// but because we replaced getContract entirely the provider isn't called.
vi.mock('../../node/opnet-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../node/opnet-client')>();
  return {
    ...actual,
    getProvider: () => ({ /* unused in mocked path */ }),
  };
});

import { op20Balance, formatTokenAmount } from './op20';

const sk = new Uint8Array(32);
sk[31] = 9;
const xOnly = schnorr.getPublicKey(sk);
const compressed = new Uint8Array(33);
compressed[0] = 0x02;
compressed.set(xOnly, 1);

// ML-DSA-44 pubkey is 1312 bytes — Address.fromString validates this length.
const mldsaPubKeyHex = 'aa'.repeat(1312);
const tweakedPubKeyHex = Buffer.from(compressed).toString('hex');

const sampleManifest = {
  version: 1,
  name: 'Test',
  contracts: [
    { name: 'Coin', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
    {
      name: 'NoDecimals',
      address: '0x' + 'bb'.repeat(32),
      type: 'Custom',
      abi: [{ name: 'foo', params: [] }],
    },
  ],
};

const sampleVault = {
  network: 'testnet',
  btcAddress: 'opt1pmocked',
  opnetAddress: '0x' + 'cd'.repeat(32),
  frostUntweakedPubKey: tweakedPubKeyHex,
  frostTweakedPubKey: tweakedPubKeyHex,
  mldsaPubKeyHex,
};

describe('op20Balance', () => {
  let tmp: string;
  let manifestPath: string;
  let vaultPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-op20-test-'));
    manifestPath = join(tmp, 'manifest.json');
    vaultPath = join(tmp, 'vault.json');
    await writeFile(manifestPath, JSON.stringify(sampleManifest));
    await writeFile(vaultPath, JSON.stringify(sampleVault));
    balanceOfMock.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads OP20 balance and formats by decimals', async () => {
    const out = await op20Balance({
      manifestPath,
      vaultPath,
      identifier: 'Coin',
    });
    expect(out).toBe('12.5'); // 12_500_000 / 10^6
    expect(balanceOfMock).toHaveBeenCalledTimes(1);
  });

  it('resolves by 1-based index', async () => {
    const out = await op20Balance({
      manifestPath,
      vaultPath,
      identifier: '1',
    });
    expect(out).toBe('12.5');
  });

  it('rejects non-OP20/OP20S contracts', async () => {
    await expect(
      op20Balance({ manifestPath, vaultPath, identifier: 'NoDecimals' }),
    ).rejects.toThrow(/only available for OP20/);
  });

  it('rejects regtest', async () => {
    await writeFile(vaultPath, JSON.stringify({ ...sampleVault, network: 'regtest' }));
    await expect(
      op20Balance({ manifestPath, vaultPath, identifier: 'Coin' }),
    ).rejects.toThrow(/not supported.*OPNet RPC/);
  });
});

describe('formatTokenAmount', () => {
  it('zero decimals returns plain integer', () => {
    expect(formatTokenAmount(42n, 0)).toBe('42');
  });

  it('formats with decimals', () => {
    expect(formatTokenAmount(12_500_000n, 6)).toBe('12.5');
    expect(formatTokenAmount(1n, 6)).toBe('0.000001');
  });

  it('strips trailing zeros', () => {
    expect(formatTokenAmount(1_000_000n, 6)).toBe('1');
  });
});
