import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBtcFees } from './btc-fees';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchBtcFees', () => {
  it('returns rates mapped from mempool.space response fields (mainnet)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ fastestFee: 50, halfHourFee: 20, hourFee: 5 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const rates = await fetchBtcFees('mainnet');
    expect(rates).toEqual({ low: 5, normal: 20, high: 50 });
    const [[url]] = fetchSpy.mock.calls as [[string, RequestInit?]];
    expect(url).toBe('https://mempool.space/api/v1/fees/recommended');
  });

  it('uses the signet URL for testnet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ fastestFee: 3, halfHourFee: 2, hourFee: 1 }), { status: 200 }),
    );
    await fetchBtcFees('testnet');
    const [[url]] = fetchSpy.mock.calls as [[string, RequestInit?]];
    expect(url).toBe('https://mempool.space/signet/api/v1/fees/recommended');
  });

  it('throws when the API responds non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    await expect(fetchBtcFees('mainnet')).rejects.toThrow(/mempool.space.*503/);
  });
});
