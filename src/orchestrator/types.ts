/**
 * Participant-side orchestrator types.
 *
 * The orchestrator listens on the transport for ceremony announces and
 * signoffs. For each new ceremony, it builds a `CeremonySpec`, asks the gate
 * for approval, and dispatches to the matching `CeremonyRunner.participate*`
 * method when approved. Outcomes are emitted via the `completed` event.
 *
 * Phase 5c ships the orchestrator shell + gate wiring. Announce payloads don't
 * yet carry high-level intent (amount/destination/method) — populated with
 * `operation: 'generic'` for signing. Phase 5d / a follow-up wire extension
 * will propagate trigger-side intent through the announce so participant-side
 * `PolicyGate` rules can evaluate against it. For 5c, operators wanting
 * participant-side enforcement should use `AutoGate` or accept that `PolicyGate`
 * rejects all generic signings (strict-by-default).
 */

import type { DKGResult } from '@btc-vision/post-quantum/threshold-ml-dsa.js';
import type { KeyPackage, PublicKeyPackage, Rng } from '@mwaddip/frots';
import type { PullOpts } from '../core/blob-puller';
import type { CeremonyRunner, CombinedDkgResult } from '../core/ceremony-runner';
import type { Transport } from '../core/transport';
import type { PartyId } from '../core/types';
import type { ControlPlane } from '../daemon/control-plane';
import type { ApprovalGate } from '../gate/types';
import type { NetworkName } from '../node/types';
import type { DecryptedShare } from '../wire/share-crypto';

export type OrchestratorCeremonyKind =
  | 'signing-mldsa'
  | 'signing-frost'
  | 'dkg-mldsa'
  | 'dkg-frost'
  | 'dkg-combined';

export type CeremonyOutcomeStatus = 'done' | 'aborted' | 'timeout' | 'rejected';

interface CeremonyOutcomeBase {
  baseCeremonyId: string;
  kind: OrchestratorCeremonyKind;
  status: CeremonyOutcomeStatus;
}

export interface SigningMldsaOutcome extends CeremonyOutcomeBase {
  kind: 'signing-mldsa';
  /** Hex-encoded signature — populated iff `status === 'done'`. */
  signatureHex?: string;
}

export interface SigningFrostOutcome extends CeremonyOutcomeBase {
  kind: 'signing-frost';
  /** Hex-encoded 64-byte BIP340 sigs, one per sighash — populated iff `status === 'done'`. */
  signaturesHex?: string[];
}

export interface DkgMldsaOutcome extends CeremonyOutcomeBase {
  kind: 'dkg-mldsa';
  /** DKG result — populated iff `status === 'done'`. Phase 5e persists the share. */
  result?: DKGResult;
}

export interface DkgFrostOutcome extends CeremonyOutcomeBase {
  kind: 'dkg-frost';
  keyPackage?: KeyPackage;
  publicKeyPackage?: PublicKeyPackage;
}

export interface DkgCombinedOutcome extends CeremonyOutcomeBase {
  kind: 'dkg-combined';
  result?: CombinedDkgResult;
}

export type CeremonyOutcome =
  | SigningMldsaOutcome
  | SigningFrostOutcome
  | DkgMldsaOutcome
  | DkgFrostOutcome
  | DkgCombinedOutcome;

/**
 * Pre-bound callback that writes a `CombinedDkgResult` to the configured
 * share file. Closure (built by `config-merge.validateLoaded`) captures the
 * destination path + share password, so leader/orchestrator don't have to
 * carry credentials. When undefined, persistence is skipped (test path via
 * `buildStateFromShare`).
 */
export type DkgPersistenceSink = (
  result: CombinedDkgResult,
  meta: { threshold: number; parties: number; level: number },
) => Promise<void>;

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface OrchestratorDeps {
  transport: Transport;
  runner: CeremonyRunner;
  gate: ApprovalGate;
  /** This daemon's identity (`node.id` + `partyId`). Must match `transport.partyId`. */
  node: { id: string; partyId: PartyId };
  /** Map of known peers (including self). Used to resolve `from` PartyId → node id for specs. */
  peersById: ReadonlyMap<PartyId, string>;
  /**
   * Decrypted share — supplies ML-DSA key material + partyId metadata.
   * Optional: a daemon started without a share (no share file at the configured
   * path) operates in DKG-only mode. ML-DSA signing announces are silently
   * dropped (logged at error level) until a share is loaded via restart.
   */
  share?: DecryptedShare;
  /** FROST key package for this party. Required when participating in FROST signing. */
  frostKeyPackage?: KeyPackage;
  /** Group FROST public material. Required when participating in FROST signing. */
  frostPublicKeyPackage?: PublicKeyPackage;
  /** CSPRNG for FROST participation (nonce generation in round 1). */
  rng: Rng;
  /** Pull options passed to participant methods. */
  pullOpts: PullOpts;
  /** Ceremony-wide safety-net deadlines (from `DaemonConfig.deadlines`). */
  ceremonyDeadlines: { signingMs: number; dkgMs: number };
  /**
   * Populated from `DaemonConfig.network.name` when the daemon is configured
   * for mainnet or testnet. Participant-side combined DKG includes the
   * key-link FROST sign phase iff this is set, mirroring the leader-side
   * behavior and producing `frostLegacySig` locally.
   */
  network?: NetworkName;
  /**
   * V3 key-link FROST sig produced during combined DKG — OPNet's SDK replays
   * it during contract-call construction (see `withFrostLegacySig`). Needed
   * by the participant-side capture when verifying an `opnet-params` announce;
   * without it, opnet-params announces silent-drop. Undefined on regtest
   * daemons (key-link phase skipped there).
   */
  frostLegacySig?: Uint8Array;
  /**
   * Throwaway mnemonic for the SDK's wallet-keypair slot during capture.
   * Never signs anything that reaches the chain (multiSignPsbt is
   * monkey-patched during capture). The daemon generates one at startup.
   * Without it, `opnet-params` announces silent-drop.
   */
  sdkWalletMnemonic?: string;
  /**
   * Persists this party's combined-DKG result after participation settles.
   * Errors are logged but do NOT abort the ceremony — DKG itself succeeded
   * in memory; persistence is best-effort on the participant side. Operator
   * monitors logs.
   */
  persistDkgShare?: DkgPersistenceSink;
  /**
   * Phase-9c control-plane sink. When set, the orchestrator routes incoming
   * `manifest-push` wire messages to it. Optional: tests / DKG-only daemons
   * may omit it; manifest-push messages then silent-drop.
   */
  controlPlane?: ControlPlane;
  logger?: Logger;
}
