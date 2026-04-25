/**
 * Phase 4d — testnet end-to-end verification for otzi-headless broadcast modules.
 *
 * Usage:
 *   source ~/projects/sharedenv/opnet-testnet.env
 *   npx tsx scripts/testnet-e2e.ts
 *
 * Phases (current):
 *   A. Init ECC + load env + connect to testnet provider; print deployer BTC
 *      and BHTT balances.
 *
 * Extension phases (added incrementally once earlier ones work):
 *   B. In-process combined DKG → derive FROST vault P2TR.
 *   C. Dry-run FROST sign + broadcastBtcTx BIP340 verify — proves the tweaked
 *      vs untweaked verify-key convention in our port.
 *   D. Seed vault with BTC + BHTT from deployer.
 *   E. BTC ceremony: vault → deployer BTC return, full DKG-derived FROST.
 *   F. OPNet ceremony: vault → deployer BHTT return via captureOpnetSighashes.
 */

import {
  toXOnly, payments, networks,
  Transaction, address as btcAddress, tapTweakHash,
} from '@btc-vision/bitcoin';
// IMPORTANT: do NOT call `initEccLib(createNobleBackend())` here.
// `@btc-vision/transaction`'s `src/ecc/backend.ts` auto-initializes a noble
// backend on import, and `MessageSigner` references that backend directly via
// `import { backend }`. Calling `initEccLib` again with a fresh
// `createNobleBackend()` registers a SECOND noble instance — `getEccLib()`
// returns the new one but `MessageSigner.backend` still points at the
// original. Any signSchnorr monkey-patch (e.g. `withFrostLegacySig`) lands on
// the wrong instance and silently does nothing.
import { Address } from '@btc-vision/transaction';
import { getContract, OP_20_ABI } from 'opnet';
import { verifySignature, type Rng } from '@mwaddip/frots';
import { schnorr } from '@noble/curves/secp256k1.js';
import { getProvider, getNetwork, generateWallet, generateMnemonic } from '../src/node/opnet-client';
import { createInMemoryRing } from '../src/core/in-memory-transport';
import { BlobStore } from '../src/core/blob-store';
import { BlobServer } from '../src/core/blob-server';
import { BlobPuller, type PullOpts } from '../src/core/blob-puller';
import { CeremonyRunner, type CombinedDkgSpec, type CombinedDkgResult, type SigningSpec, type FrostSigningSpec } from '../src/core/ceremony-runner';
import {
  parseCeremonyMessage,
  sessionIdFromAnnounceCombinedDkg,
  sighashesFromAnnounceFrost,
  makeDummyFrostKeylinkExtras,
} from '../src/core/ceremony-messages';
import type { PartyId } from '../src/core/types';
import type { Transport } from '../src/core/transport';
import type { DecryptedShare } from '../src/wire/share-crypto';
import { getKL } from '../src/wire/dkg';
import {
  selectBtcUtxos, prepareBtcTx, broadcastBtcTx, type BtcUtxo,
} from '../src/broadcast/btc-vault';
import { encodeCalldata } from '../src/broadcast/opnet-calldata';
import { captureOpnetSighashes } from '../src/broadcast/opnet-capture';
import { broadcastOpnetTx } from '../src/broadcast/opnet-broadcast';
import {
  buildCaptureInputsFromParams,
  type OpnetParamsKeyMat,
} from '../src/broadcast/opnet-params-reconstruct';
import { LeaderDispatcher } from '../src/daemon/leader';
import { AutoGate } from '../src/gate/factory';

const SYSTEM_RNG: Rng = { fillBytes(dest) { crypto.getRandomValues(dest); } };

const FAST_PULL_OPTS: PullOpts = {
  maxAttempts: 50,
  initialDelayMs: 2,
  maxDelayMs: 20,
  deadlineMs: 30_000,
};

const DKG_PULL_OPTS: PullOpts = {
  maxAttempts: 200,
  initialDelayMs: 5,
  maxDelayMs: 100,
  deadlineMs: 180_000,
};

interface Env {
  deployerMnemonic: string;
  deployerP2tr: string;
  /** Bech32 contract address e.g. opt1...; used directly by `getContract`. */
  bhttContractBech32: string;
}

function readEnv(): Env {
  const req = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var: ${name}. Did you \`source ~/projects/sharedenv/opnet-testnet.env\`?`);
    return v;
  };
  return {
    deployerMnemonic: req('OPNET_DEPLOYER_MNEMONIC'),
    deployerP2tr: req('OPNET_DEPLOYER_P2TR'),
    bhttContractBech32: req('OPNET_PAYMENT_TOKEN'),
  };
}

function hex(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('hex');
}

async function phaseA(env: Env): Promise<void> {
  console.log('\n=== PHASE A — connectivity + balances ===\n');

  const network = getNetwork('testnet');
  const provider = getProvider('testnet');
  console.log('Provider URL:', 'https://testnet.opnet.org');

  // BTC balance — sum of UTXOs on the deployer's P2TR.
  const utxos = await provider.utxoManager.getUTXOs({ address: env.deployerP2tr });
  const totalBtcSats = utxos.reduce((a: bigint, u: { value: bigint }) => a + u.value, 0n);
  console.log(`Deployer P2TR ${env.deployerP2tr}`);
  console.log(`  UTXOs: ${utxos.length}`);
  console.log(`  Total BTC: ${totalBtcSats} sats (${Number(totalBtcSats) / 1e8} BTC)`);

  // Generate deployer wallet — used both for the address and the BTC keys.
  const { wallet, mnemonic } = generateWallet(env.deployerMnemonic, 'testnet');
  try {
    console.log(`Deployer keypair publicKey: ${hex(wallet.keypair.publicKey)}`);
    console.log(`Deployer x-only:            ${hex(toXOnly(wallet.keypair.publicKey as never))}`);
    console.log(`Deployer Address (wallet):  ${wallet.address}`);

    // BHTT balance — read via OPNet SDK against the BHTT token contract.
    const contract = getContract(env.bhttContractBech32, OP_20_ABI, provider, network, wallet.address);
    const balCall = await (contract as unknown as Record<string, (arg: unknown) => Promise<{
      revert?: string;
      properties: { balance: bigint };
    }>>).balanceOf(wallet.address);
    if (balCall.revert) {
      throw new Error(`BHTT balanceOf reverted: ${balCall.revert}`);
    }
    console.log(`Deployer BHTT balance:      ${balCall.properties.balance}`);
  } finally {
    mnemonic.zeroize();
    wallet.zeroize();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — in-process combined DKG
// ─────────────────────────────────────────────────────────────────────────────

interface NodeCtx {
  transport: Transport;
  store: BlobStore;
  server: BlobServer;
  puller: BlobPuller;
  runner: CeremonyRunner;
}

function buildRing(peers: PartyId[]): { ctx: Map<PartyId, NodeCtx>; close: () => void } {
  const ring = createInMemoryRing(peers);
  const ctx = new Map<PartyId, NodeCtx>();
  for (const id of peers) {
    const transport = ring.get(id)!;
    const store = new BlobStore();
    const server = new BlobServer(transport, store);
    const puller = new BlobPuller(transport, store);
    const runner = new CeremonyRunner(transport, store, puller);
    ctx.set(id, { transport, store, server, puller, runner });
  }
  return { ctx, close: () => { for (const c of ctx.values()) c.server.close(); } };
}

function orchestrateCombinedDkgParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
): Promise<CombinedDkgResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;
      if (msg.kind === 'announce-combined-dkg') {
        void from;
        const sessionId = sessionIdFromAnnounceCombinedDkg(msg);
        const spec: CombinedDkgSpec = {
          ceremonyId: msg.ceremonyId,
          threshold: msg.threshold,
          parties: msg.parties,
          level: msg.level,
          rng: SYSTEM_RNG,
          network: 'testnet',
        };
        ctx.runner.participateInCombinedDkg(spec, sessionId, DKG_PULL_OPTS).then(
          (r) => {
            if (settled) return;
            settled = true;
            off();
            resolve(r);
          },
          (err) => {
            if (settled) return;
            settled = true;
            off();
            reject(err);
          },
        );
      }
    });
  });
}

interface DkgBundle {
  results: CombinedDkgResult[];  // indexed by partyId 0..2
  ctx: Map<PartyId, NodeCtx>;
  close: () => void;
  vaultP2tr: string;
  vaultAddress: Address;                // for OPNet calls
  mldsaPubKeyHex: string;
  tweakedSec1: Uint8Array;              // 33B frostAggregateKey
  untweakedSec1: Uint8Array;            // 33B frostUntweakedAggregateKey
  tweakedXOnly: Uint8Array;
  untweakedXOnly: Uint8Array;
  frostLegacySig: Uint8Array;           // BIP340 sig over keyLinkHash, tweaked=true
  /** Pre-wrapped DecryptedShare form per party — needed by our ML-DSA runner. */
  mldsaShares: DecryptedShare[];
}

async function phaseB(): Promise<DkgBundle> {
  console.log('\n=== PHASE B — in-process combined DKG (3 peers, t=2, key-link inline) ===\n');
  const { ctx, close } = buildRing([0, 1, 2]);
  const baseId = 'testnet-e2e-dkg';

  const p1 = orchestrateCombinedDkgParticipant(ctx.get(1)!, baseId);
  const p2 = orchestrateCombinedDkgParticipant(ctx.get(2)!, baseId);
  const t0 = Date.now();
  const initResult = await ctx.get(0)!.runner.runCombinedDkg(
    { ceremonyId: baseId, threshold: 2, parties: 3, level: 44, rng: SYSTEM_RNG, network: 'testnet' },
    DKG_PULL_OPTS,
  );
  const [r1, r2] = await Promise.all([p1, p2]);
  const elapsed = Date.now() - t0;
  const results = [initResult, r1, r2];

  console.log(`DKG (incl. key-link) completed in ${elapsed}ms`);
  console.log(`  ML-DSA pubkey (len ${initResult.mldsa.publicKey.length}): ${hex(initResult.mldsa.publicKey).slice(0, 32)}…`);
  console.log(`  FROST verifyingKey (tweaked):    ${hex(initResult.frost.publicKeyPackage.verifyingKey)}`);
  console.log(`  FROST untweakedVerifyingKey:     ${hex(initResult.frost.publicKeyPackage.untweakedVerifyingKey)}`);

  const tweakedSec1 = initResult.frost.publicKeyPackage.verifyingKey;
  const untweakedSec1 = initResult.frost.publicKeyPackage.untweakedVerifyingKey;
  const untweakedXOnly = toXOnly(Buffer.from(untweakedSec1) as never);
  const tweakedXOnly = toXOnly(Buffer.from(tweakedSec1) as never);

  const p2trAddr = payments.p2tr({
    internalPubkey: untweakedXOnly as never,
    network: networks.opnetTestnet,
  }).address!;
  console.log(`  Vault P2TR:                      ${p2trAddr}`);

  // Also construct the vault's OPNet Address (ML-DSA pubkey hex + legacy tweaked pubkey hex).
  const mldsaPubKeyHex = hex(initResult.mldsa.publicKey);
  const vaultAddress = Address.fromString(mldsaPubKeyHex, hex(tweakedSec1));
  console.log(`  Vault Address (OPNet):           ${vaultAddress}`);

  // key-link FROST sig is produced inline as part of `runCombinedDkg` (all peers
  // run the n-of-n aggregate locally). Just read it off the result.
  if (!initResult.frostLegacySig) throw new Error('phaseB: expected frostLegacySig on combined DKG result');
  const frostLegacySig = initResult.frostLegacySig;
  console.log(`  frostLegacySig: ${hex(frostLegacySig).slice(0, 32)}…`);

  // Wrap ML-DSA shares into DecryptedShare form for signAsLeader / participateInSigning.
  const { K, L } = getKL(44);
  const mldsaShares: DecryptedShare[] = results.map((r) => ({
    publicKey: mldsaPubKeyHex,
    partyId: r.mldsa.share.id,
    threshold: 2,
    parties: 3,
    level: 44,
    shareBytes: new Uint8Array(0),
    keyShare: r.mldsa.share,
    K,
    L,
  }));

  return {
    results,
    ctx,
    close,
    vaultP2tr: p2trAddr,
    vaultAddress,
    mldsaPubKeyHex,
    tweakedSec1,
    untweakedSec1,
    tweakedXOnly,
    untweakedXOnly,
    frostLegacySig,
    mldsaShares,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase C — dry-run FROST sign + BIP340 verify convention check
// ─────────────────────────────────────────────────────────────────────────────

function orchestrateFrostParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  results: CombinedDkgResult[],
  partyId: PartyId,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const off = ctx.transport.onBroadcast((from, bytes) => {
      void from;
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;
      if (msg.kind === 'announce-frost') {
        const sighashes = sighashesFromAnnounceFrost(msg);
        ctx.runner.participateInFrostSigning(
          {
            ceremonyId: msg.ceremonyId,
            sighashes,
            signers: msg.signers,
            keyPackage: results[partyId]!.frost.keyPackage,
            publicKeyPackage: results[partyId]!.frost.publicKeyPackage,
            rng: SYSTEM_RNG,
          },
          FAST_PULL_OPTS,
        ).then(
          () => { if (!settled) { settled = true; off(); resolve(); } },
          (err) => { if (!settled) { settled = true; off(); reject(err); } },
        );
      }
    });
  });
}

async function phaseC(dkg: DkgBundle): Promise<void> {
  console.log('\n=== PHASE C — dry-run FROST sign + BIP340 convention ===\n');
  const { ctx, close } = buildRing([0, 1, 2]);
  try {
    const baseId = 'testnet-e2e-dryrun';
    const signers: PartyId[] = [0, 1];

    // A dummy 32-byte "sighash" (not tied to any real tx).
    const dummyHash = new Uint8Array(32);
    crypto.getRandomValues(dummyHash);

    const participant = orchestrateFrostParticipant(ctx.get(1)!, baseId, dkg.results, 1);
    const sigs = await ctx.get(0)!.runner.signFrostAsLeader(
      {
        ceremonyId: baseId,
        sighashes: [{ hash: dummyHash, tweaked: true }],
        signers,
        keyPackage: dkg.results[0]!.frost.keyPackage,
        publicKeyPackage: dkg.results[0]!.frost.publicKeyPackage,
        rng: SYSTEM_RNG,
      },
      FAST_PULL_OPTS,
      makeDummyFrostKeylinkExtras(),
    );
    await ctx.get(0)!.runner.sendFrostSigningDoneSignoff(baseId, sigs);
    await participant;

    const sig = sigs[0]!;
    console.log(`FROST sig (tweaked=true) ${hex(sig).slice(0, 32)}…`);

    const pkg = dkg.results[0]!.frost.publicKeyPackage;
    const okUnderTweaked = verifySignature(sig, dummyHash, pkg.verifyingKey);
    const okUnderUntweaked = verifySignature(sig, dummyHash, pkg.untweakedVerifyingKey);
    console.log(`  verifySignature(..., verifyingKey)         = ${okUnderTweaked}`);
    console.log(`  verifySignature(..., untweakedVerifyingKey)= ${okUnderUntweaked}`);

    // Now match what broadcastBtcTx does: schnorr.verify against toXOnly of the
    // supplied frostTweakedPubKey (= verifyingKey).
    const verifyUnderTweakedXOnly = schnorr.verify(sig, dummyHash, dkg.tweakedXOnly);
    const verifyUnderUntweakedXOnly = schnorr.verify(sig, dummyHash, dkg.untweakedXOnly);
    console.log(`  schnorr.verify(..., tweakedXOnly)   = ${verifyUnderTweakedXOnly}`);
    console.log(`  schnorr.verify(..., untweakedXOnly) = ${verifyUnderUntweakedXOnly}`);

    if (!okUnderTweaked || !verifyUnderTweakedXOnly) {
      throw new Error('FROST tweaked=true sig did NOT verify under tweaked key — bug in verify convention');
    }
    if (okUnderUntweaked || verifyUnderUntweakedXOnly) {
      throw new Error('FROST tweaked=true sig unexpectedly verified under untweaked key — crypto invariant broken');
    }
    console.log('✓ Convention confirmed: broadcastBtcTx must verify under frostTweakedPubKey');
  } finally {
    close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase D — seed vault with BTC + BHTT from deployer
// ─────────────────────────────────────────────────────────────────────────────

async function seedBtcToVault(env: Env, vaultP2tr: string, amountSats: bigint): Promise<string> {
  const { wallet, mnemonic } = generateWallet(env.deployerMnemonic, 'testnet');
  try {
    const provider = getProvider('testnet');
    const network = networks.opnetTestnet;
    const utxos = (await provider.utxoManager.getUTXOs({ address: env.deployerP2tr })) as BtcUtxo[];
    const { selected, fee, change } = selectBtcUtxos(utxos, amountSats, 5);

    const internalXOnly = toXOnly(wallet.keypair.publicKey);
    const p2trOutput = payments.p2tr({ internalPubkey: internalXOnly as never, network }).output!;

    const tx = new Transaction();
    tx.version = 2;
    for (const utxo of selected) {
      const txidBuf = Buffer.from(utxo.transactionId.replace(/^0x/, ''), 'hex').reverse();
      tx.addInput(txidBuf as never, utxo.outputIndex);
    }
    tx.addOutput(btcAddress.toOutputScript(vaultP2tr, network) as never, amountSats as never);
    if (change > 0n) {
      tx.addOutput(btcAddress.toOutputScript(env.deployerP2tr, network) as never, change as never);
    }

    const prevoutScripts = selected.map(() => p2trOutput);
    const prevoutValues = selected.map(u => u.value as never);

    const tweak = tapTweakHash(internalXOnly, undefined);
    const tweakedKeypair = wallet.keypair.tweak(tweak);

    for (let i = 0; i < selected.length; i++) {
      const h = tx.hashForWitnessV1(i, prevoutScripts, prevoutValues, 0x00);
      const sig = await tweakedKeypair.signSchnorr!(h as never);
      tx.setWitness(i, [Buffer.from(sig)]);
    }

    const rawTx = tx.toHex();
    const result = await provider.sendRawTransaction(rawTx, false);
    if (!result.success) throw new Error(`Seed BTC broadcast failed: ${result.error ?? 'unknown'}`);
    console.log(`  BTC seed fee=${fee} change=${change} txid=${result.result ?? tx.getId()}`);
    return result.result ?? tx.getId();
  } finally {
    mnemonic.zeroize();
    wallet.zeroize();
  }
}

async function seedBhttToVault(env: Env, vaultAddress: Address, amount: bigint): Promise<string> {
  const { wallet, mnemonic } = generateWallet(env.deployerMnemonic, 'testnet');
  try {
    const provider = getProvider('testnet');
    const network = networks.opnetTestnet;
    const contract = getContract(env.bhttContractBech32, OP_20_ABI, provider, network, wallet.address);
    const simulation = await (contract as unknown as {
      transfer: (to: unknown, amount: bigint) => Promise<{
        revert?: string;
        sendTransaction: (p: unknown) => Promise<{ transactionId: string }>;
      }>;
    }).transfer(vaultAddress, amount);
    if (simulation.revert) throw new Error(`BHTT transfer simulation reverted: ${simulation.revert}`);
    const tx = await simulation.sendTransaction({
      signer: wallet.keypair,
      mldsaSigner: wallet.mldsaKeypair,
      refundTo: wallet.p2tr,
      maximumAllowedSatToSpend: 100000n,
      feeRate: 10,
      priorityFee: 1000n,
      network,
    });
    console.log(`  BHTT seed txid: ${tx.transactionId}`);
    return tx.transactionId;
  } finally {
    mnemonic.zeroize();
    wallet.zeroize();
  }
}

async function waitForVaultFunds(vaultP2tr: string, vaultAddress: Address, bhttContract: string, expectedBhtt: bigint, timeoutMs = 1_200_000): Promise<void> {
  const provider = getProvider('testnet');
  const network = getNetwork('testnet');
  const deadline = Date.now() + timeoutMs;
  console.log(`  Polling vault until funded (≤ ${timeoutMs / 1000}s)...`);

  while (Date.now() < deadline) {
    const utxos = await provider.utxoManager.getUTXOs({ address: vaultP2tr });
    const btcSats = utxos.reduce((a: bigint, u: { value: bigint }) => a + u.value, 0n);

    const bhttContractObj = getContract(bhttContract, OP_20_ABI, provider, network, vaultAddress);
    const balCall = await (bhttContractObj as unknown as Record<string, (arg: unknown) => Promise<{
      revert?: string;
      properties: { balance: bigint };
    }>>).balanceOf(vaultAddress);
    const bhttBal = balCall.revert ? 0n : balCall.properties.balance;

    console.log(`    vault: ${utxos.length} UTXOs (${btcSats} sats), BHTT=${bhttBal}`);
    if (btcSats > 0n && bhttBal >= expectedBhtt) return;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  throw new Error('Vault funding timeout');
}

async function phaseD(env: Env, dkg: DkgBundle): Promise<void> {
  console.log('\n=== PHASE D — seed vault (BTC + BHTT) ===\n');
  const BHTT_SEED = 1_000_000n; // 0.01 BHTT (8 decimals)
  const BTC_SEED = 200_000n;    // 200k sats — enough for both ceremonies + fees
  console.log(`Seeding ${BTC_SEED} sats BTC → vault...`);
  await seedBtcToVault(env, dkg.vaultP2tr, BTC_SEED);
  console.log(`Seeding ${BHTT_SEED} BHTT → vault...`);
  await seedBhttToVault(env, dkg.vaultAddress, BHTT_SEED);
  console.log('Waiting for both to land...');
  await waitForVaultFunds(dkg.vaultP2tr, dkg.vaultAddress, env.bhttContractBech32, BHTT_SEED);
  console.log('✓ Vault funded.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase E — BTC ceremony (vault → deployer)
// ─────────────────────────────────────────────────────────────────────────────

async function runFrostCeremony(
  dkg: DkgBundle,
  ceremonyIdPrefix: string,
  sighashes: Array<{ hash: Uint8Array; tweaked: boolean }>,
): Promise<Uint8Array[]> {
  const baseId = `${ceremonyIdPrefix}-${Date.now()}`;
  const part1 = orchestrateFrostParticipant(dkg.ctx.get(1)!, baseId, dkg.results, 1);
  // Participants here bypass the Orchestrator (direct `participateInFrostSigning`),
  // so announce extras are parsed but not verified. Dummy keylink satisfies the wire.
  const sigs = await dkg.ctx.get(0)!.runner.signFrostAsLeader(
    {
      ceremonyId: baseId,
      sighashes,
      signers: [0, 1],
      keyPackage: dkg.results[0]!.frost.keyPackage,
      publicKeyPackage: dkg.results[0]!.frost.publicKeyPackage,
      rng: SYSTEM_RNG,
    },
    FAST_PULL_OPTS,
    makeDummyFrostKeylinkExtras(),
  );
  await dkg.ctx.get(0)!.runner.sendFrostSigningDoneSignoff(baseId, sigs);
  await part1;
  return sigs;
}

async function phaseE(env: Env, dkg: DkgBundle): Promise<void> {
  console.log('\n=== PHASE E — BTC ceremony (vault → deployer) ===\n');
  const AMOUNT = 40_000n;
  console.log(`Preparing BTC tx: vault → deployer ${AMOUNT} sats...`);
  const prepared = await prepareBtcTx({
    to: env.deployerP2tr,
    amount: Number(AMOUNT),
    feeRate: 5,
    network: 'testnet',
    frostP2tr: dkg.vaultP2tr,
    frostUntweakedPubKey: dkg.untweakedSec1,
  });
  console.log(`  ${prepared.sighashes.length} sighash(es), est fee=${prepared.estimatedFee}, change=${prepared.changeAmount}`);

  console.log('Running FROST ceremony over sighashes (tweaked=true)...');
  const sigs = await runFrostCeremony(
    dkg,
    'btc-ceremony',
    prepared.sighashes.map(s => ({ hash: Buffer.from(s.hash, 'hex'), tweaked: true })),
  );

  const frostSignatures = prepared.sighashes.map((s, i) => ({
    index: s.index,
    signature: hex(sigs[i]!),
  }));
  console.log('Broadcasting BTC tx...');
  const result = await broadcastBtcTx({
    captureContext: prepared.captureContext,
    frostSignatures,
    frostTweakedPubKey: dkg.tweakedSec1,
    network: 'testnet',
  });
  console.log(`✓ BTC ceremony broadcast: txid=${result.txid}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase F — OPNet ceremony (BHTT.transfer back to deployer)
// ─────────────────────────────────────────────────────────────────────────────

function orchestrateMldsaParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  share: DecryptedShare,
): Promise<void> {
  return new Promise((resolve) => {
    const inflight: Promise<void>[] = [];
    let leaderId: PartyId | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      off();
      Promise.allSettled(inflight).then(() => resolve());
    };
    const off = ctx.transport.onBroadcast((from, bytes) => {
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;
      if (msg.kind === 'announce') {
        if (leaderId === null) leaderId = from;
        else if (leaderId !== from) return;
        const decoded = new Uint8Array(msg.messageHex.length / 2);
        for (let i = 0; i < decoded.length; i++) {
          decoded[i] = parseInt(msg.messageHex.slice(i * 2, i * 2 + 2), 16);
        }
        const spec: SigningSpec = {
          ceremonyId: msg.ceremonyId,
          message: decoded,
          signers: msg.signers,
          share,
        };
        inflight.push(ctx.runner.participateInSigning(spec, FAST_PULL_OPTS).catch(() => {}));
      } else if (msg.kind === 'signoff-done' || msg.kind === 'signoff-aborted') {
        if (leaderId !== null && leaderId !== from) return;
        settle();
      }
    });
  });
}

async function runMldsaThresholdSign(
  dkg: DkgBundle,
  message: Uint8Array,
): Promise<Uint8Array> {
  const baseId = `mldsa-sign-${Date.now()}`;
  const part1 = orchestrateMldsaParticipant(dkg.ctx.get(1)!, baseId, dkg.mldsaShares[1]!);
  const sig = await dkg.ctx.get(0)!.runner.signAsLeader(
    {
      ceremonyId: baseId,
      message,
      signers: [0, 1],
      share: dkg.mldsaShares[0]!,
    },
    FAST_PULL_OPTS,
  );
  await dkg.ctx.get(0)!.runner.sendSigningDoneSignoff(baseId, sig);
  await part1;
  return sig;
}

/**
 * Participant-side verify for `opnet-params`: listens for the leader's
 * announce, reconstructs identical capture inputs from the wire + local
 * key material, re-runs the capture, and compares sighashes. Throws on
 * any mismatch — that's the determinism invariant. On match, calls
 * `participateInFrostSigning`.
 *
 * Deliberately uses a DIFFERENT `sdkWalletMnemonic` than the leader to
 * exercise the invariant that capture output depends only on the shared
 * inputs (mnemonic only seeds a wallet slot the SDK never signs with
 * — publicKey is overridden, multiSignPsbt is monkey-patched).
 */
async function orchestrateOpnetParamsParticipant(
  ctx: NodeCtx,
  baseCeremonyId: string,
  partyId: PartyId,
  dkg: DkgBundle,
): Promise<void> {
  const keyMat: OpnetParamsKeyMat = {
    mldsaPubKey: dkg.results[partyId]!.mldsa.publicKey,
    frostTweakedPubKey: dkg.tweakedSec1,
    frostUntweakedPubKey: dkg.untweakedSec1,
    frostLegacySig: dkg.frostLegacySig,
    network: 'testnet',
    // Fresh mnemonic — different from the leader's. Capture must still be deterministic.
    sdkWalletMnemonic: generateMnemonic(),
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const off = ctx.transport.onBroadcast((from, bytes) => {
      void from;
      const msg = parseCeremonyMessage(bytes);
      if (!msg || msg.baseCeremonyId !== baseCeremonyId) return;
      if (msg.kind !== 'announce-frost' || msg.protocol !== 'opnet-params') return;

      console.log(`  participant ${partyId}: announce received, re-running capture to verify...`);
      const cT = Date.now();
      const inputs = buildCaptureInputsFromParams(msg.opnetParams, keyMat);
      captureOpnetSighashes(inputs).then((captured) => {
        if (settled) return;
        console.log(`  participant ${partyId}: capture completed in ${Date.now() - cT}ms — ${captured.sighashes.length} sighash(es)`);
        if (captured.sighashes.length !== msg.sighashes.length) {
          throw new Error(`participant ${partyId}: sighash count mismatch (ours=${captured.sighashes.length}, leader=${msg.sighashes.length})`);
        }
        for (let i = 0; i < captured.sighashes.length; i++) {
          const ours = captured.sighashes[i]!.hash.toLowerCase();
          const leader = msg.sighashes[i]!.hashHex.toLowerCase();
          if (ours !== leader) {
            throw new Error(`participant ${partyId}: sighash[${i}] MISMATCH (determinism broken)\n  leader=${leader}\n  ours=  ${ours}`);
          }
        }
        console.log(`  participant ${partyId}: all sighashes matched leader ✓ — signing`);
        const sighashes = sighashesFromAnnounceFrost(msg);
        return ctx.runner.participateInFrostSigning({
          ceremonyId: msg.ceremonyId,
          sighashes,
          signers: msg.signers,
          keyPackage: dkg.results[partyId]!.frost.keyPackage,
          publicKeyPackage: dkg.results[partyId]!.frost.publicKeyPackage,
          rng: SYSTEM_RNG,
        }, FAST_PULL_OPTS);
      }).then(
        () => { if (!settled) { settled = true; off(); resolve(); } },
        (err) => { if (!settled) { settled = true; off(); reject(err); } },
      );
    });
  });
}

async function phaseF(env: Env, dkg: DkgBundle): Promise<void> {
  console.log('\n=== PHASE F — OPNet ceremony via /sign protocol=opnet-params ===\n');
  const AMOUNT = 500_000n;
  const deployerAddressHex = (() => {
    const { wallet, mnemonic } = generateWallet(env.deployerMnemonic, 'testnet');
    try { return wallet.address.toString(); } finally { mnemonic.zeroize(); wallet.zeroize(); }
  })();
  console.log(`Transfer spec: ${AMOUNT} BHTT → ${deployerAddressHex}`);

  // Operator-side: encode calldata + messageHash, run ML-DSA threshold.
  const { messageHash } = encodeCalldata(
    'transfer',
    [deployerAddressHex, AMOUNT.toString()],
    ['address', 'u256'],
  );
  console.log(`  messageHash: ${hex(messageHash)}`);
  console.log('Running ML-DSA threshold ceremony (pre-computed by operator)...');
  const t0 = Date.now();
  const mldsaSig = await runMldsaThresholdSign(dkg, messageHash);
  console.log(`  ML-DSA sig (${mldsaSig.length}B) in ${Date.now() - t0}ms`);

  // Build LeaderDispatcher on peer 0 — the production sign path.
  const leader = new LeaderDispatcher({
    runner: dkg.ctx.get(0)!.runner,
    gate: new AutoGate(),
    node: { id: 'peer-0', partyId: 0 },
    peersById: new Map([[0, 'peer-0'], [1, 'peer-1'], [2, 'peer-2']]),
    share: dkg.mldsaShares[0]!,
    frostKeyPackage: dkg.results[0]!.frost.keyPackage,
    frostPublicKeyPackage: dkg.results[0]!.frost.publicKeyPackage,
    rng: SYSTEM_RNG,
    pullOpts: FAST_PULL_OPTS,
    network: 'testnet',
    frostLegacySig: dkg.frostLegacySig,
    sdkWalletMnemonic: generateMnemonic(),
    opnetProvider: getProvider('testnet'),
    logger: {
      debug: () => {},
      info: (m, x) => console.log(`  leader: ${m}`, x ?? ''),
      warn: (m, x) => console.warn(`  leader WARN: ${m}`, x ?? ''),
      error: (m, x) => console.error(`  leader ERR: ${m}`, x ?? ''),
    },
  });

  const baseId = `opnet-params-${Date.now()}`;
  const part1 = orchestrateOpnetParamsParticipant(dkg.ctx.get(1)!, baseId, 1, dkg);

  console.log('Invoking leader.sign (protocol=opnet-params)...');
  const result = await leader.sign({
    ceremonyId: baseId,
    scheme: 'frost',
    protocol: 'opnet-params',
    signers: [0, 1],
    contractAddress: env.bhttContractBech32,
    method: 'transfer',
    params: [deployerAddressHex, AMOUNT.toString()],
    paramTypes: ['address', 'u256'],
    mldsaThresholdSignature: mldsaSig,
    hints: { amountTokenAtomic: AMOUNT.toString() },
  });
  await part1;

  if (result.scheme !== 'frost' || !result.transactionId) {
    throw new Error(`phaseF: unexpected leader result shape: ${JSON.stringify({ scheme: result.scheme, hasTxid: 'transactionId' in result })}`);
  }
  console.log(`✓ OPNet ceremony broadcast via opnet-params: txid=${result.transactionId}`);
}

async function main(): Promise<void> {
  const env = readEnv();
  await phaseA(env);
  const dkg = await phaseB();
  try {
    await phaseC(dkg);
    if (!process.env.SKIP_TX) {
      await phaseD(env, dkg);
      // OPNet ceremony first — uses a confirmed seed UTXO so fee-estimation
      // has a clean state. BTC ceremony runs after and consumes whatever
      // BTC is left in the vault.
      await phaseF(env, dkg);
      await phaseE(env, dkg);
    } else {
      console.log('\n(phase D/E/F skipped — set SKIP_TX=0 to run against testnet)');
    }
  } finally {
    dkg.close();
  }
  console.log('\n✓ All phases complete.\n');
}

main().catch(err => {
  console.error('\n✗ FAILED:', err);
  process.exit(1);
});
