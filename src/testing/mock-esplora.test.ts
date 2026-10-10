import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildSend, computeSighashes, finalizeSend, vaultPayment } from '../otzi/backend/bitcoin';
import { makeTestVault } from '../otzi/backend/test-vault.fixture';
import { startMockEsplora, type MockEsplora } from './mock-esplora';

const NETWORK = 'testnet4' as const;
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('mock Esplora', () => {
  let esplora: MockEsplora;
  const { vault, tweakedSecret } = makeTestVault(2, 3);

  beforeEach(async () => {
    esplora = await startMockEsplora();
  });
  afterEach(async () => {
    await esplora.close();
  });

  function transactions() {
    const built = buildSend({
      utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 100_000 }],
      vault,
      network: NETWORK,
      to: DEST,
      amount: 50_000n,
      feeRate: 5,
    });
    const signatures = computeSighashes(built.tx, built.prevouts).map((hash, index) => ({
      index,
      signature: hex.encode(schnorr.sign(hash, tweakedSecret)),
    }));
    const signed = finalizeSend(built.tx, built.prevouts, signatures, vaultPayment(vault, NETWORK).outputKey);
    return { unsigned: built.tx, signed: signed.hex, txid: signed.txid };
  }

  const post = (path: string, body: string) => fetch(`${esplora.url}${path}`, { method: 'POST', body });

  it('refuses a transaction without witness data and accepts a signed one', async () => {
    const { unsigned, signed, txid } = transactions();

    const refused = await post('/tx', unsigned);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/empty witness/);
    expect(esplora.broadcasts).toEqual([]);

    const accepted = await post('/tx', signed);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe(txid);
    expect(esplora.broadcasts).toEqual([signed]);
  });

  it('can answer a broadcast with another txid', async () => {
    esplora.answerBroadcastsWith('cd'.repeat(32));
    expect(await (await post('/tx', transactions().signed)).text()).toBe('cd'.repeat(32));
  });

  it('serves configurable fee rates under a per-instance base path', async () => {
    expect(await (await fetch(`${esplora.url}/v1/fees/recommended`)).json()).toEqual({
      fastestFee: 10,
      halfHourFee: 5,
      hourFee: 2,
    });
    esplora.setFeeRates({ fastestFee: 1, halfHourFee: 0, hourFee: null });
    expect(await (await fetch(`${esplora.url}/v1/fees/recommended`)).json()).toEqual({
      fastestFee: 1,
      halfHourFee: 0,
      hourFee: null,
    });
    const root = esplora.url.slice(0, esplora.url.lastIndexOf('/'));
    expect((await fetch(`${root}/v1/fees/recommended`)).status).toBe(404);
  });
});
