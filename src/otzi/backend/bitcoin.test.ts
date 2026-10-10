import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  validateVaultKey, sameVaultKey, vaultPayment, buildSend, computeSighashes, finalizeSend,
  estimateVsize, InsufficientFundsError, RBF_SEQUENCE, outputScript,
} from './bitcoin.js';
import { makeTestVault } from './test-vault.fixture.js';

const NET = 'signet' as const;
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

function txid(seed: number): string {
  return Array.from({ length: 32 }, (_, i) => ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, '0')).join('');
}

test('validateVaultKey accepts a consistent key package', () => {
  const { vault } = makeTestVault(2, 3);
  const v = validateVaultKey(vault);
  assert.ok(sameVaultKey(v, vault));
  assert.equal(v.minSigners, 2);
});

test('validateVaultKey rejects inconsistent packages', () => {
  const { vault } = makeTestVault(3, 5);
  assert.throws(() => validateVaultKey({ ...vault, minSigners: 1 }), /minSigners/);
  assert.throws(() => validateVaultKey({ ...vault, verifyingKey: vault.untweakedVerifyingKey }), /tweak/);
  const { 5: _drop, ...four } = vault.verifyingShares;
  assert.throws(() => validateVaultKey({ ...vault, verifyingShares: four }), /identifiers/);
  const other = makeTestVault(3, 5).vault;
  assert.throws(
    () => validateVaultKey({ ...vault, untweakedVerifyingShares: { ...vault.untweakedVerifyingShares, '2': other.untweakedVerifyingShares['2']! } }),
    /public shares/,
  );
  assert.throws(() => validateVaultKey({ ...vault, untweakedVerifyingKey: '02' + 'ff'.repeat(32) }), /point/);
});

test('vault address is key-path P2TR of the internal key with the tweaked output key', () => {
  const { vault } = makeTestVault(2, 2);
  const pay = vaultPayment(vault, 'mainnet');
  assert.match(pay.address, /^bc1p/);
  assert.equal(hex.encode(pay.outputKey), vault.verifyingKey.slice(2));
  assert.match(vaultPayment(vault, 'testnet4').address, /^tb1p/);
});

test('buildSend selects coins largest-first and returns change to the vault', () => {
  const { vault } = makeTestVault(2, 3);
  const utxos = [{ txid: txid(1), vout: 0, value: 50_000 }, { txid: txid(2), vout: 1, value: 100_000 }, { txid: txid(3), vout: 2, value: 20_000 }];
  const send = buildSend({ utxos, vault, network: NET, to: DEST, amount: 120_000n, feeRate: 2 });

  assert.deepEqual(send.prevouts.map(p => p.amount), [100_000, 50_000]);
  const tx = btc.Transaction.fromRaw(hex.decode(send.tx));
  assert.equal(tx.version, 2);
  assert.equal(tx.lockTime, 0);
  for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, RBF_SEQUENCE);
  assert.equal(tx.getInput(0).txid && hex.encode(tx.getInput(0).txid!), txid(2));
  assert.equal(tx.outputsLength, 2);
  assert.equal(tx.getOutput(0).amount, 120_000n);
  assert.deepEqual(tx.getOutput(1).script, vaultPayment(vault, NET).script);
  assert.equal(150_000n, send.amount + send.fee + send.change);
  assert.equal(send.fee, BigInt(Math.ceil(send.vsize * 2)));
});

test('buildSend drops dust change into the fee', () => {
  const { vault } = makeTestVault(2, 2);
  const vsizeNoChange = estimateVsize(1, [outputScript(DEST, NET)]);
  const utxos = [{ txid: txid(4), vout: 0, value: 10_000 + vsizeNoChange + 100 }];
  const send = buildSend({ utxos, vault, network: NET, to: DEST, amount: 10_000n, feeRate: 1 });
  assert.equal(send.change, 0n);
  assert.equal(send.fee, BigInt(vsizeNoChange + 100));
  assert.equal(btc.Transaction.fromRaw(hex.decode(send.tx)).outputsLength, 1);
});

test('buildSend max spends everything with a single output', () => {
  const { vault } = makeTestVault(2, 2);
  const utxos = [{ txid: txid(5), vout: 0, value: 30_000 }, { txid: txid(6), vout: 3, value: 12_345 }];
  const send = buildSend({ utxos, vault, network: NET, to: DEST, amount: 'max', feeRate: 3 });
  assert.equal(send.change, 0n);
  assert.equal(send.amount + send.fee, 42_345n);
  assert.equal(btc.Transaction.fromRaw(hex.decode(send.tx)).outputsLength, 1);
});

test('buildSend reports insufficient funds', () => {
  const { vault } = makeTestVault(2, 2);
  assert.throws(
    () => buildSend({ utxos: [{ txid: txid(7), vout: 0, value: 5_000 }], vault, network: NET, to: DEST, amount: 5_000n, feeRate: 1 }),
    (e: unknown) => e instanceof InsufficientFundsError && e.available === 5_000n,
  );
  assert.throws(() => buildSend({ utxos: [], vault, network: NET, to: DEST, amount: 'max', feeRate: 1 }), InsufficientFundsError);
});

test('finalizeSend verifies signatures and produces a transaction of the estimated size', () => {
  const { vault, tweakedSecret } = makeTestVault(2, 3);
  const utxos = [{ txid: txid(8), vout: 0, value: 70_000 }, { txid: txid(9), vout: 5, value: 40_000 }];
  const send = buildSend({ utxos, vault, network: NET, to: DEST, amount: 100_000n, feeRate: 1.5 });
  const sighashes = computeSighashes(send.tx, send.prevouts);
  assert.equal(sighashes.length, 2);

  const signatures = sighashes.map((h, index) => ({ index, signature: hex.encode(schnorr.sign(h, tweakedSecret)) }));
  const outputKey = vaultPayment(vault, NET).outputKey;
  const signed = finalizeSend(send.tx, send.prevouts, signatures, outputKey);

  const final = btc.Transaction.fromRaw(hex.decode(signed.hex));
  assert.equal(final.vsize, send.vsize);
  assert.equal(signed.txid, btc.Transaction.fromRaw(hex.decode(send.tx)).id);
  assert.equal(final.getInput(1).finalScriptWitness?.[0]?.length, 64);

  // Wrong signer, wrong count, malformed signature
  const wrong = sighashes.map((h, index) => ({ index, signature: hex.encode(schnorr.sign(h, schnorr.utils.randomSecretKey())) }));
  assert.throws(() => finalizeSend(send.tx, send.prevouts, wrong, outputKey), /BIP340/);
  assert.throws(() => finalizeSend(send.tx, send.prevouts, signatures.slice(0, 1), outputKey), /Expected 2/);
  assert.throws(() => finalizeSend(send.tx, send.prevouts, [signatures[0]!, { index: 1, signature: 'zz' }], outputKey), /128 hex/);
  assert.throws(() => finalizeSend(send.tx, send.prevouts, [signatures[0]!, signatures[0]!], outputKey), /index/);
});

test('sighashes commit to prevout amounts', () => {
  const { vault } = makeTestVault(2, 2);
  const send = buildSend({ utxos: [{ txid: txid(10), vout: 0, value: 80_000 }], vault, network: NET, to: DEST, amount: 10_000n, feeRate: 1 });
  const honest = computeSighashes(send.tx, send.prevouts)[0]!;
  const lying = computeSighashes(send.tx, [{ ...send.prevouts[0]!, amount: 20_000 }])[0]!;
  assert.notDeepEqual(honest, lying);
});
