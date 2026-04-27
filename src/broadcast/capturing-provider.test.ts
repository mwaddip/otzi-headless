import { describe, it, expect } from 'vitest';
import { JSONRpcProvider } from 'opnet';
import { CapturingProvider, isCaptureOnlyError } from './capturing-provider';

describe('CapturingProvider', () => {
  it('is a subclass of JSONRpcProvider (so SDK CallResult holds the override-bearing instance)', () => {
    const wrapped = new CapturingProvider('testnet');
    expect(wrapped).toBeInstanceOf(JSONRpcProvider);
  });

  it('intercepts sendRawTransaction: records the tx and throws __capture_only__', async () => {
    const wrapped = new CapturingProvider('testnet');
    await expect(wrapped.sendRawTransaction('deadbeef', false)).rejects.toThrow('__capture_only__');
    expect(wrapped.capturedTxs).toEqual(['deadbeef']);
  });

  it('intercepts sendRawTransactionPackage: records the array and throws __capture_only__', async () => {
    const wrapped = new CapturingProvider('testnet');
    await expect(wrapped.sendRawTransactionPackage(['aa', 'bb'])).rejects.toThrow('__capture_only__');
    expect(wrapped.capturedTxs).toEqual(['aa', 'bb']);
  });

  it('appends across multiple intercepted calls in order', async () => {
    const wrapped = new CapturingProvider('testnet');
    await wrapped.sendRawTransaction('11', false).catch(() => {});
    await wrapped.sendRawTransactionPackage(['22', '33']).catch(() => {});
    await wrapped.sendRawTransaction('44', false).catch(() => {});
    expect(wrapped.capturedTxs).toEqual(['11', '22', '33', '44']);
  });

  it('keeps capturedTxs scoped per instance', async () => {
    const a = new CapturingProvider('testnet');
    const b = new CapturingProvider('testnet');
    await a.sendRawTransaction('aaaa', false).catch(() => {});
    await b.sendRawTransaction('bbbb', false).catch(() => {});
    expect(a.capturedTxs).toEqual(['aaaa']);
    expect(b.capturedTxs).toEqual(['bbbb']);
  });
});

describe('isCaptureOnlyError', () => {
  it('matches the sentinel string', () => {
    expect(isCaptureOnlyError(new Error('__capture_only__'))).toBe(true);
    expect(isCaptureOnlyError(new Error('something __capture_only__ embedded'))).toBe(true);
  });

  it('rejects non-sentinel errors', () => {
    expect(isCaptureOnlyError(new Error('boom'))).toBe(false);
    expect(isCaptureOnlyError('__capture_only__')).toBe(false);
    expect(isCaptureOnlyError(undefined)).toBe(false);
  });
});
