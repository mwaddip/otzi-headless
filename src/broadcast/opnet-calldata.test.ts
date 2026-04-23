import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { OP_20_ABI } from 'opnet';
import { encodeCalldata, resolveAbi } from './opnet-calldata';

describe('encodeCalldata', () => {
  it('prefixes selector = first 4 bytes of SHA256(method)', () => {
    const { calldata } = encodeCalldata('transfer', [], []);
    const expected = createHash('sha256').update('transfer').digest().subarray(0, 4);
    expect(Array.from(calldata.slice(0, 4))).toEqual(Array.from(expected));
  });

  it('encodes an OP_20 transfer (address + u256) at the expected byte layout', () => {
    const to = '0x' + '11'.repeat(32);
    const amount = '1000000000000000000'; // 1e18 wei
    const { calldata } = encodeCalldata('transfer', [to, amount], ['address', 'u256']);
    // Selector (4) + address (32) + u256 (32) = 68 bytes
    expect(calldata.length).toBe(4 + 32 + 32);
    // Verify the address bytes round-trip into position 4..36
    const addressField = calldata.slice(4, 36);
    expect(Array.from(addressField)).toEqual(Array(32).fill(0x11));
  });

  it('rejects mismatched params / paramTypes lengths', () => {
    expect(() => encodeCalldata('x', ['a'], [])).toThrow(/length mismatch/);
    expect(() => encodeCalldata('x', [], ['u256'])).toThrow(/length mismatch/);
  });

  it('accepts decimal and hex u256 input strings', () => {
    const a = encodeCalldata('f', ['255'], ['u256']).calldata;
    const b = encodeCalldata('f', ['0xff'], ['u256']).calldata;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('bytes param hex-decodes (with optional 0x prefix)', () => {
    const a = encodeCalldata('f', ['0xdeadbeef'], ['bytes']).calldata;
    const b = encodeCalldata('f', ['deadbeef'], ['bytes']).calldata;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('messageHash equals SHA256(calldata)', () => {
    const { calldata, messageHash } = encodeCalldata('x', ['1'], ['u256']);
    const expected = new Uint8Array(createHash('sha256').update(calldata).digest());
    expect(Array.from(messageHash)).toEqual(Array.from(expected));
  });

  it('different methods with identical params produce different selectors', () => {
    const a = encodeCalldata('transfer', ['1'], ['u256']).calldata;
    const b = encodeCalldata('approve', ['1'], ['u256']).calldata;
    expect(Array.from(a.slice(0, 4))).not.toEqual(Array.from(b.slice(0, 4)));
    expect(Array.from(a.slice(4))).toEqual(Array.from(b.slice(4)));
  });
});

describe('resolveAbi', () => {
  it('defaults to OP_20_ABI when abi is undefined or null', () => {
    expect(resolveAbi(undefined)).toBe(OP_20_ABI);
    expect(resolveAbi(null)).toBe(OP_20_ABI);
  });

  it('expands "OP_20" shorthand to the full OP_20_ABI array', () => {
    expect(resolveAbi('OP_20')).toEqual(OP_20_ABI);
  });

  it('returns empty array for unknown shorthand strings', () => {
    expect(resolveAbi('unknown-abi')).toEqual([]);
  });

  it('flattens an array containing shorthand + manifest entries', () => {
    const resolved = resolveAbi([
      'OP_20',
      { name: 'customMethod', type: 'function', inputs: [], outputs: [] },
    ]);
    expect(resolved.length).toBe(OP_20_ABI.length + 1);
  });
});
