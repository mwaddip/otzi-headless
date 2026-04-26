import { describe, it, expect } from 'vitest';
import { validate, ArgValidationError } from './validation';
import type { AbiParamType } from './manifest-types';

const ctx = (paramType: AbiParamType) => ({
  argIndex: 0,
  paramName: 'x',
  paramType,
});

describe('validate', () => {
  describe('address', () => {
    it('accepts valid 0x + 64 hex', () => {
      const r = validate('0x' + 'aa'.repeat(32), ctx('address'));
      expect(r.kind).toBe('address');
      if (r.kind === 'address') expect(r.value).toBe('0x' + 'aa'.repeat(32));
    });

    it('lowercases case-mixed input', () => {
      const r = validate('0xABCDEF' + '0'.repeat(58), ctx('address'));
      if (r.kind === 'address') expect(r.value).toBe('0xabcdef' + '0'.repeat(58));
    });

    it('rejects too-short input', () => {
      expect(() => validate('0xdeadbeef', ctx('address'))).toThrow(ArgValidationError);
    });

    it('rejects missing 0x prefix', () => {
      expect(() => validate('a'.repeat(64), ctx('address'))).toThrow(/expected.*0x/);
    });

    it('trims whitespace', () => {
      const r = validate('  0x' + 'bb'.repeat(32) + '  ', ctx('address'));
      if (r.kind === 'address') expect(r.value).toBe('0x' + 'bb'.repeat(32));
    });
  });

  describe('uint256', () => {
    it('accepts decimal values', () => {
      const r = validate('25000000', ctx('uint256'));
      if (r.kind === 'uint') expect(r.value).toBe(25000000n);
    });

    it('rejects scientific notation', () => {
      expect(() => validate('1e9', ctx('uint256'))).toThrow();
    });

    it('rejects negative', () => {
      expect(() => validate('-1', ctx('uint256'))).toThrow();
    });

    it('rejects values exceeding uint256', () => {
      const tooBig = (1n << 256n).toString();
      expect(() => validate(tooBig, ctx('uint256'))).toThrow(/exceeds/);
    });

    it('strips leading +', () => {
      const r = validate('+42', ctx('uint256'));
      if (r.kind === 'uint') expect(r.value).toBe(42n);
    });
  });

  describe('uint8', () => {
    it('accepts 255', () => {
      const r = validate('255', ctx('uint8'));
      if (r.kind === 'uint') expect(r.value).toBe(255n);
    });

    it('rejects 256', () => {
      expect(() => validate('256', ctx('uint8'))).toThrow(/exceeds/);
    });
  });

  describe('uint64', () => {
    it('accepts max u64', () => {
      const max = ((1n << 64n) - 1n).toString();
      const r = validate(max, ctx('uint64'));
      if (r.kind === 'uint') expect(r.value).toBe((1n << 64n) - 1n);
    });

    it('rejects overflow', () => {
      const overflow = (1n << 64n).toString();
      expect(() => validate(overflow, ctx('uint64'))).toThrow(/exceeds/);
    });
  });

  describe('bool', () => {
    it('accepts true / false', () => {
      const t = validate('true', ctx('bool'));
      if (t.kind === 'bool') expect(t.value).toBe(true);
      const f = validate('false', ctx('bool'));
      if (f.kind === 'bool') expect(f.value).toBe(false);
    });

    it('rejects 0 / 1', () => {
      expect(() => validate('1', ctx('bool'))).toThrow();
      expect(() => validate('0', ctx('bool'))).toThrow();
    });

    it('rejects mixed-case True', () => {
      expect(() => validate('True', ctx('bool'))).toThrow();
    });
  });

  describe('bytes', () => {
    it('accepts 0x prefix + even hex', () => {
      const r = validate('0xab12', ctx('bytes'));
      if (r.kind === 'bytes') expect(Array.from(r.value)).toEqual([0xab, 0x12]);
    });

    it('accepts empty 0x', () => {
      const r = validate('0x', ctx('bytes'));
      if (r.kind === 'bytes') expect(r.value.length).toBe(0);
    });

    it('rejects odd-length hex', () => {
      expect(() => validate('0xabc', ctx('bytes'))).toThrow();
    });

    it('rejects missing 0x prefix', () => {
      expect(() => validate('abcd', ctx('bytes'))).toThrow();
    });
  });

  describe('string', () => {
    it('passes through trimmed input', () => {
      const r = validate('  hello world  ', ctx('string'));
      if (r.kind === 'string') expect(r.value).toBe('hello world');
    });
  });

  describe('error context', () => {
    it('includes argIndex+1 + paramName + paramType in the message', () => {
      try {
        validate('-1', { argIndex: 2, paramName: 'amount', paramType: 'uint256' });
      } catch (err) {
        expect((err as Error).message).toMatch(/arg 3.*amount.*uint256/);
      }
    });
  });
});
