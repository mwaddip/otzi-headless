/**
 * Build the `CeremonySpec` a gate evaluates (facts/gate.md).
 *
 * A signing spec comes from this node's own `ProposalAnalysis` — the leader and
 * every participant analyse the proposal against their own key and network before
 * building it, so no field is taken from the leader's say-so. A DKG spec comes
 * from the ring this node is configured with.
 */

import type { PartyId } from '../core/types';
import type { CeremonySpecBase, DkgSpec, SigningSpec, SpecOutput } from '../gate/types';
import type { ProposalAnalysis } from '../otzi/lib/bitcoin';
import type { NetworkName } from '../otzi/lib/vault-types';

export function resolveLeaderId(
  from: PartyId,
  peersById: ReadonlyMap<PartyId, string>,
): string {
  return peersById.get(from) ?? String(from);
}

/**
 * Copy the analysis fields into a `SigningSpec` (dropping the sighashes) and add
 * `amount`, the sum of the outputs with `isChange === false`. `labelFor` maps an
 * output address to a label from this node's address book; an output gets a
 * `label` only when it returns a string.
 */
export function buildSigningSpec(
  analysis: ProposalAnalysis,
  base: CeremonySpecBase,
  network: NetworkName,
  labelFor?: (address: string) => string | undefined,
): SigningSpec {
  const outputs = analysis.outputs.map((o): SpecOutput => {
    const label = labelFor?.(o.address);
    return typeof label === 'string'
      ? { address: o.address, amount: o.amount, isChange: o.isChange, label }
      : { address: o.address, amount: o.amount, isChange: o.isChange };
  });
  return {
    kind: 'signing',
    ceremonyId: base.ceremonyId,
    leader: base.leader,
    role: base.role,
    network,
    txid: analysis.txid,
    inputs: analysis.inputs.map((i) => ({ txid: i.txid, vout: i.vout, amount: i.amount })),
    outputs,
    amount: outputs.reduce((sum, o) => (o.isChange ? sum : sum + o.amount), 0),
    totalIn: analysis.totalIn,
    totalOut: analysis.totalOut,
    fee: analysis.fee,
    vsize: analysis.vsize,
    feeRate: analysis.feeRate,
  };
}

export function buildDkgSpec(
  base: CeremonySpecBase,
  p: { threshold: number; parties: number; network: NetworkName; peerIds: string[] },
): DkgSpec {
  return {
    kind: 'dkg',
    ceremonyId: base.ceremonyId,
    leader: base.leader,
    role: base.role,
    threshold: p.threshold,
    parties: p.parties,
    network: p.network,
    peerIds: [...p.peerIds],
  };
}
