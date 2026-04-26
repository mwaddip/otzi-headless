import { describe, it, expect } from 'vitest';
import { parseBtcAmount, formatSats } from './units';

describe('parseBtcAmount', () => {
  it('default sats', () => {
    expect(parseBtcAmount('25000').sats).toBe(25000n);
  });

  it('explicit sats', () => {
    expect(parseBtcAmount('25000sats').sats).toBe(25000n);
  });

  it('btc → sats', () => {
    expect(parseBtcAmount('1btc').sats).toBe(100_000_000n);
    expect(parseBtcAmount('0.001btc').sats).toBe(100_000n);
  });

  it('mbtc', () => {
    expect(parseBtcAmount('1mbtc').sats).toBe(100_000n);
  });

  it('ubtc', () => {
    expect(parseBtcAmount('1ubtc').sats).toBe(100n);
  });

  it('rejects fractional sats', () => {
    // 0.000000001btc = 0.1 sats — sub-sat precision; reject.
    expect(() => parseBtcAmount('0.000000001btc')).toThrow(/integer.*sats/);
  });

  it('accepts 0.0000001btc as 10 sats (whole-sat amount)', () => {
    expect(parseBtcAmount('0.0000001btc').sats).toBe(10n);
  });

  it('rejects sats with decimal', () => {
    expect(() => parseBtcAmount('1.5sats')).toThrow(/integer/);
  });

  it('rejects malformed input', () => {
    expect(() => parseBtcAmount('foo')).toThrow();
    expect(() => parseBtcAmount('')).toThrow();
    expect(() => parseBtcAmount('100btc1')).toThrow();
  });

  it('handles uppercase units', () => {
    expect(parseBtcAmount('1BTC').sats).toBe(100_000_000n);
  });

  it('preserves raw string in result', () => {
    expect(parseBtcAmount('25000sats').raw).toBe('25000sats');
  });
});

describe('formatSats', () => {
  it('default sats', () => {
    expect(formatSats(25000n)).toBe('25000');
  });

  it('btc', () => {
    expect(formatSats(100_000_000n, 'btc')).toBe('1');
    expect(formatSats(100_000n, 'btc')).toBe('0.001');
  });

  it('full precision', () => {
    expect(formatSats(123_456_789n, 'btc')).toBe('1.23456789');
  });

  it('mbtc', () => {
    expect(formatSats(100_000n, 'mbtc')).toBe('1');
    expect(formatSats(150_000n, 'mbtc')).toBe('1.5');
  });

  it('zero', () => {
    expect(formatSats(0n, 'btc')).toBe('0');
    expect(formatSats(0n)).toBe('0');
  });
});
