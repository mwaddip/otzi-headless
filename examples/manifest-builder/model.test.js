import { describe, it, expect } from 'vitest';
import {
  emptyManifest,
  renameContractKey,
  exportManifest,
  resolveAbiMethods,
} from './model.js';

describe('emptyManifest', () => {
  it('returns a valid v2 skeleton', () => {
    const m = emptyManifest();
    expect(m.version).toBe(2);
    expect(m.name).toBe('');
    expect(m.contracts).toEqual({});
    expect(m.operations).toEqual([]);
  });
});

describe('renameContractKey', () => {
  it('updates contracts object key', () => {
    const m = {
      version: 2, name: 'x', contracts: { old: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [],
    };
    const next = renameContractKey(m, 'old', 'new');
    expect(next.contracts.new).toBeDefined();
    expect(next.contracts.old).toBeUndefined();
  });

  it('updates Operation.contract references', () => {
    const m = {
      version: 2, name: 'x', contracts: { tok: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [{ id: 'op1', label: 'Op', contract: 'tok', method: 'transfer', params: [] }],
    };
    const next = renameContractKey(m, 'tok', 'token');
    expect(next.operations[0].contract).toBe('token');
  });

  it('updates Param.source contract references', () => {
    const m = {
      version: 2, name: 'x', contracts: { tok: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [{
        id: 'op1', label: 'Op', contract: 'tok', method: 'transfer',
        params: [{ name: 'to', type: 'address', source: 'contract:tok' }],
      }],
    };
    const next = renameContractKey(m, 'tok', 'token');
    expect(next.operations[0].params[0].source).toBe('contract:token');
  });

  it('updates dynamic dropdown references in Param.options', () => {
    const m = {
      version: 2, name: 'x',
      contracts: { src: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [{
        id: 'op1', label: 'Op', contract: 'src', method: 'm',
        params: [{
          name: 'idx', type: 'uint256',
          options: { count: { contract: 'src', method: 'count' }, item: { contract: 'src', method: 'at' } },
        }],
      }],
    };
    const next = renameContractKey(m, 'src', 'list');
    expect(next.operations[0].params[0].options.count.contract).toBe('list');
    expect(next.operations[0].params[0].options.item.contract).toBe('list');
  });

  it('returns the input unchanged when source key does not exist', () => {
    const m = { version: 2, name: 'x', contracts: {}, operations: [] };
    expect(renameContractKey(m, 'nope', 'new')).toEqual(m);
  });

  it('refuses to rename onto an existing key', () => {
    const m = {
      version: 2, name: 'x',
      contracts: { a: { label: 'A', abi: 'OP_20', address: '0x1' }, b: { label: 'B', abi: 'OP_20', address: '0x2' } },
      operations: [],
    };
    expect(() => renameContractKey(m, 'a', 'b')).toThrow(/already exists/);
  });
});

describe('exportManifest', () => {
  it('strips empty optional fields', () => {
    const m = {
      version: 2, name: 'x', description: '', icon: '',
      contracts: {}, operations: [], reads: {}, status: [],
    };
    const out = exportManifest(m, 'headless');
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('icon');
    expect(out).not.toHaveProperty('reads');
    expect(out).not.toHaveProperty('status');
  });

  it('preserves populated optional fields', () => {
    const m = {
      version: 2, name: 'x', description: 'desc',
      contracts: {}, operations: [],
    };
    const out = exportManifest(m, 'headless');
    expect(out.description).toBe('desc');
  });

  it('omits Operation.condition and ownerOnly in headless mode', () => {
    const m = {
      version: 2, name: 'x',
      contracts: {},
      operations: [{
        id: 'op1', label: 'Op', contract: 'c', method: 'm', params: [],
        condition: { read: 'x', eq: 1 }, ownerOnly: true,
      }],
    };
    const out = exportManifest(m, 'headless');
    expect(out.operations[0]).not.toHaveProperty('condition');
    expect(out.operations[0]).not.toHaveProperty('ownerOnly');
  });

  it('preserves Operation.condition and ownerOnly in full mode', () => {
    const m = {
      version: 2, name: 'x',
      contracts: {},
      operations: [{
        id: 'op1', label: 'Op', contract: 'c', method: 'm', params: [],
        condition: { read: 'x', eq: 1 }, ownerOnly: true,
      }],
    };
    const out = exportManifest(m, 'full');
    expect(out.operations[0].condition).toEqual({ read: 'x', eq: 1 });
    expect(out.operations[0].ownerOnly).toBe(true);
  });

  it('omits Param.source: read: in headless mode', () => {
    const m = {
      version: 2, name: 'x', contracts: {},
      operations: [{
        id: 'op1', label: 'Op', contract: 'c', method: 'm',
        params: [{ name: 'p', type: 'uint256', source: 'read:foo' }],
      }],
    };
    const out = exportManifest(m, 'headless');
    expect(out.operations[0].params[0]).not.toHaveProperty('source');
  });
});

describe('resolveAbiMethods', () => {
  it('returns OP_20 standard method names for shorthand', () => {
    const methods = resolveAbiMethods('OP_20');
    expect(methods).toContain('transfer');
    expect(methods).toContain('balanceOf');
    expect(methods).toContain('approve');
  });

  it('extracts names from a custom AbiEntry array', () => {
    const abi = [
      { name: 'foo', type: 'Function', inputs: [], outputs: [] },
      { name: 'Bar', type: 'Event', inputs: [] },
    ];
    expect(resolveAbiMethods(abi)).toEqual(['foo']);
  });

  it('handles a mixed array', () => {
    const abi = [
      'OP_20',
      { name: 'customMethod', type: 'Function', inputs: [], outputs: [] },
    ];
    const methods = resolveAbiMethods(abi);
    expect(methods).toContain('transfer');
    expect(methods).toContain('customMethod');
  });

  it('returns empty array for unknown shorthand', () => {
    expect(resolveAbiMethods('UNKNOWN')).toEqual([]);
  });
});
