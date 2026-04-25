/**
 * Leader-side ceremony dispatcher.
 *
 * Counterpart to `Orchestrator` (which is participant-side). Called by the
 * trigger layer when this daemon is the initiating node: builds a
 * `CeremonySpec` with real intent, evaluates the gate, invokes the runner's
 * leader method, broadcasts the signoff on success, and surfaces the result.
 *
 * A gate `reject` or `pending` decision throws `GateRejection` (the ceremony
 * never even announces — no side effect on peers). Other failures propagate
 * from the runner (which handles its own signoff-aborted broadcast).
 */

import type { DKGResult } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { KeyPackage, PublicKeyPackage, Rng } from '@mwaddip/frots';
import {
  buildBtcTxFromParams,
  extractBtcSighashes,
  type BtcSighashInput,
  type BtcUtxo,
  type DecodedBtcOutput,
} from '../broadcast/btc-vault';
import { captureOpnetSighashes, type OpnetCaptureContext } from '../broadcast/opnet-capture';
import {
  deriveVaultP2tr,
  serializeOpnetParams,
} from '../broadcast/opnet-params-reconstruct';
import { broadcastOpnetTx } from '../broadcast/opnet-broadcast';
import type { ChallengeSolution } from '@btc-vision/transaction';
import type { UTXO as OpnetUtxo } from 'opnet';
import type { PullOpts } from '../core/blob-puller';
import type { CeremonyRunner, CombinedDkgResult } from '../core/ceremony-runner';
import type { NetworkName } from '../node/types';
import type { PartyId } from '../core/types';
import type { ApprovalGate, CeremonySpec, Decision } from '../gate/types';
import { NOOP_LOGGER, type DkgPersistenceSink, type Logger } from '../orchestrator/types';
import { toHex } from '../wire/hex';
import type { DecryptedShare } from '../wire/share-crypto';

export interface LeaderDeps {
  runner: CeremonyRunner;
  gate: ApprovalGate;
  node: { id: string; partyId: PartyId };
  peersById: ReadonlyMap<PartyId, string>;
  /**
   * Decrypted share for this party. Optional: a DKG-only daemon (no share
   * file at startup) leaves this undefined; signing methods then throw a
   * clear error before doing any side-effecting work.
   */
  share?: DecryptedShare;
  frostKeyPackage?: KeyPackage;
  frostPublicKeyPackage?: PublicKeyPackage;
  rng: Rng;
  pullOpts: PullOpts;
  /**
   * When set, combined DKG runs the key-link FROST sign phase (producing
   * `frostLegacySig` on every peer) before persistence. Undefined (e.g.
   * regtest daemons) skips key-link — OPNet contract calls then won't work
   * against the resulting vault, but other ceremonies are unaffected.
   */
  network?: NetworkName;
  /**
   * V3 key-link FROST sig for `opnet-params` capture — replayed by the
   * OPNet SDK during contract-call construction against a V3 vault. Read
   * from the share envelope by `config-merge`. Required when the leader
   * handles `LeaderSignOpnetParamsRequest`; absence produces a clear error.
   */
  frostLegacySig?: Uint8Array;
  /**
   * Throwaway mnemonic for the SDK's wallet-keypair slot during capture
   * (never signs; multiSignPsbt is monkey-patched). Daemon generates one at
   * startup and reuses. Required for `opnet-params` leader flow.
   */
  sdkWalletMnemonic?: string;
  /**
   * OPNet JSON-RPC provider for UTXO + challenge fetches during the
   * `opnet-params` flow. Tests inject a stub; production wires the real
   * `JSONRpcProvider` via `daemon.ts`. The type is intentionally loose —
   * the SDK's full `JSONRpcProvider` type leaks many internal fields we
   * don't need here.
   */
  opnetProvider?: {
    utxoManager: { getUTXOs: (args: { address: string }) => Promise<unknown[]> };
    getChallenge: () => Promise<unknown>;
  };
  /**
   * CSPRNG used to fill the 32B rnd-bytes seed the leader asserts on-wire
   * for the deterministic `opnet-params` capture. Defaults to WebCrypto when
   * not supplied. Tests inject a deterministic fill for reproducibility.
   */
  opnetSeedFill?: (buf: Uint8Array) => void;
  /**
   * Persists this party's combined-DKG result after the protocol completes.
   * Errors propagate to the caller (HTTP 500) — leader stops short of
   * returning success when its own share didn't make it to disk.
   */
  persistDkgShare?: DkgPersistenceSink;
  logger?: Logger;
}

export interface LeaderDkgRequest {
  ceremonyId: string;
  threshold: number;
  parties: number;
}

export interface LeaderMldsaLikeDkgRequest extends LeaderDkgRequest {
  level: number;
}

/**
 * Unified `/sign` request, discriminated by (scheme, protocol).
 *
 * **BTC (construction params).** Operator sends the parameters needed to
 * deterministically build the unsigned vault-transfer tx: destination,
 * amount, fee rate, self P2TR + pubkey, and an asserted UTXO snapshot.
 * Every daemon (leader + participants) builds the same tx locally and
 * signs its own sighashes — participants verify by matching their
 * rebuild against the leader's asserted sighashes. If the leader lies
 * about UTXOs, Bitcoin consensus rejects at broadcast (BIP-341 commits
 * to real prevout scripts + values) — worst case is wasted ceremony.
 *
 * **OPNet (raw-tx + hints).** Operator-side tooling uses the OPNet SDK to
 * build the full funding + interaction tx bundle and POSTs raw bytes +
 * prevout info. Daemon extracts BIP-341 sighashes from the bytes;
 * participants re-extract and compare. Gate policy runs against
 * operator-supplied `hints` (contractAddress, method, amountTokenAtomic)
 * which are advisory — matches Ötzi's federation-trust posture.
 * Construction-params for OPNet is deferred (needs SDK-level UTXO
 * fetcher control to be deterministic).
 *
 * **ML-DSA (raw message).** Operator POSTs opaque bytes to sign.
 */
interface LeaderSignRequestBase {
  ceremonyId: string;
  signers: PartyId[];
}

export interface LeaderSignBtcRequest extends LeaderSignRequestBase {
  scheme: 'frost';
  protocol: 'btc';
  btc: {
    to: string;
    amountSat: bigint;
    feeRate: number;
    network: NetworkName;
    frostP2tr: string;
    /** 33B SEC1 compressed untweaked FROST aggregate pubkey. */
    frostUntweakedPubKey: Uint8Array;
    /** UTXOs the operator asserts the vault holds. */
    utxos: readonly BtcUtxo[];
  };
}

export interface LeaderSignOpnetRequest extends LeaderSignRequestBase {
  scheme: 'frost';
  protocol: 'opnet';
  unsignedTx: Uint8Array;
  inputs: readonly BtcSighashInput[];
  /** Advisory hints for policy gate (unverified). */
  hints?: {
    contractAddress?: string;
    method?: string;
    amountTokenAtomic?: string;
  };
}

/**
 * OPNet construction-params flow. Operator POSTs contract + method + params
 * + pre-computed ML-DSA threshold sig. Daemon fetches UTXOs + challenge,
 * generates the rnd-bytes seed, runs capture, asserts everything on-wire,
 * runs FROST ceremony, broadcasts. Participants rebuild the exact capture
 * and verify sighashes match — gate policy then evaluates structurally-
 * verified `contractAddress` + `method`.
 */
export interface LeaderSignOpnetParamsRequest extends LeaderSignRequestBase {
  scheme: 'frost';
  protocol: 'opnet-params';
  contractAddress: string;
  method: string;
  params: readonly unknown[];
  paramTypes?: readonly ('address' | 'u256' | 'bytes')[];
  /** ML-DSA threshold sig over `sha256(calldata)`. Operator pre-computes. */
  mldsaThresholdSignature: Uint8Array;
  feeRate?: number;
  priorityFee?: bigint;
  maximumAllowedSatToSpend?: bigint;
  /** Advisory hints for policy gate (amountTokenAtomic remains advisory). */
  hints?: {
    amountTokenAtomic?: string;
  };
}

export interface LeaderSignMldsaRequest extends LeaderSignRequestBase {
  scheme: 'mldsa';
  protocol: 'raw';
  /** Opaque bytes to sign. */
  message: Uint8Array;
}

export type LeaderSignRequest =
  | LeaderSignBtcRequest
  | LeaderSignOpnetRequest
  | LeaderSignOpnetParamsRequest
  | LeaderSignMldsaRequest;

export type LeaderSignResult =
  | { scheme: 'mldsa'; signature: Uint8Array }
  | {
      scheme: 'frost';
      signatures: Uint8Array[];
      /** Populated iff the daemon broadcast the tx internally (OPNet construction-params flow). */
      transactionId?: string;
    };

type SigningOperation = 'btc-transfer' | 'opnet-call' | 'generic';

function operationFromSignReq(req: LeaderSignRequest): SigningOperation {
  if (req.scheme === 'mldsa') return 'generic';
  if (req.protocol === 'btc') return 'btc-transfer';
  if (req.protocol === 'opnet') return 'opnet-call';
  if (req.protocol === 'opnet-params') return 'opnet-call';
  return 'generic';
}

export class GateRejection extends Error {
  constructor(
    public readonly ceremonyId: string,
    public readonly decision: Exclude<Decision, 'approve'>,
  ) {
    super(`leader: gate ${decision} for ceremony '${ceremonyId}'`);
    this.name = 'GateRejection';
  }
}

export class LeaderDispatcher {
  private readonly log: Logger;
  constructor(private readonly deps: LeaderDeps) {
    this.log = deps.logger ?? NOOP_LOGGER;
  }

  async runCombinedDkg(req: LeaderMldsaLikeDkgRequest): Promise<CombinedDkgResult> {
    await this.requireApprove(this.dkgSpec('combined', req));
    this.log.info('leader: runCombinedDkg', { ceremonyId: req.ceremonyId });
    const result = await this.deps.runner.runCombinedDkg(
      {
        ceremonyId: req.ceremonyId,
        threshold: req.threshold,
        parties: req.parties,
        level: req.level,
        rng: this.deps.rng,
        ...(this.deps.network ? { network: this.deps.network } : {}),
      },
      this.deps.pullOpts,
    );
    if (this.deps.persistDkgShare) {
      await this.deps.persistDkgShare(result, {
        threshold: req.threshold,
        parties: req.parties,
        level: req.level,
      });
    }
    return result;
  }

  async runMldsaDkg(req: LeaderMldsaLikeDkgRequest): Promise<DKGResult> {
    await this.requireApprove(this.dkgSpec('mldsa', req));
    this.log.info('leader: runMldsaDkg', { ceremonyId: req.ceremonyId });
    return this.deps.runner.runMldsaDkg(
      { ceremonyId: req.ceremonyId, threshold: req.threshold, parties: req.parties, level: req.level },
      this.deps.pullOpts,
    );
  }

  async runFrostDkg(req: LeaderDkgRequest): Promise<{
    keyPackage: KeyPackage;
    publicKeyPackage: PublicKeyPackage;
  }> {
    await this.requireApprove(this.dkgSpec('frost', req));
    this.log.info('leader: runFrostDkg', { ceremonyId: req.ceremonyId });
    return this.deps.runner.runFrostDkg(
      { ceremonyId: req.ceremonyId, threshold: req.threshold, parties: req.parties, rng: this.deps.rng },
      this.deps.pullOpts,
    );
  }

  /**
   * Unified `/sign` entry. BTC: build tx from construction params, extract
   * sighashes, run ceremony. OPNet: extract sighashes from supplied raw tx,
   * run ceremony. ML-DSA raw: sign the supplied message bytes.
   */
  async sign(req: LeaderSignRequest): Promise<LeaderSignResult> {
    this.assertInSigners(req.signers);
    const operation = operationFromSignReq(req);
    this.log.info('leader: sign', {
      ceremonyId: req.ceremonyId,
      scheme: req.scheme,
      protocol: req.protocol,
    });

    if (req.scheme === 'mldsa') {
      await this.requireApprove(this.signingSpecMldsa(req, operation));
      if (!this.deps.share)
        throw new Error(
          'leader: sign scheme=mldsa requires a share — daemon started in DKG-only mode',
        );
      const sig = await this.deps.runner.signAsLeader(
        {
          ceremonyId: req.ceremonyId,
          message: req.message,
          signers: req.signers,
          share: this.deps.share,
        },
        this.deps.pullOpts,
      );
      await this.deps.runner.sendSigningDoneSignoff(req.ceremonyId, sig);
      return { scheme: 'mldsa', signature: sig };
    }

    // scheme === 'frost'
    if (!this.deps.frostKeyPackage || !this.deps.frostPublicKeyPackage)
      throw new Error('leader: FROST signing requested but no FROST key material loaded');

    if (req.protocol === 'btc') {
      const built = buildBtcTxFromParams({
        to: req.btc.to,
        amountSat: req.btc.amountSat,
        feeRate: req.btc.feeRate,
        network: req.btc.network,
        frostP2tr: req.btc.frostP2tr,
        frostUntweakedPubKey: req.btc.frostUntweakedPubKey,
        utxos: req.btc.utxos,
      });
      await this.requireApprove(this.signingSpecBtc(req, built.outputs));

      const sigs = await this.deps.runner.signFrostAsLeader(
        {
          ceremonyId: req.ceremonyId,
          sighashes: built.sighashes.map((s) => ({ hash: s.hash, tweaked: s.tweaked })),
          signers: req.signers,
          keyPackage: this.deps.frostKeyPackage,
          publicKeyPackage: this.deps.frostPublicKeyPackage,
          rng: this.deps.rng,
        },
        this.deps.pullOpts,
        {
          protocol: 'btc',
          btcParams: {
            to: req.btc.to,
            amountSat: req.btc.amountSat.toString(),
            feeRate: req.btc.feeRate,
            network: req.btc.network,
            frostP2tr: req.btc.frostP2tr,
            frostUntweakedPubKeyHex: toHex(req.btc.frostUntweakedPubKey),
            utxos: req.btc.utxos.map((u) => ({
              transactionId: u.transactionId,
              outputIndex: u.outputIndex,
              valueSat: u.value.toString(),
            })),
          },
        },
      );
      await this.deps.runner.sendFrostSigningDoneSignoff(req.ceremonyId, sigs);
      return { scheme: 'frost', signatures: sigs };
    }

    if (req.protocol === 'opnet-params') {
      return this.signOpnetParams(req);
    }

    // protocol === 'opnet'
    if (req.inputs.length === 0)
      throw new Error(`leader: scheme='frost' protocol='opnet' requires non-empty 'inputs' array`);

    await this.requireApprove(this.signingSpecOpnet(req));

    const unsignedTxHex = toHex(req.unsignedTx);
    const extracted = extractBtcSighashes(unsignedTxHex, req.inputs);

    const sigs = await this.deps.runner.signFrostAsLeader(
      {
        ceremonyId: req.ceremonyId,
        sighashes: extracted.map((s) => ({ hash: s.hash, tweaked: s.tweaked })),
        signers: req.signers,
        keyPackage: this.deps.frostKeyPackage,
        publicKeyPackage: this.deps.frostPublicKeyPackage,
        rng: this.deps.rng,
      },
      this.deps.pullOpts,
      {
        protocol: 'opnet',
        unsignedTxHex,
        inputs: req.inputs,
        ...(req.hints ? { hints: { ...req.hints } } : {}),
      },
    );
    await this.deps.runner.sendFrostSigningDoneSignoff(req.ceremonyId, sigs);
    return { scheme: 'frost', signatures: sigs };
  }

  /**
   * OPNet construction-params leader flow: fetches UTXOs + challenge from
   * provider, generates the rnd-bytes seed, runs capture, announces with
   * the full wire blob, runs the FROST ceremony, then broadcasts the tx.
   * Returns the txid alongside signatures because the daemon owns the
   * captureContext — operator has no way to broadcast externally.
   */
  private async signOpnetParams(req: LeaderSignOpnetParamsRequest): Promise<LeaderSignResult> {
    const { share, frostKeyPackage, frostPublicKeyPackage, frostLegacySig, sdkWalletMnemonic, network, opnetProvider } = this.deps;
    if (!share) throw new Error("leader: protocol='opnet-params' requires share");
    if (!frostKeyPackage || !frostPublicKeyPackage) throw new Error("leader: protocol='opnet-params' requires FROST key material");
    if (!frostLegacySig) throw new Error("leader: protocol='opnet-params' requires frostLegacySig (V3 share)");
    if (!sdkWalletMnemonic) throw new Error("leader: protocol='opnet-params' requires sdkWalletMnemonic");
    if (!network) throw new Error("leader: protocol='opnet-params' requires network");
    if (!opnetProvider) throw new Error("leader: protocol='opnet-params' requires opnetProvider");

    const mldsaPubKey = new Uint8Array(Buffer.from(share.publicKey, 'hex'));
    const frostTweakedPubKey = frostPublicKeyPackage.verifyingKey;
    const frostUntweakedPubKey = frostPublicKeyPackage.untweakedVerifyingKey;
    const refundAddress = deriveVaultP2tr(frostUntweakedPubKey, network);

    // Fetch UTXOs + challenge before seed generation so the async I/O fault
    // lane runs first; seed + subsequent capture are local-only.
    const rawUtxos = await opnetProvider.utxoManager.getUTXOs({ address: refundAddress });
    const utxos = rawUtxos as OpnetUtxo[];
    const challenge = (await opnetProvider.getChallenge()) as ChallengeSolution;

    const rndBytesSeed = new Uint8Array(32);
    const fill = this.deps.opnetSeedFill ?? ((buf: Uint8Array) => {
      if (typeof globalThis.crypto?.getRandomValues !== 'function') {
        throw new Error('leader: no globalThis.crypto.getRandomValues — provide opnetSeedFill');
      }
      globalThis.crypto.getRandomValues(buf);
    });
    fill(rndBytesSeed);

    const feeRate = req.feeRate ?? 10;
    const priorityFee = req.priorityFee ?? 1000n;
    const maximumAllowedSatToSpend = req.maximumAllowedSatToSpend ?? 100000n;

    const captured = await captureOpnetSighashes({
      contractAddress: req.contractAddress,
      method: req.method,
      params: [...req.params],
      ...(req.paramTypes ? { paramTypes: [...req.paramTypes] } : {}),
      network,
      mldsaThresholdSignature: req.mldsaThresholdSignature,
      mldsaPubKey,
      frostTweakedPubKey,
      frostUntweakedPubKey,
      frostLegacySig,
      refundAddress,
      sdkWalletMnemonic,
      feeRate,
      priorityFee,
      maximumAllowedSatToSpend,
      utxos,
      challenge,
      rndBytesSeed,
    });

    await this.requireApprove(this.signingSpecOpnetParams(req));

    const announceExtras = {
      protocol: 'opnet-params' as const,
      opnetParams: serializeOpnetParams({
        contractAddress: req.contractAddress,
        method: req.method,
        params: req.params,
        ...(req.paramTypes ? { paramTypes: req.paramTypes } : {}),
        refundAddress,
        feeRate,
        priorityFee,
        maximumAllowedSatToSpend,
        randomBytesSeed: rndBytesSeed,
        mldsaThresholdSignature: req.mldsaThresholdSignature,
        utxos,
        challenge,
        ...(req.hints ? { hints: { ...req.hints } } : {}),
      }),
    };

    const sigs = await this.deps.runner.signFrostAsLeader(
      {
        ceremonyId: req.ceremonyId,
        sighashes: captured.sighashes.map((s) => ({
          hash: new Uint8Array(Buffer.from(s.hash, 'hex')),
          tweaked: s.type === 'key-path',
        })),
        signers: req.signers,
        keyPackage: frostKeyPackage,
        publicKeyPackage: frostPublicKeyPackage,
        rng: this.deps.rng,
      },
      this.deps.pullOpts,
      announceExtras,
    );
    await this.deps.runner.sendFrostSigningDoneSignoff(req.ceremonyId, sigs);

    const broadcast = await broadcastOpnetTx({
      captureContext: captured.captureContext,
      frostSignatures: captured.sighashes.map((s, i) => ({
        hash: s.hash,
        signature: toHex(sigs[i]!),
      })),
      frostTweakedPubKey,
      frostUntweakedPubKey,
      network,
    });
    return { scheme: 'frost', signatures: sigs, transactionId: broadcast.transactionId };
  }

  private signingSpecMldsa(
    req: LeaderSignMldsaRequest,
    operation: SigningOperation,
  ): CeremonySpec {
    return {
      kind: 'signing',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      operation,
    };
  }

  private signingSpecBtc(
    req: LeaderSignBtcRequest,
    outputs: readonly DecodedBtcOutput[],
  ): CeremonySpec {
    // Filter out self (change back to the vault's own P2TR). Policy rules
    // evaluate over the external-facing outputs only — paying yourself is
    // not a policy-relevant action.
    const nonSelf = outputs.filter((o) => o.address !== req.btc.frostP2tr);
    const amount = nonSelf.reduce((sum, o) => sum + o.amountSat, 0n);
    const destination = nonSelf.find((o) => o.address !== null)?.address ?? undefined;
    return {
      kind: 'signing',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      operation: 'btc-transfer',
      amount,
      ...(destination !== undefined ? { destination } : {}),
      outputs: nonSelf.map((o) => ({ address: o.address, amountSat: o.amountSat })),
    };
  }

  private signingSpecOpnet(
    req: LeaderSignOpnetRequest,
  ): CeremonySpec {
    const hints = req.hints ?? {};
    const amount = hints.amountTokenAtomic !== undefined ? BigInt(hints.amountTokenAtomic) : undefined;
    return {
      kind: 'signing',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      operation: 'opnet-call',
      ...(hints.contractAddress !== undefined ? { destination: hints.contractAddress } : {}),
      ...(hints.method !== undefined ? { method: hints.method } : {}),
      ...(amount !== undefined ? { amount } : {}),
    };
  }

  private signingSpecOpnetParams(
    req: LeaderSignOpnetParamsRequest,
  ): CeremonySpec {
    const amount = req.hints?.amountTokenAtomic !== undefined
      ? BigInt(req.hints.amountTokenAtomic) : undefined;
    return {
      kind: 'signing',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      operation: 'opnet-call',
      // Verified structurally: leader runs capture from these exact inputs,
      // participants rebuild + match. Policy rules `allowed_contracts` +
      // `method_allowlist` evaluate trusted data.
      destination: req.contractAddress,
      method: req.method,
      ...(amount !== undefined ? { amount } : {}),
    };
  }

  // ─────────────────────────────────────────────────────────────────────

  private dkgSpec(
    protocol: 'mldsa' | 'frost' | 'combined',
    req: LeaderDkgRequest,
  ): CeremonySpec {
    return {
      kind: 'dkg',
      ceremonyId: req.ceremonyId,
      leader: this.deps.node.id,
      role: 'leader',
      protocol,
      threshold: req.threshold,
      parties: req.parties,
      peerIds: [...this.deps.peersById.values()],
    };
  }

  private async requireApprove(spec: CeremonySpec): Promise<void> {
    let decision: Decision;
    try {
      decision = await this.deps.gate.approve(spec);
    } catch (err) {
      throw new Error(
        `leader: gate threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (decision !== 'approve') throw new GateRejection(spec.ceremonyId, decision);
  }

  private assertInSigners(signers: PartyId[]): void {
    if (!signers.includes(this.deps.node.partyId))
      throw new Error(
        `leader: self (partyId=${this.deps.node.partyId}) is not in signers [${signers.join(',')}]`,
      );
  }
}
