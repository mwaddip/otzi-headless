import { describe, it, expect } from 'vitest';
import {
  emptyManifest,
  exportManifest,
  contractTypeRequiresDecimals,
  contractTypeRequiresAbi,
} from './model.js';

describe('emptyManifest', () => {
  it('returns a valid v1 skeleton', () => {
    const m = emptyManifest();
    expect(m.version).toBe(1);
    expect(m.name).toBe('');
    expect(m.description).toBe('');
    expect(m.contracts).toEqual([]);
  });
});

describe('contractTypeRequiresDecimals', () => {
  it('is true for OP20 + OP20S', () => {
    expect(contractTypeRequiresDecimals('OP20')).toBe(true);
    expect(contractTypeRequiresDecimals('OP20S')).toBe(true);
  });
  it('is false for OP721 + Custom', () => {
    expect(contractTypeRequiresDecimals('OP721')).toBe(false);
    expect(contractTypeRequiresDecimals('Custom')).toBe(false);
  });
});

describe('contractTypeRequiresAbi', () => {
  it('is true only for Custom', () => {
    expect(contractTypeRequiresAbi('Custom')).toBe(true);
    expect(contractTypeRequiresAbi('OP20')).toBe(false);
    expect(contractTypeRequiresAbi('OP20S')).toBe(false);
    expect(contractTypeRequiresAbi('OP721')).toBe(false);
  });
});

describe('exportManifest', () => {
  it('emits version + name + contracts always', () => {
    const m = {
      version: 1, name: 'X', description: '',
      contracts: [{ name: 'tok', address: '0xabc', type: 'OP20', decimals: 8 }],
    };
    const out = exportManifest(m);
    expect(out.version).toBe(1);
    expect(out.name).toBe('X');
    expect(Array.isArray(out.contracts)).toBe(true);
  });

  it('omits empty description', () => {
    const m = { version: 1, name: 'X', description: '', contracts: [] };
    const out = exportManifest(m);
    expect(out).not.toHaveProperty('description');
  });

  it('preserves non-empty description', () => {
    const m = { version: 1, name: 'X', description: 'desc', contracts: [] };
    const out = exportManifest(m);
    expect(out.description).toBe('desc');
  });

  it('OP20 contract: emits decimals, omits abi', () => {
    const m = {
      version: 1, name: 'X', contracts: [{
        name: 'tok', address: '0xabc', type: 'OP20', decimals: 8,
        abi: [{ name: 'lingering', params: [] }], // should be stripped
      }],
    };
    const out = exportManifest(m);
    expect(out.contracts[0].decimals).toBe(8);
    expect(out.contracts[0]).not.toHaveProperty('abi');
  });

  it('OP20S contract: emits decimals, omits abi', () => {
    const m = {
      version: 1, name: 'X', contracts: [{
        name: 'pegged', address: '0xabc', type: 'OP20S', decimals: 18,
      }],
    };
    const out = exportManifest(m);
    expect(out.contracts[0].decimals).toBe(18);
    expect(out.contracts[0]).not.toHaveProperty('abi');
  });

  it('OP721 contract: omits both decimals and abi', () => {
    const m = {
      version: 1, name: 'X', contracts: [{
        name: 'nft', address: '0xabc', type: 'OP721',
        decimals: 99, abi: [{ name: 'x', params: [] }], // both should be stripped
      }],
    };
    const out = exportManifest(m);
    expect(out.contracts[0]).not.toHaveProperty('decimals');
    expect(out.contracts[0]).not.toHaveProperty('abi');
  });

  it('Custom contract: emits abi, omits decimals', () => {
    const m = {
      version: 1, name: 'X', contracts: [{
        name: 'cm', address: '0xabc', type: 'Custom',
        decimals: 99, // should be stripped
        abi: [{ name: 'doThing', params: [{ name: 'x', type: 'uint256' }] }],
      }],
    };
    const out = exportManifest(m);
    expect(out.contracts[0]).not.toHaveProperty('decimals');
    expect(out.contracts[0].abi).toEqual([
      { name: 'doThing', params: [{ name: 'x', type: 'uint256' }] },
    ]);
  });

  it('preserves contract order from state array', () => {
    const m = {
      version: 1, name: 'X', contracts: [
        { name: 'a', address: '0x1', type: 'OP20', decimals: 1 },
        { name: 'b', address: '0x2', type: 'OP721' },
        { name: 'c', address: '0x3', type: 'Custom', abi: [] },
      ],
    };
    const out = exportManifest(m);
    expect(out.contracts.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });
});
