import { describe, it, expect } from 'vitest';
import { CapturingProvider } from './capturing-provider';

describe('CapturingProvider', () => {
  it('forwards arbitrary property reads to the inner provider', () => {
    const inner = { network: { name: 'testnet' }, foo: 42, bar: 'hello' };
    const wrapped = new CapturingProvider(inner as never);
    const proxied = wrapped.proxy as never as typeof inner;

    expect(proxied.network).toEqual({ name: 'testnet' });
    expect(proxied.foo).toBe(42);
    expect(proxied.bar).toBe('hello');
  });

  it('forwards arbitrary method calls to the inner provider', async () => {
    const calls: unknown[][] = [];
    const inner = {
      async getChallenge(...args: unknown[]) { calls.push(['getChallenge', ...args]); return 'CHAL'; },
      utxoManager: {
        async getUTXOs(...args: unknown[]) { calls.push(['getUTXOs', ...args]); return ['u1', 'u2']; },
      },
    };
    const wrapped = new CapturingProvider(inner as never);
    const proxied = wrapped.proxy as never as typeof inner;

    expect(await proxied.getChallenge()).toBe('CHAL');
    expect(await proxied.utxoManager.getUTXOs({ address: 'bc1...' })).toEqual(['u1', 'u2']);
    expect(calls).toEqual([
      ['getChallenge'],
      ['getUTXOs', { address: 'bc1...' }],
    ]);
  });

  it('intercepts sendRawTransaction: records the tx and throws __capture_only__', async () => {
    const inner = {
      async sendRawTransaction() { throw new Error('inner SHOULD NOT be called'); },
    };
    const wrapped = new CapturingProvider(inner as never);
    const proxied = wrapped.proxy as never as { sendRawTransaction: (tx: string, psbt: boolean) => Promise<unknown> };

    await expect(proxied.sendRawTransaction('deadbeef', false)).rejects.toThrow('__capture_only__');
    expect(wrapped.capturedTxs).toEqual(['deadbeef']);
  });

  it('intercepts sendRawTransactionPackage: records the array and throws __capture_only__', async () => {
    const inner = {
      async sendRawTransactionPackage() { throw new Error('inner SHOULD NOT be called'); },
    };
    const wrapped = new CapturingProvider(inner as never);
    const proxied = wrapped.proxy as never as { sendRawTransactionPackage: (txs: string[]) => Promise<unknown> };

    await expect(proxied.sendRawTransactionPackage(['aa', 'bb'])).rejects.toThrow('__capture_only__');
    expect(wrapped.capturedTxs).toEqual(['aa', 'bb']);
  });

  it('appends across multiple intercepted calls in order', async () => {
    const inner = {
      async sendRawTransaction() {},
      async sendRawTransactionPackage() {},
    };
    const wrapped = new CapturingProvider(inner as never);
    const proxied = wrapped.proxy as never as {
      sendRawTransaction: (tx: string, psbt: boolean) => Promise<unknown>;
      sendRawTransactionPackage: (txs: string[]) => Promise<unknown>;
    };

    await proxied.sendRawTransaction('11', false).catch(() => {});
    await proxied.sendRawTransactionPackage(['22', '33']).catch(() => {});
    await proxied.sendRawTransaction('44', false).catch(() => {});

    expect(wrapped.capturedTxs).toEqual(['11', '22', '33', '44']);
  });

  it('does NOT mutate the inner provider object', async () => {
    const innerSendRaw = async () => 'untouched';
    const inner = { sendRawTransaction: innerSendRaw };
    const wrapped = new CapturingProvider(inner as never);
    void wrapped;
    expect(inner.sendRawTransaction).toBe(innerSendRaw);
  });
});
