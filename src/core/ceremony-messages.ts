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
      /**
       * Protocol tag. Populated whenever the leader supplies enough context
       * for participants to rebuild or verify (BTC construction params, or
       * OPNet raw tx + inputs). Absent on ceremony-mechanics tests that use
       * synthetic sighashes.
       */
      protocol?: 'btc' | 'opnet';
      /**
       * BTC vault construction parameters. Present iff `protocol='btc'`.
       * Participants rebuild the tx locally from these + compare computed
       * sighashes to the leader's `sighashes` field. Mismatch → silent drop
       * (catches honest-leader bugs AND any leader asserting inconsistent
       * sighashes vs construction params).
       */
      btcParams?: {
        to: string;
        amountSat: string;          // decimal, u64-safe
        feeRate: number;
        network: 'mainnet' | 'testnet';
        frostP2tr: string;
        frostUntweakedPubKeyHex: string;
        utxos: Array<{
          transactionId: string;
          outputIndex: number;
          valueSat: string;
        }>;
      };
      /**
       * Full unsigned tx hex (OPNet path — construction-params for OPNet is
       * deferred until the SDK-level UTXO fetcher can be deterministically
       * controlled). Present iff `protocol='opnet'`.
       */
      unsignedTxHex?: string;
      /** OPNet per-input prevout info. Present iff `protocol='opnet'`. */
      inputs?: Array<{ scriptHex: string; valueSat: string; tweaked: boolean }>;
      /**
       * Advisory hints for gate policy matching (OPNet). Operator-supplied on
       * `/sign`, propagated here; unverified. Matches Ötzi's trust posture:
       * federation-insider lies are out-of-scope (threshold protects key
       * material; DoS is the worst insider outcome). Used for
       * `allowed_contracts` / `allowed_methods` / amount-cap rules.
       */
      hints?: {
        contractAddress?: string;
        method?: string;
        amountTokenAtomic?: string;
      };
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
    const out: Extract<CeremonyMessage, { kind: 'announce-frost' }> = {
      v: 1,
      kind: 'announce-frost',
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      sighashes,
      signers: m.signers as PartyId[],
    };
    if (typeof m.unsignedTxHex === 'string') out.unsignedTxHex = m.unsignedTxHex;
    if (m.protocol === 'btc' || m.protocol === 'opnet') out.protocol = m.protocol;
    if (Array.isArray(m.inputs)) {
      const inputs: Array<{ scriptHex: string; valueSat: string; tweaked: boolean }> = [];
      for (const inp of m.inputs) {
        if (!inp || typeof inp !== 'object') return null;
        const item = inp as Record<string, unknown>;
        if (
          typeof item.scriptHex !== 'string' ||
          typeof item.valueSat !== 'string' ||
          typeof item.tweaked !== 'boolean'
        ) return null;
        inputs.push({ scriptHex: item.scriptHex, valueSat: item.valueSat, tweaked: item.tweaked });
      }
      out.inputs = inputs;
    }
    if (m.btcParams && typeof m.btcParams === 'object') {
      const bp = m.btcParams as Record<string, unknown>;
      if (
        typeof bp.to !== 'string' ||
        typeof bp.amountSat !== 'string' ||
        typeof bp.feeRate !== 'number' ||
        (bp.network !== 'mainnet' && bp.network !== 'testnet') ||
        typeof bp.frostP2tr !== 'string' ||
        typeof bp.frostUntweakedPubKeyHex !== 'string' ||
        !Array.isArray(bp.utxos)
      ) return null;
      const utxos: Array<{ transactionId: string; outputIndex: number; valueSat: string }> = [];
      for (const u of bp.utxos) {
        if (!u || typeof u !== 'object') return null;
        const item = u as Record<string, unknown>;
        if (
          typeof item.transactionId !== 'string' ||
          typeof item.outputIndex !== 'number' ||
          typeof item.valueSat !== 'string'
        ) return null;
        utxos.push({
          transactionId: item.transactionId,
          outputIndex: item.outputIndex,
          valueSat: item.valueSat,
        });
      }
      out.btcParams = {
        to: bp.to,
        amountSat: bp.amountSat,
        feeRate: bp.feeRate,
        network: bp.network,
        frostP2tr: bp.frostP2tr,
        frostUntweakedPubKeyHex: bp.frostUntweakedPubKeyHex,
        utxos,
      };
    }
    if (m.hints && typeof m.hints === 'object') {
      const h = m.hints as Record<string, unknown>;
      const hints: { contractAddress?: string; method?: string; amountTokenAtomic?: string } = {};
      if (typeof h.contractAddress === 'string') hints.contractAddress = h.contractAddress;
      if (typeof h.method === 'string') hints.method = h.method;
      if (typeof h.amountTokenAtomic === 'string') hints.amountTokenAtomic = h.amountTokenAtomic;
      out.hints = hints;
    }
    return out;
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

export interface AnnounceHints {
  contractAddress?: string;
  method?: string;
  amountTokenAtomic?: string;
}

export interface AnnounceBtcParams {
  to: string;
  amountSat: string;
  feeRate: number;
  network: 'mainnet' | 'testnet';
  frostP2tr: string;
  frostUntweakedPubKeyHex: string;
  utxos: ReadonlyArray<{ transactionId: string; outputIndex: number; valueSat: string }>;
}

/** BTC construction-params variant — participants rebuild from `btcParams`. */
export interface AnnounceFrostBtcExtras {
  protocol: 'btc';
  btcParams: AnnounceBtcParams;
}

/** OPNet raw-tx variant — participants re-extract sighashes from the tx + inputs. */
export interface AnnounceFrostOpnetExtras {
  protocol: 'opnet';
  unsignedTxHex: string;
  inputs: ReadonlyArray<{ scriptHex: string; valueSat: string; tweaked: boolean }>;
  hints?: AnnounceHints;
}

export type AnnounceFrostExtras = AnnounceFrostBtcExtras | AnnounceFrostOpnetExtras;

export function announceFrostMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  sighashes: ReadonlyArray<{ hash: Uint8Array; tweaked: boolean }>,
  signers: PartyId[],
  extras?: AnnounceFrostExtras,
): CeremonyMessage {
  const msg: Extract<CeremonyMessage, { kind: 'announce-frost' }> = {
    v: 1,
    kind: 'announce-frost',
    ceremonyId,
    baseCeremonyId,
    sighashes: sighashes.map(s => ({ hashHex: toHex(s.hash), tweaked: s.tweaked })),
    signers,
  };
  if (extras) {
    msg.protocol = extras.protocol;
    if (extras.protocol === 'btc') {
      msg.btcParams = {
        to: extras.btcParams.to,
        amountSat: extras.btcParams.amountSat,
        feeRate: extras.btcParams.feeRate,
        network: extras.btcParams.network,
        frostP2tr: extras.btcParams.frostP2tr,
        frostUntweakedPubKeyHex: extras.btcParams.frostUntweakedPubKeyHex,
        utxos: extras.btcParams.utxos.map((u) => ({
          transactionId: u.transactionId,
          outputIndex: u.outputIndex,
          valueSat: u.valueSat,
        })),
      };
    } else {
      msg.unsignedTxHex = extras.unsignedTxHex;
      msg.inputs = extras.inputs.map((inp) => ({
        scriptHex: inp.scriptHex,
        valueSat: inp.valueSat,
        tweaked: inp.tweaked,
      }));
      if (extras.hints) {
        const h: AnnounceHints = {};
        if (extras.hints.contractAddress !== undefined) h.contractAddress = extras.hints.contractAddress;
        if (extras.hints.method !== undefined) h.method = extras.hints.method;
        if (extras.hints.amountTokenAtomic !== undefined) h.amountTokenAtomic = extras.hints.amountTokenAtomic;
        msg.hints = h;
      }
    }
  }
  return msg;
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
