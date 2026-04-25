import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { Address, BitcoinUtils } from '@btc-vision/transaction';
import {
  convertOpnetParams,
  deriveCaptureRndBytes,
  installRndBytesPatch,
} from './opnet-capture';

/**
 * Unit coverage for the pure helpers exposed by `opnet-capture`. The full
 * capture flow (which drives the OPNet SDK through tx construction and
 * intercepts via monkey-patched providers) is not unit-tested — it requires
 * a live testnet endpoint or a stub of the SDK's signing machinery. End-to-end
 * verification lives in `scripts/testnet-e2e.ts` (phase-5 integration).
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

describe('deriveCaptureRndBytes', () => {
  it('returns 64 bytes', () => {
    const seed = new Uint8Array(32).fill(1);
    expect(deriveCaptureRndBytes(seed, 0).length).toBe(64);
  });

  it('is deterministic: same seed + counter → same output', () => {
    const seed = new Uint8Array(32).fill(7);
    const a = deriveCaptureRndBytes(seed, 0);
    const b = deriveCaptureRndBytes(seed, 0);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('differs by counter: same seed, different counter → different output', () => {
    const seed = new Uint8Array(32).fill(7);
    const a = deriveCaptureRndBytes(seed, 0);
    const b = deriveCaptureRndBytes(seed, 1);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('differs by seed: different seed, same counter → different output', () => {
    const a = deriveCaptureRndBytes(new Uint8Array(32).fill(1), 0);
    const b = deriveCaptureRndBytes(new Uint8Array(32).fill(2), 0);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('matches HMAC-SHA-512(seed, BE32(counter)) exactly', () => {
    const seed = new Uint8Array([1, 2, 3, 4]);
    const counter = 42;
    const cntBuf = Buffer.alloc(4);
    cntBuf.writeUInt32BE(counter, 0);
    const expected = new Uint8Array(createHmac('sha512', seed).update(cntBuf).digest());
    expect(Buffer.from(deriveCaptureRndBytes(seed, counter)).toString('hex'))
      .toBe(Buffer.from(expected).toString('hex'));
  });

  it('throws on negative or non-integer counter', () => {
    const seed = new Uint8Array(32);
    expect(() => deriveCaptureRndBytes(seed, -1)).toThrow();
    expect(() => deriveCaptureRndBytes(seed, 1.5)).toThrow();
  });
});

describe('installRndBytesPatch', () => {
  it('replaces BitcoinUtils.rndBytes with a deterministic sequence and restores on cleanup', () => {
    const original = BitcoinUtils.rndBytes;
    const seed = new Uint8Array(32).fill(9);
    const handle = installRndBytesPatch(seed);
    try {
      const a1 = BitcoinUtils.rndBytes();
      const a2 = BitcoinUtils.rndBytes();
      expect(Buffer.from(a1).toString('hex')).toBe(Buffer.from(deriveCaptureRndBytes(seed, 0)).toString('hex'));
      expect(Buffer.from(a2).toString('hex')).toBe(Buffer.from(deriveCaptureRndBytes(seed, 1)).toString('hex'));
      expect(handle.getCallCount()).toBe(2);
    } finally {
      handle.restore();
    }
    expect(BitcoinUtils.rndBytes).toBe(original);
  });

  it('produces identical sequences across independent patch instances with the same seed', () => {
    const seed = new Uint8Array(32).fill(3);

    const h1 = installRndBytesPatch(seed);
    const seq1 = [BitcoinUtils.rndBytes(), BitcoinUtils.rndBytes(), BitcoinUtils.rndBytes()];
    h1.restore();

    const h2 = installRndBytesPatch(seed);
    const seq2 = [BitcoinUtils.rndBytes(), BitcoinUtils.rndBytes(), BitcoinUtils.rndBytes()];
    h2.restore();

    for (let i = 0; i < seq1.length; i++) {
      expect(Buffer.from(seq1[i]!).toString('hex')).toBe(Buffer.from(seq2[i]!).toString('hex'));
    }
  });

  it('each call advances the counter — no rng collisions within a capture', () => {
    const seed = new Uint8Array(32).fill(5);
    const h = installRndBytesPatch(seed);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        seen.add(Buffer.from(BitcoinUtils.rndBytes()).toString('hex'));
      }
      expect(seen.size).toBe(10);
    } finally {
      h.restore();
    }
  });
});
