import { describe, it, expect } from 'vitest';
import { Address } from '@btc-vision/transaction';
import { convertOpnetParams } from './opnet-capture';

/**
 * Unit coverage for the pure helper exposed by `opnet-capture`. The full
 * capture flow (which drives the OPNet SDK through tx construction and
 * intercepts via monkey-patched providers) is not unit-tested — it requires
 * a live testnet endpoint or a stub of the SDK's signing machinery. End-to-end
 * verification belongs in phase-5 integration tests gated on `OPNET_TESTNET_ENV`.
 */

describe('convertOpnetParams', () => {
  it('returns an empty array for empty inputs', () => {
    expect(convertOpnetParams([], undefined)).toEqual([]);
    expect(convertOpnetParams([], [])).toEqual([]);
  });

  it("wraps 'address' params into Address (accepting 0x prefix)", () => {
    const hex32 = '11'.repeat(32);
    const prefixed = '0x' + hex32;
    const [a, b] = convertOpnetParams([hex32, prefixed], ['address', 'address']);
    expect(a).toBeInstanceOf(Address);
    expect(b).toBeInstanceOf(Address);
    // Both forms should decode to the same 32 bytes
    expect(Buffer.from(a as Address).toString('hex')).toBe(hex32);
    expect(Buffer.from(b as Address).toString('hex')).toBe(hex32);
  });

  it("parses 'u256' params as BigInt from decimal and hex strings", () => {
    expect(convertOpnetParams(['255'], ['u256'])).toEqual([255n]);
    expect(convertOpnetParams(['0xff'], ['u256'])).toEqual([255n]);
    expect(convertOpnetParams(['1000000000000000000'], ['u256'])).toEqual([10n ** 18n]);
  });

  it("passes 'bytes' and unspecified params through unchanged", () => {
    const [bytes, anything] = convertOpnetParams(
      ['deadbeef', 'not-typed'],
      ['bytes', undefined as never],
    );
    expect(bytes).toBe('deadbeef');
    expect(anything).toBe('not-typed');
  });

  it('preserves positional correspondence between params and paramTypes', () => {
    const [addr, amount, raw] = convertOpnetParams(
      ['0x' + 'ab'.repeat(32), '42', 'raw-payload'],
      ['address', 'u256', 'bytes'],
    );
    expect(addr).toBeInstanceOf(Address);
    expect(amount).toBe(42n);
    expect(raw).toBe('raw-payload');
  });

  it('leaves params untyped when paramTypes is undefined', () => {
    expect(convertOpnetParams(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });
});
