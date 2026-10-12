/**
 * Daemon API request parsing and input rules (facts/daemon.md, `api.ts`;
 * spec §6.1).
 *
 * Shape and ring rules only: unknown top-level fields, ceremony ids, signer
 * sets and the proposal's shape. Whether the proposal spends this vault's
 * coins is `analyzeProposal`'s job, in `LeaderDispatcher.sign`.
 */

import { randomUUID } from 'node:crypto';
import { isCeremonyId, isProposalShape, MAX_INPUTS } from '../core/messages';
import type { PartyId } from '../core/types';
import type { SendProposal } from '../otzi/lib/vault-types';

/** A request the daemon refuses: a client status, or a retryable 503 (nothing announced); the handler answers `{ error: message }`. */
export class RequestError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** The 409 text for an op that needs a loaded vault. */
export const NO_VAULT_MESSAGE = 'no vault loaded — run otzi generate, then restart the daemon';

export interface LeaderSignRequest {
  ceremonyId: string;
  signers: PartyId[];
  proposal: SendProposal;
}

type Body = Record<string, unknown>;

export function defaultCeremonyId(op: 'dkg' | 'sign'): string {
  return `${op}-${randomUUID()}`;
}

/** `vault-info` takes no fields besides `op`. */
export function parseVaultInfoRequest(body: Body): void {
  allowOnly(body, ['op']);
}

export function parseDkgRequest(body: Body): { ceremonyId: string } {
  allowOnly(body, ['op', 'ceremonyId']);
  return { ceremonyId: ceremonyIdOf(body, 'dkg') };
}

export function parseSignRequest(
  body: Body,
  ring: { partyIds: readonly PartyId[]; self: PartyId; minSigners: number },
): LeaderSignRequest {
  allowOnly(body, ['op', 'ceremonyId', 'signers', 'proposal']);
  const ceremonyId = ceremonyIdOf(body, 'sign');
  const signers = body.signers === undefined ? [...ring.partyIds].sort((a, b) => a - b) : signersOf(body.signers, ring);
  return { ceremonyId, signers, proposal: parseProposal(body.proposal) };
}

// ─── Rules ──────────────────────────────────────────────────────────────────

function bad(message: string): never {
  throw new RequestError(400, message);
}

/** Every key of `body` must be in `allowed`. */
function allowOnly(body: Body, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) bad(`unknown field '${key}'`);
  }
}

function ceremonyIdOf(body: Body, op: 'dkg' | 'sign'): string {
  if (body.ceremonyId === undefined) return defaultCeremonyId(op);
  if (!isCeremonyId(body.ceremonyId)) bad('ceremonyId must match ^[A-Za-z0-9._:-]{1,128}$');
  return body.ceremonyId;
}

function signersOf(raw: unknown, ring: { partyIds: readonly PartyId[]; self: PartyId; minSigners: number }): PartyId[] {
  if (!Array.isArray(raw) || !raw.every(s => Number.isSafeInteger(s))) bad('signers must be an array of party ids');
  const signers = raw as PartyId[];
  if (new Set(signers).size !== signers.length) bad('signers must be unique');
  const stranger = signers.find(s => !ring.partyIds.includes(s));
  if (stranger !== undefined) bad(`signer ${stranger} is not in the ring`);
  if (!signers.includes(ring.self)) bad(`signers must include this node (party ${ring.self})`);
  if (signers.length < ring.minSigners) bad(`signers needs at least ${ring.minSigners} entries, got ${signers.length}`);
  return [...signers];
}

function isObject(x: unknown): x is Body {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A copy of `o` with the string values of `keys` lowercased. */
function lowercased(o: Body, keys: readonly string[]): Body {
  const out: Body = { ...o };
  for (const key of keys) {
    const v = out[key];
    if (typeof v === 'string') out[key] = v.toLowerCase();
  }
  return out;
}

/**
 * A `SendProposal` from untrusted JSON: the same shape, size and hex-case
 * rules the `sign` op applies, so the CLI refuses exactly what the daemon
 * would (`otzi btc sign`).
 */
export function parseProposal(raw: unknown): SendProposal {
  if (!isObject(raw) || typeof raw.tx !== 'string' || !Array.isArray(raw.prevouts)) {
    bad('proposal must be an object with string tx and array prevouts');
  }
  const prevouts: unknown[] = raw.prevouts;
  if (prevouts.length > MAX_INPUTS) {
    bad(`proposal has ${prevouts.length} inputs; at most ${MAX_INPUTS} fit in one transaction`);
  }
  const proposal = {
    ...lowercased(raw, ['tx']),
    prevouts: prevouts.map(p => (isObject(p) ? lowercased(p, ['txid', 'script']) : p)),
  };
  if (!isProposalShape(proposal)) {
    bad('proposal does not have the expected shape { network, tx, prevouts: [{ txid, vout, amount, script }] }');
  }
  return proposal;
}
