/**
 * Participant-side ceremony orchestrator.
 *
 * Lifts the per-ceremony test helpers (`orchestrateParticipant`,
 * `orchestrateFrostParticipant`, `orchestrateDkgParticipant`,
 * `orchestrateFrostDkgParticipant`, `orchestrateCombinedDkgParticipant`)
 * into a single long-lived listener. Serves a daemon over its lifetime,
 * multiplexing many ceremonies.
 *
 * Contract (from CLAUDE.md § Core Architecture + § Security Model):
 *   - Leader-authenticated signoffs: the first announce's `from` is pinned
 *     as the leader; all subsequent announces (including `#N` retries) and
 *     the signoff for that baseCeremonyId MUST come from the same peer.
 *   - Gate evaluation happens once per ceremony (decision is cached across
 *     ML-DSA retries — intent doesn't change between attempts).
 *   - Rejected/pending gate decisions are silent: the node contributes no
 *     blobs, and peers see it as indistinguishable from offline.
 *   - DKG completion is driven by the participate method's resolution; only
 *     signoff-aborted settles DKG as failed (and the deadline fires on a
 *     crashed-leader fallback).
 */

import { EventEmitter } from 'node:events';
import {
  buildBtcTxFromParams,
  extractBtcSighashes,
  type DecodedBtcOutput,
} from '../broadcast/btc-vault';
import {
  messageFromAnnounce,
  parseCeremonyMessage,
  sessionIdFromAnnounceCombinedDkg,
  sessionIdFromAnnounceDkg,
  sessionIdFromAnnounceFrostDkg,
  sighashesFromAnnounceFrost,
  type CeremonyMessage,
} from '../core/ceremony-messages';
import { fromHex, toHex } from '../wire/hex';
import type { PartyId, Unsubscribe } from '../core/types';
import type { Decision } from '../gate/types';
import { buildSpecFromAnnounce } from './spec-builder';
import {
  NOOP_LOGGER,
  type CeremonyOutcome,
  type Logger,
  type OrchestratorCeremonyKind,
  type OrchestratorDeps,
} from './types';

interface FrostVerifyOk {
  ok: true;
  btcOutputs?: ReadonlyArray<DecodedBtcOutput>;
  btcFrostP2tr?: string;
}
interface FrostVerifyError {
  ok: false;
  reason: string;
}
type FrostVerifyOutcome = FrostVerifyOk | FrostVerifyError;

type AnnounceMessage = Extract<
  CeremonyMessage,
  {
    kind:
      | 'announce'
      | 'announce-frost'
      | 'announce-dkg'
      | 'announce-frost-dkg'
      | 'announce-combined-dkg';
  }
>;

interface CeremonyTracker {
  baseCeremonyId: string;
  kind: OrchestratorCeremonyKind;
  leaderId: PartyId;
  inflight: Promise<unknown>[];
  dispatchedCeremonyIds: Set<string>;
  gateDecisionPromise?: Promise<Decision>;
  settled: boolean;
  deadlineTimer: NodeJS.Timeout | null;
}

const ANNOUNCE_KIND_TO_CEREMONY_KIND: Record<AnnounceMessage['kind'], OrchestratorCeremonyKind> = {
  announce: 'signing-mldsa',
  'announce-frost': 'signing-frost',
  'announce-dkg': 'dkg-mldsa',
  'announce-frost-dkg': 'dkg-frost',
  'announce-combined-dkg': 'dkg-combined',
};

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly log: Logger;
  private readonly events = new EventEmitter();
  private readonly ceremonies = new Map<string, CeremonyTracker>();
  private off: Unsubscribe | null = null;
  private started = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.log = deps.logger ?? NOOP_LOGGER;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.off = this.deps.transport.onBroadcast((from, bytes) => {
      this.onBroadcast(from, bytes);
    });
    this.log.info('orchestrator: started', { nodeId: this.deps.node.id, partyId: this.deps.node.partyId });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.off?.();
    this.off = null;
    for (const tracker of this.ceremonies.values()) {
      if (tracker.deadlineTimer) clearTimeout(tracker.deadlineTimer);
    }
    this.ceremonies.clear();
    this.events.emit('stopped');
    this.log.info('orchestrator: stopped');
  }

  /** Subscribe to ceremony outcomes. Use for daemon-level event handling (logging, persistence). */
  onCompleted(handler: (outcome: CeremonyOutcome) => void): Unsubscribe {
    this.events.on('completed', handler);
    return () => this.events.off('completed', handler);
  }

  /**
   * Resolves when the named ceremony settles. Test-friendly — subscribes
   * synchronously, so call this BEFORE the leader broadcasts its announce.
   * Rejects if the timeout elapses without a matching outcome or if stop() fires.
   */
  waitFor(baseCeremonyId: string, timeoutMs = 60_000): Promise<CeremonyOutcome> {
    return new Promise((resolve, reject) => {
      const onCompleted = (outcome: CeremonyOutcome) => {
        if (outcome.baseCeremonyId !== baseCeremonyId) return;
        cleanup();
        resolve(outcome);
      };
      const onStopped = () => {
        cleanup();
        reject(new Error(`orchestrator stopped before ${baseCeremonyId} settled`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`orchestrator.waitFor timed out for ${baseCeremonyId}`));
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

  // ─────────────────────────────────────────────────────────────────────────
  // Dispatch
  // ─────────────────────────────────────────────────────────────────────────

  private onBroadcast(from: PartyId, bytes: Uint8Array): void {
    const msg = parseCeremonyMessage(bytes);
    if (!msg) return;

    if (
      msg.kind === 'announce' ||
      msg.kind === 'announce-frost' ||
      msg.kind === 'announce-dkg' ||
      msg.kind === 'announce-frost-dkg' ||
      msg.kind === 'announce-combined-dkg'
    ) {
      void this.handleAnnounce(from, msg as AnnounceMessage);
      return;
    }

    if (
      msg.kind === 'signoff-done' ||
      msg.kind === 'signoff-frost-done' ||
      msg.kind === 'signoff-aborted'
    ) {
      this.handleSignoff(from, msg);
    }
  }

  private async handleAnnounce(from: PartyId, msg: AnnounceMessage): Promise<void> {
    const baseId = msg.baseCeremonyId;
    const kind = ANNOUNCE_KIND_TO_CEREMONY_KIND[msg.kind];

    let tracker = this.ceremonies.get(baseId);

    if (!tracker) {
      tracker = this.initTracker(baseId, kind, from);
      this.ceremonies.set(baseId, tracker);
    } else {
      if (tracker.settled) return;
      if (tracker.leaderId !== from) {
        this.log.warn('orchestrator: announce from non-leader; ignored', {
          baseId,
          leaderId: tracker.leaderId,
          from,
        });
        return;
      }
      if (tracker.kind !== kind) {
        this.log.warn('orchestrator: announce kind mismatch for existing ceremony; ignored', {
          baseId,
          expected: tracker.kind,
          got: kind,
        });
        return;
      }
    }

    // ML-DSA signing has `#N` retry suffixes; every unique ceremonyId under the
    // baseId is a fresh attempt. Other kinds have a single attempt — duplicates
    // (rebroadcast / network echo) must be deduped.
    if (tracker.dispatchedCeremonyIds.has(msg.ceremonyId)) {
      this.log.debug('orchestrator: duplicate ceremonyId; dropping', { ceremonyId: msg.ceremonyId });
      return;
    }
    tracker.dispatchedCeremonyIds.add(msg.ceremonyId);

    // Verify FROST-signing construction/sighashes before the gate sees the
    // spec — so policy evaluation runs over VERIFIED fields. BTC rebuild from
    // `btcParams`; OPNet re-extracts sighashes from the raw tx + inputs.
    // Mismatch → silent drop (peer indistinguishable from offline). Verify
    // outcome for BTC carries the decoded outputs that populate the spec.
    let verify: FrostVerifyOutcome = { ok: true };
    if (msg.kind === 'announce-frost') {
      verify = verifyAndDecodeFrostAnnounce(msg);
      if (!verify.ok) {
        this.log.error(
          `orchestrator: FROST announce sighash mismatch — silent drop (${verify.reason})`,
          { baseId },
        );
        return;
      }
    }

    const decision = await this.evaluateGate(tracker, msg, verify);
    if (decision !== 'approve') {
      this.log.info('orchestrator: gate non-approve; silent drop', { baseId, decision });
      return;
    }

    this.dispatchParticipant(tracker, msg);
  }

  private async evaluateGate(
    tracker: CeremonyTracker,
    msg: AnnounceMessage,
    verify: FrostVerifyOutcome,
  ): Promise<Decision> {
    if (!tracker.gateDecisionPromise) {
      const spec = buildSpecFromAnnounce(msg, {
        fromPartyId: tracker.leaderId,
        peersById: this.deps.peersById,
        ...(verify.ok && verify.btcOutputs
          ? { btcOutputs: verify.btcOutputs, btcFrostP2tr: verify.btcFrostP2tr }
          : {}),
      });
      tracker.gateDecisionPromise = this.deps.gate.approve(spec).catch((err) => {
        this.log.warn('orchestrator: gate threw; treating as reject', {
          baseId: tracker.baseCeremonyId,
          err: errString(err),
        });
        return 'reject' as Decision;
      });
    }
    return tracker.gateDecisionPromise;
  }

  private dispatchParticipant(tracker: CeremonyTracker, msg: AnnounceMessage): void {
    switch (msg.kind) {
      case 'announce':
        this.dispatchMldsaSigning(tracker, msg);
        return;
      case 'announce-frost':
        this.dispatchFrostSigning(tracker, msg);
        return;
      case 'announce-dkg':
        this.dispatchMldsaDkg(tracker, msg);
        return;
      case 'announce-frost-dkg':
        this.dispatchFrostDkg(tracker, msg);
        return;
      case 'announce-combined-dkg':
        this.dispatchCombinedDkg(tracker, msg);
        return;
    }
  }

  private dispatchMldsaSigning(
    tracker: CeremonyTracker,
    announce: Extract<CeremonyMessage, { kind: 'announce' }>,
  ): void {
    if (!announce.signers.includes(this.deps.node.partyId)) {
      this.log.debug('orchestrator: not in signer set; passive listener', { baseId: tracker.baseCeremonyId });
      return;
    }
    if (!this.deps.share) {
      this.log.error('orchestrator: ML-DSA signing requested but no share loaded — daemon is DKG-only (restart with share file present)', {
        baseId: tracker.baseCeremonyId,
      });
      return;
    }
    const spec = {
      ceremonyId: announce.ceremonyId,
      message: messageFromAnnounce(announce),
      signers: announce.signers,
      share: this.deps.share,
    };
    const task = this.deps.runner
      .participateInSigning(spec, this.deps.pullOpts)
      .catch((err) => {
        this.log.warn('orchestrator: participateInSigning errored', {
          baseId: tracker.baseCeremonyId,
          ceremonyId: spec.ceremonyId,
          err: errString(err),
        });
      });
    tracker.inflight.push(task);
  }

  private dispatchFrostSigning(
    tracker: CeremonyTracker,
    announce: Extract<CeremonyMessage, { kind: 'announce-frost' }>,
  ): void {
    if (!announce.signers.includes(this.deps.node.partyId)) {
      this.log.debug('orchestrator: not in FROST signer set; passive listener', {
        baseId: tracker.baseCeremonyId,
      });
      return;
    }
    if (!this.deps.frostKeyPackage || !this.deps.frostPublicKeyPackage) {
      this.log.error('orchestrator: FROST signing requested but no FROST key package loaded', {
        baseId: tracker.baseCeremonyId,
      });
      return;
    }
    // Sighash verification already happened upstream in handleAnnounce (BTC
    // rebuild from btcParams or OPNet extract from unsignedTxHex+inputs) —
    // a mismatching announce would have been silent-dropped before reaching
    // dispatch. Signers here can trust `sighashes` are consistent with the
    // construction data (or were absent, in which case participants sign
    // the asserted sighashes directly — tests exercise this path).
    const spec = {
      ceremonyId: announce.ceremonyId,
      sighashes: sighashesFromAnnounceFrost(announce),
      signers: announce.signers,
      keyPackage: this.deps.frostKeyPackage,
      publicKeyPackage: this.deps.frostPublicKeyPackage,
      rng: this.deps.rng,
    };
    const task = this.deps.runner
      .participateInFrostSigning(spec, this.deps.pullOpts)
      .catch((err) => {
        this.log.warn('orchestrator: participateInFrostSigning errored', {
          baseId: tracker.baseCeremonyId,
          err: errString(err),
        });
      });
    tracker.inflight.push(task);
  }

  private dispatchMldsaDkg(
    tracker: CeremonyTracker,
    announce: Extract<CeremonyMessage, { kind: 'announce-dkg' }>,
  ): void {
    const spec = {
      ceremonyId: announce.ceremonyId,
      threshold: announce.threshold,
      parties: announce.parties,
      level: announce.level,
    };
    const sessionId = sessionIdFromAnnounceDkg(announce);
    const task = this.deps.runner.participateInMldsaDkg(spec, sessionId, this.deps.pullOpts).then(
      (result) => {
        this.settle(tracker, {
          baseCeremonyId: tracker.baseCeremonyId,
          kind: 'dkg-mldsa',
          status: 'done',
          result,
        });
      },
      (err) => {
        this.log.warn('orchestrator: participateInMldsaDkg errored', {
          baseId: tracker.baseCeremonyId,
          err: errString(err),
        });
      },
    );
    tracker.inflight.push(task);
  }

  private dispatchFrostDkg(
    tracker: CeremonyTracker,
    announce: Extract<CeremonyMessage, { kind: 'announce-frost-dkg' }>,
  ): void {
    const spec = {
      ceremonyId: announce.ceremonyId,
      threshold: announce.threshold,
      parties: announce.parties,
      rng: this.deps.rng,
    };
    const sessionId = sessionIdFromAnnounceFrostDkg(announce);
    const task = this.deps.runner.participateInFrostDkg(spec, sessionId, this.deps.pullOpts).then(
      (result) => {
        this.settle(tracker, {
          baseCeremonyId: tracker.baseCeremonyId,
          kind: 'dkg-frost',
          status: 'done',
          keyPackage: result.keyPackage,
          publicKeyPackage: result.publicKeyPackage,
        });
      },
      (err) => {
        this.log.warn('orchestrator: participateInFrostDkg errored', {
          baseId: tracker.baseCeremonyId,
          err: errString(err),
        });
      },
    );
    tracker.inflight.push(task);
  }

  private dispatchCombinedDkg(
    tracker: CeremonyTracker,
    announce: Extract<CeremonyMessage, { kind: 'announce-combined-dkg' }>,
  ): void {
    const spec = {
      ceremonyId: announce.ceremonyId,
      threshold: announce.threshold,
      parties: announce.parties,
      level: announce.level,
      rng: this.deps.rng,
    };
    const sessionId = sessionIdFromAnnounceCombinedDkg(announce);
    const task = this.deps.runner
      .participateInCombinedDkg(spec, sessionId, this.deps.pullOpts)
      .then(
        async (result) => {
          if (this.deps.persistDkgShare) {
            try {
              await this.deps.persistDkgShare(result, {
                threshold: spec.threshold,
                parties: spec.parties,
                level: spec.level,
              });
            } catch (err) {
              // Persistence is best-effort on participants: the DKG itself
              // succeeded in memory, so we still settle as `done` and let the
              // operator notice the error in logs. (Leader-side, by contrast,
              // propagates the error to its HTTP caller.)
              this.log.error('orchestrator: persist DKG share failed', {
                baseId: tracker.baseCeremonyId,
                err: errString(err),
              });
            }
          }
          this.settle(tracker, {
            baseCeremonyId: tracker.baseCeremonyId,
            kind: 'dkg-combined',
            status: 'done',
            result,
          });
        },
        (err) => {
          this.log.warn('orchestrator: participateInCombinedDkg errored', {
            baseId: tracker.baseCeremonyId,
            err: errString(err),
          });
        },
      );
    tracker.inflight.push(task);
  }

  private handleSignoff(
    from: PartyId,
    msg: Extract<
      CeremonyMessage,
      { kind: 'signoff-done' | 'signoff-frost-done' | 'signoff-aborted' }
    >,
  ): void {
    const tracker = this.ceremonies.get(msg.baseCeremonyId);
    if (!tracker || tracker.settled) return;
    if (tracker.leaderId !== from) {
      this.log.warn('orchestrator: signoff from non-leader; ignored', {
        baseId: msg.baseCeremonyId,
        leaderId: tracker.leaderId,
        from,
      });
      return;
    }

    if (msg.kind === 'signoff-done' && tracker.kind === 'signing-mldsa') {
      this.settle(tracker, {
        baseCeremonyId: msg.baseCeremonyId,
        kind: 'signing-mldsa',
        status: 'done',
        signatureHex: msg.signatureHex,
      });
      return;
    }
    if (msg.kind === 'signoff-frost-done' && tracker.kind === 'signing-frost') {
      this.settle(tracker, {
        baseCeremonyId: msg.baseCeremonyId,
        kind: 'signing-frost',
        status: 'done',
        signaturesHex: msg.signaturesHex,
      });
      return;
    }
    if (msg.kind === 'signoff-aborted') {
      this.settle(tracker, this.abortedOutcome(tracker));
      return;
    }
    // Otherwise: signoff kind mismatches tracker kind. Ignore (shouldn't happen from a valid leader).
    this.log.warn('orchestrator: signoff kind/ceremony-kind mismatch; ignored', {
      baseId: msg.baseCeremonyId,
      ceremonyKind: tracker.kind,
      signoffKind: msg.kind,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tracker helpers
  // ─────────────────────────────────────────────────────────────────────────

  private initTracker(
    baseCeremonyId: string,
    kind: OrchestratorCeremonyKind,
    leaderId: PartyId,
  ): CeremonyTracker {
    const deadlineMs = kind === 'signing-mldsa' || kind === 'signing-frost'
      ? this.deps.ceremonyDeadlines.signingMs
      : this.deps.ceremonyDeadlines.dkgMs;
    const tracker: CeremonyTracker = {
      baseCeremonyId,
      kind,
      leaderId,
      inflight: [],
      dispatchedCeremonyIds: new Set(),
      settled: false,
      deadlineTimer: null,
    };
    tracker.deadlineTimer = setTimeout(() => {
      if (tracker.settled) return;
      this.log.warn('orchestrator: ceremony deadline elapsed; settling as timeout', {
        baseId: baseCeremonyId,
        kind,
      });
      this.settle(tracker, this.timeoutOutcome(tracker));
    }, deadlineMs);
    return tracker;
  }

  private settle(tracker: CeremonyTracker, outcome: CeremonyOutcome): void {
    if (tracker.settled) return;
    tracker.settled = true;
    if (tracker.deadlineTimer) {
      clearTimeout(tracker.deadlineTimer);
      tracker.deadlineTimer = null;
    }
    this.ceremonies.delete(tracker.baseCeremonyId);
    this.log.info('orchestrator: ceremony settled', {
      baseId: tracker.baseCeremonyId,
      kind: outcome.kind,
      status: outcome.status,
    });
    this.events.emit('completed', outcome);
  }

  private abortedOutcome(tracker: CeremonyTracker): CeremonyOutcome {
    return { baseCeremonyId: tracker.baseCeremonyId, kind: tracker.kind, status: 'aborted' } as CeremonyOutcome;
  }

  private timeoutOutcome(tracker: CeremonyTracker): CeremonyOutcome {
    return { baseCeremonyId: tracker.baseCeremonyId, kind: tracker.kind, status: 'timeout' } as CeremonyOutcome;
  }
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Verify the leader's asserted FROST-signing sighashes against what this
 * node computes locally from the announce's construction data.
 *
 * BTC (`btcParams` present): rebuild the tx via `buildBtcTxFromParams`,
 * compare sighashes. Produces decoded outputs that populate the `SigningSpec`
 * — `allowed_btc_recipients` / `max_btc_per_tx` rules evaluate against these.
 *
 * OPNet (`unsignedTxHex` + `inputs` present): re-extract sighashes via
 * `extractBtcSighashes`, compare. Decoded outputs aren't populated
 * (daemon stays ABI-agnostic for OPNet); policy matches against
 * operator-supplied `hints` instead (advisory; matches Ötzi's
 * federation-trust posture).
 *
 * Legacy (no construction data — test harnesses with synthetic sighashes):
 * returns `{ok: true}` with no outputs; participant signs whatever the
 * leader asserts. Production paths always carry construction data.
 */
function verifyAndDecodeFrostAnnounce(
  announce: Extract<CeremonyMessage, { kind: 'announce-frost' }>,
): FrostVerifyOutcome {
  const { sighashes } = announce;

  if (announce.btcParams) {
    const bp = announce.btcParams;
    let rebuilt;
    try {
      rebuilt = buildBtcTxFromParams({
        to: bp.to,
        amountSat: BigInt(bp.amountSat),
        feeRate: bp.feeRate,
        network: bp.network,
        frostP2tr: bp.frostP2tr,
        frostUntweakedPubKey: fromHex(bp.frostUntweakedPubKeyHex),
        utxos: bp.utxos.map((u) => ({
          transactionId: u.transactionId,
          outputIndex: u.outputIndex,
          value: BigInt(u.valueSat),
        })),
      });
    } catch (err) {
      return { ok: false, reason: `btc rebuild failed: ${errString(err)}` };
    }
    if (rebuilt.sighashes.length !== sighashes.length) {
      return {
        ok: false,
        reason: `btc rebuild produced ${rebuilt.sighashes.length} sighashes, announce has ${sighashes.length}`,
      };
    }
    for (let i = 0; i < sighashes.length; i++) {
      const leaderHex = sighashes[i]!.hashHex.toLowerCase();
      const ourHex = toHex(rebuilt.sighashes[i]!.hash).toLowerCase();
      if (leaderHex !== ourHex) {
        return {
          ok: false,
          reason: `btc sighash[${i}] mismatch: leader=${leaderHex} ours=${ourHex}`,
        };
      }
    }
    return { ok: true, btcOutputs: rebuilt.outputs, btcFrostP2tr: bp.frostP2tr };
  }

  if (announce.unsignedTxHex !== undefined && announce.inputs !== undefined) {
    const { unsignedTxHex, inputs } = announce;
    if (inputs.length !== sighashes.length) {
      return {
        ok: false,
        reason: `inputs.length=${inputs.length} != sighashes.length=${sighashes.length}`,
      };
    }
    let recomputed: Array<{ index: number; hash: Uint8Array; tweaked: boolean }>;
    try {
      recomputed = extractBtcSighashes(unsignedTxHex, inputs);
    } catch (err) {
      return { ok: false, reason: `extract failed: ${errString(err)}` };
    }
    for (let i = 0; i < sighashes.length; i++) {
      const leaderHex = sighashes[i]!.hashHex.toLowerCase();
      const ourHex = toHex(recomputed[i]!.hash).toLowerCase();
      if (leaderHex !== ourHex) {
        return {
          ok: false,
          reason: `sighash[${i}] mismatch: leader=${leaderHex} ours=${ourHex}`,
        };
      }
    }
    return { ok: true };
  }

  return { ok: true };
}
