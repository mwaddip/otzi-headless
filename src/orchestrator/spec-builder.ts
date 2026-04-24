/**
 * Build a `CeremonySpec` from a parsed announce message for gate evaluation.
 *
 * For FROST-signing announces, the caller (`orchestrator`) has already run
 * the verify/rebuild step and — for BTC — has decoded outputs in hand. Pass
 * them in via `btcOutputs` + `btcFrostP2tr` so the spec carries verified
 * policy fields (outputs[], amount, destination). OPNet populates intent
 * fields from operator-supplied `hints` on the announce (advisory,
 * matches federation-trust posture).
 */

import type { CeremonyMessage } from '../core/ceremony-messages';
import type { PartyId } from '../core/types';
import type { CeremonySpec, SigningSpec } from '../gate/types';

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

export interface SpecBuilderCtx {
  fromPartyId: PartyId;
  peersById: ReadonlyMap<PartyId, string>;
  /** Decoded BTC outputs from the participant's own rebuild. Present iff announce had `btcParams`. */
  btcOutputs?: ReadonlyArray<{ address: string | null; amountSat: bigint }>;
  /** FROST vault self-address — used to filter change outputs out of amount/destination. */
  btcFrostP2tr?: string;
}

export function resolveLeaderId(
  from: PartyId,
  peersById: ReadonlyMap<PartyId, string>,
): string {
  return peersById.get(from) ?? String(from);
}

export function buildSpecFromAnnounce(
  msg: AnnounceMessage,
  ctx: SpecBuilderCtx,
): CeremonySpec {
  const leader = resolveLeaderId(ctx.fromPartyId, ctx.peersById);

  switch (msg.kind) {
    case 'announce':
      return {
        kind: 'signing',
        ceremonyId: msg.baseCeremonyId,
        leader,
        role: 'participant',
        operation: 'generic',
      };
    case 'announce-frost':
      return buildFrostSigningSpec(msg, ctx, leader);
    case 'announce-dkg':
      return {
        kind: 'dkg',
        ceremonyId: msg.baseCeremonyId,
        leader,
        role: 'participant',
        protocol: 'mldsa',
        threshold: msg.threshold,
        parties: msg.parties,
        peerIds: collectPeerIds(ctx.peersById),
      };
    case 'announce-frost-dkg':
      return {
        kind: 'dkg',
        ceremonyId: msg.baseCeremonyId,
        leader,
        role: 'participant',
        protocol: 'frost',
        threshold: msg.threshold,
        parties: msg.parties,
        peerIds: collectPeerIds(ctx.peersById),
      };
    case 'announce-combined-dkg':
      return {
        kind: 'dkg',
        ceremonyId: msg.baseCeremonyId,
        leader,
        role: 'participant',
        protocol: 'combined',
        threshold: msg.threshold,
        parties: msg.parties,
        peerIds: collectPeerIds(ctx.peersById),
      };
  }
}

function buildFrostSigningSpec(
  msg: Extract<CeremonyMessage, { kind: 'announce-frost' }>,
  ctx: SpecBuilderCtx,
  leader: string,
): SigningSpec {
  const base: SigningSpec = {
    kind: 'signing',
    ceremonyId: msg.baseCeremonyId,
    leader,
    role: 'participant',
    operation: msg.protocol === 'btc' ? 'btc-transfer'
      : msg.protocol === 'opnet' ? 'opnet-call'
      : 'generic',
  };

  // BTC: populate outputs from verified rebuild, filtering the vault's own
  // change-back. Policy rules only care about external outputs.
  if (msg.protocol === 'btc' && ctx.btcOutputs) {
    const nonSelf = ctx.btcOutputs
      .filter((o) => o.address !== ctx.btcFrostP2tr)
      .map((o) => ({ address: o.address, amountSat: o.amountSat }));
    const amount = nonSelf.reduce((sum, o) => sum + o.amountSat, 0n);
    const destination = nonSelf.find((o) => o.address !== null)?.address ?? undefined;
    return {
      ...base,
      amount,
      ...(destination !== undefined ? { destination } : {}),
      outputs: nonSelf,
    };
  }

  // OPNet: populate from operator-supplied hints (advisory).
  if (msg.protocol === 'opnet' && msg.hints) {
    const { contractAddress, method, amountTokenAtomic } = msg.hints;
    return {
      ...base,
      ...(contractAddress !== undefined ? { destination: contractAddress } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(amountTokenAtomic !== undefined ? { amount: BigInt(amountTokenAtomic) } : {}),
    };
  }

  return base;
}

function collectPeerIds(peersById: ReadonlyMap<PartyId, string>): string[] {
  return [...peersById.values()];
}
