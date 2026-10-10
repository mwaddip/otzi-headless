/**
 * Composition root for the headless daemon (facts/daemon.md, `daemon.ts`).
 *
 * Wires:
 *   - blob infrastructure (`BlobStore`, `BlobServer`, `BlobPuller`) into one
 *     `CeremonyIo`;
 *   - the approval gate (from `DaemonConfig.gate`), with this node's address
 *     book for `allowed_recipients = "address-book"`;
 *   - the participant-side `Orchestrator` and the leader-side
 *     `LeaderDispatcher`, sharing the I/O, the gate, the vault and this node's
 *     address book (output labels in gate specs), with the orchestrator
 *     holding the node's ceremony slots for both;
 *   - triggers (HTTP, UDS, cron, from `DaemonConfig.triggers`) and the
 *     operator API handler (`vault-info`, `dkg`, `sign`).
 *
 * The transport is injected: peer-mesh or relay in production, the in-memory
 * ring in tests. The daemon has no chain access; signed transactions are
 * returned to the caller, which broadcasts them.
 */

import { access } from 'node:fs/promises';
import type { Rng } from '@mwaddip/frots';
import { DEFAULT_ADDRESS_BOOK_PATH, readAddressBook } from '../address-book/store';
import type { PullOpts } from '../core/blob-puller';
import { BlobPuller } from '../core/blob-puller';
import { BlobServer } from '../core/blob-server';
import { BlobStore } from '../core/blob-store';
import type { CeremonyIo } from '../core/ceremony-io';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import type { NetworkName, TriggerEntry } from '../config/types';
import { createGate } from '../gate/factory';
import { Orchestrator } from '../orchestrator/orchestrator';
import { NOOP_LOGGER, type CeremonyOutcome, type Logger } from '../orchestrator/types';
import { CronTrigger } from '../triggers/cron';
import { HttpTrigger } from '../triggers/http';
import type { CronHandler, HttpHandler, HttpRequest, HttpResponse, TriggerSource } from '../triggers/types';
import { UdsTrigger } from '../triggers/uds';
import { NO_VAULT_MESSAGE, parseDkgRequest, parseSignRequest, parseVaultInfoRequest, RequestError } from './api';
import type { LoadedDaemonState } from './config-merge';
import { GateRejection, LeaderDispatcher } from './leader';
import { vaultPubkeyFromPackage } from './vault-pubkey';
import { createShareStager, vaultFileExists } from './vault-share';

export interface DaemonDeps {
  state: LoadedDaemonState;
  transport: Transport;
  /** Self's partyId, resolved from the pubkey book by pubkey match (`TransportBundle.selfPartyId`). */
  selfPartyId: number;
  /**
   * Every ring member's label, self included (`TransportBundle.peersById`):
   * `peer-<partyId>` for others, `config.node.id` for self. Its size is the
   * ring size used for DKG `parties` and the default signer set.
   */
  peersById: ReadonlyMap<PartyId, string>;
  rng: Rng;
  /** Pull backoff for every ceremony; orchestrator and leader replace `deadlineMs` and `maxAttempts`. */
  pullOpts: PullOpts;
  logger?: Logger;
  /** Override the operator API handler. Defaults to `buildDefaultHttpHandler`. */
  httpHandler?: HttpHandler;
  /** Cron jobs by `job_name`; a configured cron trigger without a handler fails construction. */
  cronHandlers?: ReadonlyMap<string, CronHandler>;
  /** Env source; not read by the daemon itself (triggers read `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where a DKG commit writes `vault-pubkey.json`; the path given to `loadAndValidate`. */
  vaultPubkeyPath?: string;
  /** This node's address book; default `DEFAULT_ADDRESS_BOOK_PATH`. Tests point it at a temporary file. */
  addressBookPath?: string;
}

/**
 * The addresses of the address book at `path`, for the policy gate's
 * `allowed_recipients = "address-book"`. Unlike `readAddressBook`, which reads a
 * missing file as an empty book, a missing file is an error here: a node without
 * a book has no recipients to allow, so its policy rejects every signing spec.
 */
async function bookAddresses(path: string, network: NetworkName): Promise<string[]> {
  const entries = await readAddressBook(path, network);
  if (entries.length === 0) await access(path); // throws ENOENT when the empty answer meant "no file"
  return entries.map(e => e.address);
}

export class Daemon {
  private readonly orchestrator: Orchestrator;
  private readonly leader: LeaderDispatcher;
  private readonly server: BlobServer;
  private readonly triggers: TriggerSource[];
  private readonly log: Logger;
  private started = false;

  constructor(deps: DaemonDeps) {
    const { state, transport, selfPartyId, peersById, rng } = deps;
    const { config } = state;
    const network = config.network.name;
    this.log = deps.logger ?? NOOP_LOGGER;

    const store = new BlobStore();
    this.server = new BlobServer(transport, store);
    const io: CeremonyIo = { transport, store, puller: new BlobPuller(transport, store), pullOpts: deps.pullOpts };
    const bookPath = deps.addressBookPath ?? DEFAULT_ADDRESS_BOOK_PATH;
    const gate = createGate(config.gate, {
      loadAddressBook: () => bookAddresses(bookPath, network),
      logger: this.log,
    });
    const node = { id: config.node.id, partyId: selfPartyId };
    const sharePath = config.share.path;
    const vaultExists = async () => state.share !== undefined || (await vaultFileExists(sharePath));
    // The password reaches only the stager, which encrypts the share a DKG produces.
    const createStager = () =>
      createShareStager({
        path: sharePath,
        password: state.password,
        network,
        partyId: selfPartyId,
        vaultPubkeyPath: deps.vaultPubkeyPath,
      });
    const shared = {
      io,
      gate,
      node,
      peersById,
      network,
      vault: state.share,
      vaultExists,
      createStager,
      rng,
      ceremonyDeadlines: config.deadlines,
      addressBook: () => readAddressBook(bookPath, network),
      logger: this.log,
    };

    this.orchestrator = new Orchestrator(shared);
    this.leader = new LeaderDispatcher({ ...shared, slots: this.orchestrator });

    const httpHandler =
      deps.httpHandler ?? buildDefaultHttpHandler(this.leader, state, peersById, selfPartyId, this.log);
    this.triggers = buildTriggers(config.triggers, httpHandler, deps.cronHandlers, this.log);
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

// ─── Trigger assembly ────────────────────────────────────────────────────

function buildTriggers(
  entries: readonly TriggerEntry[],
  httpHandler: HttpHandler,
  cronHandlers: ReadonlyMap<string, CronHandler> | undefined,
  log: Logger,
): TriggerSource[] {
  const out: TriggerSource[] = [];
  entries.forEach((entry, i) => {
    const path = `triggers[${i}]`;
    switch (entry.kind) {
      case 'http': {
        const bind = requireStringParam(entry.params, 'bind', path);
        const authTokenEnv = optionalStringParam(entry.params, 'auth_token_env', path);
        out.push(new HttpTrigger({ bind, authTokenEnv, handler: httpHandler, logger: log }));
        break;
      }
      case 'uds': {
        const socketPath = requireStringParam(entry.params, 'path', path);
        out.push(new UdsTrigger({ path: socketPath, handler: httpHandler, logger: log }));
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
        out.push(new CronTrigger({ jobName, schedule, handler, timezone, logger: log }));
        break;
      }
    }
  });
  return out;
}

function requireStringParam(params: Record<string, unknown> | undefined, key: string, path: string): string {
  const v = params?.[key];
  if (typeof v !== 'string') throw new Error(`daemon: ${path}.${key} missing or not a string`);
  return v;
}

function optionalStringParam(params: Record<string, unknown> | undefined, key: string, path: string): string | undefined {
  const v = params?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`daemon: ${path}.${key} must be a string`);
  return v;
}

// ─── Operator API ────────────────────────────────────────────────────────

/** The `vault-info`, `dkg` and `sign` ops (facts/daemon.md, `buildDefaultHttpHandler`). */
export function buildDefaultHttpHandler(
  leader: LeaderDispatcher,
  state: LoadedDaemonState,
  peersById: ReadonlyMap<PartyId, string>,
  selfPartyId: PartyId,
  logger: Logger,
): HttpHandler {
  const network = state.config.network.name;
  const partyIds = [...peersById.keys()].sort((a, b) => a - b);

  const vaultInfo = (body: Record<string, unknown>): HttpResponse => {
    parseVaultInfoRequest(body);
    const { share } = state;
    if (!share) throw new RequestError(409, NO_VAULT_MESSAGE);
    const meta = vaultPubkeyFromPackage(share.publicKeyPackage, network);
    return {
      status: 200,
      body: {
        partyIds,
        threshold: share.threshold,
        parties: share.parties,
        network,
        address: meta.address,
        internalKey: meta.internalKey,
        outputKey: meta.outputKey,
      },
    };
  };

  return async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'body must be a JSON object' } };
    }
    const b = body as Record<string, unknown>;
    const op = b.op;
    if (typeof op !== 'string') return { status: 400, body: { error: "missing 'op' field" } };

    let ceremonyId: string | undefined;
    try {
      switch (op) {
        case 'vault-info':
          return vaultInfo(b);
        case 'dkg': {
          ({ ceremonyId } = parseDkgRequest(b));
          const r = await leader.runDkg({ ceremonyId });
          return {
            status: 200,
            body: { ceremonyId: r.ceremonyId, status: 'done', address: r.address, internalKey: r.internalKey, network: r.network },
          };
        }
        case 'sign': {
          const { share } = state;
          if (!share) throw new RequestError(409, NO_VAULT_MESSAGE);
          const signReq = parseSignRequest(b, { partyIds, self: selfPartyId, minSigners: share.threshold });
          ceremonyId = signReq.ceremonyId;
          const r = await leader.sign(signReq);
          return {
            status: 200,
            body: {
              ceremonyId: r.ceremonyId,
              status: 'done',
              txid: r.txid,
              signedTxHex: r.signedTxHex,
              signaturesHex: r.signaturesHex,
            },
          };
        }
        default:
          return { status: 400, body: { error: `unknown op '${op}'` } };
      }
    } catch (err) {
      if (err instanceof RequestError) return { status: err.status, body: { error: err.message } };
      if (err instanceof GateRejection) {
        return { status: 403, body: { error: 'gate rejected', decision: err.decision, ceremonyId: err.ceremonyId } };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`api: ${op} ${ceremonyId ?? ''} failed: ${message}`, { op, ceremonyId });
      return { status: 500, body: { error: message, ceremonyId } };
    }
  };
}
