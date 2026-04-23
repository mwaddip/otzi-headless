/**
 * Peer-mesh wire format.
 *
 * Two message families:
 *   1. Handshake (cleartext, one-shot at the start of each connection) — JSON.
 *      hs1: initiator → responder with (partyId, ephemeralPubHex).
 *      hs2: responder → initiator with (partyId, ephemeralPubHex).
 *
 *   2. Application (AES-GCM-encrypted, many per connection) — JSON ciphertext.
 *      broadcast: opaque byte payload from the ceremony layer.
 *      pull-req / pull-resp: correlated by requestId for `Transport.pull`.
 *
 * The handshake is the only thing that ever goes over the socket unencrypted;
 * it carries no secrets (just ephemeral pubkeys). Everything after handshake
 * completion rides through `RecordSession.seal` / `open`.
 */

import type { BlobKey, PartyId } from '../../core/types';
import { fromHex, toHex } from '../../wire/hex';

// ─────────────────────────────────────────────────────────────────────────
// Handshake
// ─────────────────────────────────────────────────────────────────────────

export interface Handshake1 {
  kind: 'hs1';
  partyId: PartyId;
  ephemeralPubHex: string;
}
export interface Handshake2 {
  kind: 'hs2';
  partyId: PartyId;
  ephemeralPubHex: string;
}

export function encodeHandshake1(partyId: PartyId, ephemeralPub: Uint8Array): Uint8Array {
  return jsonEncode({ kind: 'hs1', partyId, ephemeralPubHex: toHex(ephemeralPub) });
}

export function encodeHandshake2(partyId: PartyId, ephemeralPub: Uint8Array): Uint8Array {
  return jsonEncode({ kind: 'hs2', partyId, ephemeralPubHex: toHex(ephemeralPub) });
}

export function parseHandshake(bytes: Uint8Array): Handshake1 | Handshake2 | null {
  const obj = jsonDecode(bytes);
  if (!obj) return null;
  if (obj.kind !== 'hs1' && obj.kind !== 'hs2') return null;
  if (typeof obj.partyId !== 'number' || !Number.isInteger(obj.partyId) || obj.partyId < 0) return null;
  if (typeof obj.ephemeralPubHex !== 'string') return null;
  return {
    kind: obj.kind,
    partyId: obj.partyId,
    ephemeralPubHex: obj.ephemeralPubHex,
  };
}

export function ephemeralFromHandshake(msg: Handshake1 | Handshake2): Uint8Array {
  return fromHex(msg.ephemeralPubHex);
}

// ─────────────────────────────────────────────────────────────────────────
// Application messages (wrapped in AES-GCM post-handshake)
// ─────────────────────────────────────────────────────────────────────────

export interface AppBroadcast {
  kind: 'broadcast';
  msgB64: string;
}
export interface AppPullRequest {
  kind: 'pull-req';
  requestId: string;
  ceremonyId: string;
  round: string;
  from: PartyId;
  to?: PartyId;
}
export interface AppPullResponse {
  kind: 'pull-resp';
  requestId: string;
  /** base64-encoded blob, or null if the producer has not yet generated it. */
  blobB64: string | null;
}

export type AppMessage = AppBroadcast | AppPullRequest | AppPullResponse;

export function encodeBroadcast(msg: Uint8Array): Uint8Array {
  return jsonEncode({ kind: 'broadcast', msgB64: bytesToBase64(msg) });
}

export function encodePullRequest(requestId: string, key: BlobKey): Uint8Array {
  const o: AppPullRequest = {
    kind: 'pull-req',
    requestId,
    ceremonyId: key.ceremonyId,
    round: key.round,
    from: key.from,
  };
  if (key.to !== undefined) o.to = key.to;
  return jsonEncode(o);
}

export function encodePullResponse(requestId: string, blob: Uint8Array | null): Uint8Array {
  return jsonEncode({
    kind: 'pull-resp',
    requestId,
    blobB64: blob === null ? null : bytesToBase64(blob),
  });
}

export function parseAppMessage(bytes: Uint8Array): AppMessage | null {
  const obj = jsonDecode(bytes);
  if (!obj) return null;
  switch (obj.kind) {
    case 'broadcast':
      if (typeof obj.msgB64 !== 'string') return null;
      return { kind: 'broadcast', msgB64: obj.msgB64 };
    case 'pull-req':
      if (
        typeof obj.requestId !== 'string' ||
        typeof obj.ceremonyId !== 'string' ||
        typeof obj.round !== 'string' ||
        typeof obj.from !== 'number'
      )
        return null;
      return {
        kind: 'pull-req',
        requestId: obj.requestId,
        ceremonyId: obj.ceremonyId,
        round: obj.round,
        from: obj.from,
        to: typeof obj.to === 'number' ? obj.to : undefined,
      };
    case 'pull-resp':
      if (typeof obj.requestId !== 'string') return null;
      if (obj.blobB64 !== null && typeof obj.blobB64 !== 'string') return null;
      return { kind: 'pull-resp', requestId: obj.requestId, blobB64: obj.blobB64 };
    default:
      return null;
  }
}

export function broadcastBytes(msg: AppBroadcast): Uint8Array {
  return base64ToBytes(msg.msgB64);
}

export function pullResponseBlob(msg: AppPullResponse): Uint8Array | null {
  return msg.blobB64 === null ? null : base64ToBytes(msg.blobB64);
}

export function pullRequestKey(msg: AppPullRequest): BlobKey {
  const k: BlobKey = { ceremonyId: msg.ceremonyId, round: msg.round, from: msg.from };
  if (msg.to !== undefined) k.to = msg.to;
  return k;
}

// ─────────────────────────────────────────────────────────────────────────
// Low-level helpers
// ─────────────────────────────────────────────────────────────────────────

function jsonEncode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function jsonDecode(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
