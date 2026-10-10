import type { NetworkName, VaultConfig } from './types.js';

const DEFAULT_CHAIN_API: Record<NetworkName, string> = {
  mainnet: 'https://mempool.space/api',
  testnet4: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
};

/** Effective Esplora base URL for a config: the override, or the network default. */
export function chainApiUrl(config: Pick<VaultConfig, 'network' | 'esploraUrl'>): string {
  return config.esploraUrl || DEFAULT_CHAIN_API[config.network];
}

const TIMEOUT_MS = 15_000;

async function request(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim().slice(0, 300);
    throw new Error(`${res.status} ${body}`.trim());
  }
  return res;
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
}

export async function getUtxos(base: string, address: string): Promise<EsploraUtxo[]> {
  const res = await request(`${base}/address/${address}/utxo`);
  const raw = await res.json() as Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>;
  return raw.map(u => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
}

export async function getBalance(base: string, address: string): Promise<{ confirmed: number; unconfirmed: number }> {
  const res = await request(`${base}/address/${address}`);
  const data = await res.json() as {
    chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
  };
  return {
    confirmed: data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum,
    unconfirmed: data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum,
  };
}

export async function broadcastTx(base: string, txHex: string): Promise<string> {
  const res = await request(`${base}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: txHex,
  });
  return (await res.text()).trim();
}

export interface FeeRates {
  low: number;
  normal: number;
  high: number;
}

const feeCache = new Map<string, { rates: FeeRates; ts: number }>();

export async function getFeeRates(base: string): Promise<FeeRates> {
  const cached = feeCache.get(base);
  if (cached && Date.now() - cached.ts < 60_000) return cached.rates;

  let rates: FeeRates;
  try {
    // mempool.space API
    const res = await request(`${base}/v1/fees/recommended`);
    const d = await res.json() as { fastestFee: number; halfHourFee: number; hourFee: number };
    rates = { low: d.hourFee, normal: d.halfHourFee, high: d.fastestFee };
  } catch {
    // Blockstream Esplora API: confirmation target (blocks) → sat/vB
    const res = await request(`${base}/fee-estimates`);
    const d = await res.json() as Record<string, number>;
    const at = (target: number) => Math.max(1, Math.ceil(d[String(target)] ?? 1));
    rates = { low: at(6), normal: at(3), high: at(1) };
  }
  feeCache.set(base, { rates, ts: Date.now() });
  return rates;
}
