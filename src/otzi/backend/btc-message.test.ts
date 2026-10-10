import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyBitcoinMessage, bip322MessageHash, legacyMessageHash } from './btc-message.js';

// BIP-322 test vectors
const WPKH = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
const TR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3';

test('BIP-322 message hashes match the specification', () => {
  assert.equal(hex.encode(bip322MessageHash('')), 'c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1');
  assert.equal(hex.encode(bip322MessageHash('Hello World')), 'f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a');
});

test('BIP-322 simple P2WPKH vectors verify', () => {
  assert.ok(verifyBitcoinMessage(WPKH, '', 'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='));
  assert.ok(verifyBitcoinMessage(WPKH, 'Hello World', 'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='));
  assert.ok(!verifyBitcoinMessage(WPKH, 'Hello World!', 'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='));
});

test('BIP-322 simple P2TR vector verifies', () => {
  const sig = 'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==';
  assert.ok(verifyBitcoinMessage(TR, 'Hello World', sig));
  assert.ok(!verifyBitcoinMessage(TR, 'Hello World.', sig));
  assert.ok(!verifyBitcoinMessage(WPKH, 'Hello World', sig));
});

function legacySign(message: string, secret: Uint8Array, header: number): string {
  const rec = secp256k1.sign(legacyMessageHash(message), secret, { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out[0] = header + rec[0]!;
  out.set(rec.slice(1), 1);
  return base64.encode(out);
}

test('legacy signmessage signatures verify for P2PKH, P2SH-P2WPKH and P2WPKH', () => {
  const secret = secp256k1.utils.randomSecretKey();
  const pub = secp256k1.getPublicKey(secret, true);
  const msg = 'Sign in to Otzi\nHost: localhost\nChallenge: 00';
  const pkh = btc.p2pkh(pub).address!;
  const shwpkh = btc.p2sh(btc.p2wpkh(pub)).address!;
  const wpkh = btc.p2wpkh(pub).address!;

  assert.ok(verifyBitcoinMessage(pkh, msg, legacySign(msg, secret, 31)));          // Core / Electrum compressed
  assert.ok(verifyBitcoinMessage(shwpkh, msg, legacySign(msg, secret, 35)));       // BIP-137 P2SH-P2WPKH
  assert.ok(verifyBitcoinMessage(wpkh, msg, legacySign(msg, secret, 39)));         // BIP-137 P2WPKH
  assert.ok(verifyBitcoinMessage(wpkh, msg, legacySign(msg, secret, 31)));         // Electrum-style header for segwit
  assert.ok(!verifyBitcoinMessage(wpkh, msg + '!', legacySign(msg, secret, 39)));
  assert.ok(!verifyBitcoinMessage(btc.p2wpkh(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)).address!, msg, legacySign(msg, secret, 39)));

  const testnet = btc.p2wpkh(pub, btc.TEST_NETWORK).address!;
  assert.ok(verifyBitcoinMessage(testnet, msg, legacySign(msg, secret, 39)));
});

test('legacy uncompressed P2PKH signatures verify', () => {
  const secret = secp256k1.utils.randomSecretKey();
  const pubUncompressed = secp256k1.getPublicKey(secret, false);
  const msg = 'hello';
  const addr = btc.Address(btc.NETWORK).encode({ type: 'pkh', hash: btc.p2wpkh(secp256k1.getPublicKey(secret, true)).hash });
  // Uncompressed key has a different hash160; compressed address must not match an uncompressed header
  assert.ok(!verifyBitcoinMessage(addr, msg, legacySign(msg, secret, 27)));
  const uncompressedAddr = btc.p2pkh(pubUncompressed).address!;
  assert.ok(verifyBitcoinMessage(uncompressedAddr, msg, legacySign(msg, secret, 27)));
});

test('garbage never verifies and never throws', () => {
  assert.ok(!verifyBitcoinMessage(WPKH, 'x', 'not base64!!'));
  assert.ok(!verifyBitcoinMessage('not-an-address', 'x', 'AAAA'));
  assert.ok(!verifyBitcoinMessage(WPKH, 'x', ''));
});
