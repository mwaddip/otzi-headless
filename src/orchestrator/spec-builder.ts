/**
 * Build a `CeremonySpec` from a parsed announce message for gate evaluation.
 *
 * The announce payload carries protocol-level data (sighashes, threshold,
 * parties) but not trigger-level intent (amount, destination, method).
 * Participant-side gates therefore see `operation: 'generic'` + undefined
 * amount/destination/method for all signing ceremonies in phase 5c. An
 * announce-payload extension (phase 5d or later) will propagate intent so
 * `PolicyGate` rules can enforce on the participant side too.
 */

import type { CeremonyMessage } from '../core/ceremony-messages';
import type { PartyId } from '../core/types';
import type { CeremonySpec } from '../gate/types';

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

export function resolveLeaderId(
  from: PartyId,
  peersById: ReadonlyMap<PartyId, string>,
): string {
  return peersById.get(from) ?? String(from);
}

export function buildSpecFromAnnounce(
  msg: AnnounceMessage,
  ctx: { fromPartyId: PartyId; peersById: ReadonlyMap<PartyId, string> },
): CeremonySpec {
  const leader = resolveLeaderId(ctx.fromPartyId, ctx.peersById);

  switch (msg.kind) {
    case 'announce':
    case 'announce-frost':
      return {
        kind: 'signing',
        ceremonyId: msg.baseCeremonyId,
        leader,
        role: 'participant',
        operation: 'generic',
      };
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

function collectPeerIds(peersById: ReadonlyMap<PartyId, string>): string[] {
  return [...peersById.values()];
}
