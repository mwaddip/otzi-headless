/**
 * FROST signing blob codec and shared types.
 *
 * Blob types:
 *   frost-sign-r1: N SigningCommitments (one per sighash, broadcast)
 *   frost-sign-r2: N SignatureShares (one per sighash, broadcast)
 *
 * Uses the same envelope format as DKG blobs (base64 JSON).
 */

import { encodeEnvelope, decodeEnvelope } from './dkg';
import { fromHex } from './hex';
import type { SigningCommitment, SignatureShare } from '@mwaddip/frots';

// ── Shared types ──

export interface SighashInfo {
  index: number;
  hash: string;  // hex, 32 bytes
  type: 'script-path' | 'key-path';
}

export interface FrostSignatureSet {
  signatures: Array<{ index: number; signature: string }>;  // hex, 64 bytes each
}

// ── Helpers ──

function bigintTo32BE(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

function bigintFrom32BE(buf: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < 32; i++) val = (val << 8n) | BigInt(buf[i]!);
  return val;
}

// ── frost-sign-r1: commitments for N sighashes ──
// Layout: 1B partyId, 1B count, N × (2B identifier LE + 33B hiding + 33B binding)

export function encodeFrostSignR1(
  partyId: number,
  commitments: readonly SigningCommitment[],
  sessionId: Uint8Array,
): string {
  const n = commitments.length;
  const buf = new Uint8Array(2 + n * 68);
  let pos = 0;
  buf[pos++] = partyId;
  buf[pos++] = n;
  for (const c of commitments) {
    buf[pos++] = c.identifier & 0xff;
    buf[pos++] = (c.identifier >>> 8) & 0xff;
    buf.set(c.hiding, pos); pos += 33;
    buf.set(c.binding, pos); pos += 33;
  }
  return encodeEnvelope('frost-sign-r1', partyId, -1, sessionId, buf);
}

export function decodeFrostSignR1(blob: string): { partyId: number; commitments: SigningCommitment[] } | null {
  const env = decodeEnvelope(blob);
  if (!env || env.type !== 'frost-sign-r1') return null;
  const data = fromHex(env.data);
  let pos = 0;
  const partyId = data[pos++]!;
  const count = data[pos++]!;
  const commitments: SigningCommitment[] = [];
  for (let i = 0; i < count; i++) {
    const identifier = data[pos]! | (data[pos + 1]! << 8); pos += 2;
    const hiding = data.slice(pos, pos + 33); pos += 33;
    const binding = data.slice(pos, pos + 33); pos += 33;
    commitments.push({ identifier, hiding, binding });
  }
  return { partyId, commitments };
}

// ── frost-sign-r2: partial sigs for N sighashes ──
// Layout: 1B partyId, 1B count, N × (2B identifier LE + 32B share bigint BE)

export function encodeFrostSignR2(
  partyId: number,
  shares: readonly SignatureShare[],
  sessionId: Uint8Array,
): string {
  const n = shares.length;
  const buf = new Uint8Array(2 + n * 34);
  let pos = 0;
  buf[pos++] = partyId;
  buf[pos++] = n;
  for (const s of shares) {
    buf[pos++] = s.identifier & 0xff;
    buf[pos++] = (s.identifier >>> 8) & 0xff;
    buf.set(bigintTo32BE(s.share), pos); pos += 32;
  }
  return encodeEnvelope('frost-sign-r2', partyId, -1, sessionId, buf);
}

export function decodeFrostSignR2(blob: string): { partyId: number; shares: SignatureShare[] } | null {
  const env = decodeEnvelope(blob);
  if (!env || env.type !== 'frost-sign-r2') return null;
  const data = fromHex(env.data);
  let pos = 0;
  const partyId = data[pos++]!;
  const count = data[pos++]!;
  const shares: SignatureShare[] = [];
  for (let i = 0; i < count; i++) {
    const identifier = data[pos]! | (data[pos + 1]! << 8); pos += 2;
    const share = bigintFrom32BE(data.slice(pos, pos + 32)); pos += 32;
    shares.push({ identifier, share });
  }
  return { partyId, shares };
}
