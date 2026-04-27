import { describe, it, expect } from 'vitest';
import { BitcoinUtils } from '@btc-vision/transaction';

/**
 * Canary for the one OPNet capture monkey-patch we cannot replace today —
 * `installRndBytesPatch` mutates `BitcoinUtils.rndBytes` (module-global)
 * for the duration of a capture. The honest fix is upstream: thread
 * `randomBytes` through `CallResult.sendTransaction` → `factory.signInteraction`.
 *
 * Until then, this test asserts the symbol shape we depend on. If a
 * future @btc-vision/transaction restructure renames the class, removes
 * the function, or changes its return contract, this test fails loudly
 * — even when version pinning has slipped.
 *
 * Pinning notes:
 *  - `package.json` pins `@btc-vision/transaction` to an exact version.
 *  - This canary is the second-line defense.
 */
describe('BitcoinUtils.rndBytes canary (capture monkey-patch surface)', () => {
  it('the symbol exists on the BitcoinUtils namespace', () => {
    expect('rndBytes' in BitcoinUtils).toBe(true);
  });

  it('is a callable function', () => {
    expect(typeof BitcoinUtils.rndBytes).toBe('function');
  });

  it('returns at least 32 bytes (the capture seed length)', () => {
    const out = BitcoinUtils.rndBytes();
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThanOrEqual(32);
  });

  it('is settable (the patch path replaces the symbol on the namespace)', () => {
    const original = BitcoinUtils.rndBytes;
    try {
      BitcoinUtils.rndBytes = (() => new Uint8Array(64).fill(7)) as typeof original;
      const out = BitcoinUtils.rndBytes();
      expect(out[0]).toBe(7);
      expect(out.length).toBe(64);
    } finally {
      BitcoinUtils.rndBytes = original;
    }
  });
});
