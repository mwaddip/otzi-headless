/**
 * HTTP-over-UDS client for talking to the local otzi daemon.
 *
 * Reads `triggers.uds.path` from daemon.toml; falls back to the http
 * trigger's bind for opt-in TCP. Provides a typed `request()` shape that
 * matches the daemon's JSON request/response convention (200 → typed
 * body; non-200 → throws `DaemonClientError` with status + message).
 */

import * as http from 'node:http';
import { loadDaemonConfig } from '../config/load';
import type { DaemonConfig } from '../config/types';

export class DaemonClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonClientError';
  }
}

export interface VaultInfo {
  partyIds: number[];
  threshold: number;
  parties: number;
  network: 'mainnet' | 'testnet' | 'regtest';
  btcAddress: string;
  opnetAddress: string;
}

interface TransportOpts {
  socketPath?: string;
  host?: string;
  port?: number;
}

export class DaemonClient {
  private constructor(private readonly transport: TransportOpts) {}

  static async fromConfig(configPath: string): Promise<DaemonClient> {
    const cfg = await loadDaemonConfig(configPath);
    return DaemonClient.fromParsed(cfg);
  }

  static fromParsed(cfg: DaemonConfig): DaemonClient {
    // Prefer UDS, fall back to http loopback.
    const uds = cfg.triggers.find((t) => t.kind === 'uds');
    if (uds) {
      const path = uds.params?.path;
      if (typeof path !== 'string')
        throw new Error('daemon-client: triggers.uds.params.path missing');
      return new DaemonClient({ socketPath: path });
    }
    const httpTrig = cfg.triggers.find((t) => t.kind === 'http');
    if (httpTrig) {
      const bind = httpTrig.params?.bind;
      if (typeof bind !== 'string')
        throw new Error('daemon-client: triggers.http.params.bind missing');
      // The http trigger's `validateHttpTriggerParams` allows UDS-shaped paths
      // (starting with '/') under kind='http'. Honour that: if `bind` looks
      // like a path, treat it as a socketPath.
      if (bind.startsWith('/')) {
        return new DaemonClient({ socketPath: bind });
      }
      const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(bind);
      if (!m) throw new Error(`daemon-client: invalid http bind '${bind}'`);
      return new DaemonClient({ host: m[1]!, port: Number(m[2]) });
    }
    throw new Error('daemon-client: no uds or http trigger in daemon.toml');
  }

  async vaultInfo(): Promise<VaultInfo> {
    return this.request<VaultInfo>({ op: 'vault-info' });
  }

  /** Send a JSON request; throw on non-200; return the parsed body. */
  async request<T = unknown>(body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          ...this.transport,
          method: 'POST',
          path: '/',
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload, 'utf8')),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status !== 200) {
              let msg = text;
              try {
                const json = JSON.parse(text) as { error?: unknown };
                if (typeof json.error === 'string') msg = json.error;
              } catch {
                /* keep raw text */
              }
              reject(new DaemonClientError(status, msg));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new Error('daemon returned invalid JSON'));
            }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
}
