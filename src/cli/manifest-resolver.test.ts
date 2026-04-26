import { describe, it, expect } from 'vitest';
import { resolve, resolveContract, resolveMethod } from './manifest-resolver';
import type { HeadlessManifest } from './manifest-types';

const sample: HeadlessManifest = {
  version: 1,
  name: 'Sample',
  contracts: [
    { name: 'Shitcoin', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
    {
      name: 'Reserve',
      address: '0x' + 'bb'.repeat(32),
      type: 'Custom',
      abi: [
        { name: 'emergencyWithdraw', params: [{ name: 'to', type: 'address' }] },
        { name: 'pause', params: [] },
      ],
    },
  ],
};

describe('resolveContract', () => {
  it('resolves by 1-based index', () => {
    expect(resolveContract(sample, '1').contract.name).toBe('Shitcoin');
    expect(resolveContract(sample, '2').contract.name).toBe('Reserve');
  });

  it('resolves by name', () => {
    expect(resolveContract(sample, 'Shitcoin').index).toBe(0);
    expect(resolveContract(sample, 'Reserve').index).toBe(1);
  });

  it('throws on out-of-range index', () => {
    expect(() => resolveContract(sample, '99')).toThrow(/out of range/);
  });

  it('throws on unknown name', () => {
    expect(() => resolveContract(sample, 'Bitcoin')).toThrow(/no contract/);
  });

  it('throws on empty identifier', () => {
    expect(() => resolveContract(sample, '')).toThrow(/empty/);
    expect(() => resolveContract(sample, '   ')).toThrow(/empty/);
  });
});

describe('resolveMethod', () => {
  it('resolves OP20 methods by letter', () => {
    const op20 = sample.contracts[0]!;
    expect(resolveMethod(op20, 'a').method.name).toBe('transfer');
  });

  it('resolves Custom methods by letter', () => {
    const custom = sample.contracts[1]!;
    expect(resolveMethod(custom, 'a').method.name).toBe('emergencyWithdraw');
    expect(resolveMethod(custom, 'b').method.name).toBe('pause');
  });

  it('resolves by method name', () => {
    expect(resolveMethod(sample.contracts[0]!, 'transfer').method.name).toBe('transfer');
  });

  it('throws on unknown method name', () => {
    expect(() => resolveMethod(sample.contracts[1]!, 'mint')).toThrow(/no method/);
  });

  it('throws on out-of-range letter', () => {
    expect(() => resolveMethod(sample.contracts[1]!, 'z')).toThrow(/out of range/);
  });

  it('throws on Custom without abi', () => {
    expect(() =>
      resolveMethod(
        { name: 'Bad', address: '0x' + 'cc'.repeat(32), type: 'Custom' },
        'a',
      ),
    ).toThrow(/inline abi/);
  });
});

describe('resolve (combined)', () => {
  it('handles 1 a form', () => {
    const r = resolve(sample, '1', 'a');
    expect(r.contract.name).toBe('Shitcoin');
    expect(r.method.name).toBe('transfer');
    expect(r.contractIndex).toBe(0);
    expect(r.methodIndex).toBe(0);
  });

  it('handles name name form', () => {
    const r = resolve(sample, 'Reserve', 'pause');
    expect(r.contract.name).toBe('Reserve');
    expect(r.method.name).toBe('pause');
  });
});
