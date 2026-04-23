/**
 * Relay wire protocol — minimal JSON envelope.
 *
 * The relay is a dumb frame router. It never sees plaintext — payloads are
 * already AES-GCM-encrypted at the peer layer (Noise KK key schedule from
 * phase 3b). The server's only job:
 *   - Group connections by `ringId` (derived from the pubkey book, so every
 *     peer in a ring agrees on it at startup).
 *   - Maintain a per-ring roster; push `peer-joined` / `peer-left` events to
 *     all connected ring members.
 *   - Forward `frame { to, payload }` from one peer to another in the same
 *     ring.
 *
 * No authentication at this layer — deploy behind a restricted network.
 * Anyone who can reach the relay port can claim a partyId slot (first come,
 * first served). Noise KK at the peer layer provides real auth: a squatter
 * can't complete handshakes with legitimate peers.
 */

import type { PartyId } from '../../core/types';

// ─────────────────────────────────────────────────────────────────────────
// Client → Server
// ─────────────────────────────────────────────────────────────────────────

export interface RelayHello {
  kind: 'hello';
  ringId: string;
  partyId: PartyId;
}

export interface RelayFrame {
  kind: 'frame';
  to: PartyId;
  /** Hex-encoded opaque bytes (handshake or AES-GCM ciphertext). */
  payloadHex: string;
}

export type RelayClientMsg = RelayHello | RelayFrame;

// ─────────────────────────────────────────────────────────────────────────
// Server → Client
// ─────────────────────────────────────────────────────────────────────────

export interface RelayAck {
  kind: 'ack';
  /** Currently-connected peers in the ring (excluding self). */
  roster: PartyId[];
}

export interface RelayPeerJoined {
  kind: 'peer-joined';
  partyId: PartyId;
}

export interface RelayPeerLeft {
  kind: 'peer-left';
  partyId: PartyId;
}

export interface RelayIncoming {
  kind: 'incoming';
  from: PartyId;
  payloadHex: string;
}

export interface RelayError {
  kind: 'error';
  message: string;
}

export type RelayServerMsg =
  | RelayAck
  | RelayPeerJoined
  | RelayPeerLeft
  | RelayIncoming
  | RelayError;

// ─────────────────────────────────────────────────────────────────────────
// Encode / parse
// ─────────────────────────────────────────────────────────────────────────

export function encodeClientMsg(msg: RelayClientMsg): string {
  return JSON.stringify(msg);
}

export function encodeServerMsg(msg: RelayServerMsg): string {
  return JSON.stringify(msg);
}

export function parseClientMsg(text: string): RelayClientMsg | null {
  const obj = parseObject(text);
  if (!obj) return null;
  switch (obj.kind) {
    case 'hello':
      if (typeof obj.ringId !== 'string' || typeof obj.partyId !== 'number' || !Number.isInteger(obj.partyId))
        return null;
      return { kind: 'hello', ringId: obj.ringId, partyId: obj.partyId };
    case 'frame':
      if (typeof obj.to !== 'number' || !Number.isInteger(obj.to) || typeof obj.payloadHex !== 'string')
        return null;
      return { kind: 'frame', to: obj.to, payloadHex: obj.payloadHex };
    default:
      return null;
  }
}

export function parseServerMsg(text: string): RelayServerMsg | null {
  const obj = parseObject(text);
  if (!obj) return null;
  switch (obj.kind) {
    case 'ack':
      if (!Array.isArray(obj.roster)) return null;
      if (!obj.roster.every((p) => typeof p === 'number' && Number.isInteger(p))) return null;
      return { kind: 'ack', roster: obj.roster as PartyId[] };
    case 'peer-joined':
      if (typeof obj.partyId !== 'number' || !Number.isInteger(obj.partyId)) return null;
      return { kind: 'peer-joined', partyId: obj.partyId };
    case 'peer-left':
      if (typeof obj.partyId !== 'number' || !Number.isInteger(obj.partyId)) return null;
      return { kind: 'peer-left', partyId: obj.partyId };
    case 'incoming':
      if (typeof obj.from !== 'number' || !Number.isInteger(obj.from) || typeof obj.payloadHex !== 'string')
        return null;
      return { kind: 'incoming', from: obj.from, payloadHex: obj.payloadHex };
    case 'error':
      if (typeof obj.message !== 'string') return null;
      return { kind: 'error', message: obj.message };
    default:
      return null;
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}
