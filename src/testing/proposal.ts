/**
 * Test helpers (facts/core.md, `src/testing/proposal.ts`): a real FROST vault
 * and unsigned send proposals against it. Never imported by runtime code.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { KeyPackage, PublicKeyPackage } from '@mwaddip/frots';
import { btcNetwork, RBF_SEQUENCE, vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { runDkg } from '../otzi/lib/dkg.fixture';
import type { NetworkName, SendProposal, VaultKey } from '../otzi/lib/vault-types';

export interface TestVault {
  keyPackages: KeyPackage[];
  publicKeyPackage: PublicKeyPackage;
  vaultKey: VaultKey;
}

/** A real t-of-n FROST DKG result; `keyPackages[i]` belongs to partyId `i`. */
export function testVault(t: number, n: number): TestVault {
  const { keyPackages, publicKeyPackages } = runDkg(t, n);
  // Every party's public package has the same content.
  const publicKeyPackage = publicKeyPackages[0]!;
  return { keyPackages, publicKeyPackage, vaultKey: toVaultKey(publicKeyPackage) };
}

export interface ProposalOptions {
  /** Inputs to spend; `script` overrides the prevout script (default: the vault script). */
  inputs?: Array<{ amount: number; script?: string }>;
  /** External outputs (default: one random p2wpkh output of 50 000 sats). */
  outputs?: Array<{ address: string; amount: number }>;
  /** Change back to the vault in sats (default 49 000; 0 omits the output). */
  change?: number;
}

/** A fresh, valid external address for `network`. */
function randomAddress(network: NetworkName): string {
  const pubkey = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
  return btc.p2wpkh(pubkey, btcNetwork(network)).address!;
}

/**
 * An unsigned send transaction with random prevout txids, every input
 * sequence `RBF_SEQUENCE` and lockTime 0. With the defaults,
 * `analyzeProposal(makeProposal(v, net), v, net)` succeeds.
 */
export function makeProposal(vaultKey: VaultKey, network: NetworkName, opts: ProposalOptions = {}): SendProposal {
  const vaultScript = vaultPayment(vaultKey, network).script;
  const inputs = opts.inputs ?? [{ amount: 100_000 }];
  const outputs = opts.outputs ?? [{ address: randomAddress(network), amount: 50_000 }];
  const change = opts.change ?? 49_000;

  const tx = new btc.Transaction({ version: 2, lockTime: 0 });
  const prevouts = inputs.map(input => {
    const txid = hex.encode(crypto.getRandomValues(new Uint8Array(32)));
    tx.addInput({ txid, index: 0, sequence: RBF_SEQUENCE });
    return { txid, vout: 0, amount: input.amount, script: input.script ?? hex.encode(vaultScript) };
  });
  for (const out of outputs) tx.addOutputAddress(out.address, BigInt(out.amount), btcNetwork(network));
  if (change > 0) tx.addOutput({ script: vaultScript, amount: BigInt(change) });

  return { network, tx: hex.encode(tx.unsignedTx), prevouts };
}
