import type { PartyId } from './types';
import { toHex, fromHex } from '../wire/hex';

/**
 * Ceremony-level control messages broadcast over the Transport.
 *
 * These are NOT ceremony blobs (those flow via pull). These are coordination
 * signals: the leader announces each signing attempt and signs off on
 * completion or abort. Participants listen to decide when to participate
 * and when to release state.
 */

export type CeremonyMessage =
  /** Leader announcement of an ML-DSA signing attempt. Sent before each attempt (base + each #N retry). */
  | {
      v: 1;
      kind: 'announce';
      ceremonyId: string;        // may carry a `#N` retry suffix
      baseCeremonyId: string;    // stable across retries
      messageHex: string;        // bytes to sign, hex-encoded
      signers: PartyId[];        // active signer set
    }
  /** Leader announcement of a FROST signing ceremony. Single attempt — FROST combine is deterministic. */
  | {
      v: 1;
      kind: 'announce-frost';
      ceremonyId: string;
      baseCeremonyId: string;
      sighashes: Array<{ hashHex: string; tweaked: boolean }>;
      signers: PartyId[];
    }
  /**
   * Initiator announcement of an ML-DSA DKG ceremony. Symmetric: no leader,
   * no retry. Carries the setup parameters every peer needs to create a
   * matching local session. The initiator is trigger-assigned — the one
   * whose operator / cron fired — not a mid-ceremony coordinator.
   */
  | {
      v: 1;
      kind: 'announce-dkg';
      ceremonyId: string;
      baseCeremonyId: string;
      sessionIdHex: string;  // 32 bytes, hex-encoded
      threshold: number;
      parties: number;
      level: number;         // ML-DSA security level (44/65/87)
    }
  /** Initiator announcement of a FROST DKG ceremony (secp256k1). Symmetric. */
  | {
      v: 1;
      kind: 'announce-frost-dkg';
      ceremonyId: string;
      baseCeremonyId: string;
      sessionIdHex: string;
      threshold: number;
      parties: number;
    }
  /**
   * Initiator announcement of a combined ML-DSA DKG + FROST DKG ceremony under
   * a single `sessionId`. Matches Ötzi's `DKGWizard.tsx` flow — ML-DSA phases
   * first, then FROST DKG — so the resulting share files stay V3-compatible.
   */
  | {
      v: 1;
      kind: 'announce-combined-dkg';
      ceremonyId: string;
      baseCeremonyId: string;
      sessionIdHex: string;
      threshold: number;
      parties: number;
      level: number;  // ML-DSA security level; FROST is fixed secp256k1
    }
  /** Leader signs off after the produced ML-DSA signature has been broadcast. */
  | {
      v: 1;
      kind: 'signoff-done';
      baseCeremonyId: string;
      signatureHex: string;
    }
  /** Leader signs off after the produced FROST signatures have been broadcast. */
  | {
      v: 1;
      kind: 'signoff-frost-done';
      baseCeremonyId: string;
      signaturesHex: string[];    // one 64-byte BIP340 sig per sighash, in ceremony order
    }
  /** Leader aborts. Protocol-agnostic: same shape for ML-DSA and FROST. */
  | {
      v: 1;
      kind: 'signoff-aborted';
      baseCeremonyId: string;
      reason?: string;
    };

export function encodeCeremonyMessage(msg: CeremonyMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

export function parseCeremonyMessage(bytes: Uint8Array): CeremonyMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  if (m.v !== 1) return null;
  if (m.kind === 'announce') {
    if (
      typeof m.ceremonyId !== 'string' ||
      typeof m.baseCeremonyId !== 'string' ||
      typeof m.messageHex !== 'string' ||
      !Array.isArray(m.signers)
    ) return null;
    return {
      v: 1,
      kind: 'announce',
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      messageHex: m.messageHex,
      signers: m.signers as PartyId[],
    };
  }
  if (m.kind === 'announce-frost') {
    if (
      typeof m.ceremonyId !== 'string' ||
      typeof m.baseCeremonyId !== 'string' ||
      !Array.isArray(m.sighashes) ||
      !Array.isArray(m.signers)
    ) return null;
    const sighashes: Array<{ hashHex: string; tweaked: boolean }> = [];
    for (const s of m.sighashes) {
      if (!s || typeof s !== 'object') return null;
      const item = s as Record<string, unknown>;
      if (typeof item.hashHex !== 'string' || typeof item.tweaked !== 'boolean') return null;
      sighashes.push({ hashHex: item.hashHex, tweaked: item.tweaked });
    }
    return {
      v: 1,
      kind: 'announce-frost',
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      sighashes,
      signers: m.signers as PartyId[],
    };
  }
  if (m.kind === 'announce-dkg') {
    if (
      typeof m.ceremonyId !== 'string' ||
      typeof m.baseCeremonyId !== 'string' ||
      typeof m.sessionIdHex !== 'string' ||
      typeof m.threshold !== 'number' ||
      typeof m.parties !== 'number' ||
      typeof m.level !== 'number'
    ) return null;
    return {
      v: 1,
      kind: 'announce-dkg',
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      sessionIdHex: m.sessionIdHex,
      threshold: m.threshold,
      parties: m.parties,
      level: m.level,
    };
  }
  if (m.kind === 'announce-frost-dkg') {
    if (
      typeof m.ceremonyId !== 'string' ||
      typeof m.baseCeremonyId !== 'string' ||
      typeof m.sessionIdHex !== 'string' ||
      typeof m.threshold !== 'number' ||
      typeof m.parties !== 'number'
    ) return null;
    return {
      v: 1,
      kind: 'announce-frost-dkg',
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      sessionIdHex: m.sessionIdHex,
      threshold: m.threshold,
      parties: m.parties,
    };
  }
  if (m.kind === 'announce-combined-dkg') {
    if (
      typeof m.ceremonyId !== 'string' ||
      typeof m.baseCeremonyId !== 'string' ||
      typeof m.sessionIdHex !== 'string' ||
      typeof m.threshold !== 'number' ||
      typeof m.parties !== 'number' ||
      typeof m.level !== 'number'
    ) return null;
    return {
      v: 1,
      kind: 'announce-combined-dkg',
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      sessionIdHex: m.sessionIdHex,
      threshold: m.threshold,
      parties: m.parties,
      level: m.level,
    };
  }
  if (m.kind === 'signoff-done') {
    if (typeof m.baseCeremonyId !== 'string' || typeof m.signatureHex !== 'string') return null;
    return { v: 1, kind: 'signoff-done', baseCeremonyId: m.baseCeremonyId, signatureHex: m.signatureHex };
  }
  if (m.kind === 'signoff-frost-done') {
    if (typeof m.baseCeremonyId !== 'string' || !Array.isArray(m.signaturesHex)) return null;
    const sigs: string[] = [];
    for (const s of m.signaturesHex) {
      if (typeof s !== 'string') return null;
      sigs.push(s);
    }
    return { v: 1, kind: 'signoff-frost-done', baseCeremonyId: m.baseCeremonyId, signaturesHex: sigs };
  }
  if (m.kind === 'signoff-aborted') {
    if (typeof m.baseCeremonyId !== 'string') return null;
    return {
      v: 1,
      kind: 'signoff-aborted',
      baseCeremonyId: m.baseCeremonyId,
      reason: typeof m.reason === 'string' ? m.reason : undefined,
    };
  }
  return null;
}

export function announceMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  message: Uint8Array,
  signers: PartyId[],
): CeremonyMessage {
  return {
    v: 1,
    kind: 'announce',
    ceremonyId,
    baseCeremonyId,
    messageHex: toHex(message),
    signers,
  };
}

export function announceFrostMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  sighashes: ReadonlyArray<{ hash: Uint8Array; tweaked: boolean }>,
  signers: PartyId[],
): CeremonyMessage {
  return {
    v: 1,
    kind: 'announce-frost',
    ceremonyId,
    baseCeremonyId,
    sighashes: sighashes.map(s => ({ hashHex: toHex(s.hash), tweaked: s.tweaked })),
    signers,
  };
}

export function announceDkgMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  sessionId: Uint8Array,
  threshold: number,
  parties: number,
  level: number,
): CeremonyMessage {
  return {
    v: 1,
    kind: 'announce-dkg',
    ceremonyId,
    baseCeremonyId,
    sessionIdHex: toHex(sessionId),
    threshold,
    parties,
    level,
  };
}

export function sessionIdFromAnnounceDkg(
  msg: Extract<CeremonyMessage, { kind: 'announce-dkg' }>,
): Uint8Array {
  return fromHex(msg.sessionIdHex);
}

export function announceFrostDkgMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  sessionId: Uint8Array,
  threshold: number,
  parties: number,
): CeremonyMessage {
  return {
    v: 1,
    kind: 'announce-frost-dkg',
    ceremonyId,
    baseCeremonyId,
    sessionIdHex: toHex(sessionId),
    threshold,
    parties,
  };
}

export function sessionIdFromAnnounceFrostDkg(
  msg: Extract<CeremonyMessage, { kind: 'announce-frost-dkg' }>,
): Uint8Array {
  return fromHex(msg.sessionIdHex);
}

export function announceCombinedDkgMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  sessionId: Uint8Array,
  threshold: number,
  parties: number,
  level: number,
): CeremonyMessage {
  return {
    v: 1,
    kind: 'announce-combined-dkg',
    ceremonyId,
    baseCeremonyId,
    sessionIdHex: toHex(sessionId),
    threshold,
    parties,
    level,
  };
}

export function sessionIdFromAnnounceCombinedDkg(
  msg: Extract<CeremonyMessage, { kind: 'announce-combined-dkg' }>,
): Uint8Array {
  return fromHex(msg.sessionIdHex);
}

export function signoffDoneMessage(baseCeremonyId: string, signature: Uint8Array): CeremonyMessage {
  return { v: 1, kind: 'signoff-done', baseCeremonyId, signatureHex: toHex(signature) };
}

export function signoffFrostDoneMessage(
  baseCeremonyId: string,
  signatures: ReadonlyArray<Uint8Array>,
): CeremonyMessage {
  return {
    v: 1,
    kind: 'signoff-frost-done',
    baseCeremonyId,
    signaturesHex: signatures.map(sig => toHex(sig)),
  };
}

export function signoffAbortedMessage(baseCeremonyId: string, reason?: string): CeremonyMessage {
  return { v: 1, kind: 'signoff-aborted', baseCeremonyId, reason };
}

export function messageFromAnnounce(msg: Extract<CeremonyMessage, { kind: 'announce' }>): Uint8Array {
  return fromHex(msg.messageHex);
}

export function sighashesFromAnnounceFrost(
  msg: Extract<CeremonyMessage, { kind: 'announce-frost' }>,
): Array<{ hash: Uint8Array; tweaked: boolean }> {
  return msg.sighashes.map(s => ({ hash: fromHex(s.hashHex), tweaked: s.tweaked }));
}

export function signatureFromSignoff(msg: Extract<CeremonyMessage, { kind: 'signoff-done' }>): Uint8Array {
  return fromHex(msg.signatureHex);
}

export function signaturesFromFrostSignoff(
  msg: Extract<CeremonyMessage, { kind: 'signoff-frost-done' }>,
): Uint8Array[] {
  return msg.signaturesHex.map(hex => fromHex(hex));
}
