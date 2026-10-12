/**
 * Participant-side ceremony orchestrator (facts/orchestrator.md, `orchestrator.ts`;
 * spec §5.3 and §5.4, participant side).
 *
 * One long-lived listener per daemon. For every ceremony announce it applies
 * the participant checks, derives the gate spec from this node's own data
 * (verify-before-gate), asks the gate once, and runs the DKG or the signing
 * participation. A tracker per ceremony pins the leader (first announce wins),
 * owns the abort controller and the deadline, and keeps the sighashes this
 * node computed so the leader's `signoff-done` can be verified.
 *
 * Refusals are silent to peers. A failed analysis or a gate non-approve
 * settles the ceremony locally as `rejected`; every earlier check is a
 * structural drop that is only logged.
 *
 * The orchestrator also holds this node's single DKG slot and reserves the ids
 * of ceremonies this node leads (`beginLocalDkg`, `beginLocalSigning`): no
 * second DKG — led or joined — starts while one is live, because two DKGs
 * would share one `.pending` path, and a joined ceremony never shares an id
 * with one this node leads.
 */

import { EventEmitter } from 'node:events';
import { verifySignature } from '@mwaddip/frots';
import { BLOB_RETENTION_MS, scheduleClear } from '../core/blob-retention';
import type { CeremonyIo } from '../core/ceremony-io';
import { DkgShareKeptError, runDkgCeremony, type ShareStager } from '../core/dkg-ceremony';
import {
  MAX_INPUTS,
  parseMessage,
  type AnnounceDkg,
  type AnnounceSign,
  type SignoffAborted,
  type SignoffDone,
} from '../core/messages';
import { participateInSigning } from '../core/sign-ceremony';
import type { PartyId, Unsubscribe } from '../core/types';
import type { CeremonySpec, CeremonySpecBase, Decision } from '../gate/types';
import { labelFor } from '../otzi/lib/address-book';
import { analyzeProposal, vaultPayment, type ProposalAnalysis } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { fromHex } from '../otzi/lib/hex';
import { buildDkgSpec, buildSigningSpec, resolveLeaderId } from './spec-builder';
import {
  NOOP_LOGGER,
  type CeremonyOutcome,
  type Logger,
  type OrchestratorDeps,
  type OutcomeStatus,
} from './types';

type CeremonyKind = CeremonyOutcome['kind'];
type LogLevel = keyof Logger;

interface Tracker {
  readonly ceremonyId: string;
  readonly kind: CeremonyKind;
  /** The sender of the first announce. */
  readonly leader: PartyId;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  /** Signing: the sighashes this node computed, for signoff verification. */
  sighashes?: readonly Uint8Array[];
}

interface Settlement {
  status: OutcomeStatus;
  reason?: string;
  signaturesHex?: string[];
  address?: string;
  /** Overrides the status's default log level. */
  level?: LogLevel;
}

interface LocalDkgSlot {
  readonly ceremonyId: string;
  readonly controller: AbortController;
}

const SETTLE_LEVEL: Record<OutcomeStatus, LogLevel> = {
  done: 'info',
  rejected: 'info',
  aborted: 'warn',
  timeout: 'warn',
  'invalid-signoff': 'error',
};

const DEFAULT_WAIT_MS = 60_000;

/**
 * Most signing ceremonies one remote leader may hold live on this node at once
 * (facts/orchestrator.md, `announce-sign`). Each live tracker holds a timer, an
 * abort controller and a pull loop — for an `exec` or `webhook` gate until the
 * operator decides — so a compromised ring member must not be able to open
 * them without bound.
 */
export const MAX_LIVE_SIGNINGS_PER_LEADER = 32;

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly log: Logger;
  private readonly events = new EventEmitter();
  /** Live ceremonies by `ceremonyId`. */
  private readonly trackers = new Map<string, Tracker>();
  /**
   * Ids that ended here within their retention period: settled ceremonies
   * (with their outcome) and ended local slots (no outcome).
   */
  private readonly ended = new Map<string, { outcome?: CeremonyOutcome; timer: ReturnType<typeof setTimeout> }>();
  private localDkg: LocalDkgSlot | null = null;
  /** A joined DKG's ceremony, held until it settles: stage, commit and discard can outlast its tracker. */
  private joinedDkg: Promise<void> | null = null;
  /** Signing ceremonies this node leads, by id; the value identifies the reservation. */
  private readonly localSigning = new Map<string, object>();
  private off: Unsubscribe | null = null;
  private started = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.log = deps.logger ?? NOOP_LOGGER;
    // One listener per pending waitFor; there is no fixed bound.
    this.events.setMaxListeners(0);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.off = this.deps.io.transport.onBroadcast((from, bytes) => this.onBroadcast(from, bytes));
    this.log.info('orchestrator: started', { nodeId: this.deps.node.id, partyId: this.deps.node.partyId });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.off?.();
    this.off = null;
    for (const t of this.trackers.values()) {
      // Cut short without an outcome: the late rejection of its ceremony is ignored.
      t.settled = true;
      this.halt(t);
      // Its blobs (DKG round-2 secret shares included) still leave the store.
      scheduleClear(this.deps.io.store, t.ceremonyId, this.retentionMs(t.kind));
    }
    this.trackers.clear();
    for (const { timer } of this.ended.values()) clearTimeout(timer);
    this.ended.clear();
    this.localDkg?.controller.abort();
    this.localDkg = null;
    this.localSigning.clear();
    // `joinedDkg` stays held until that ceremony has unwound.
    this.events.emit('stopped');
    this.log.info('orchestrator: stopped');
  }

  /** Fires on every ceremony outcome. A throwing handler is logged and never disturbs the others. */
  onCompleted(handler: (o: CeremonyOutcome) => void): Unsubscribe {
    const isolated = (o: CeremonyOutcome) => {
      try {
        handler(o);
      } catch (err) {
        this.log.error(`orchestrator: onCompleted handler threw for ${o.ceremonyId}: ${errorMessage(err)}`, {
          ceremonyId: o.ceremonyId,
        });
      }
    };
    this.events.on('completed', isolated);
    return () => {
      this.events.off('completed', isolated);
    };
  }

  /**
   * Resolves when `ceremonyId` settles on this node, or at once when it
   * settled within its retention period. Rejects on timeout or `stop()`.
   */
  waitFor(ceremonyId: string, timeoutMs = DEFAULT_WAIT_MS): Promise<CeremonyOutcome> {
    const ended = this.ended.get(ceremonyId)?.outcome;
    if (ended) return Promise.resolve(ended);
    return new Promise((resolve, reject) => {
      const onCompleted = (o: CeremonyOutcome) => {
        if (o.ceremonyId !== ceremonyId) return;
        cleanup();
        resolve(o);
      };
      const onStopped = () => {
        cleanup();
        reject(new Error(`orchestrator stopped before ${ceremonyId} settled`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`orchestrator.waitFor timed out for ${ceremonyId}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off('completed', onCompleted);
        this.events.off('stopped', onStopped);
      };
      this.events.on('completed', onCompleted);
      this.events.on('stopped', onStopped);
    });
  }

  /**
   * Register a DKG this node leads. `null` while any DKG — led or joined — is
   * live, or when `ceremonyId` is taken. The slot's `signal` aborts on a ring
   * member's `signoff-aborted` for `ceremonyId` or on `stop()`; `end()`
   * releases the slot and keeps `ceremonyId` taken for the DKG retention
   * period (idempotent).
   */
  beginLocalDkg(ceremonyId: string): { signal: AbortSignal; end(): void } | null {
    if (this.dkgLive() || this.idTaken(ceremonyId)) return null;
    const slot: LocalDkgSlot = { ceremonyId, controller: new AbortController() };
    this.localDkg = slot;
    return {
      signal: slot.controller.signal,
      end: () => {
        if (this.localDkg !== slot) return;
        this.localDkg = null;
        this.record(ceremonyId, this.retentionMs('dkg'));
      },
    };
  }

  /**
   * Reserve the id of a signing ceremony this node leads. `null` when
   * `ceremonyId` is taken; `end()` releases the reservation and keeps
   * `ceremonyId` taken for the signing retention period (idempotent).
   */
  beginLocalSigning(ceremonyId: string): { end(): void } | null {
    if (this.idTaken(ceremonyId)) return null;
    const token = {};
    this.localSigning.set(ceremonyId, token);
    return {
      end: () => {
        if (this.localSigning.get(ceremonyId) !== token) return;
        this.localSigning.delete(ceremonyId);
        this.record(ceremonyId, this.retentionMs('signing'));
      },
    };
  }

  /** Whether `ceremonyId` is taken: live here, or ended here within its retention period. */
  ceremonyIdInUse(ceremonyId: string): boolean {
    return this.idTaken(ceremonyId);
  }

  // ─── Dispatch ────────────────────────────────────────────────────────────

  private onBroadcast(from: PartyId, bytes: Uint8Array): void {
    const msg = parseMessage(bytes);
    if (!msg) {
      this.log.warn(`orchestrator: dropped an unparseable message from party ${from}`, { from, bytes: bytes.length });
      return;
    }
    switch (msg.kind) {
      case 'announce-dkg':
        this.run(this.onAnnounceDkg(from, msg));
        return;
      case 'announce-sign':
        this.run(this.onAnnounceSign(from, msg));
        return;
      case 'signoff-done':
        this.onSignoffDone(from, msg);
        return;
      case 'signoff-aborted':
        this.onSignoffAborted(from, msg);
        return;
    }
  }

  private run(task: Promise<void>): void {
    task.catch(err => this.unexpected(err));
  }

  private unexpected(err: unknown, t?: Tracker): void {
    this.log.error(`orchestrator: unexpected error${t ? ` in ${t.kind} ${t.ceremonyId}` : ''}: ${errorMessage(err)}`, {
      ceremonyId: t?.ceremonyId,
    });
    if (t) this.settle(t, { status: 'aborted', reason: `internal error: ${errorMessage(err)}` });
  }

  // ─── announce-dkg ────────────────────────────────────────────────────────

  private async onAnnounceDkg(from: PartyId, msg: AnnounceDkg): Promise<void> {
    const { ceremonyId, threshold, parties, network } = msg;
    const drop = (level: LogLevel, reason: string) => this.drop(level, msg.kind, ceremonyId, from, reason);
    const ringSize = this.deps.peersById.size;

    // The transport authenticates ring members; this check keeps it that way here.
    if (!this.deps.peersById.has(from)) return drop('warn', `party ${from} is not a ring member`);
    if (this.isDuplicate(from, msg, 'dkg')) return;
    if (this.dkgLive()) return drop('warn', 'a DKG is already running on this node');
    if (network !== this.deps.network) return drop('warn', `network ${network} does not match ${this.deps.network}`);
    if (parties !== ringSize) return drop('warn', `parties ${parties} does not match ring size ${ringSize}`);
    if (this.deps.vault) return drop('warn', 'this node already holds a vault (share loaded)');

    // Reserve the ceremonyId and the DKG slot before the first await.
    const t = this.open(ceremonyId, 'dkg', from);
    let exists: boolean;
    try {
      exists = await this.deps.vaultExists();
    } catch (err) {
      if (t.settled) return;
      this.discard(t);
      return drop('warn', `cannot check the share path: ${errorMessage(err)}`);
    }
    if (t.settled) return;
    if (exists) {
      this.discard(t);
      return drop('warn', 'this node already holds a vault (a share file exists at the share path)');
    }

    const spec = buildDkgSpec(this.specBase(ceremonyId, from), { threshold, parties, network, peerIds: this.peerIds() });
    if (!(await this.approved(t, spec))) return;

    let stager: ShareStager;
    try {
      stager = this.deps.createStager();
    } catch (err) {
      return this.settle(t, { status: 'aborted', reason: `cannot create the share stager: ${errorMessage(err)}` });
    }
    const dkgSpec = { ceremonyId, sessionId: fromHex(msg.sessionIdHex), threshold, parties, network, rng: this.deps.rng };
    const ceremony = runDkgCeremony(this.ceremonyIo('dkg'), dkgSpec, stager, t.controller.signal)
      .then(
        ({ publicKeyPackage }) => {
          const address = vaultPayment(toVaultKey(publicKeyPackage), network).address;
          if (t.settled) {
            this.log.warn(
              `orchestrator: dkg ${ceremonyId} committed a share for ${address} after the ceremony ended here; the share is on disk`,
              { ceremonyId, address },
            );
            return;
          }
          this.settle(t, { status: 'done', address });
        },
        err => {
          if (!(err instanceof DkgShareKeptError)) {
            this.settle(t, { status: 'aborted', reason: errorMessage(err) });
            return;
          }
          // This node had published its confirmation: its staged share was kept, and the
          // operator must check the other nodes. Said at error level, settled or not.
          if (t.settled) {
            this.log.error(`orchestrator: dkg ${ceremonyId}: ${err.message}`, { ceremonyId, path: err.stagedPath });
            return;
          }
          this.settle(t, { status: 'aborted', reason: err.message, level: 'error' });
        },
      )
      .catch(err => this.unexpected(err, t));
    // The DKG slot stays held until the ceremony has unwound, discard or commit included.
    this.joinedDkg = ceremony;
    void ceremony.finally(() => {
      if (this.joinedDkg === ceremony) this.joinedDkg = null;
    });
  }

  // ─── announce-sign ───────────────────────────────────────────────────────

  private async onAnnounceSign(from: PartyId, msg: AnnounceSign): Promise<void> {
    const { ceremonyId, signers, proposal } = msg;
    const drop = (level: LogLevel, reason: string) => this.drop(level, msg.kind, ceremonyId, from, reason);
    const { vault } = this.deps;
    const me = this.deps.node.partyId;

    if (this.isDuplicate(from, msg, 'signing')) return;
    if (!vault) return drop('warn', 'no vault loaded on this node');
    if (!signers.includes(me)) return drop('info', `party ${me} is not in signers`);
    const signerProblem = this.signerProblem(from, signers, vault.threshold);
    if (signerProblem) return drop('warn', signerProblem);
    if (proposal.prevouts.length > MAX_INPUTS) {
      return drop('warn', `proposal has ${proposal.prevouts.length} inputs, at most ${MAX_INPUTS}`);
    }
    // Checked and opened without an await in between, so concurrent announces cannot overshoot.
    const live = this.liveSigningsOf(from);
    if (live >= MAX_LIVE_SIGNINGS_PER_LEADER) {
      return drop(
        'warn',
        `party ${from} already leads ${live} live signing ceremonies here, at most ${MAX_LIVE_SIGNINGS_PER_LEADER}`,
      );
    }

    const t = this.open(ceremonyId, 'signing', from);
    let analysis: ProposalAnalysis;
    try {
      analysis = analyzeProposal(proposal, toVaultKey(vault.publicKeyPackage), this.deps.network);
    } catch (err) {
      return this.settle(t, { status: 'rejected', reason: `proposal analysis failed: ${errorMessage(err)}`, level: 'warn' });
    }
    const sighashes = analysis.sighashes.map(s => fromHex(s.hash));
    t.sighashes = sighashes;

    const label = await this.labeler(ceremonyId);
    if (t.settled) return;
    const spec = buildSigningSpec(analysis, this.specBase(ceremonyId, from), this.deps.network, label);
    if (!(await this.approved(t, spec))) return;

    const signSpec = {
      ceremonyId,
      signers,
      sighashes,
      keyPackage: vault.keyPackage,
      publicKeyPackage: vault.publicKeyPackage,
      rng: this.deps.rng,
    };
    // Success leaves the tracker live until a signoff or the deadline.
    participateInSigning(this.ceremonyIo('signing'), signSpec, t.controller.signal)
      .then(
        () => {},
        err => this.settle(t, { status: 'aborted', reason: errorMessage(err) }),
      )
      .catch(err => this.unexpected(err, t));
  }

  private signerProblem(from: PartyId, signers: readonly PartyId[], threshold: number): string | null {
    if (!signers.includes(from)) return `leader party ${from} is not in signers`;
    if (new Set(signers).size !== signers.length) return 'signers has duplicates';
    const stranger = signers.find(p => !this.deps.peersById.has(p));
    if (stranger !== undefined) return `signer ${stranger} is not in the ring`;
    if (signers.length < threshold) return `signers has ${signers.length} entries, the vault needs ${threshold}`;
    return null;
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
        `orchestrator: signing ${ceremonyId}: address book read failed, the gate sees no output labels: ${errorMessage(err)}`,
        { ceremonyId },
      );
      return undefined;
    }
  }

  // ─── Signoffs ────────────────────────────────────────────────────────────

  private onSignoffDone(from: PartyId, msg: SignoffDone): void {
    const { ceremonyId, signaturesHex } = msg;
    const drop = (level: LogLevel, reason: string) => this.drop(level, msg.kind, ceremonyId, from, reason);
    const t = this.trackers.get(ceremonyId);
    if (!t) return drop('debug', 'no live ceremony with this id');
    if (t.kind !== 'signing') return drop('warn', 'the ceremony is a DKG');
    if (from !== t.leader) return drop('warn', `party ${from} is not the pinned leader (party ${t.leader})`);

    const problem = this.signoffProblem(t, signaturesHex);
    if (problem) return this.settle(t, { status: 'invalid-signoff', reason: problem });
    this.settle(t, { status: 'done', signaturesHex: [...signaturesHex] });
  }

  /** Why the signatures fail against this node's own sighashes and output key, or null. */
  private signoffProblem(t: Tracker, signaturesHex: readonly string[]): string | null {
    const { sighashes } = t;
    const { vault } = this.deps;
    if (!sighashes || !vault) return 'this node computed no sighashes for the ceremony';
    if (signaturesHex.length !== sighashes.length) {
      return `${signaturesHex.length} signatures for ${sighashes.length} inputs`;
    }
    const key = vault.publicKeyPackage.verifyingKey;
    for (let i = 0; i < sighashes.length; i++) {
      if (!verifies(fromHex(signaturesHex[i]!), sighashes[i]!, key)) return `signature for input ${i} does not verify`;
    }
    return null;
  }

  private onSignoffAborted(from: PartyId, msg: SignoffAborted): void {
    const { ceremonyId } = msg;
    const reason = msg.reason ?? `aborted by party ${from}`;
    const ringMember = this.deps.peersById.has(from);
    let known = false;

    // The DKG this node leads stops as soon as any ring member aborts it.
    const slot = this.localDkg;
    if (slot && slot.ceremonyId === ceremonyId && ringMember) {
      known = true;
      if (!slot.controller.signal.aborted) {
        this.log.warn(`orchestrator: dkg ${ceremonyId} (led here) aborted by party ${from}: ${reason}`, {
          ceremonyId,
          from,
        });
        slot.controller.abort();
      }
    }

    const t = this.trackers.get(ceremonyId);
    if (t) {
      known = true;
      if (t.kind === 'signing' && from !== t.leader) {
        this.drop('warn', msg.kind, ceremonyId, from, `party ${from} is not the pinned leader (party ${t.leader})`);
      } else if (t.kind === 'dkg' && !ringMember) {
        this.drop('warn', msg.kind, ceremonyId, from, `party ${from} is not a ring member`);
      } else {
        this.settle(t, { status: 'aborted', reason });
      }
    }

    if (!known) this.drop('debug', msg.kind, ceremonyId, from, 'no live ceremony with this id');
  }

  // ─── Trackers ────────────────────────────────────────────────────────────

  /**
   * The checks every announce passes first. Reusing an id that ended here
   * within retention would collide with its blobs and its scheduled clear.
   */
  private isDuplicate(from: PartyId, msg: AnnounceDkg | AnnounceSign, kind: CeremonyKind): boolean {
    const { ceremonyId } = msg;
    const drop = (level: LogLevel, reason: string) => this.drop(level, msg.kind, ceremonyId, from, reason);
    const live = this.trackers.get(ceremonyId);
    if (live) {
      if (live.leader !== from) drop('warn', `party ${from} is not the pinned leader (party ${live.leader})`);
      else if (live.kind !== kind) drop('warn', `a ${live.kind} ceremony with this id is live`);
      else drop('info', 'duplicate announce for a live ceremony');
      return true;
    }
    if (this.localDkg?.ceremonyId === ceremonyId || this.localSigning.has(ceremonyId)) {
      drop('warn', 'this node leads a ceremony with this id');
      return true;
    }
    const ended = this.ended.get(ceremonyId);
    if (ended) {
      if (ended.outcome) drop('info', 'the ceremony already ended on this node');
      else drop('warn', 'this node led a ceremony with this id within its retention period');
      return true;
    }
    return false;
  }

  /** A local DKG slot, a DKG tracker, or a joined DKG still unwinding. */
  private dkgLive(): boolean {
    if (this.localDkg || this.joinedDkg) return true;
    for (const t of this.trackers.values()) if (t.kind === 'dkg') return true;
    return false;
  }

  /**
   * Signing ceremonies `leader` has live on this node. Only trackers count:
   * the ceremonies this node leads itself are local slots, never trackers.
   */
  private liveSigningsOf(leader: PartyId): number {
    let n = 0;
    for (const t of this.trackers.values()) if (t.kind === 'signing' && t.leader === leader && !t.settled) n++;
    return n;
  }

  /** A live tracker, an outcome within retention, or a local slot holds `ceremonyId`. */
  private idTaken(ceremonyId: string): boolean {
    return (
      this.trackers.has(ceremonyId) ||
      this.ended.has(ceremonyId) ||
      this.localDkg?.ceremonyId === ceremonyId ||
      this.localSigning.has(ceremonyId)
    );
  }

  /** Create the tracker (leader pinned) and start the ceremony deadline. */
  private open(ceremonyId: string, kind: CeremonyKind, leader: PartyId): Tracker {
    const t: Tracker = { ceremonyId, kind, leader, controller: new AbortController(), timer: null, settled: false };
    const ms = this.deadlineMs(kind);
    t.timer = setTimeout(() => this.settle(t, { status: 'timeout', reason: `ceremony deadline of ${ms} ms passed` }), ms);
    this.trackers.set(ceremonyId, t);
    return t;
  }

  /** Remove a tracker after a structural drop: no outcome, nothing to clear. */
  private discard(t: Tracker): void {
    t.settled = true;
    this.halt(t);
    if (this.trackers.get(t.ceremonyId) === t) this.trackers.delete(t.ceremonyId);
  }

  private halt(t: Tracker): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.controller.abort();
  }

  /** Gate once. Anything but approve (a throw included) settles `rejected`. */
  private async approved(t: Tracker, spec: CeremonySpec): Promise<boolean> {
    let decision: Decision;
    try {
      decision = await this.deps.gate.approve(spec);
    } catch (err) {
      this.settle(t, { status: 'rejected', reason: `gate error: ${errorMessage(err)}`, level: 'warn' });
      return false;
    }
    if (t.settled) return false;
    if (decision !== 'approve') {
      this.settle(t, { status: 'rejected', reason: `gate decision: ${decision}` });
      return false;
    }
    return true;
  }

  private settle(t: Tracker, s: Settlement): void {
    if (t.settled) return;
    t.settled = true;
    this.halt(t);
    if (this.trackers.get(t.ceremonyId) === t) this.trackers.delete(t.ceremonyId);

    const retention = this.retentionMs(t.kind);
    scheduleClear(this.deps.io.store, t.ceremonyId, retention);

    const outcome: CeremonyOutcome = { ceremonyId: t.ceremonyId, kind: t.kind, status: s.status };
    if (s.signaturesHex) outcome.signaturesHex = s.signaturesHex;
    if (s.address) outcome.address = s.address;
    if (s.reason) outcome.reason = s.reason;
    this.record(t.ceremonyId, retention, outcome);

    const level = s.level ?? SETTLE_LEVEL[s.status];
    this.log[level](`orchestrator: ${t.kind} ${t.ceremonyId} ${s.status}${s.reason ? `: ${s.reason}` : ''}`, {
      ceremonyId: t.ceremonyId,
      kind: t.kind,
      status: s.status,
      leader: t.leader,
    });
    this.events.emit('completed', outcome);
  }

  /**
   * Keep `ceremonyId` taken for the retention period, with the outcome of a
   * settled ceremony (duplicate announces, late `waitFor`) or none for an
   * ended local slot.
   */
  private record(ceremonyId: string, retentionMs: number, outcome?: CeremonyOutcome): void {
    const previous = this.ended.get(ceremonyId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (this.ended.get(ceremonyId)?.timer === timer) this.ended.delete(ceremonyId);
    }, retentionMs);
    timer.unref();
    this.ended.set(ceremonyId, outcome ? { outcome, timer } : { timer });
  }

  private retentionMs(kind: CeremonyKind): number {
    return (this.deps.blobRetentionMs ?? BLOB_RETENTION_MS)[kind];
  }

  private drop(level: LogLevel, kind: string, ceremonyId: string, from: PartyId, reason: string): void {
    this.log[level](`orchestrator: dropped ${kind} ${ceremonyId} from party ${from}: ${reason}`, {
      ceremonyId,
      from,
      kind,
      reason,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private specBase(ceremonyId: string, from: PartyId): CeremonySpecBase {
    return { ceremonyId, leader: resolveLeaderId(from, this.deps.peersById), role: 'participant' };
  }

  /** Every ring member's label, in party order. */
  private peerIds(): string[] {
    return [...this.deps.peersById.entries()].sort(([a], [b]) => a - b).map(([, id]) => id);
  }

  private deadlineMs(kind: CeremonyKind): number {
    return kind === 'signing' ? this.deps.ceremonyDeadlines.signingMs : this.deps.ceremonyDeadlines.dkgMs;
  }

  /** The ceremony's I/O: pulls bounded by the ceremony deadline, not an attempt count. */
  private ceremonyIo(kind: CeremonyKind): CeremonyIo {
    const { io } = this.deps;
    return {
      ...io,
      pullOpts: { ...io.pullOpts, deadlineMs: this.deadlineMs(kind), maxAttempts: Number.MAX_SAFE_INTEGER },
    };
  }
}

function verifies(signature: Uint8Array, message: Uint8Array, key: Uint8Array): boolean {
  try {
    return verifySignature(signature, message, key);
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
