/**
 * Leader-side ceremony dispatcher.
 *
 * Counterpart to `Orchestrator` (which is participant-side). Called by the
 * trigger layer when this daemon is the initiating node: builds a
 * `CeremonySpec` with real intent, evaluates the gate, invokes the runner's
 * leader method, broadcasts the signoff on success, and surfaces the result.
 *
 * A gate `reject` or `pending` decision throws `GateRejection` (the ceremony
 * never even announces — no side effect on peers). Other failures propagate
 * from the runner (which handles its own signoff-aborted broadcast).
 */

import type { DKGResult } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { KeyPackage, PublicKeyPackage, Rng } from '@mwaddip/frots';
import type { PullOpts } from '../core/blob-puller';
import type { CeremonyRunner, CombinedDkgResult } from '../core/ceremony-runner';
import type { PartyId } from '../core/types';
import type { ApprovalGate, CeremonySpec, Decision } from '../gate/types';
import { NOOP_LOGGER, type DkgPersistenceSink, type Logger } from '../orchestrator/types';
import type { DecryptedShare } from '../wire/share-crypto';

export interface LeaderDeps {
  runner: CeremonyRunner;
  gate: ApprovalGate;
  node: { id: string; partyId: PartyId };
  peersById: ReadonlyMap<PartyId, string>;
  /**
   * Decrypted share for this party. Optional: a DKG-only daemon (no share
   * file at startup) leaves this undefined; signing methods then throw a
   * clear error before doing any side-effecting work.
   */
  share?: DecryptedShare;
  frostKeyPackage?: KeyPackage;
  frostPublicKeyPackage?: PublicKeyPackage;
  rng: Rng;
  pullOpts: PullOpts;
  /**
   * Persists this party's combined-DKG result after the protocol completes.
   * Errors propagate to the caller (HTTP 500) — leader stops short of
   * returning success when its own share didn't make it to disk.
   */
  persistDkgShare?: DkgPersistenceSink;
  logger?: Logger;
}

export interface LeaderDkgRequest {
  ceremonyId: string;
  threshold: number;
  parties: number;
}

export interface LeaderMldsaLikeDkgRequest extends LeaderDkgRequest {
  level: number;
}

export interface LeaderSigningRequestBase {
  ceremonyId: string;
  operation: 'btc-transfer' | 'opnet-call' | 'key-link' | 'generic';
  signers: PartyId[];
  amount?: bigint;
  destination?: string;
  method?: string;
}

export interface LeaderMldsaSigningRequest extends LeaderSigningRequestBase {
  message: Uint8Array;
}

export interface LeaderFrostSigningRequest extends LeaderSigningRequestBase {
  sighashes: ReadonlyArray<{ hash: Uint8Array; tweaked: boolean }>;
}

export class GateRejection extends Error {
  constructor(
    public readonly ceremonyId: string,
    public readonly decision: Exclude<Decision, 'approve'>,
  ) {
    super(`leader: gate ${decision} for ceremony '${ceremonyId}'`);
    this.name = 'GateRejection';
  }
}

export class LeaderDispatcher {
  private readonly log: Logger;
  constructor(private readonly deps: LeaderDeps) {
    this.log = deps.logger ?? NOOP_LOGGER;
  }

  async runCombinedDkg(req: LeaderMldsaLikeDkgRequest): Promise<CombinedDkgResult> {
    await this.requireApprove(this.dkgSpec('combined', req));
    this.log.info('leader: runCombinedDkg', { ceremonyId: req.ceremonyId });
    const result = await this.deps.runner.runCombinedDkg(
      {
        ceremonyId: req.ceremonyId,
        threshold: req.threshold,
        parties: req.parties,
        level: req.level,
        rng: this.deps.rng,
      },
      this.deps.pullOpts,
    );
    if (this.deps.persistDkgShare) {
      await this.deps.persistDkgShare(result, {
        threshold: req.threshold,
        parties: req.parties,
        level: req.level,
      });
    }
    return result;
  }

  async runMldsaDkg(req: LeaderMldsaLikeDkgRequest): Promise<DKGResult> {
    await this.requireApprove(this.dkgSpec('mldsa', req));
    this.log.info('leader: runMldsaDkg', { ceremonyId: req.ceremonyId });
    return this.deps.runner.runMldsaDkg(
      { ceremonyId: req.ceremonyId, threshold: req.threshold, parties: req.parties, level: req.level },
      this.deps.pullOpts,
    );
  }

  async runFrostDkg(req: LeaderDkgRequest): Promise<{
    keyPackage: KeyPackage;
    publicKeyPackage: PublicKeyPackage;
  }> {
    await this.requireApprove(this.dkgSpec('frost', req));
    this.log.info('leader: runFrostDkg', { ceremonyId: req.ceremonyId });
    return this.deps.runner.runFrostDkg(
      { ceremonyId: req.ceremonyId, threshold: req.threshold, parties: req.parties, rng: this.deps.rng },
      this.deps.pullOpts,
    );
  }

  async signMldsa(req: LeaderMldsaSigningRequest): Promise<Uint8Array> {
    if (!this.deps.share)
      throw new Error(
        'leader: signMldsa requires a share — daemon started in DKG-only mode (no share file at configured path). Run DKG, then restart daemon to load the persisted share.',
      );
    this.assertInSigners(req.signers);
    await this.requireApprove(this.signingSpec(req));
    this.log.info('leader: signMldsa', { ceremonyId: req.ceremonyId, operation: req.operation });
    const sig = await this.deps.runner.signAsLeader(
      { ceremonyId: req.ceremonyId, message: req.message, signers: req.signers, share: this.deps.share },
      this.deps.pullOpts,
    );
    await this.deps.runner.sendSigningDoneSignoff(req.ceremonyId, sig);
    return sig;
  }

  async signFrost(req: LeaderFrostSigningRequest): Promise<Uint8Array[]> {
    if (!this.deps.frostKeyPackage || !this.deps.frostPublicKeyPackage)
      throw new Error('leader: FROST signing requested but no FROST key material loaded');
    this.assertInSigners(req.signers);
    await this.requireApprove(this.signingSpec(req));
    this.log.info('leader: signFrost', { ceremonyId: req.ceremonyId, operation: req.operation });
    const sigs = await this.deps.runner.signFrostAsLeader(
      {
        ceremonyId: req.ceremonyId,
        sighashes: req.sighashes,
        signers: req.signers,
        keyPackage: this.deps.frostKeyPackage,
        publicKeyPackage: this.deps.frostPublicKeyPackage,
        rng: this.deps.rng,
      },
      this.deps.pullOpts,
    );
    await this.deps.runner.sendFrostSigningDoneSignoff(req.ceremonyId, sigs);
    return sigs;
  }

  // ─────────────────────────────────────────────────────────────────────

  private dkgSpec(
    protocol: 'mldsa' | 'frost' | 'combined',
    req: LeaderDkgRequest,
  ): CeremonySpec {
    return {
      kind: 'dkg',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      protocol,
      threshold: req.threshold,
      parties: req.parties,
      peerIds: [...this.deps.peersById.values()],
    };
  }

  private signingSpec(req: LeaderSigningRequestBase): CeremonySpec {
    return {
      kind: 'signing',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      operation: req.operation,
      amount: req.amount,
      destination: req.destination,
      method: req.method,
    };
  }

  private async requireApprove(spec: CeremonySpec): Promise<void> {
    let decision: Decision;
    try {
      decision = await this.deps.gate.approve(spec);
    } catch (err) {
      throw new Error(
        `leader: gate threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (decision !== 'approve') throw new GateRejection(spec.ceremonyId, decision);
  }

  private assertInSigners(signers: PartyId[]): void {
    if (!signers.includes(this.deps.node.partyId))
      throw new Error(
        `leader: self (partyId=${this.deps.node.partyId}) is not in signers [${signers.join(',')}]`,
      );
  }
}
