import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest-validate';

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const ok = validateManifest({
      version: 1,
      name: 'Project',
      contracts: [
        {
          name: 'Shitcoin',
          address: '0x' + 'aa'.repeat(32),
          type: 'OP20',
          decimals: 6,
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects wrong version', () => {
    const r = validateManifest({
      version: 2,
      name: 'X',
      contracts: [{ name: 'C', address: '0x' + 'aa'.repeat(32), type: 'Custom', abi: [] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/version/);
  });

  it('rejects OP20 missing decimals', () => {
    const r = validateManifest({
      version: 1,
      name: 'X',
      contracts: [{ name: 'C', address: '0x' + 'aa'.repeat(32), type: 'OP20' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /decimals/.test(e))).toBe(true);
  });

  it('rejects Custom without abi', () => {
    const r = validateManifest({
      version: 1,
      name: 'X',
      contracts: [{ name: 'C', address: '0x' + 'aa'.repeat(32), type: 'Custom' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /abi/.test(e))).toBe(true);
  });

  it('rejects OP20 with abi field present', () => {
    const r = validateManifest({
      version: 1,
      name: 'X',
      contracts: [{
        name: 'C', address: '0x' + 'aa'.repeat(32),
        type: 'OP20', decimals: 6,
        abi: [{ name: 'foo', params: [] }],
      }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed addresses', () => {
    const r = validateManifest({
      version: 1, name: 'X',
      contracts: [{ name: 'C', address: 'deadbeef', type: 'Custom', abi: [] }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown ABI types', () => {
    const r = validateManifest({
      version: 1, name: 'X',
      contracts: [{
        name: 'C', address: '0x' + 'aa'.repeat(32), type: 'Custom',
        abi: [{ name: 'm', params: [{ name: 'x', type: 'uint512' as 'uint256' }] }],
      }],
    });
    expect(r.ok).toBe(false);
  });

  it('catches duplicate contract names', () => {
    const r = validateManifest({
      version: 1, name: 'X',
      contracts: [
        { name: 'A', address: '0x' + 'aa'.repeat(32), type: 'Custom', abi: [] },
        { name: 'A', address: '0x' + 'bb'.repeat(32), type: 'Custom', abi: [] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });
});
