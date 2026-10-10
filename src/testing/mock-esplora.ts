/**
 * Test helper (facts/daemon.md, `src/testing/mock-esplora.ts`): an in-process
 * Esplora stand-in for CLI tests. Never imported by runtime code.
 */

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

export interface MockEsplora {
  /**
   * Esplora base URL, no trailing slash: `http://127.0.0.1:<port>/<random>`.
   * The random path segment makes every instance's base unique, so the Esplora
   * client's per-base fee-rate cache never carries rates from one mock to
   * another that happens to reuse the port.
   */
  url: string;
  /** Raw transaction hex of every accepted `POST /tx`, in order. */
  broadcasts: string[];
  /** Adds a coin to `address` (confirmed unless `opts.confirmed` is false) and returns its outpoint. */
  fund(address: string, value: number, opts?: { confirmed?: boolean }): { txid: string; vout: number };
  /**
   * `POST /tx` accepts only a transaction that carries witness data for every
   * input (an unsigned transaction is refused, as a node would refuse it).
   * While `rejectBroadcasts` is set it fails with status 400 and that message;
   * `null` accepts broadcasts again.
   */
  rejectBroadcasts(message: string | null): void;
  /** While set, an accepted `POST /tx` answers with this txid instead of the transaction's own; `null` restores that. */
  answerBroadcastsWith(txid: string | null): void;
  /** Replaces the `GET /v1/fees/recommended` body (default `{ fastestFee: 10, halfHourFee: 5, hourFee: 2 }`). */
  setFeeRates(rates: { fastestFee: unknown; halfHourFee: unknown; hourFee: unknown }): void;
  close(): Promise<void>;
}

interface Coin {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
}

export async function startMockEsplora(): Promise<MockEsplora> {
  const coins = new Map<string, Coin[]>();
  const broadcasts: string[] = [];
  let rejection: string | null = null;
  let answer: string | null = null;
  let feeRates: unknown = { fastestFee: 10, halfHourFee: 5, hourFee: 2 };
  const prefix = `/${randomBytes(4).toString('hex')}`;

  const fund: MockEsplora['fund'] = (address, value, opts = {}) => {
    const coin: Coin = {
      txid: randomBytes(32).toString('hex'),
      vout: 0,
      value,
      confirmed: opts.confirmed ?? true,
    };
    const list = coins.get(address) ?? [];
    list.push(coin);
    coins.set(address, list);
    return { txid: coin.txid, vout: coin.vout };
  };

  const stats = (list: Coin[], confirmed: boolean) => {
    const funded = list.filter(c => c.confirmed === confirmed);
    return {
      funded_txo_count: funded.length,
      funded_txo_sum: funded.reduce((sum, c) => sum + c.value, 0),
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: funded.length,
    };
  };

  const send = (res: http.ServerResponse, status: number, body: string, type = 'text/plain') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const sendJson = (res: http.ServerResponse, body: unknown) => send(res, 200, JSON.stringify(body), 'application/json');

  const route = (method: string, path: string, body: string, res: http.ServerResponse) => {
    if (method === 'GET' && path === '/v1/fees/recommended') {
      return sendJson(res, feeRates);
    }
    if (method === 'POST' && path === '/tx') {
      if (rejection !== null) return send(res, 400, rejection);
      let tx: btc.Transaction;
      try {
        tx = btc.Transaction.fromRaw(hex.decode(body.trim()), { allowUnknownOutputs: true });
      } catch {
        return send(res, 400, 'sendrawtransaction RPC error: TX decode failed');
      }
      for (let i = 0; i < tx.inputsLength; i++) {
        if (!tx.getInput(i).finalScriptWitness?.length) {
          return send(res, 400, 'sendrawtransaction RPC error: mandatory-script-verify-flag-failed (Witness program was passed an empty witness)');
        }
      }
      broadcasts.push(body.trim());
      return send(res, 200, answer ?? tx.id);
    }
    if (method === 'POST' && path === '/_fund') {
      let req: { address: string; value: number; confirmed?: boolean };
      try {
        req = JSON.parse(body);
      } catch {
        return send(res, 400, 'bad JSON');
      }
      return sendJson(res, fund(req.address, req.value, { confirmed: req.confirmed ?? true }));
    }
    const utxo = /^\/address\/([^/]+)\/utxo$/.exec(path);
    if (method === 'GET' && utxo) {
      const list = coins.get(utxo[1]!) ?? [];
      return sendJson(res, list.map(c => ({ txid: c.txid, vout: c.vout, value: c.value, status: { confirmed: c.confirmed } })));
    }
    const address = /^\/address\/([^/]+)$/.exec(path);
    if (method === 'GET' && address) {
      const list = coins.get(address[1]!) ?? [];
      return sendJson(res, { address: address[1], chain_stats: stats(list, true), mempool_stats: stats(list, false) });
    }
    return send(res, 404, 'not found');
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const full = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!full.startsWith(`${prefix}/`)) return send(res, 404, 'not found');
      route(req.method ?? 'GET', full.slice(prefix.length), Buffer.concat(chunks).toString('utf8'), res);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    broadcasts,
    fund,
    rejectBroadcasts(message) {
      rejection = message;
    },
    answerBroadcastsWith(txid) {
      answer = txid;
    },
    setFeeRates(rates) {
      feeRates = rates;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
