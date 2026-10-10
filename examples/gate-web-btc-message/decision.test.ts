import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { legacyMessageHash } from '../../src/otzi/backend/btc-message';
import { decisionMessage, verifyDecision } from './decision';

describe('decision', () => {
  it('builds the message the operator signs', () => {
    expect(decisionMessage('approve', 'sign-1', 'ab'.repeat(16))).toBe(`otzi-gate:approve:sign-1:${'ab'.repeat(16)}`);
    expect(decisionMessage('reject', 'dkg-7', '00'.repeat(16))).toBe(`otzi-gate:reject:dkg-7:${'00'.repeat(16)}`);
  });

  it('accepts a legacy signmessage signature from the pinned P2WPKH address', () => {
    const priv = secp256k1.utils.randomSecretKey();
    const address = btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address!;
    const msg = decisionMessage('approve', 'sign-1', 'ab'.repeat(16));
    const sig = secp256k1.sign(legacyMessageHash(msg), priv, { prehash: false, format: 'recovered' }); // [recid, r, s]
    const header = 27 + 4 + 8 + sig[0]; // compressed P2WPKH (BIP-137)
    const signature = base64.encode(Uint8Array.from([header, ...sig.slice(1)]));
    expect(verifyDecision({ address, decision: 'approve', ceremonyId: 'sign-1', nonce: 'ab'.repeat(16), signature })).toBe(true);
    expect(verifyDecision({ address, decision: 'reject', ceremonyId: 'sign-1', nonce: 'ab'.repeat(16), signature })).toBe(false);
  });
});
