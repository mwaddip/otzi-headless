/**
 * Build a `PublicKeyPackage` from a persisted per-party `KeyPackage`.
 *
 * The persisted V3 share (`serializeFrostKeyPackage`) carries only the
 * caller's own `KeyPackage` — not the other parties' verifying shares.
 * Re-deriving those shares would require the group commitment polynomial,
 * which is not persisted.
 *
 * `signAggregate` (frots `sign.ts:690`) documents `verifyingShares` as
 * "currently unused" on the happy path — it's read only by the
 * cheater-detection branch that runs when BIP340 verify fails. Participants
 * (`signRound1` / `signRound2`) never touch `PublicKeyPackage`. So an empty
 * map is functionally sufficient. Matches Ötzi's own pattern
 * (`DKGWizard.tsx:1155`, `FrostSign.tsx:165`).
 *
 * Tradeoff: on aggregation failure the `culprits` list comes back empty.
 * Acceptable — the transport layer exposes authenticated `from` per frame,
 * so the offender is identifiable without the PKG.
 */

import type { KeyPackage as FrostKeyPackage, PublicKeyPackage } from '@mwaddip/frots';

export function buildFrostPublicKeyPackage(kp: FrostKeyPackage): PublicKeyPackage {
  return {
    verifyingKey: kp.verifyingKey,
    untweakedVerifyingKey: kp.untweakedVerifyingKey,
    minSigners: kp.minSigners,
    verifyingShares: new Map(),
    untweakedVerifyingShares: new Map(),
  };
}
