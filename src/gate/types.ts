/**
 * Approval gate — per-node participation filter for ceremonies.
 *
 * CLAUDE.md § Security Model:
 *   - `approve(spec) → approve | reject | pending`
 *   - A gate can only *further restrict* what its node will sign, never widen.
 *   - A rejecting node stays silent; to peers it is indistinguishable from offline.
 *   - DKG aborts on any reject (threshold = n); signing proceeds iff ≥ t peers approve.
 *   - Lives in the trigger layer. Ceremony core / transport do not know the gate exists.
 *
 * The gate evaluates a `CeremonySpec` — the intent behind the ceremony (operation,
 * amount, destination, method) — not the raw sighashes. Specs are built at trigger
 * time (leader context) or at announce-receipt time (participant context). Wiring
 * the spec through the wire announce payload happens in phase 5c/5d.
 */

export type Decision = 'approve' | 'reject' | 'pending';

export type CeremonyRole = 'leader' | 'participant';

interface CeremonySpecBase {
  /** Unique ceremony identifier — audit + logging. Matches ceremonyId on the wire. */
  ceremonyId: string;
  /** Logical node id of the leader. Participant gates inspect this to trust the source. */
  leader: string;
  /** This node's role in the ceremony. */
  role: CeremonyRole;
}

export interface SigningSpec extends CeremonySpecBase {
  kind: 'signing';
  /** High-level operation the signing supports. */
  operation: 'btc-transfer' | 'opnet-call' | 'key-link' | 'generic';
  /**
   * Amount in smallest units (sats for BTC, atomic for OPNet tokens).
   * `undefined` when not applicable (e.g. raw-message signing).
   */
  amount?: bigint;
  /** Destination address (BTC P2TR, OPNet contract, etc.). */
  destination?: string;
  /** OPNet method name ("transfer", "approve", ...) or BTC sighash tag. */
  method?: string;
  /** Extra structured details for audit/logging. Gates ignore unless relevant. */
  details?: Record<string, unknown>;
}

export interface DkgSpec extends CeremonySpecBase {
  kind: 'dkg';
  protocol: 'mldsa' | 'frost' | 'combined';
  threshold: number;
  parties: number;
  /** Expected peer identities (node ids, including self). */
  peerIds: string[];
}

export type CeremonySpec = SigningSpec | DkgSpec;

export interface ApprovalGate {
  approve(spec: CeremonySpec): Promise<Decision>;
}
