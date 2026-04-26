/**
 * Loads + merges the daemon TOML config with the Ötzi-compatible share file.
 *
 * Two startup modes:
 *  - **Share present** (normal operation). The file is read + decrypted; full
 *    cross-field invariants are enforced (partyId match, peers count alignment,
 *    contiguous partyIds spanning `[0, share.parties)`). Daemon can sign + DKG.
 *  - **Share missing** (first-time DKG / "DKG-only" mode). The configured path
 *    has no file (`ENOENT`); daemon comes up with `state.share = undefined`,
 *    can run DKG ceremonies, and persists the result to the configured path.
 *    Signing is rejected (LeaderDispatcher throws; orchestrator drops + logs).
 *    Operator restarts after DKG to enter signing-capable mode.
 *
 * Both modes require the share-password env var to be set so the daemon can
 * decrypt an existing share *or* encrypt a freshly-DKG'd one.
 */

import type { PublicKeyPackage } from '@mwaddip/frots';
import { readFile } from 'node:fs/promises';
import { loadDaemonConfig } from '../config/load';
import type { DaemonConfig } from '../config/types';
import type { PartyId } from '../core/types';
import type { DkgPersistenceSink } from '../orchestrator/types';
import { buildFrostPublicKeyPackage } from '../wire/frost-reconstruct';
import { decryptShareFile, type DecryptedShare, type ShareFile } from '../wire/share-crypto';
import { persistCombinedDkgShare } from './share-persistence';

export type ShareDecryptor = (file: ShareFile, password: string) => Promise<DecryptedShare>;

export interface LoadedDaemonState {
  config: DaemonConfig;
  /** Decrypted share. Undefined when the daemon is in DKG-only mode (no share file at startup). */
  share?: DecryptedShare;
  /** Derived from `share.frostKeyPackage` when present (see `buildFrostPublicKeyPackage`). */
  frostPublicKeyPackage?: PublicKeyPackage;
  /**
   * V3 share envelope carries `frostLegacySig` as an extra top-level hex
   * field (piggy-backed by `share-persistence.ts` — outside Ötzi's canonical
   * V3 byte format but tolerated). Extracted here from the raw share-file
   * JSON (not via `decryptShareFile`, which is one of the lifted Ötzi
   * byte-compat files). Consumed by `opnet-params` capture verification.
   */
  frostLegacySig?: Uint8Array;
  /** Includes self. Orchestrator + leader consume this directly. */
  peersById: ReadonlyMap<PartyId, string>;
  /** Pre-bound persistence sink. Present after `validateLoaded`; absent for `buildStateFromShare` / `buildStateNoShare`. */
  persistDkgShare?: DkgPersistenceSink;
  /**
   * Optional shared secret read from `/var/lib/otzi/bootstrap-secret` at
   * daemon startup. Used by phase 9c's control-plane wire opcode to verify
   * operator-typed HMAC. Wiped on first successful DKG completion.
   */
  bootstrapSecret?: string;
}

const BOOTSTRAP_SECRET_PATH = '/var/lib/otzi/bootstrap-secret';

async function loadBootstrapSecret(): Promise<string | undefined> {
  try {
    const raw = await readFile(BOOTSTRAP_SECRET_PATH, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
}

export interface LoadOptions {
  /** Override the share-decryption function (tests inject a pre-built `DecryptedShare`). */
  shareDecryptor?: ShareDecryptor;
  /** Env source for password resolution. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export async function loadAndValidate(
  configPath: string,
  options: LoadOptions = {},
): Promise<LoadedDaemonState> {
  const config = await loadDaemonConfig(configPath);
  return validateLoaded(config, options);
}

/** Variant that accepts an already-parsed `DaemonConfig` — useful for tests. */
export async function validateLoaded(
  config: DaemonConfig,
  options: LoadOptions = {},
): Promise<LoadedDaemonState> {
  const env = options.env ?? process.env;
  const password = env[config.share.passwordEnv];
  if (!password)
    throw new Error(
      `daemon: env var '${config.share.passwordEnv}' not set — must be set for both share decryption (when share file exists) and DKG-output encryption (when in DKG-only mode)`,
    );

  const bootstrapSecret = await loadBootstrapSecret();

  let shareText: string | undefined;
  try {
    shareText = await readFile(config.share.path, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) {
      // DKG-only mode: no share to decrypt; build state without share but
      // with a persist sink ready for the post-DKG write.
      const base = buildStateNoShare(config);
      const persistDkgShare = makePersistSink(config, password);
      return {
        ...base,
        persistDkgShare,
        ...(bootstrapSecret ? { bootstrapSecret } : {}),
      };
    }
    throw err;
  }

  let shareFile: ShareFile;
  try {
    shareFile = JSON.parse(shareText) as ShareFile;
  } catch (err) {
    throw new Error(
      `daemon: share file at '${config.share.path}' is not valid JSON: ${errMsg(err)}`,
    );
  }

  const decryptor = options.shareDecryptor ?? decryptShareFile;
  const share = await decryptor(shareFile, password);
  const base = buildStateFromShare(config, share);
  const frostLegacySig = extractFrostLegacySig(shareFile, config.share.path);
  const persistDkgShare = makePersistSink(config, password);
  return {
    ...base,
    ...(frostLegacySig ? { frostLegacySig } : {}),
    persistDkgShare,
    ...(bootstrapSecret ? { bootstrapSecret } : {}),
  };
}

function extractFrostLegacySig(shareFile: ShareFile, path: string): Uint8Array | undefined {
  const raw = (shareFile as ShareFile & { frostLegacySig?: unknown }).frostLegacySig;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]+$/.test(raw) || raw.length === 0) {
    throw new Error(`daemon: share file at '${path}' has invalid frostLegacySig (must be hex)`);
  }
  return new Uint8Array(Buffer.from(raw, 'hex'));
}

/**
 * Pure validation + peersById assembly from an already-decrypted share.
 * The file-read/decrypt path is skipped entirely — tests pass a share from
 * `dealerKeygen` or an in-memory DKG, production calls `validateLoaded` via
 * `loadAndValidate`.
 */
export function buildStateFromShare(
  config: DaemonConfig,
  share: DecryptedShare,
): LoadedDaemonState {
  validateAlignment(config, share);
  const peersById = buildPeersById(config);
  const frostPublicKeyPackage = share.frostKeyPackage
    ? buildFrostPublicKeyPackage(share.frostKeyPackage)
    : undefined;
  return { config, share, frostPublicKeyPackage, peersById };
}

/**
 * Build state for a daemon that has no share yet (first-time DKG flow).
 * No share-vs-config alignment check possible; only config-internal coherence
 * was already verified by the TOML parser.
 */
export function buildStateNoShare(config: DaemonConfig): LoadedDaemonState {
  const peersById = buildPeersById(config);
  return { config, peersById };
}

function buildPeersById(config: DaemonConfig): ReadonlyMap<PartyId, string> {
  const peersById = new Map<PartyId, string>();
  peersById.set(config.node.partyId, config.node.id);
  for (const p of config.peers) peersById.set(p.partyId, p.id);
  return peersById;
}

function makePersistSink(config: DaemonConfig, password: string): DkgPersistenceSink {
  return (result, meta) =>
    persistCombinedDkgShare({
      result,
      threshold: meta.threshold,
      parties: meta.parties,
      level: meta.level,
      path: config.share.path,
      password,
    });
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function validateAlignment(config: DaemonConfig, share: DecryptedShare): void {
  if (share.partyId !== config.node.partyId)
    throw new Error(
      `daemon: share.partyId (${share.partyId}) does not match config node.party_id (${config.node.partyId})`,
    );
  if (config.peers.length + 1 !== share.parties)
    throw new Error(
      `daemon: peers count + self (${config.peers.length + 1}) does not match share.parties (${share.parties})`,
    );

  const all = new Set<number>([config.node.partyId, ...config.peers.map((p) => p.partyId)]);
  for (let i = 0; i < share.parties; i++) {
    if (!all.has(i))
      throw new Error(
        `daemon: partyId ${i} missing from config — partyIds must span [0, ${share.parties}) exactly`,
      );
  }
  for (const pid of all) {
    if (pid < 0 || pid >= share.parties)
      throw new Error(
        `daemon: partyId ${pid} out of range for share.parties=${share.parties}`,
      );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
