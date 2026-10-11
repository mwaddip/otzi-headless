/**
 * The symmetric FROST DKG ceremony with verification signature and all-N
 * confirmation (facts/core.md, `dkg-ceremony.ts`; spec §5.3 steps 2–7).
 *
 * Every node runs the same steps and pulls what it needs from every other
 * node; there is no leader. A node commits its share only once every node has
 * signed the DKG transcript under the same vault key and staged its share:
 *
 *   1. Round 1  — `dkg-r1` broadcast blobs.
 *   2. Round 2  — `dkg-r2` addressed blobs, then finalize.
 *   3. Verify   — all N nodes FROST-sign M = dkgVerifyMessage(...) under the new
 *                 key (`dkg-verify-r1` / `dkg-verify-r2`); every node aggregates.
 *   4. Stage    — the share goes durably to `.pending`.
 *   5. Confirm  — `dkg-verified` = the raw 64-byte signature, pulled from all N−1
 *                 others and checked against this node's own M and key.
 *   6. Complete — commit, whatever the signal says once every confirmation verified.
 *
 * Announcing is the caller's job. On any failure, unless `signal` aborted
 * (someone else already announced the abort), `signoff-aborted` is broadcast.
 * The staged share is discarded only while this node has not published its
 * own `dkg-verified`: no node can commit without that confirmation. After it,
 * another node may already have committed the vault, so the staged share is
 * kept and the error (`DkgShareKeptError`) names it and the recovery.
 */

import { verifySignature, type KeyPackage, type PublicKeyPackage, type Rng } from '@mwaddip/frots';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { dkgVerifyMessage, toVaultKey } from '../otzi/lib/dkg';
import type { NetworkName } from '../otzi/lib/vault-types';
import type { CeremonyIo } from './ceremony-io';
import * as dkgSession from './frost-dkg-session';
import * as signSession from './frost-sign-session';
import { encodeMessage } from './messages';
import type { BlobKey, PartyId } from './types';

export const DKG_ROUNDS = {
  r1: 'dkg-r1',
  r2: 'dkg-r2',
  verifyR1: 'dkg-verify-r1',
  verifyR2: 'dkg-verify-r2',
  verified: 'dkg-verified',
} as const;

export interface DkgCeremonyResult {
  keyPackage: KeyPackage;
  publicKeyPackage: PublicKeyPackage;
}

export interface ShareStager {
  /** Where `commit` puts the share. */
  readonly sharePath: string;
  /** Where `stage` writes it. */
  readonly stagedPath: string;
  /** Resolves once the share is durable at `stagedPath`. */
  stage(r: DkgCeremonyResult): Promise<void>;
  /** Resolves once the share is at `sharePath`; never replaces an entry there. */
  commit(): Promise<void>;
  /**
   * Removes what this stager's own `stage` wrote, and nothing else: a call
   * before or without a `stage` is a no-op, because a `.pending` already at
   * `stagedPath` may be a share an earlier ceremony kept (ruling R41).
   */
  discard(): Promise<void>;
}

export interface DkgCeremonySpec {
  ceremonyId: string;
  sessionId: Uint8Array;
  threshold: number;
  parties: number;
  network: NetworkName;
  rng: Rng;
}

/** Where a confirmed node's staged share was kept, and what the operator does with it. */
export function keptShareNote(stager: Pick<ShareStager, 'sharePath' | 'stagedPath'>, address: string): string {
  const { sharePath, stagedPath } = stager;
  return (
    `this node published its confirmation of vault ${address}, so its staged share was kept at ${stagedPath}: ` +
    `run 'otzi vault' on the other nodes; if any of them shows ${address}, rename ${stagedPath} to ${sharePath} ` +
    `and restart this daemon, otherwise remove ${stagedPath}`
  );
}

/**
 * A DKG that failed after this node published its `dkg-verified`: another node
 * may have committed the vault, so this node's staged share was kept.
 */
export class DkgShareKeptError extends Error {
  constructor(
    /** Why the ceremony failed. */
    readonly reason: string,
    /** `keptShareNote(...)`: where the share is and the recovery. */
    readonly keptNote: string,
    readonly stagedPath: string,
    options?: ErrorOptions,
  ) {
    super(`DKG aborted: ${reason}; ${keptNote}`, options);
    this.name = 'DkgShareKeptError';
  }
}

/** Longest `reason` a `signoff-aborted` may carry (messages.ts parser rule). */
const MAX_REASON_LENGTH = 1024;
const SIGNATURE_LENGTH = 64;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

type AddBlobResult = { ok: true } | { ok: false; error: string };

export async function runDkgCeremony(
  io: CeremonyIo,
  spec: DkgCeremonySpec,
  stager: ShareStager,
  signal?: AbortSignal,
): Promise<DkgCeremonyResult> {
  const me = io.transport.partyId;
  const { ceremonyId } = spec;
  const all: PartyId[] = Array.from({ length: spec.parties }, (_, i) => i);
  const others = all.filter(p => p !== me);
  let dkg: dkgSession.FrostDkgSession | null = null;
  let sign: signSession.FrostSigningSession | null = null;
  /** Set once this node's `dkg-verified` is in its store, i.e. servable to the others. */
  let confirmedVault: string | null = null;

  const put = (key: BlobKey, blob: Uint8Array) => io.store.put(key, blob);
  const broadcastKeys = (round: string): BlobKey[] => others.map(from => ({ ceremonyId, round, from }));

  /** Pull `keys` and hand each blob, as text, to `add` with its authenticated producer. */
  const pullAndAdd = async (keys: BlobKey[], add: (blob: string, from: PartyId) => AddBlobResult) => {
    await io.puller.pullAll(keys, io.pullOpts, signal);
    for (const key of keys) {
      const bytes = io.store.get(key);
      if (!bytes) throw new Error(`Missing ${key.round} blob from party ${key.from}`);
      const result = add(fromUtf8.decode(bytes), key.from);
      if (!result.ok) throw new Error(`Rejected ${key.round} blob from party ${key.from}: ${result.error}`);
    }
  };

  try {
    if (spec.parties !== io.transport.peers.length) {
      throw new Error(`parties ${spec.parties} does not match ring size ${io.transport.peers.length}`);
    }

    // 1. Round 1.
    throwIfAborted(signal);
    const session = dkgSession.createSession({
      partyId: me,
      sessionId: spec.sessionId,
      threshold: spec.threshold,
      parties: spec.parties,
      rng: spec.rng,
    });
    dkg = session;
    put({ ceremonyId, round: DKG_ROUNDS.r1, from: me }, utf8.encode(dkgSession.round1(session)));
    await pullAndAdd(broadcastKeys(DKG_ROUNDS.r1), (blob, from) => dkgSession.addBlob(session, blob, 'r1', from));

    // 2. Round 2 (addressed shares), then finalize.
    throwIfAborted(signal);
    dkgSession.round2(session);
    for (const to of dkgSession.round2Recipients(session)) {
      const blob = dkgSession.round2ForTarget(session, to);
      if (!blob) throw new Error(`no round-2 share for party ${to}`);
      put({ ceremonyId, round: DKG_ROUNDS.r2, from: me, to }, utf8.encode(blob));
    }
    await pullAndAdd(
      others.map(from => ({ ceremonyId, round: DKG_ROUNDS.r2, from, to: me })),
      (blob, from) => dkgSession.addBlob(session, blob, 'r2', from),
    );
    const { keyPackage, publicKeyPackage } = dkgSession.finalize(session);
    const result: DkgCeremonyResult = { keyPackage, publicKeyPackage };

    // 3. Verify: all N nodes sign M under the new key; every node aggregates.
    throwIfAborted(signal);
    const M = dkgVerifyMessage(spec.sessionId, spec.network, publicKeyPackage);
    const signing = signSession.createSession({
      partyId: me,
      keyPackage,
      publicKeyPackage,
      sighashes: [{ hash: M, tweaked: true }],
      activeSigners: all,
      rng: spec.rng,
      sessionId: spec.sessionId,
    });
    sign = signing;
    put({ ceremonyId, round: DKG_ROUNDS.verifyR1, from: me }, utf8.encode(signSession.round1(signing)));
    await pullAndAdd(broadcastKeys(DKG_ROUNDS.verifyR1), (blob, from) => signSession.addBlob(signing, blob, 1, from));
    throwIfAborted(signal);
    put({ ceremonyId, round: DKG_ROUNDS.verifyR2, from: me }, utf8.encode(signSession.round2(signing)));
    await pullAndAdd(broadcastKeys(DKG_ROUNDS.verifyR2), (blob, from) => signSession.addBlob(signing, blob, 2, from));
    const sigs = signSession.aggregate(signing);
    const signature = sigs[0];
    if (sigs.length !== 1 || !signature) throw new Error(`expected 1 verification signature, got ${sigs.length}`);
    if (!verifySignature(signature, M, publicKeyPackage.verifyingKey)) {
      throw new Error('verification signature does not verify');
    }

    // 4. Stage.
    throwIfAborted(signal);
    await stager.stage(result);

    // 5. Confirm: every other node signed the same M under the same key. From
    // the put on, any node may complete with this node's confirmation, so this
    // node never discards its staged share again.
    throwIfAborted(signal);
    confirmedVault = vaultPayment(toVaultKey(publicKeyPackage), spec.network).address;
    put({ ceremonyId, round: DKG_ROUNDS.verified, from: me }, signature);
    const confirmations = broadcastKeys(DKG_ROUNDS.verified);
    await io.puller.pullAll(confirmations, io.pullOpts, signal);
    for (const key of confirmations) {
      const theirs = io.store.get(key);
      if (!theirs) throw new Error(`Missing ${key.round} blob from party ${key.from}`);
      if (theirs.length !== SIGNATURE_LENGTH) {
        throw new Error(`${key.round} from party ${key.from} is ${theirs.length} bytes, expected ${SIGNATURE_LENGTH}`);
      }
      if (!verifySignature(theirs, M, publicKeyPackage.verifyingKey)) {
        throw new Error(`${key.round} from party ${key.from} does not verify`);
      }
    }

    // 6. Complete. Every confirmation verified: the others may be committing
    // now, so an abort that arrives from here on does not stop this node.
    await stager.commit();
    return result;
  } catch (err) {
    const reason = errorMessage(err);
    let note = '';
    if (confirmedVault === null) {
      try {
        await stager.discard();
      } catch (discardErr) {
        note = ` (discard failed: ${errorMessage(discardErr)})`;
      }
    }
    if (!signal?.aborted) {
      try {
        await io.transport.broadcast(
          encodeMessage({ v: 2, kind: 'signoff-aborted', ceremonyId, reason: reason.slice(0, MAX_REASON_LENGTH) }),
        );
      } catch {
        // Best effort: peers still stop on their own pull failures or deadline.
      }
    }
    if (confirmedVault !== null) {
      throw new DkgShareKeptError(reason, keptShareNote(stager, confirmedVault), stager.stagedPath, { cause: err });
    }
    throw new Error(`DKG aborted: ${reason}${note}`);
  } finally {
    if (sign) signSession.destroySession(sign);
    if (dkg) dkgSession.destroySession(dkg);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('aborted');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
