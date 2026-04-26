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
  /**
   * Leader announcement of a FROST signing ceremony. Single attempt — FROST
   * combine is deterministic. The `protocol` discriminant is mandatory and
   * selects which construction data accompanies the announce:
   *
   * - `'btc'`: `btcParams` — participants rebuild the tx and verify sighashes.
   * - `'opnet'`: `unsignedTxHex` + `inputs` — participants re-extract sighashes
   *   from leader-supplied raw bytes. Advisory `hints` populate the spec.
   * - `'opnet-params'`: `opnetParams` — participants re-run `captureOpnetSighashes`
   *   with the same asserted UTXOs / challenge / random-bytes seed and verify
   *   the resulting sighashes match. `contractAddress` + `method` land on the
   *   spec as STRUCTURALLY-verified fields (policy rules gate on them).
   * - `'keylink'`: `network` — participants sign the SDK key-link hash the
   *   daemon produces as part of DKG finalization (see `computeKeyLinkHash`).
   *   Currently unverified at the orchestrator (the inputs to the hash are
   *   DKG-derived, so recomputation is possible; wire it when needed).
   */
  | AnnounceFrostMessage
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
    }
  /**
   * Control-plane: distribute a `.otzi.json` manifest to every peer during
   * the bootstrap window. Authenticated by HMAC-SHA-256 over the operator-typed
   * shared `bootstrap-secret`. Receivers drop with `ControlPlaneClosed` once
   * `share-persistence` has unlinked the secret post-DKG. Carries the verbatim
   * manifest text (no canonicalization — HMAC is over the exact bytes).
   */
  | {
      v: 1;
      kind: 'manifest-push';
      manifest: string;
      hmac: string;
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
    const base = {
      v: 1 as const,
      kind: 'announce-frost' as const,
      ceremonyId: m.ceremonyId,
      baseCeremonyId: m.baseCeremonyId,
      sighashes,
      signers: m.signers as PartyId[],
    };

    if (m.protocol === 'btc') {
      if (!m.btcParams || typeof m.btcParams !== 'object') return null;
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
      return {
        ...base,
        protocol: 'btc',
        btcParams: {
          to: bp.to,
          amountSat: bp.amountSat,
          feeRate: bp.feeRate,
          network: bp.network,
          frostP2tr: bp.frostP2tr,
          frostUntweakedPubKeyHex: bp.frostUntweakedPubKeyHex,
          utxos,
        },
      };
    }

    if (m.protocol === 'opnet') {
      if (typeof m.unsignedTxHex !== 'string' || !Array.isArray(m.inputs)) return null;
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
      const out: AnnounceFrostMessage = {
        ...base,
        protocol: 'opnet',
        unsignedTxHex: m.unsignedTxHex,
        inputs,
      };
      if (m.hints && typeof m.hints === 'object') {
        const h = m.hints as Record<string, unknown>;
        const hints: AnnounceHints = {};
        if (typeof h.contractAddress === 'string') hints.contractAddress = h.contractAddress;
        if (typeof h.method === 'string') hints.method = h.method;
        if (typeof h.amountTokenAtomic === 'string') hints.amountTokenAtomic = h.amountTokenAtomic;
        out.hints = hints;
      }
      return out;
    }

    if (m.protocol === 'opnet-params') {
      const parsed = parseOpnetParams(m.opnetParams);
      if (!parsed) return null;
      return {
        ...base,
        protocol: 'opnet-params',
        opnetParams: parsed,
      };
    }

    if (m.protocol === 'keylink') {
      if (m.network !== 'mainnet' && m.network !== 'testnet') return null;
      return {
        ...base,
        protocol: 'keylink',
        network: m.network,
      };
    }

    return null;
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
  if (m.kind === 'manifest-push') {
    if (typeof m.manifest !== 'string') return null;
    if (typeof m.hmac !== 'string' || m.hmac.length === 0 || !MANIFEST_PUSH_HEX_RE.test(m.hmac)) return null;
    return {
      v: 1,
      kind: 'manifest-push',
      manifest: m.manifest,
      hmac: m.hmac.toLowerCase(),
    };
  }
  return null;
}

const MANIFEST_PUSH_HEX_RE = /^[0-9a-fA-F]+$/;

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

/**
 * UTXO in on-wire raw form. Mirrors OPNet's `IUTXO` / `RawUTXOResponse` shape
 * so participants can do `new UTXO(raw, raw.isCSV)` during rebuild. The
 * `value` field is a decimal string (bigint-safe over JSON). `scriptPubKey`
 * is a pass-through structure — the SDK consumes it verbatim during
 * `signInteraction` (no daemon-side parsing).
 */
export interface AnnounceOpnetUtxoRaw {
  transactionId: string;
  outputIndex: number;
  value: string;
  scriptPubKey: unknown;
  raw?: string;
  witnessScript?: string;
  redeemScript?: string;
  isCSV?: boolean;
}

/**
 * Full OPNet construction-params payload. The leader fetches UTXOs +
 * challenge from the provider, generates a 32B random seed, and asserts all
 * three on-wire. Participants run `captureOpnetSighashes` with identical
 * inputs and verify the resulting sighashes match. Same deterministic-rebuild
 * trust model as BTC's `btcParams`: if the leader lies about prevout state,
 * broadcast fails at OPNet consensus — DoS at worst, never theft
 * (federation-trust posture).
 */
export interface AnnounceOpnetParams {
  contractAddress: string;
  method: string;
  /** Pre-conversion, JSON-safe — strings / numbers / booleans. */
  params: ReadonlyArray<unknown>;
  paramTypes?: ReadonlyArray<'address' | 'u256' | 'bytes'>;
  refundAddress: string;
  feeRate: number;
  priorityFeeSat: string;
  maxSatToSpendSat: string;
  /** 32-byte random seed for deterministic `BitcoinUtils.rndBytes()` during capture. */
  randomBytesSeedHex: string;
  utxos: ReadonlyArray<AnnounceOpnetUtxoRaw>;
  /** `ChallengeSolution.toRaw()` form — participant does `new ChallengeSolution(raw)`. */
  challenge: Record<string, unknown>;
  /**
   * ML-DSA threshold signature over `sha256(calldata)` — the outer OPNet
   * tx-level auth. Operator computes via a prior `/sign scheme='mldsa'`
   * ceremony and hands it to the daemon as a `LeaderSignOpnetParamsRequest`
   * field; leader asserts on-wire; participants use the asserted bytes
   * during capture. Cryptographic verify is omitted in the participant verify
   * step — a forged sig produces sighashes that also verify (since they
   * commit to the tx bytes including the bad sig) and the tx fails at OPNet
   * broadcast consensus → DoS, not theft. Matches federation-trust posture.
   */
  mldsaThresholdSignatureHex: string;
  hints?: AnnounceHints;
}

/**
 * OPNet construction-params variant — participants re-run the capture with
 * asserted UTXOs + challenge + random-bytes seed and verify the resulting
 * sighashes match the leader's assertion. The `contractAddress` + 4-byte
 * method selector end up as STRUCTURALLY-verified fields on the `SigningSpec`,
 * so policy rules (`allowed_contracts`, `method_allowlist`) evaluate against
 * trusted data — unlike the legacy `opnet` variant whose `hints` are advisory.
 */
export interface AnnounceFrostOpnetParamsExtras {
  protocol: 'opnet-params';
  opnetParams: AnnounceOpnetParams;
}

/**
 * Key-link signing — the FROST Schnorr sig over `computeKeyLinkHash(...)`
 * that OPNet's SDK replays via `withFrostLegacySig` during contract-call
 * construction against a V3 vault. The hash inputs (mldsaPubKey + both
 * FROST pubkeys) are DKG-derived, so participants already hold them; the
 * wire carries only `network` (the remaining input). Unverified at the
 * orchestrator today — threading DKG state into the verify function is
 * the trivially-pluggable upgrade.
 */
export interface AnnounceFrostKeylinkExtras {
  protocol: 'keylink';
  network: 'mainnet' | 'testnet';
}

export type AnnounceFrostExtras =
  | AnnounceFrostBtcExtras
  | AnnounceFrostOpnetExtras
  | AnnounceFrostOpnetParamsExtras
  | AnnounceFrostKeylinkExtras;

/**
 * Wire shape of an `announce-frost` message — the common header intersected
 * with one of the three `AnnounceFrostExtras` variants. The extras variant
 * is MANDATORY: every production signing path carries construction data.
 * Tests that only exercise ceremony mechanics use `makeDummyFrostKeylinkExtras`.
 */
export type AnnounceFrostMessage = {
  v: 1;
  kind: 'announce-frost';
  ceremonyId: string;
  baseCeremonyId: string;
  sighashes: Array<{ hashHex: string; tweaked: boolean }>;
  signers: PartyId[];
} & AnnounceFrostExtras;

/**
 * Dummy extras for ceremony-mechanics tests that don't care about tx
 * specifics — produces a `keylink` variant, which is unverified at the
 * orchestrator. Production code never calls this.
 */
export function makeDummyFrostKeylinkExtras(
  network: 'mainnet' | 'testnet' = 'testnet',
): AnnounceFrostKeylinkExtras {
  return { protocol: 'keylink', network };
}

export function announceFrostMessage(
  ceremonyId: string,
  baseCeremonyId: string,
  sighashes: ReadonlyArray<{ hash: Uint8Array; tweaked: boolean }>,
  signers: PartyId[],
  extras: AnnounceFrostExtras,
): CeremonyMessage {
  const base = {
    v: 1 as const,
    kind: 'announce-frost' as const,
    ceremonyId,
    baseCeremonyId,
    sighashes: sighashes.map((s) => ({ hashHex: toHex(s.hash), tweaked: s.tweaked })),
    signers: [...signers],
  };
  if (extras.protocol === 'btc') {
    return {
      ...base,
      protocol: 'btc',
      btcParams: {
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
      },
    };
  }
  if (extras.protocol === 'opnet') {
    const msg: AnnounceFrostMessage = {
      ...base,
      protocol: 'opnet',
      unsignedTxHex: extras.unsignedTxHex,
      inputs: extras.inputs.map((inp) => ({
        scriptHex: inp.scriptHex,
        valueSat: inp.valueSat,
        tweaked: inp.tweaked,
      })),
    };
    if (extras.hints) {
      const h: AnnounceHints = {};
      if (extras.hints.contractAddress !== undefined) h.contractAddress = extras.hints.contractAddress;
      if (extras.hints.method !== undefined) h.method = extras.hints.method;
      if (extras.hints.amountTokenAtomic !== undefined) h.amountTokenAtomic = extras.hints.amountTokenAtomic;
      msg.hints = h;
    }
    return msg;
  }
  if (extras.protocol === 'opnet-params') {
    return {
      ...base,
      protocol: 'opnet-params',
      opnetParams: encodeOpnetParams(extras.opnetParams),
    };
  }
  return {
    ...base,
    protocol: 'keylink',
    network: extras.network,
  };
}

function encodeOpnetParams(p: AnnounceOpnetParams): AnnounceOpnetParams {
  const out: AnnounceOpnetParams = {
    contractAddress: p.contractAddress,
    method: p.method,
    params: [...p.params],
    refundAddress: p.refundAddress,
    feeRate: p.feeRate,
    priorityFeeSat: p.priorityFeeSat,
    maxSatToSpendSat: p.maxSatToSpendSat,
    randomBytesSeedHex: p.randomBytesSeedHex,
    mldsaThresholdSignatureHex: p.mldsaThresholdSignatureHex,
    utxos: p.utxos.map((u) => {
      const clone: AnnounceOpnetUtxoRaw = {
        transactionId: u.transactionId,
        outputIndex: u.outputIndex,
        value: u.value,
        scriptPubKey: u.scriptPubKey,
      };
      if (u.raw !== undefined) clone.raw = u.raw;
      if (u.witnessScript !== undefined) clone.witnessScript = u.witnessScript;
      if (u.redeemScript !== undefined) clone.redeemScript = u.redeemScript;
      if (u.isCSV !== undefined) clone.isCSV = u.isCSV;
      return clone;
    }),
    challenge: p.challenge,
  };
  if (p.paramTypes) out.paramTypes = [...p.paramTypes];
  if (p.hints) {
    const h: AnnounceHints = {};
    if (p.hints.contractAddress !== undefined) h.contractAddress = p.hints.contractAddress;
    if (p.hints.method !== undefined) h.method = p.hints.method;
    if (p.hints.amountTokenAtomic !== undefined) h.amountTokenAtomic = p.hints.amountTokenAtomic;
    out.hints = h;
  }
  return out;
}

/**
 * Parse the raw-JSON `opnetParams` blob off an announce. Structural validation
 * only (top-level fields + utxo shape); the `challenge` pass-through is checked
 * at reconstruction time (`new ChallengeSolution(raw)` throws on malformed
 * data, which silent-drops the announce — matches federation-trust posture).
 */
function parseOpnetParams(raw: unknown): AnnounceOpnetParams | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.contractAddress !== 'string' ||
    typeof p.method !== 'string' ||
    !Array.isArray(p.params) ||
    typeof p.refundAddress !== 'string' ||
    typeof p.feeRate !== 'number' ||
    typeof p.priorityFeeSat !== 'string' ||
    typeof p.maxSatToSpendSat !== 'string' ||
    typeof p.randomBytesSeedHex !== 'string' ||
    typeof p.mldsaThresholdSignatureHex !== 'string' ||
    !Array.isArray(p.utxos) ||
    !p.challenge ||
    typeof p.challenge !== 'object'
  ) return null;

  if (!/^[0-9a-fA-F]+$/.test(p.randomBytesSeedHex) || p.randomBytesSeedHex.length !== 64) return null;
  if (!/^[0-9a-fA-F]+$/.test(p.mldsaThresholdSignatureHex) || p.mldsaThresholdSignatureHex.length === 0) return null;
  if (!/^\d+$/.test(p.priorityFeeSat)) return null;
  if (!/^\d+$/.test(p.maxSatToSpendSat)) return null;

  let paramTypes: ReadonlyArray<'address' | 'u256' | 'bytes'> | undefined;
  if (p.paramTypes !== undefined) {
    if (!Array.isArray(p.paramTypes)) return null;
    const out: Array<'address' | 'u256' | 'bytes'> = [];
    for (const t of p.paramTypes) {
      if (t !== 'address' && t !== 'u256' && t !== 'bytes') return null;
      out.push(t);
    }
    paramTypes = out;
  }

  const utxos: AnnounceOpnetUtxoRaw[] = [];
  for (const u of p.utxos) {
    if (!u || typeof u !== 'object') return null;
    const item = u as Record<string, unknown>;
    if (
      typeof item.transactionId !== 'string' ||
      typeof item.outputIndex !== 'number' ||
      typeof item.value !== 'string' ||
      !item.scriptPubKey ||
      typeof item.scriptPubKey !== 'object'
    ) return null;
    if (!/^\d+$/.test(item.value)) return null;
    const clone: AnnounceOpnetUtxoRaw = {
      transactionId: item.transactionId,
      outputIndex: item.outputIndex,
      value: item.value,
      scriptPubKey: item.scriptPubKey,
    };
    if (typeof item.raw === 'string') clone.raw = item.raw;
    if (typeof item.witnessScript === 'string') clone.witnessScript = item.witnessScript;
    if (typeof item.redeemScript === 'string') clone.redeemScript = item.redeemScript;
    if (typeof item.isCSV === 'boolean') clone.isCSV = item.isCSV;
    utxos.push(clone);
  }

  let hints: AnnounceHints | undefined;
  if (p.hints && typeof p.hints === 'object') {
    const h = p.hints as Record<string, unknown>;
    hints = {};
    if (typeof h.contractAddress === 'string') hints.contractAddress = h.contractAddress;
    if (typeof h.method === 'string') hints.method = h.method;
    if (typeof h.amountTokenAtomic === 'string') hints.amountTokenAtomic = h.amountTokenAtomic;
  }

  const out: AnnounceOpnetParams = {
    contractAddress: p.contractAddress,
    method: p.method,
    params: [...p.params],
    refundAddress: p.refundAddress,
    feeRate: p.feeRate,
    priorityFeeSat: p.priorityFeeSat,
    maxSatToSpendSat: p.maxSatToSpendSat,
    randomBytesSeedHex: p.randomBytesSeedHex,
    utxos,
    challenge: p.challenge as Record<string, unknown>,
    mldsaThresholdSignatureHex: p.mldsaThresholdSignatureHex,
  };
  if (paramTypes) out.paramTypes = paramTypes;
  if (hints) out.hints = hints;
  return out;
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

export function manifestPushMessage(opts: { manifest: string; hmac: string }): CeremonyMessage {
  return { v: 1, kind: 'manifest-push', manifest: opts.manifest, hmac: opts.hmac.toLowerCase() };
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
