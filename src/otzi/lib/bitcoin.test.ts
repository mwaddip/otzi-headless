import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signRound1, signRound2, signAggregate } from '@mwaddip/frots';
import { runDkg, rng } from './dkg.fixture';
import { toVaultKey } from './dkg';
import { analyzeProposal, vaultPayment, formatBtc, explorerTxUrl, isValidAddress, parseAmountSats, RBF_SEQUENCE } from './bitcoin';
import type { SendProposal, VaultKey } from './vault-types';

const NET = 'testnet4' as const;
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const TXID_A = '1f'.repeat(32);
const TXID_B = 'a0' + '0b'.repeat(31);

function makeProposal(vault: VaultKey, opts: { sequence?: number; lockTime?: number; prevoutScript?: string; extraOut?: string } = {}): SendProposal {
  const pay = vaultPayment(vault, NET);
  const tx = new btc.Transaction({ version: 2, lockTime: opts.lockTime ?? 0 });
  tx.addInput({ txid: TXID_A, index: 3, sequence: opts.sequence ?? RBF_SEQUENCE });
  tx.addInput({ txid: TXID_B, index: 0, sequence: RBF_SEQUENCE });
  tx.addOutputAddress(DEST, 70_000n, btc.TEST_NETWORK);
  tx.addOutput({ script: pay.script, amount: 29_000n });
  if (opts.extraOut) tx.addOutputAddress(opts.extraOut, 1_000n, btc.TEST_NETWORK);
  const script = opts.prevoutScript ?? hex.encode(pay.script);
  return {
    network: NET,
    tx: hex.encode(tx.unsignedTx),
    prevouts: [
      { txid: TXID_A, vout: 3, amount: 60_000, script },
      { txid: TXID_B, vout: 0, amount: 40_000, script: hex.encode(pay.script) },
    ],
  };
}

test('analyzeProposal shows recipients, change and fee, then FROST signatures finalize a valid transaction', () => {
  const { keyPackages, publicKeyPackages } = runDkg(2, 3);
  const vault = toVaultKey(publicKeyPackages[0]!);
  const proposal = makeProposal(vault);
  const a = analyzeProposal(proposal, vault, NET);

  assert.deepEqual(a.outputs, [
    { address: DEST, amount: 70_000, isChange: false },
    { address: vaultPayment(vault, NET).address, amount: 29_000, isChange: true },
  ]);
  assert.equal(a.totalIn, 100_000);
  assert.equal(a.fee, 1_000);
  assert.equal(a.sighashes.length, 2);

  // Two of three parties sign each sighash
  const signers = [keyPackages[0]!, keyPackages[2]!];
  const tx = btc.Transaction.fromRaw(hex.decode(proposal.tx));
  a.sighashes.forEach((s, i) => {
    const msg = hex.decode(s.hash);
    const r1 = signers.map(k => signRound1(k, rng));
    const commitments = r1.map(r => r.commitments);
    const shares = signers.map((k, j) => signRound2(k, r1[j]!.nonces, msg, commitments, { tweaked: true }));
    const sig = signAggregate(shares, msg, commitments, publicKeyPackages[1]!, { tweaked: true });
    assert.ok(schnorr.verify(sig, msg, vaultPayment(vault, NET).outputKey));
    tx.updateInput(i, { finalScriptWitness: [sig] }, true);
  });
  assert.equal(tx.vsize, a.vsize);
  assert.equal(tx.id, a.txid);
});

test('analyzeProposal refuses what the vault must not sign', () => {
  const { publicKeyPackages } = runDkg(2, 2);
  const vault = toVaultKey(publicKeyPackages[0]!);
  const other = toVaultKey(runDkg(2, 2).publicKeyPackages[0]!);
  const good = makeProposal(vault);

  assert.throws(() => analyzeProposal({ ...good, network: 'mainnet' }, vault, NET), /Proposal is for mainnet/);
  assert.throws(() => analyzeProposal(good, other, NET), /does not spend a coin of this vault/);
  assert.throws(() => analyzeProposal(makeProposal(vault, { prevoutScript: hex.encode(vaultPayment(other, NET).script) }), vault, NET), /Input 0 does not spend a coin of this vault/);
  assert.throws(() => analyzeProposal(makeProposal(vault, { sequence: 0 }), vault, NET), /sequence/);
  assert.throws(() => analyzeProposal(makeProposal(vault, { lockTime: 900_000 }), vault, NET), /lock time/);
  assert.throws(() => analyzeProposal({ ...good, prevouts: good.prevouts.slice(0, 1) }, vault, NET), /Input count/);
  assert.throws(() => analyzeProposal({ ...good, prevouts: [good.prevouts[1]!, good.prevouts[0]!] }, vault, NET), /does not spend the listed coin/);
  assert.throws(() => analyzeProposal({ ...good, prevouts: good.prevouts.map(p => ({ ...p, amount: 100 })) }, vault, NET), /Outputs exceed inputs/);
  assert.throws(() => analyzeProposal({ ...good, prevouts: [{ ...good.prevouts[0]!, txid: 'zz' }, good.prevouts[1]!] }, vault, NET), /Malformed/);
});

test('extra outputs to third parties are listed, not hidden', () => {
  const { publicKeyPackages } = runDkg(2, 2);
  const vault = toVaultKey(publicKeyPackages[0]!);
  const thief = btc.p2wpkh(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'), btc.TEST_NETWORK).address!;
  const a = analyzeProposal(makeProposal(vault, { extraOut: thief }), vault, NET);
  assert.equal(a.outputs.length, 3);
  assert.deepEqual(a.outputs[2], { address: thief, amount: 1_000, isChange: false });
});

test('formatting and explorer links', () => {
  assert.equal(formatBtc(0), '0.00000000');
  assert.equal(formatBtc(123_456_789), '1.23456789');
  assert.equal(formatBtc(-5), '-0.00000005');
  assert.equal(explorerTxUrl('https://mempool.space/testnet4/api', 'ab'), 'https://mempool.space/testnet4/tx/ab');
  assert.equal(parseAmountSats('0.1', 'btc'), 10_000_000);
  assert.equal(parseAmountSats('1.23456789', 'btc'), 123_456_789);
  assert.equal(parseAmountSats('.5', 'mbtc'), 50_000);
  assert.equal(parseAmountSats('12', 'sats'), 12);
  assert.ok(Number.isNaN(parseAmountSats('0.123456789', 'btc')));
  assert.ok(Number.isNaN(parseAmountSats('1.5', 'sats')));
  assert.ok(Number.isNaN(parseAmountSats('', 'btc')));
  assert.ok(Number.isNaN(parseAmountSats('1e5', 'sats')));
  assert.ok(isValidAddress(DEST, 'signet'));
  assert.ok(!isValidAddress(DEST, 'mainnet'));
});
