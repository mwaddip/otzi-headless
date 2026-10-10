/**
 * Participant-side orchestrator types (facts/orchestrator.md, `types.ts`):
 * ceremony outcomes, the orchestrator's dependencies, and the logger contract
 * shared across the daemon.
 */

import type { Rng } from '@mwaddip/frots';
import type { CeremonyIo } from '../core/ceremony-io';
import type { ShareStager } from '../core/dkg-ceremony';
import type { PartyId } from '../core/types';
import type { ApprovalGate } from '../gate/types';
import type { DecryptedShare } from '../otzi/lib/share-file';
import type { AddressBookEntry, NetworkName } from '../otzi/lib/vault-types';

export type OutcomeStatus = 'done' | 'aborted' | 'timeout' | 'rejected' | 'invalid-signoff';

export interface CeremonyOutcome {
  ceremonyId: string;
  kind: 'signing' | 'dkg';
  status: OutcomeStatus;
  /** `done` (signing): the verified signatures from `signoff-done`, input order. */
  signaturesHex?: string[];
  /** `done` (DKG): the new vault address. */
  address?: string;
  /** `rejected`, `aborted`, `timeout`, `invalid-signoff`: why. */
  reason?: string;
}

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
  /** The daemon's ceremony I/O; `io.transport.partyId === node.partyId`. */
  io: CeremonyIo;
  gate: ApprovalGate;
  node: { id: string; partyId: PartyId };
  /** Every ring member's label, self included (`size` = ring size). */
  peersById: ReadonlyMap<PartyId, string>;
  /** The configured network. */
  network: NetworkName;
  /** The share loaded at startup; undefined on a node without a vault. */
  vault?: DecryptedShare;
  /** Whether a file exists at the share path (a `.pending` file does not count). */
  vaultExists: () => Promise<boolean>;
  /** A fresh stager for the share path. */
  createStager: () => ShareStager;
  rng: Rng;
  /** Ceremony deadlines; participant pulls run until them (facts/orchestrator.md). */
  ceremonyDeadlines: { signingMs: number; dkgMs: number };
  /** Blob retention after a ceremony ends here; default `BLOB_RETENTION_MS`. */
  blobRetentionMs?: { signing: number; dkg: number };
  /** This node's address-book entries, for output labels; a rejection means no labels. */
  addressBook?: () => Promise<AddressBookEntry[]>;
  logger?: Logger;
}
