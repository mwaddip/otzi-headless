/**
 * Composition root for the headless daemon.
 *
 * Wires:
 *   - Blob infrastructure (BlobStore, BlobServer, BlobPuller)
 *   - CeremonyRunner
 *   - Approval gate (from `DaemonConfig.gate`)
 *   - Participant-side Orchestrator
 *   - Leader-side dispatcher
 *   - Triggers (HTTP + cron, from `DaemonConfig.triggers`)
 *
 * Transport is injected — phase 3 (peer-mesh / relay) will supply a real
 * implementation; tests use the in-memory ring. The daemon explicitly does
 * NOT call `initEccLib` (phase-4d trap: double-init misroutes the FROST
 * legacy-sig monkey-patch — see SESSION_CONTEXT § Phase-4d findings).
 */

import type { KeyPackage, PublicKeyPackage, Rng } from '@mwaddip/frots';
import type { PullOpts } from '../core/blob-puller';
import { BlobPuller } from '../core/blob-puller';
import { BlobServer } from '../core/blob-server';
import { BlobStore } from '../core/blob-store';
import { CeremonyRunner } from '../core/ceremony-runner';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import { createGate } from '../gate/factory';
import type { ApprovalGate } from '../gate/types';
import { Orchestrator } from '../orchestrator/orchestrator';
import {
  NOOP_LOGGER,
  type CeremonyOutcome,
  type Logger,
} from '../orchestrator/types';
import { CronTrigger } from '../triggers/cron';
import { HttpTrigger } from '../triggers/http';
import type {
  CronHandler,
  HttpHandler,
  HttpRequest,
  HttpResponse,
  TriggerSource,
} from '../triggers/types';
import { toHex } from '../wire/hex';
import { fromHex } from '../wire/hex';
import type { LoadedDaemonState } from './config-merge';
import { GateRejection, LeaderDispatcher } from './leader';

export interface DaemonDeps {
  state: LoadedDaemonState;
  transport: Transport;
  rng: Rng;
  pullOpts: PullOpts;
  /** FROST key material, when the share was produced by a V3 combined DKG. */
  frostKeyPackage?: KeyPackage;
  frostPublicKeyPackage?: PublicKeyPackage;
  logger?: Logger;
  /** Override the HTTP handler. Defaults to `buildDefaultHttpHandler(leader)`. */
  httpHandler?: HttpHandler;
  /**
   * Registry of cron jobs. Each entry binds a `jobName` (matching
   * `DaemonConfig.triggers[].params.jobName`) to an async handler. Unknown
   * job names cause `start()` to fail.
   */
  cronHandlers?: ReadonlyMap<string, CronHandler>;
  /** Optional env override for HTTP auth token lookup. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export class Daemon {
  readonly orchestrator: Orchestrator;
  readonly leader: LeaderDispatcher;
  private readonly store: BlobStore;
  private readonly server: BlobServer;
  private readonly triggers: TriggerSource[];
  private readonly log: Logger;
  private started = false;

  constructor(deps: DaemonDeps) {
    this.log = deps.logger ?? NOOP_LOGGER;

    this.store = new BlobStore();
    this.server = new BlobServer(deps.transport, this.store);
    const puller = new BlobPuller(deps.transport, this.store);
    const runner = new CeremonyRunner(deps.transport, this.store, puller);
    const gate: ApprovalGate = createGate(deps.state.config.gate);

    this.orchestrator = new Orchestrator({
      transport: deps.transport,
      runner,
      gate,
      node: { id: deps.state.config.node.id, partyId: deps.state.config.node.partyId },
      peersById: deps.state.peersById,
      share: deps.state.share,
      frostKeyPackage: deps.frostKeyPackage ?? deps.state.share?.frostKeyPackage,
      frostPublicKeyPackage: deps.frostPublicKeyPackage ?? deps.state.frostPublicKeyPackage,
      rng: deps.rng,
      pullOpts: deps.pullOpts,
      ceremonyDeadlines: deps.state.config.deadlines,
      persistDkgShare: deps.state.persistDkgShare,
      logger: this.log,
    });

    this.leader = new LeaderDispatcher({
      runner,
      gate,
      node: { id: deps.state.config.node.id, partyId: deps.state.config.node.partyId },
      peersById: deps.state.peersById,
      share: deps.state.share,
      frostKeyPackage: deps.frostKeyPackage ?? deps.state.share?.frostKeyPackage,
      frostPublicKeyPackage: deps.frostPublicKeyPackage ?? deps.state.frostPublicKeyPackage,
      rng: deps.rng,
      pullOpts: deps.pullOpts,
      persistDkgShare: deps.state.persistDkgShare,
      logger: this.log,
    });

    const httpHandler = deps.httpHandler ?? buildDefaultHttpHandler(this.leader, this.log);
    this.triggers = buildTriggers(deps.state.config.triggers, httpHandler, deps.cronHandlers, this.log);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.orchestrator.start();
    for (const t of this.triggers) await t.start();
    this.log.info('daemon: started', { triggers: this.triggers.length });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const t of this.triggers) await t.stop();
    this.orchestrator.stop();
    this.server.close();
    this.log.info('daemon: stopped');
  }

  onCompleted(handler: (outcome: CeremonyOutcome) => void) {
    return this.orchestrator.onCompleted(handler);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Trigger assembly
// ─────────────────────────────────────────────────────────────────────────

function buildTriggers(
  entries: ReadonlyArray<import('../config/types').TriggerEntry>,
  httpHandler: HttpHandler,
  cronHandlers: ReadonlyMap<string, CronHandler> | undefined,
  log: Logger,
): TriggerSource[] {
  const out: TriggerSource[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const path = `triggers[${i}]`;
    switch (entry.kind) {
      case 'http': {
        const bind = requireStringParam(entry.params, 'bind', path);
        const authTokenEnv = optionalStringParam(entry.params, 'auth_token_env', path);
        out.push(new HttpTrigger({ bind, authTokenEnv, handler: httpHandler, logger: log }));
        break;
      }
      case 'cron': {
        const schedule = requireStringParam(entry.params, 'schedule', path);
        const jobName = requireStringParam(entry.params, 'job_name', path);
        const timezone = optionalStringParam(entry.params, 'timezone', path);
        const handler = cronHandlers?.get(jobName);
        if (!handler)
          throw new Error(
            `daemon: ${path}.job_name='${jobName}' has no registered handler (supply via DaemonDeps.cronHandlers)`,
          );
        out.push(
          new CronTrigger({ jobName, schedule, handler, timezone, logger: log }),
        );
        break;
      }
      case 'chain-watcher':
        throw new Error(`daemon: ${path}.kind='chain-watcher' not implemented yet`);
    }
  }
  return out;
}

function requireStringParam(
  params: Record<string, unknown> | undefined,
  key: string,
  path: string,
): string {
  const v = params?.[key];
  if (typeof v !== 'string')
    throw new Error(`daemon: ${path}.${key} missing or not a string`);
  return v;
}

function optionalStringParam(
  params: Record<string, unknown> | undefined,
  key: string,
  path: string,
): string | undefined {
  const v = params?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string')
    throw new Error(`daemon: ${path}.${key} must be a string`);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────
// Default HTTP handler — dispatches `op` to leader primitives.
// ─────────────────────────────────────────────────────────────────────────

export function buildDefaultHttpHandler(
  leader: LeaderDispatcher,
  logger: Logger = NOOP_LOGGER,
): HttpHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return { status: 400, body: { error: 'body must be a JSON object' } };
    const b = body as Record<string, unknown>;
    const op = b.op;
    if (typeof op !== 'string') return { status: 400, body: { error: "missing 'op' field" } };
    const ceremonyId = typeof b.ceremonyId === 'string'
      ? b.ceremonyId
      : `${op}-${(globalThis.crypto?.randomUUID?.() ?? String(Date.now()))}`;

    try {
      switch (op) {
        case 'dkg-combined': {
          const result = await leader.runCombinedDkg({
            ceremonyId,
            threshold: requireNumber(b, 'threshold'),
            parties: requireNumber(b, 'parties'),
            level: requireNumber(b, 'level'),
          });
          return {
            status: 200,
            body: {
              ceremonyId,
              status: 'done',
              mldsaPublicKeyHex: toHex(result.mldsa.publicKey),
              frostVerifyingKeyHex: toHex(result.frost.publicKeyPackage.verifyingKey),
            },
          };
        }
        case 'dkg-mldsa': {
          const result = await leader.runMldsaDkg({
            ceremonyId,
            threshold: requireNumber(b, 'threshold'),
            parties: requireNumber(b, 'parties'),
            level: requireNumber(b, 'level'),
          });
          return {
            status: 200,
            body: { ceremonyId, status: 'done', mldsaPublicKeyHex: toHex(result.publicKey) },
          };
        }
        case 'dkg-frost': {
          const result = await leader.runFrostDkg({
            ceremonyId,
            threshold: requireNumber(b, 'threshold'),
            parties: requireNumber(b, 'parties'),
          });
          return {
            status: 200,
            body: {
              ceremonyId,
              status: 'done',
              frostVerifyingKeyHex: toHex(result.publicKeyPackage.verifyingKey),
            },
          };
        }
        case 'sign': {
          const scheme = requireString(b, 'scheme');
          if (scheme !== 'frost' && scheme !== 'mldsa')
            return { status: 400, body: { error: "'scheme' must be 'frost' or 'mldsa'" } };
          const protocol = requireString(b, 'protocol');
          const signers = requireNumberArray(b, 'signers');

          let result: Awaited<ReturnType<typeof leader.sign>>;
          if (scheme === 'mldsa') {
            if (protocol !== 'raw')
              return { status: 400, body: { error: "scheme='mldsa' requires protocol='raw'" } };
            result = await leader.sign({
              ceremonyId,
              scheme: 'mldsa',
              protocol: 'raw',
              message: fromHex(requireString(b, 'messageHex')),
              signers,
            });
          } else if (protocol === 'btc') {
            const btc = requireObject(b, 'btc');
            const network = requireString(btc, 'network');
            if (network !== 'mainnet' && network !== 'testnet')
              return { status: 400, body: { error: "btc.network must be 'mainnet' or 'testnet'" } };
            const utxosRaw = btc.utxos;
            if (!Array.isArray(utxosRaw))
              return { status: 400, body: { error: "btc.utxos must be an array" } };
            const utxos = utxosRaw.map((u, i) => {
              if (!u || typeof u !== 'object')
                throw new Error(`btc.utxos[${i}] must be { transactionId, outputIndex, valueSat }`);
              const item = u as Record<string, unknown>;
              return {
                transactionId: requireString(item, 'transactionId'),
                outputIndex: requireNumber(item, 'outputIndex'),
                value: BigInt(requireString(item, 'valueSat')),
              };
            });
            result = await leader.sign({
              ceremonyId,
              scheme: 'frost',
              protocol: 'btc',
              signers,
              btc: {
                to: requireString(btc, 'to'),
                amountSat: BigInt(requireString(btc, 'amountSat')),
                feeRate: requireNumber(btc, 'feeRate'),
                network,
                frostP2tr: requireString(btc, 'frostP2tr'),
                frostUntweakedPubKey: fromHex(requireString(btc, 'frostUntweakedPubKeyHex')),
                utxos,
              },
            });
          } else if (protocol === 'opnet') {
            const rawInputs = b.inputs;
            if (!Array.isArray(rawInputs))
              return { status: 400, body: { error: "'inputs' must be an array for protocol='opnet'" } };
            const inputs = rawInputs.map((inp, i) => {
              if (!inp || typeof inp !== 'object')
                throw new Error(`inputs[${i}] must be { scriptHex, valueSat, tweaked }`);
              const item = inp as Record<string, unknown>;
              const rawValue = item.valueSat;
              const valueSat =
                typeof rawValue === 'string'
                  ? rawValue
                  : typeof rawValue === 'number'
                    ? String(Math.trunc(rawValue))
                    : null;
              if (valueSat === null)
                throw new Error(`inputs[${i}].valueSat must be a string or integer`);
              return {
                scriptHex: requireString(item, 'scriptHex'),
                valueSat,
                tweaked: typeof item.tweaked === 'boolean' ? item.tweaked : true,
              };
            });
            const hintsRaw = b.hints;
            let hints: { contractAddress?: string; method?: string; amountTokenAtomic?: string } | undefined;
            if (hintsRaw && typeof hintsRaw === 'object') {
              const h = hintsRaw as Record<string, unknown>;
              hints = {};
              if (typeof h.contractAddress === 'string') hints.contractAddress = h.contractAddress;
              if (typeof h.method === 'string') hints.method = h.method;
              if (typeof h.amountTokenAtomic === 'string') hints.amountTokenAtomic = h.amountTokenAtomic;
            }
            result = await leader.sign({
              ceremonyId,
              scheme: 'frost',
              protocol: 'opnet',
              signers,
              unsignedTx: fromHex(requireString(b, 'unsignedTxHex')),
              inputs,
              ...(hints ? { hints } : {}),
            });
          } else {
            return { status: 400, body: { error: "'protocol' must be 'raw', 'btc', or 'opnet'" } };
          }
          if (result.scheme === 'mldsa') {
            return {
              status: 200,
              body: {
                ceremonyId,
                status: 'done',
                scheme: 'mldsa',
                signatureHex: toHex(result.signature),
              },
            };
          }
          return {
            status: 200,
            body: {
              ceremonyId,
              status: 'done',
              scheme: 'frost',
              signaturesHex: result.signatures.map((s) => toHex(s)),
            },
          };
        }
      }
    } catch (err) {
      if (err instanceof GateRejection) {
        return { status: 403, body: { error: 'gate rejected', decision: err.decision, ceremonyId } };
      }
      logger.warn('http handler: ceremony failed', {
        op,
        ceremonyId,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err), ceremonyId },
      };
    }
    return { status: 400, body: { error: `unknown op '${op}'` } };
  };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new Error(`'${key}' must be a string`);
  return v;
}
function requireObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(`'${key}' must be an object`);
  return v as Record<string, unknown>;
}
function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`'${key}' must be a finite number`);
  return v;
}
function requireNumberArray(obj: Record<string, unknown>, key: string): number[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new Error(`'${key}' must be an array of numbers`);
  return v.map((item, i) => {
    if (typeof item !== 'number' || !Number.isFinite(item))
      throw new Error(`'${key}[${i}]' must be a number`);
    return item;
  });
}
