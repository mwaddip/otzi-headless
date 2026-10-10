/**
 * Leader-side ceremony dispatcher (facts/daemon.md, `leader.ts`; spec §5.3 and
 * §5.4, leader side).
 *
 * The counterpart of the participant-side `Orchestrator`, called by the API
 * handler on the node whose trigger fired:
 *
 *   - `runDkg` checks that this node holds no vault, takes the node's single
 *     DKG slot, gates, announces and runs the symmetric DKG like any other
 *     node; it only generated the session ID.
 *   - `sign` analyses the proposal against this node's own key, gates on that
 *     analysis, reserves the ceremony id, leads both signing rounds,
 *     aggregates, finalizes the transaction and sends the signoff. It returns
 *     the signed transaction; it never broadcasts it to the chain.
 *
 * Refusals before the announce (409, 400, a gate non-approve) leave peers
 * untouched. Each ceremony runs under its ceremony deadline as a whole, and
 * its pulls retry until then.
 */

import type { Rng } from '@mwaddip/frots';
import { BLOB_RETENTION_MS, scheduleClear } from '../core/blob-retention';
import type { CeremonyIo } from '../core/ceremony-io';
import { runDkgCeremony, type ShareStager } from '../core/dkg-ceremony';
import { encodeMessage, type CeremonyMessage } from '../core/messages';
import { leadSigning } from '../core/sign-ceremony';
import type { PartyId } from '../core/types';
import type { ApprovalGate, CeremonySpec, Decision } from '../gate/types';
import { buildDkgSpec, buildSigningSpec } from '../orchestrator/spec-builder';
import { NOOP_LOGGER, type Logger } from '../orchestrator/types';
import { finalizeSend } from '../otzi/backend/bitcoin';
import { labelFor } from '../otzi/lib/address-book';
import { analyzeProposal, vaultPayment, type ProposalAnalysis } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { fromHex, toHex } from '../otzi/lib/hex';
import type { DecryptedShare } from '../otzi/lib/share-file';
import type { AddressBookEntry, NetworkName } from '../otzi/lib/vault-types';
import { NO_VAULT_MESSAGE, RequestError, type LeaderSignRequest } from './api';

/** Longest `reason` a `signoff-aborted` may carry (messages.ts parser rule). */
const MAX_REASON_LENGTH = 1024;
const SESSION_ID_LENGTH = 32;
const VAULT_HELD = 'this node already holds a vault';

/** Thrown when the leader's own gate does not approve; nothing was announced. */
export class GateRejection extends Error {
  constructor(
    readonly ceremonyId: string,
    readonly decision: Decision,
  ) {
    super(`gate ${decision} for ceremony ${ceremonyId}`);
    this.name = 'GateRejection';
  }
}

/**
 * This node's DKG slot and led-signing id reservations; implemented by
 * `Orchestrator`. An id stays taken for its retention period after `end()`.
 */
export interface LocalCeremonySlots {
  beginLocalDkg(ceremonyId: string): { signal: AbortSignal; end(): void } | null;
  beginLocalSigning(ceremonyId: string): { end(): void } | null;
  ceremonyIdInUse(ceremonyId: string): boolean;
}

export interface LeaderDeps {
  /** The daemon's ceremony I/O, shared with the orchestrator. */
  io: CeremonyIo;
  gate: ApprovalGate;
  node: { id: string; partyId: PartyId };
  /** Every ring member's label, self included (`size` = ring size). */
  peersById: ReadonlyMap<PartyId, string>;
  network: NetworkName;
  /** The share loaded at startup; undefined on a node without a vault. */
  vault?: DecryptedShare;
  /** Whether a file exists at the share path. */
  vaultExists: () => Promise<boolean>;
  /** A fresh stager for the share path. */
  createStager: () => ShareStager;
  rng: Rng;
  /** `config.deadlines`: each ceremony the leader runs ends at its deadline at the latest. */
  ceremonyDeadlines: { signingMs: number; dkgMs: number };
  /** The daemon's orchestrator. */
  slots: LocalCeremonySlots;
  /** Blob retention after a ceremony ends here; default `BLOB_RETENTION_MS`. */
  blobRetentionMs?: { signing: number; dkg: number };
  /** This node's address-book entries, for output labels; a rejection means no labels. */
  addressBook?: () => Promise<AddressBookEntry[]>;
  logger?: Logger;
}

export interface LeaderDkgResult {
  ceremonyId: string;
  address: string;
  internalKey: string;
  network: NetworkName;
}

export interface LeaderSignResult {
  ceremonyId: string;
  txid: string;
  signedTxHex: string;
  signaturesHex: string[];
}

type CeremonyKind = 'signing' | 'dkg';

/** Aborts `signal` when the ceremony deadline passes; `clear()` stops the timer. */
interface CeremonyDeadline {
  signal: AbortSignal;
  ms: number;
  clear(): void;
}

export class LeaderDispatcher {
  private readonly deps: LeaderDeps;
  private readonly log: Logger;

  constructor(deps: LeaderDeps) {
    this.deps = deps;
    this.log = deps.logger ?? NOOP_LOGGER;
  }

  async runDkg(req: { ceremonyId: string }): Promise<LeaderDkgResult> {
    const { ceremonyId } = req;
    const { network, peersById, rng } = this.deps;
    if (this.deps.vault) throw new RequestError(409, VAULT_HELD);
    if (this.deps.slots.ceremonyIdInUse(ceremonyId)) throw new RequestError(409, idInUse(ceremonyId));

    const slot = this.deps.slots.beginLocalDkg(ceremonyId);
    if (!slot) throw new RequestError(409, 'a DKG is already running on this node');
    try {
      // Checked while the slot is held: a DKG this node joined and committed meanwhile is seen.
      if (await this.deps.vaultExists()) throw new RequestError(409, VAULT_HELD);

      const parties = peersById.size;
      const threshold = parties;
      const peerIds = [...peersById.entries()].sort(([a], [b]) => a - b).map(([, id]) => id);
      await this.approve(buildDkgSpec(this.specBase(ceremonyId), { threshold, parties, network, peerIds }));

      const stager = this.deps.createStager();
      const sessionId = new Uint8Array(SESSION_ID_LENGTH);
      rng.fillBytes(sessionId);
      this.log.info(`leader: dkg ${ceremonyId}: announcing a ${threshold}-of-${parties} DKG on ${network}`, {
        ceremonyId,
      });
      const deadline = this.startDeadline('dkg');
      try {
        await this.deps.io.transport.broadcast(
          encodeMessage({ v: 2, kind: 'announce-dkg', ceremonyId, sessionIdHex: toHex(sessionId), threshold, parties, network }),
        );
        const spec = { ceremonyId, sessionId, threshold, parties, network, rng };
        const signal = AbortSignal.any([slot.signal, deadline.signal]);
        const { publicKeyPackage } = await runDkgCeremony(this.ceremonyIo('dkg'), spec, stager, signal);
        const vaultKey = toVaultKey(publicKeyPackage);
        const address = vaultPayment(vaultKey, network).address;
        this.log.info(`leader: dkg ${ceremonyId} done: vault ${address}`, { ceremonyId, address });
        return { ceremonyId, address, internalKey: vaultKey.untweakedVerifyingKey, network };
      } catch (err) {
        let failure = err;
        if (deadline.signal.aborted && !slot.signal.aborted) {
          // The ceremony stops silently on its signal; nobody else has announced this abort.
          const reason = deadlineReason(deadline);
          await this.broadcastBestEffort({ v: 2, kind: 'signoff-aborted', ceremonyId, reason });
          failure = new Error(`DKG aborted: ${reason}`, { cause: err });
        }
        this.log.warn(`leader: dkg ${ceremonyId} failed: ${errorMessage(failure)}`, { ceremonyId });
        throw failure;
      } finally {
        deadline.clear();
        this.clearLater(ceremonyId, 'dkg');
      }
    } finally {
      slot.end();
    }
  }

  async sign(req: LeaderSignRequest): Promise<LeaderSignResult> {
    const { ceremonyId, signers, proposal } = req;
    const { vault, network } = this.deps;
    if (!vault) throw new RequestError(409, NO_VAULT_MESSAGE);

    const vaultKey = toVaultKey(vault.publicKeyPackage);
    let analysis: ProposalAnalysis;
    try {
      analysis = analyzeProposal(proposal, vaultKey, network);
    } catch (err) {
      throw new RequestError(400, errorMessage(err));
    }
    const label = await this.labeler(ceremonyId);
    await this.approve(buildSigningSpec(analysis, this.specBase(ceremonyId), network, label));

    const slot = this.deps.slots.beginLocalSigning(ceremonyId);
    if (!slot) throw new RequestError(409, idInUse(ceremonyId));
    const deadline = this.startDeadline('signing');
    try {
      let result: LeaderSignResult;
      try {
        const spec = {
          ceremonyId,
          signers,
          sighashes: analysis.sighashes.map(s => fromHex(s.hash)),
          keyPackage: vault.keyPackage,
          publicKeyPackage: vault.publicKeyPackage,
          rng: this.deps.rng,
        };
        this.log.info(`leader: signing ${ceremonyId}: ${analysis.inputs.length} inputs, signers ${signers.join(',')}`, {
          ceremonyId,
          txid: analysis.txid,
        });
        const signatures = await leadSigning(this.ceremonyIo('signing'), spec, proposal, deadline.signal);
        const signaturesHex = signatures.map(s => toHex(s));
        const finalized = finalizeSend(
          proposal.tx,
          proposal.prevouts,
          signaturesHex.map((signature, index) => ({ index, signature })),
          vaultPayment(vaultKey, network).outputKey,
        );
        result = { ceremonyId, txid: finalized.txid, signedTxHex: finalized.hex, signaturesHex };
      } catch (err) {
        const failure = deadline.signal.aborted ? new Error(deadlineReason(deadline), { cause: err }) : err;
        const reason = errorMessage(failure);
        this.log.warn(`leader: signing ${ceremonyId} failed: ${reason}`, { ceremonyId });
        await this.broadcastBestEffort({ v: 2, kind: 'signoff-aborted', ceremonyId, reason: reason.slice(0, MAX_REASON_LENGTH) });
        throw failure;
      }
      await this.broadcastBestEffort({ v: 2, kind: 'signoff-done', ceremonyId, signaturesHex: result.signaturesHex });
      this.log.info(`leader: signing ${ceremonyId} done: txid ${result.txid}`, { ceremonyId, txid: result.txid });
      return result;
    } finally {
      deadline.clear();
      slot.end();
      this.clearLater(ceremonyId, 'signing');
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private specBase(ceremonyId: string) {
    return { ceremonyId, leader: this.deps.node.id, role: 'leader' as const };
  }

  /** Gate once. Anything but approve (a throw counts as reject) is a `GateRejection`. */
  private async approve(spec: CeremonySpec): Promise<void> {
    let decision: Decision;
    try {
      decision = await this.deps.gate.approve(spec);
    } catch (err) {
      this.log.warn(`leader: ${spec.kind} ${spec.ceremonyId}: gate error, treated as reject: ${errorMessage(err)}`, {
        ceremonyId: spec.ceremonyId,
      });
      throw new GateRejection(spec.ceremonyId, 'reject');
    }
    if (decision !== 'approve') {
      this.log.info(`leader: ${spec.kind} ${spec.ceremonyId}: gate decision ${decision}`, { ceremonyId: spec.ceremonyId });
      throw new GateRejection(spec.ceremonyId, decision);
    }
  }

  /** Output labels from this node's address book; a failed read means no labels. */
  private async labeler(ceremonyId: string): Promise<((address: string) => string | undefined) | undefined> {
    const { addressBook } = this.deps;
    if (!addressBook) return undefined;
    try {
      const entries = await addressBook();
      return address => labelFor(entries, address);
    } catch (err) {
      this.log.warn(
        `leader: signing ${ceremonyId}: address book read failed, the gate sees no output labels: ${errorMessage(err)}`,
        { ceremonyId },
      );
      return undefined;
    }
  }

  /** Signoffs are best-effort: peers that miss one settle at their ceremony deadline. */
  private async broadcastBestEffort(msg: CeremonyMessage): Promise<void> {
    try {
      await this.deps.io.transport.broadcast(encodeMessage(msg));
    } catch (err) {
      this.log.warn(`leader: ${msg.kind} broadcast for ${msg.ceremonyId} failed: ${errorMessage(err)}`, {
        ceremonyId: msg.ceremonyId,
      });
    }
  }

  /** The whole-ceremony deadline, started at the ceremony start (just before the announce). */
  private startDeadline(kind: CeremonyKind): CeremonyDeadline {
    const ms = kind === 'signing' ? this.deps.ceremonyDeadlines.signingMs : this.deps.ceremonyDeadlines.dkgMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, ms, clear: () => clearTimeout(timer) };
  }

  private clearLater(ceremonyId: string, kind: CeremonyKind): void {
    const retention = (this.deps.blobRetentionMs ?? BLOB_RETENTION_MS)[kind];
    scheduleClear(this.deps.io.store, ceremonyId, retention);
  }

  /** The ceremony's I/O: pulls bounded by the ceremony deadline, not an attempt count. */
  private ceremonyIo(kind: CeremonyKind): CeremonyIo {
    const { io, ceremonyDeadlines } = this.deps;
    const deadlineMs = kind === 'signing' ? ceremonyDeadlines.signingMs : ceremonyDeadlines.dkgMs;
    return { ...io, pullOpts: { ...io.pullOpts, deadlineMs, maxAttempts: Number.MAX_SAFE_INTEGER } };
  }
}

function idInUse(ceremonyId: string): string {
  return `ceremony id ${ceremonyId} is already in use on this node`;
}

function deadlineReason(deadline: CeremonyDeadline): string {
  return `ceremony deadline of ${deadline.ms} ms passed`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
