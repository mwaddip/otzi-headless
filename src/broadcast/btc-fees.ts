/**
 * BTC fee-rate fetcher backed by mempool.space.
 *
 * Ported from `otzi/backend/src/routes/btc.ts` GET /fees. The Ötzi handler
 * also kept a 60s in-module cache and a silent fallback — both dropped here.
 * This function is a pure async call: on failure it throws and the caller
 * decides (retry, fallback, fail the ceremony). The trigger layer can add
 * caching if it cares.
 */

import type { NetworkName } from '../node/types.js';

const MEMPOOL_FEES_URLS: Record<NetworkName, string> = {
  mainnet: 'https://mempool.space/api/v1/fees/recommended',
  testnet: 'https://mempool.space/signet/api/v1/fees/recommended',
};

export interface BtcFeeRates {
  /** Next-hour confirm (sat/vB). */
  low: number;
  /** Half-hour confirm (sat/vB). */
  normal: number;
  /** Fastest (next-block) confirm (sat/vB). */
  high: number;
}

interface MempoolFeesResponse {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
}

export async function fetchBtcFees(network: NetworkName): Promise<BtcFeeRates> {
  const url = MEMPOOL_FEES_URLS[network];
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`mempool.space fee API returned ${resp.status}`);
  }
  const data = (await resp.json()) as MempoolFeesResponse;
  return {
    low: data.hourFee,
    normal: data.halfHourFee,
    high: data.fastestFee,
  };
}
