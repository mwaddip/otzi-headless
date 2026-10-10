import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRound1, signRound2, signAggregate, verifySignature, type SignatureShare } from '@mwaddip/frots';
import { runDkg, rng } from './dkg.fixture';
import {
  dkgVerifyMessage, toVaultKey, fromVaultKey, encodeSessionConfig, decodeSessionConfig,
  identifyBlob, encodeFrostRound1, decodeFrostRound1, decodeFrostRound2, getSessionIdPrefix,
} from './dkg';
import { encodeFrostSignR1, decodeFrostSignR1, encodeFrostSignR2, decodeFrostSignR2 } from './frost-sign';
import { toHex } from './hex';

test('DKG through the blob codec yields one consistent group key', () => {
  const { publicKeyPackages, keyPackages } = runDkg(2, 3);
  const keys = publicKeyPackages.map(p => toHex(p.untweakedVerifyingKey));
  assert.equal(new Set(keys).size, 1);
  assert.equal(new Set(publicKeyPackages.map(p => toHex(p.verifyingKey))).size, 1);
  assert.deepEqual(keyPackages.map(k => k.identifier), [1n, 2n, 3n]);
});

test('VaultKey conversion round-trips', () => {
  const { publicKeyPackages } = runDkg(2, 3);
  const v = toVaultKey(publicKeyPackages[0]!);
  assert.deepEqual(Object.keys(v.verifyingShares), ['1', '2', '3']);
  assert.deepEqual(toVaultKey(fromVaultKey(v)), v);
});

test('session config envelope round-trips and rejects garbage', () => {
  const sid = crypto.getRandomValues(new Uint8Array(32));
  const blob = encodeSessionConfig(3, 5, 'signet', sid);
  assert.deepEqual(decodeSessionConfig(blob), { t: 3, n: 5, network: 'signet', sid: toHex(sid) });
  assert.deepEqual(identifyBlob(blob), { type: 'session', from: 0, to: -1, sid: getSessionIdPrefix(sid) });
  assert.equal(decodeSessionConfig('nonsense'), null);
  assert.equal(identifyBlob(btoa('{"v":1}')), null);
  assert.equal(decodeFrostRound2(blob), null);
});

test('verify step: all N parties sign the transcript message and each verifies under its own key', () => {
  const { sessionId, keyPackages, publicKeyPackages } = runDkg(2, 3);
  const messages = publicKeyPackages.map(p => toHex(dkgVerifyMessage(sessionId, 'testnet4', p)));
  assert.equal(new Set(messages).size, 1);
  const msg = dkgVerifyMessage(sessionId, 'testnet4', publicKeyPackages[0]!);

  // Round 1 and 2 via the signing blob codec, as over the relay
  const r1 = keyPackages.map(k => signRound1(k, rng));
  const commitments = r1.map((r, p) => decodeFrostSignR1(encodeFrostSignR1(p, [r.commitments], sessionId))!.commitments[0]!);
  const shares: SignatureShare[] = keyPackages.map((k, p) => {
    const share = signRound2(k, r1[p]!.nonces, msg, commitments, { tweaked: true });
    return decodeFrostSignR2(encodeFrostSignR2(p, [share], sessionId))!.shares[0]!;
  });
  for (const pkp of publicKeyPackages) {
    const sig = signAggregate(shares, msg, commitments, pkp, { tweaked: true });
    assert.ok(verifySignature(sig, msg, pkp.verifyingKey));
  }

  // A party with a different view computes a different message
  assert.notEqual(toHex(dkgVerifyMessage(sessionId, 'mainnet', publicKeyPackages[0]!)), messages[0]);
});

test('verify step names a party that sends a bad signature share', () => {
  const { sessionId, keyPackages, publicKeyPackages } = runDkg(2, 3);
  const msg = dkgVerifyMessage(sessionId, 'signet', publicKeyPackages[0]!);
  const r1 = keyPackages.map(k => signRound1(k, rng));
  const commitments = r1.map(r => r.commitments);
  const shares = keyPackages.map((k, p) => signRound2(k, r1[p]!.nonces, msg, commitments, { tweaked: true }));
  const tampered = shares.map((s, p) => (p === 1 ? { ...s, share: s.share + 1n } : s));
  assert.throws(() => signAggregate(tampered, msg, commitments, publicKeyPackages[0]!, { tweaked: true }), /2/);
});

test('round-1 decoder rejects a blob whose sender does not match its payload', () => {
  const sid = crypto.getRandomValues(new Uint8Array(32));
  const blob = encodeFrostRound1({ identifier: 1n, commitment: [new Uint8Array(33), new Uint8Array(33)], proofOfKnowledge: { R: new Uint8Array(33), z: 5n } }, sid);
  assert.equal(decodeFrostRound1(blob)?.identifier, 1n);
  const env = JSON.parse(atob(blob));
  env.from = 1;
  assert.equal(decodeFrostRound1(btoa(JSON.stringify(env))), null);
});
