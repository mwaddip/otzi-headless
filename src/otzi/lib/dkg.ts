/**
 * DKG ceremony blob encoding/decoding and helpers.
 *
 * Each blob is a base64-encoded JSON envelope:
 *   { v, type, from, to, sid, data }
 */

import type { PublicKeyPackage } from '@mwaddip/frots';
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, fromHex } from './hex';
import type { NetworkName, VaultKey } from './vault-types';

// ── Blob envelope ──

export type BlobType = 'session' | 'frost-r1' | 'frost-r2' | 'frost-sign-r1' | 'frost-sign-r2';

export interface BlobEnvelope {
  v: 2;
  type: BlobType;
  from: number;
  to: number;       // -1 = broadcast
  sid: string;      // first 16 hex chars of sessionId
  data: string;     // hex-encoded payload
}

export function encodeEnvelope(type: BlobType, from: number, to: number, sid: Uint8Array, data: Uint8Array): string {
  const envelope: BlobEnvelope = { v: 2, type, from, to, sid: toHex(sid).slice(0, 16), data: toHex(data) };
  return btoa(JSON.stringify(envelope));
}

export function decodeEnvelope(blob: string): BlobEnvelope | null {
  try {
    const obj = JSON.parse(atob(blob.trim())) as BlobEnvelope;
    if (obj.v !== 2 || typeof obj.type !== 'string' || typeof obj.from !== 'number' || typeof obj.to !== 'number') return null;
    if (typeof obj.sid !== 'string' || typeof obj.data !== 'string' || !/^([0-9a-f]{2})*$/.test(obj.data)) return null;
    return obj;
  } catch {
    return null;
  }
}

export interface BlobInfo {
  type: BlobType;
  from: number;
  to: number;
  sid: string;
}

export function identifyBlob(blob: string): BlobInfo | null {
  const env = decodeEnvelope(blob);
  if (!env) return null;
  return { type: env.type, from: env.from, to: env.to, sid: env.sid };
}

// ── Session config ──

export interface SessionConfig {
  t: number;
  n: number;
  network: NetworkName;
  sid: string; // full hex
}

export function encodeSessionConfig(t: number, n: number, network: NetworkName, sessionId: Uint8Array): string {
  const config: SessionConfig = { t, n, network, sid: toHex(sessionId) };
  return encodeEnvelope('session', 0, -1, sessionId, new TextEncoder().encode(JSON.stringify(config)));
}

export function decodeSessionConfig(blob: string): SessionConfig | null {
  const env = decodeEnvelope(blob);
  if (!env || env.type !== 'session') return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromHex(env.data))) as SessionConfig;
    if (!Number.isInteger(c.t) || !Number.isInteger(c.n) || c.t < 2 || c.n < c.t || c.n > 255) return null;
    if (typeof c.sid !== 'string' || !/^[0-9a-f]{64}$/.test(c.sid) || typeof c.network !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}

export function generateSessionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function getSessionIdPrefix(sessionId: Uint8Array): string {
  return toHex(sessionId).slice(0, 16);
}

// ── Party ↔ FROST identifiers ──

/** 0-indexed partyId → 1-indexed FROST identifier. */
export function partyIdToFrostId(partyId: number): bigint {
  return BigInt(partyId + 1);
}

/** 1-indexed FROST identifier → 0-indexed partyId. */
export function frostIdToPartyId(id: bigint): number {
  return Number(id) - 1;
}

export function bigintTo32BE(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

export function bigintFrom32BE(buf: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < 32; i++) val = (val << 8n) | BigInt(buf[i]!);
  return val;
}

// ── FROST DKG round 1: commitment broadcast ──
// Layout: 1B partyId, 1B numCommitments, numCommitments × 33B SEC1, 33B proof.R, 32B proof.z (BE)

export interface FrostRound1Package {
  readonly identifier: bigint;
  readonly commitment: readonly Uint8Array[];
  readonly proofOfKnowledge: { readonly R: Uint8Array; readonly z: bigint };
}

export function encodeFrostRound1(pkg: FrostRound1Package, sessionId: Uint8Array): string {
  const partyId = frostIdToPartyId(pkg.identifier);
  const n = pkg.commitment.length;
  const buf = new Uint8Array(2 + n * 33 + 33 + 32);
  let pos = 0;
  buf[pos++] = partyId;
  buf[pos++] = n;
  for (const c of pkg.commitment) { buf.set(c, pos); pos += 33; }
  buf.set(pkg.proofOfKnowledge.R, pos); pos += 33;
  buf.set(bigintTo32BE(pkg.proofOfKnowledge.z), pos);
  return encodeEnvelope('frost-r1', partyId, -1, sessionId, buf);
}

export function decodeFrostRound1(blob: string): FrostRound1Package | null {
  const env = decodeEnvelope(blob);
  if (!env || env.type !== 'frost-r1') return null;
  const data = fromHex(env.data);
  if (data.length < 2) return null;
  const partyId = data[0]!;
  const n = data[1]!;
  if (n === 0 || data.length !== 2 + n * 33 + 33 + 32 || partyId !== env.from) return null;
  let pos = 2;
  const commitment: Uint8Array[] = [];
  for (let i = 0; i < n; i++) { commitment.push(data.slice(pos, pos + 33)); pos += 33; }
  const R = data.slice(pos, pos + 33); pos += 33;
  const z = bigintFrom32BE(data.slice(pos, pos + 32));
  return { identifier: partyIdToFrostId(partyId), commitment, proofOfKnowledge: { R, z } };
}

// ── FROST DKG round 2: private shares ──
// Layout: 1B senderPartyId, 1B recipientPartyId, 32B signingShare (BE)

export interface FrostRound2Package {
  readonly sender: bigint;
  readonly recipient: bigint;
  readonly signingShare: bigint;
}

export function encodeFrostRound2(pkg: FrostRound2Package, sessionId: Uint8Array): string {
  const sender = frostIdToPartyId(pkg.sender);
  const recipient = frostIdToPartyId(pkg.recipient);
  const buf = new Uint8Array(34);
  buf[0] = sender;
  buf[1] = recipient;
  buf.set(bigintTo32BE(pkg.signingShare), 2);
  return encodeEnvelope('frost-r2', sender, recipient, sessionId, buf);
}

export function decodeFrostRound2(blob: string): FrostRound2Package | null {
  const env = decodeEnvelope(blob);
  if (!env || env.type !== 'frost-r2') return null;
  const data = fromHex(env.data);
  if (data.length !== 34 || data[0] !== env.from || data[1] !== env.to) return null;
  return {
    sender: partyIdToFrostId(data[0]!),
    recipient: partyIdToFrostId(data[1]!),
    signingShare: bigintFrom32BE(data.slice(2, 34)),
  };
}

// ── Public key package ↔ VaultKey ──

export function toVaultKey(pkp: PublicKeyPackage): VaultKey {
  const map = (m: ReadonlyMap<bigint, Uint8Array>) =>
    Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, p]) => [id.toString(), toHex(p)]));
  return {
    minSigners: pkp.minSigners,
    verifyingKey: toHex(pkp.verifyingKey),
    untweakedVerifyingKey: toHex(pkp.untweakedVerifyingKey),
    verifyingShares: map(pkp.verifyingShares),
    untweakedVerifyingShares: map(pkp.untweakedVerifyingShares),
  };
}

export function fromVaultKey(v: VaultKey): PublicKeyPackage {
  const map = (o: Record<string, string>) => new Map(Object.entries(o).map(([id, p]) => [BigInt(id), fromHex(p)]));
  return {
    minSigners: v.minSigners,
    verifyingKey: fromHex(v.verifyingKey),
    untweakedVerifyingKey: fromHex(v.untweakedVerifyingKey),
    verifyingShares: map(v.verifyingShares),
    untweakedVerifyingShares: map(v.untweakedVerifyingShares),
  };
}

// ── DKG verification message ──

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  const buf = new Uint8Array(64 + msg.length);
  buf.set(t, 0);
  buf.set(t, 32);
  buf.set(msg, 64);
  return sha256(buf);
}

/**
 * Message all N parties sign at the end of the DKG. Each party computes it
 * from its own view of the ceremony, so any disagreement makes signing fail.
 */
export function dkgVerifyMessage(sessionId: Uint8Array, network: NetworkName, pkp: PublicKeyPackage): Uint8Array {
  const ids = [...pkp.untweakedVerifyingShares.keys()].sort((a, b) => (a < b ? -1 : 1));
  const parts: Uint8Array[] = [
    sessionId,
    new TextEncoder().encode(network),
    pkp.untweakedVerifyingKey,
    pkp.verifyingKey,
    Uint8Array.of(pkp.minSigners),
  ];
  for (const id of ids) {
    parts.push(Uint8Array.of(Number(id) & 0xff, (Number(id) >> 8) & 0xff));
    parts.push(pkp.untweakedVerifyingShares.get(id)!);
    const tweaked = pkp.verifyingShares.get(id);
    if (!tweaked) throw new Error(`Missing verifying share ${id}`);
    parts.push(tweaked);
  }
  const msg = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { msg.set(p, o); o += p.length; }
  return taggedHash('Otzi/dkg-verify', msg);
}
