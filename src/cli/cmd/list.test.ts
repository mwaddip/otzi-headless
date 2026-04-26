import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list } from './list';

describe('list command', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-list-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('formats OP20 + Custom mixed', async () => {
    const path = join(tmp, 'manifest.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        name: 'Mixed',
        contracts: [
          { name: 'Shitcoin', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
          {
            name: 'Reserve',
            address: '0x' + 'bb'.repeat(32),
            type: 'Custom',
            abi: [
              { name: 'emergencyWithdraw', params: [{ name: 'to', type: 'address' }] },
            ],
          },
        ],
      }),
    );

    const out = await list({ manifestPath: path });
    expect(out).toMatch(/^1 - Shitcoin - OP20 - 6 decimals$/m);
    expect(out).toMatch(/^  a - transfer\(to:address, amount:uint256\)$/m);
    expect(out).toMatch(/^2 - Reserve - Custom$/m);
    expect(out).toMatch(/^  a - emergencyWithdraw\(to:address\)$/m);
  });

  it('errors when no manifest', async () => {
    await expect(list({ manifestPath: join(tmp, 'absent.json') })).rejects.toThrow(
      /no manifest installed/,
    );
  });

  it('errors when manifest is invalid', async () => {
    const path = join(tmp, 'manifest.json');
    await writeFile(path, JSON.stringify({ version: 2, name: 'X', contracts: [] }));
    await expect(list({ manifestPath: path })).rejects.toThrow(/invalid/);
  });
});
