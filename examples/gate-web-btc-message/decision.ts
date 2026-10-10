/**
 * The decision message the operator signs, and its verification.
 *
 * Pure functions; the approver holds the pinned address and the nonce.
 */

import { verifyBitcoinMessage } from '../../src/otzi/backend/btc-message.ts';

export type Decision = 'approve' | 'reject';

/** An approver-issued nonce: 16 random bytes as lowercase hex. */
const NONCE = /^[0-9a-f]{32}$/;

/**
 * Text the operator signs in their wallet. It names the decision, the ceremony
 * and the approver-issued nonce, so a signature covers exactly one decision on
 * one pending request.
 */
export function decisionMessage(decision: Decision, ceremonyId: string, nonce: string): string {
  return `otzi-gate:${decision}:${ceremonyId}:${nonce}`;
}

/**
 * True iff `signature` (base64) is `address`'s message signature over
 * `decisionMessage(decision, ceremonyId, nonce)`: BIP-322 simple for P2WPKH and
 * P2TR, legacy / BIP-137 for older address types. False unless `decision` is
 * 'approve' or 'reject' and `nonce` is 32 lowercase hex characters: the decision
 * and the nonce then sit in fixed positions of the message, so two different
 * (decision, ceremonyId, nonce) triples never share one message, even for a
 * caller that skipped its own input checks. Never throws.
 */
export function verifyDecision(p: {
  address: string;
  decision: Decision;
  ceremonyId: string;
  nonce: string;
  signature: string;
}): boolean {
  if (p.decision !== 'approve' && p.decision !== 'reject') return false;
  if (typeof p.nonce !== 'string' || !NONCE.test(p.nonce)) return false;
  return verifyBitcoinMessage(p.address, decisionMessage(p.decision, p.ceremonyId, p.nonce), p.signature);
}
