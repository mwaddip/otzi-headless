/**
 * Approval gate — per-node participation filter for ceremonies.
 *
 * CLAUDE.md § Security Model:
 *   - `approve(spec) → approve | reject | pending`
 *   - A gate can only *further restrict* what its node will sign, never widen.
 *   - A rejecting node stays silent; to peers it is indistinguishable from offline.
 *   - DKG aborts on any reject (every ring member takes part); signing completes
 *     only if every node in `signers` approves.
 *   - Lives in the trigger layer. Ceremony core / transport do not know the gate exists.
 *
 * The gate evaluates a `CeremonySpec` — the Bitcoin transaction this node is asked
 * to sign (outputs, amount, fee), or the ring a DKG would create. Every field is
 * derived by this node from its own analysis of the proposal; nothing is taken from
 * the leader's say-so. See facts/gate.md.
 */

import type { NetworkName } from '../otzi/lib/vault-types';

export type Decision = 'approve' | 'reject' | 'pending';

export type CeremonyRole = 'leader' | 'participant';

export interface CeremonySpecBase {
  /** Unique ceremony identifier — audit + logging. Matches ceremonyId on the wire. */
  ceremonyId: string;
  /** Label of the leader (`resolveLeaderId`). Participant gates inspect this to trust the source. */
  leader: string;
  /** This node's role in the ceremony. */
  role: CeremonyRole;
}

/** One transaction output as this node's `analyzeProposal` decoded it. */
export interface SpecOutput {
  /** Address as the analysis encodes it (lowercase bech32/bech32m for segwit and taproot). */
  address: string;
  /** Sats (safe integer). */
  amount: number;
  /** True iff the output pays this node's own vault script. */
  isChange: boolean;
  /** From this node's own address book when the address is in it. */
  label?: string;
}

export interface SigningSpec extends CeremonySpecBase {
  kind: 'signing';
  network: NetworkName;
  txid: string;
  inputs: Array<{ txid: string; vout: number; amount: number }>;
  /** Every output, change included, in transaction order. */
  outputs: SpecOutput[];
  /** Sum of the outputs with `isChange === false`, sats. */
  amount: number;
  totalIn: number;
  totalOut: number;
  /** `totalIn − totalOut`, sats. */
  fee: number;
  vsize: number;
  /** `fee / vsize`, sat/vB; may be fractional. */
  feeRate: number;
}

export interface DkgSpec extends CeremonySpecBase {
  kind: 'dkg';
  threshold: number;
  parties: number;
  network: NetworkName;
  /** Labels of every ring member, self included. */
  peerIds: string[];
}

export type CeremonySpec = SigningSpec | DkgSpec;

export interface ApprovalGate {
  approve(spec: CeremonySpec): Promise<Decision>;
}
