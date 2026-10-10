import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { legacyMessageHash } from '../../src/otzi/backend/btc-message';
import { decisionMessage, verifyDecision } from './decision';

/** A legacy signmessage / BIP-137 signature (compressed P2WPKH header) over an arbitrary message. */
function signMessage(message: string, priv: Uint8Array): string {
  const sig = secp256k1.sign(legacyMessageHash(message), priv, { prehash: false, format: 'recovered' }); // [recid, r, s]
  const header = 27 + 4 + 8 + sig[0]!; // compressed P2WPKH (BIP-137)
  return base64.encode(Uint8Array.from([header, ...sig.slice(1)]));
}

describe('decision', () => {
  it('builds the message the operator signs', () => {
    expect(decisionMessage('approve', 'sign-1', 'ab'.repeat(16))).toBe(`otzi-gate:approve:sign-1:${'ab'.repeat(16)}`);
    expect(decisionMessage('reject', 'dkg-7', '00'.repeat(16))).toBe(`otzi-gate:reject:dkg-7:${'00'.repeat(16)}`);
  });

  it('accepts a legacy signmessage signature from the pinned P2WPKH address', () => {
    const priv = secp256k1.utils.randomSecretKey();
    const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address!;
    const msg = decisionMessage('approve', 'sign-1', 'ab'.repeat(16));
    const signature = signMessage(msg, priv);
    expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-1', nonce: 'ab'.repeat(16), signature })).toBe(true);
    expect(verifyDecision({ address, decision: 'reject', ceremonyId: 'sign-1', nonce: 'ab'.repeat(16), signature })).toBe(false);
  });

  it('rejects a signature from another key or for another ceremony or nonce', () => {
    const priv = secp256k1.utils.randomSecretKey();
    const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address!;
    const nonce = 'ab'.repeat(16);
    const signature = signMessage(decisionMessage('approve', 'sign-1', nonce), priv);
    const stranger = signMessage(decisionMessage('approve', 'sign-1', nonce), secp256k1.utils.randomSecretKey());
    expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-1', nonce, signature: stranger })).toBe(false);
    expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-2', nonce, signature })).toBe(false);
    expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-1', nonce: 'cd'.repeat(16), signature })).toBe(false);
  });

  // The message stays injective (decision and nonce occupy fixed, colon-free positions) even for a
  // fork that skips the approver's own input checks, so verifyDecision refuses odd inputs itself,
  // however validly the odd message was signed.
  it('refuses a decision other than approve or reject, even with a valid signature over that message', () => {
    const priv = secp256k1.utils.randomSecretKey();
    const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address!;
    const nonce = 'ab'.repeat(16);
    for (const decision of ['maybe', 'approve:x', '', 'APPROVE']) {
      const signature = signMessage(decisionMessage(decision as 'approve', 'sign-1', nonce), priv);
      expect(verifyDecision({ address, decision: decision as 'approve', ceremonyId: 'sign-1', nonce, signature })).toBe(false);
    }
  });

  it('refuses a nonce that is not 32 lowercase hex characters, even with a valid signature over that message', () => {
    const priv = secp256k1.utils.randomSecretKey();
    const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address!;
    for (const nonce of ['', 'ab', 'AB'.repeat(16), 'ab'.repeat(17), `${'ab'.repeat(15)}:a`, `${'ab'.repeat(15)}zz`, 'x:' + 'ab'.repeat(16)]) {
      const signature = signMessage(decisionMessage('approve', 'sign-1', nonce), priv);
      expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-1', nonce, signature })).toBe(false);
    }
  });

  it('never throws on garbage input', () => {
    expect(verifyDecision({ address: 'nope', decision: 'approve', ceremonyId: 'x', nonce: 'ab'.repeat(16), signature: '!!' })).toBe(false);
  });
});
