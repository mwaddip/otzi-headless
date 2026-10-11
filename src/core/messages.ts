import type { NetworkName, SendProposal } from '../otzi/lib/vault-types';
import { NETWORK_NAMES } from '../otzi/backend/types';
import type { PartyId } from './types';

/**
 * v2 ceremony control messages (facts/core.md, `messages.ts`).
 *
 * These are broadcasts, not blobs (blobs flow via pull). The parser is strict:
 * exact key sets, exact value shapes, and it never throws. A parse failure is
 * a silent drop at the receiver. Messages carry no sender field; the sender is
 * the transport's authenticated `from`.
 */

export const CEREMONY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_INPUTS = 255;

/** Largest accepted `reason` length (UTF-16 code units). */
const MAX_REASON_LENGTH = 1024;
/** Valid party indices are 0..254 (FROST identifiers are index + 1, capped at 255). */
const MAX_PARTY_ID = 254;
const MIN_THRESHOLD = 2;
const MAX_PARTIES = 255;

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;
const NONEMPTY_EVEN_HEX_RE = /^(?:[0-9a-f]{2})+$/;

export interface AnnounceDkg {
  v: 2;
  kind: 'announce-dkg';
  ceremonyId: string;
  sessionIdHex: string;
  threshold: number;
  parties: number;
  network: NetworkName;
}

export interface AnnounceSign {
  v: 2;
  kind: 'announce-sign';
  ceremonyId: string;
  signers: PartyId[];
  proposal: SendProposal;
}

export interface SignoffDone {
  v: 2;
  kind: 'signoff-done';
  ceremonyId: string;
  signaturesHex: string[];
}

export interface SignoffAborted {
  v: 2;
  kind: 'signoff-aborted';
  ceremonyId: string;
  reason?: string;
}

export type CeremonyMessage = AnnounceDkg | AnnounceSign | SignoffDone | SignoffAborted;

type Obj = Record<string, unknown>;

function isPlainObject(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** True iff `o` has every `required` key, no key outside `required` + `optional`. */
function hasExactKeys(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  for (const k of required) {
    if (!keys.includes(k)) return false;
  }
  return keys.every((k) => required.includes(k) || optional.includes(k));
}

function isNetworkName(x: unknown): x is NetworkName {
  return typeof x === 'string' && (NETWORK_NAMES as readonly string[]).includes(x);
}

function isIntInRange(x: unknown, min: number, max: number): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
}

function isNonNegativeSafeInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

function isHexOfLength(x: unknown, re: RegExp): x is string {
  return typeof x === 'string' && re.test(x);
}

/** `true` iff `s` is a string matching `CEREMONY_ID_RE`. */
export function isCeremonyId(s: unknown): s is string {
  return typeof s === 'string' && CEREMONY_ID_RE.test(s);
}

function isPrevoutShape(p: unknown): boolean {
  return (
    isPlainObject(p) &&
    hasExactKeys(p, ['txid', 'vout', 'amount', 'script']) &&
    isHexOfLength(p.txid, HEX64_RE) &&
    isNonNegativeSafeInt(p.vout) &&
    isNonNegativeSafeInt(p.amount) &&
    isHexOfLength(p.script, NONEMPTY_EVEN_HEX_RE)
  );
}

/**
 * Shape check only. Input/prevout agreement, vault script, network match and
 * fee policy are `analyzeProposal`'s job.
 */
export function isProposalShape(p: unknown): p is SendProposal {
  return (
    isPlainObject(p) &&
    hasExactKeys(p, ['network', 'tx', 'prevouts']) &&
    isNetworkName(p.network) &&
    isHexOfLength(p.tx, NONEMPTY_EVEN_HEX_RE) &&
    Array.isArray(p.prevouts) &&
    p.prevouts.length >= 1 &&
    p.prevouts.length <= MAX_INPUTS &&
    p.prevouts.every(isPrevoutShape)
  );
}

function isSignerList(x: unknown): x is PartyId[] {
  return (
    Array.isArray(x) &&
    x.length >= 1 &&
    x.length <= MAX_INPUTS &&
    x.every((s) => isIntInRange(s, 0, MAX_PARTY_ID))
  );
}

function isSignatureList(x: unknown): x is string[] {
  return (
    Array.isArray(x) &&
    x.length >= 1 &&
    x.length <= MAX_INPUTS &&
    x.every((s) => isHexOfLength(s, HEX128_RE))
  );
}

/** UTF-8 JSON. `msg` must satisfy the parser rules. */
export function encodeMessage(msg: CeremonyMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function parseAnnounceDkg(o: Obj): AnnounceDkg | null {
  if (!hasExactKeys(o, ['v', 'kind', 'ceremonyId', 'sessionIdHex', 'threshold', 'parties', 'network'])) return null;
  const { ceremonyId, sessionIdHex, threshold, parties, network } = o;
  if (!isCeremonyId(ceremonyId)) return null;
  if (!isHexOfLength(sessionIdHex, HEX64_RE)) return null;
  if (!isIntInRange(threshold, MIN_THRESHOLD, MAX_PARTIES)) return null;
  if (!isIntInRange(parties, MIN_THRESHOLD, MAX_PARTIES)) return null;
  if (threshold > parties) return null;
  if (!isNetworkName(network)) return null;
  return { v: 2, kind: 'announce-dkg', ceremonyId, sessionIdHex, threshold, parties, network };
}

function parseAnnounceSign(o: Obj): AnnounceSign | null {
  if (!hasExactKeys(o, ['v', 'kind', 'ceremonyId', 'signers', 'proposal'])) return null;
  const { ceremonyId, signers, proposal } = o;
  if (!isCeremonyId(ceremonyId)) return null;
  if (!isSignerList(signers)) return null;
  if (!isProposalShape(proposal)) return null;
  return { v: 2, kind: 'announce-sign', ceremonyId, signers, proposal };
}

function parseSignoffDone(o: Obj): SignoffDone | null {
  if (!hasExactKeys(o, ['v', 'kind', 'ceremonyId', 'signaturesHex'])) return null;
  const { ceremonyId, signaturesHex } = o;
  if (!isCeremonyId(ceremonyId)) return null;
  if (!isSignatureList(signaturesHex)) return null;
  return { v: 2, kind: 'signoff-done', ceremonyId, signaturesHex };
}

function parseSignoffAborted(o: Obj): SignoffAborted | null {
  if (!hasExactKeys(o, ['v', 'kind', 'ceremonyId'], ['reason'])) return null;
  const { ceremonyId } = o;
  if (!isCeremonyId(ceremonyId)) return null;
  if (!('reason' in o)) return { v: 2, kind: 'signoff-aborted', ceremonyId };
  const { reason } = o;
  if (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH) return null;
  return { v: 2, kind: 'signoff-aborted', ceremonyId, reason };
}

/** Returns the message when every rule holds, `null` otherwise. Never throws. */
export function parseMessage(bytes: Uint8Array): CeremonyMessage | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const o: unknown = JSON.parse(text);
    if (!isPlainObject(o) || o.v !== 2) return null;
    switch (o.kind) {
      case 'announce-dkg':
        return parseAnnounceDkg(o);
      case 'announce-sign':
        return parseAnnounceSign(o);
      case 'signoff-done':
        return parseSignoffDone(o);
      case 'signoff-aborted':
        return parseSignoffAborted(o);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
