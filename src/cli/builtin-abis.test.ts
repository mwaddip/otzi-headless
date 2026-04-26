import { describe, it, expect } from 'vitest';
import {
  methodsForBuiltinType,
  OP20_METHODS,
  OP20S_METHODS,
  OP721_METHODS,
} from './builtin-abis';

describe('methodsForBuiltinType', () => {
  it('returns OP20 methods for OP20', () => {
    expect(methodsForBuiltinType('OP20')).toBe(OP20_METHODS);
    expect(methodsForBuiltinType('OP20').map((m) => m.name)).toContain('transfer');
    expect(methodsForBuiltinType('OP20').map((m) => m.name)).toContain('safeTransfer');
    expect(methodsForBuiltinType('OP20').map((m) => m.name)).toContain('mint');
    expect(methodsForBuiltinType('OP20').map((m) => m.name)).toContain('burn');
  });

  it('OP20S extends OP20 with peg-rate methods', () => {
    const op20s = methodsForBuiltinType('OP20S');
    const names = op20s.map((m) => m.name);
    expect(names).toContain('transfer');
    expect(names).toContain('updatePegRate');
    expect(names).toContain('transferPegAuthority');
    expect(names.length).toBe(OP20_METHODS.length + 5);
  });

  it('OP721 has tokenId-style methods', () => {
    const op721 = methodsForBuiltinType('OP721');
    const transfer = op721.find((m) => m.name === 'safeTransfer');
    expect(transfer).toBeDefined();
    expect(transfer!.params.find((p) => p.name === 'tokenId')).toBeDefined();
  });

  it('OP721 omits setApprovalForAll (bool not encoder-supported)', () => {
    const names = methodsForBuiltinType('OP721').map((m) => m.name);
    expect(names).not.toContain('setApprovalForAll');
  });

  it('all methods use only encoder-supported types', () => {
    const supported = new Set([
      'address',
      'bytes',
      'uint8',
      'uint16',
      'uint32',
      'uint64',
      'uint128',
      'uint256',
    ]);
    for (const builtin of [OP20_METHODS, OP20S_METHODS, OP721_METHODS]) {
      for (const method of builtin) {
        for (const param of method.params) {
          expect(supported.has(param.type)).toBe(true);
        }
      }
    }
  });
});
