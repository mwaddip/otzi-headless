/**
 * Noise-KK-style handshake over P-256 ECDH.
 *
 * Both peers know each other's static identity public keys in advance
 * (populated during bootstrap — phase 3c). Each handshake exchanges fresh
 * ephemeral P-256 keys and mixes four DH outputs into the key schedule:
 *
 *   dh_ss = ECDH(sI, sR)   — static × static (mutual auth)
 *   dh_es = ECDH(eI, sR)   — initiator-ephemeral × responder-static
 *   dh_se = ECDH(sI, eR)   — initiator-static × responder-ephemeral
 *   dh_ee = ECDH(eI, eR)   — ephemeral × ephemeral (forward secrecy)
 *
 * If either side is impersonating, one of the DH outputs yields a different
 * shared value, the derived traffic keys diverge, and the very first record
 * frame fails AES-GCM authentication — caller tears down the connection.
 * That implicit-key-confirmation is standard for this family of patterns
 * (Noise KK, Signal X3DH, etc).
 *
 * Messages (both cleartext; carry no secrets):
 *   Msg 1 (I → R): eI_pub — 65 bytes (uncompressed P-256 point)
 *   Msg 2 (R → I): eR_pub — 65 bytes
 *
 * Framing / identity-claim headers live one layer up (phase 3d) — this
 * module is pure crypto.
 */

import { importPeerPubKey, type IdentityKeyPair } from './identity';
import type { RecordSecrets } from './record';

const PROTOCOL_LABEL = 'otzi-xk-v1';
const HANDSHAKE_MSG_BYTES = 65;
const DH_OUT_BYTES = 32;
const TRAFFIC_OUT_BYTES = 72; // 32 + 32 + 4 + 4

function toBuf(arr: Uint8Array): ArrayBuffer {
  return new Uint8Array(arr).buffer as ArrayBuffer;
}

// ─────────────────────────────────────────────────────────────────────────
// Initiator
// ─────────────────────────────────────────────────────────────────────────

export interface InitiatorState {
  me: IdentityKeyPair;
  ephemeralPriv: CryptoKey;
  ephemeralPubRaw: Uint8Array;
}

/**
 * Step 1 (initiator): generate an ephemeral keypair; return the message to
 * send + the in-flight handshake state to feed into `initiatorFinish`.
 */
export async function initiatorBegin(me: IdentityKeyPair): Promise<{
  state: InitiatorState;
  message1: Uint8Array;
}> {
  const { privateKey, publicKeyRaw } = await generateEphemeral();
  return {
    state: { me, ephemeralPriv: privateKey, ephemeralPubRaw: publicKeyRaw },
    message1: publicKeyRaw,
  };
}

/**
 * Step 3 (initiator): consume the responder's message, compute the four DH
 * outputs, and derive traffic secrets. Returns `RecordSecrets` oriented for
 * the initiator (sendKey = init→resp, recvKey = resp→init).
 */
export async function initiatorFinish(
  state: InitiatorState,
  message2: Uint8Array,
  peerStaticPubKeyRaw: Uint8Array,
): Promise<RecordSecrets> {
  requireHandshakeMessage(message2, 'message2');
  const eR_pub = await importPeerPubKey(message2);
  const sR_pub = await importPeerPubKey(peerStaticPubKeyRaw);

  const dh_ss = await ecdh(state.me.privateKey, sR_pub);
  const dh_es = await ecdh(state.ephemeralPriv, sR_pub);
  const dh_se = await ecdh(state.me.privateKey, eR_pub);
  const dh_ee = await ecdh(state.ephemeralPriv, eR_pub);

  return deriveTrafficSecrets({
    dh_ss, dh_es, dh_se, dh_ee,
    sI_pub: state.me.publicKeyRaw,
    sR_pub: peerStaticPubKeyRaw,
    eI_pub: state.ephemeralPubRaw,
    eR_pub: message2,
    role: 'initiator',
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Responder
// ─────────────────────────────────────────────────────────────────────────

/**
 * Step 2 (responder): consume the initiator's message, generate own
 * ephemeral, compute the four DH outputs, and return the response + secrets.
 * Responder is single-shot — no intermediate state.
 */
export async function responderRespond(
  me: IdentityKeyPair,
  message1: Uint8Array,
  peerStaticPubKeyRaw: Uint8Array,
): Promise<{ message2: Uint8Array; secrets: RecordSecrets }> {
  requireHandshakeMessage(message1, 'message1');
  const eI_pub = await importPeerPubKey(message1);
  const sI_pub = await importPeerPubKey(peerStaticPubKeyRaw);
  const { privateKey: eR_priv, publicKeyRaw: eR_pubRaw } = await generateEphemeral();

  const dh_ss = await ecdh(me.privateKey, sI_pub);
  const dh_es = await ecdh(me.privateKey, eI_pub);
  const dh_se = await ecdh(eR_priv, sI_pub);
  const dh_ee = await ecdh(eR_priv, eI_pub);

  const secrets = await deriveTrafficSecrets({
    dh_ss, dh_es, dh_se, dh_ee,
    sI_pub: peerStaticPubKeyRaw,
    sR_pub: me.publicKeyRaw,
    eI_pub: message1,
    eR_pub: eR_pubRaw,
    role: 'responder',
  });

  return { message2: eR_pubRaw, secrets };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

async function generateEphemeral(): Promise<{ privateKey: CryptoKey; publicKeyRaw: Uint8Array }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyRaw: raw };
}

async function ecdh(priv: CryptoKey, pub: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, DH_OUT_BYTES * 8);
  return new Uint8Array(bits);
}

interface DeriveInputs {
  dh_ss: Uint8Array;
  dh_es: Uint8Array;
  dh_se: Uint8Array;
  dh_ee: Uint8Array;
  sI_pub: Uint8Array;
  sR_pub: Uint8Array;
  eI_pub: Uint8Array;
  eR_pub: Uint8Array;
  role: 'initiator' | 'responder';
}

async function deriveTrafficSecrets(d: DeriveInputs): Promise<RecordSecrets> {
  const ikm = concat([d.dh_ss, d.dh_es, d.dh_se, d.dh_ee]);
  const transcript = concat([
    new TextEncoder().encode(PROTOCOL_LABEL),
    d.sI_pub,
    d.sR_pub,
    d.eI_pub,
    d.eR_pub,
  ]);
  const saltBuf = await crypto.subtle.digest('SHA-256', toBuf(transcript));
  const info = new TextEncoder().encode(`${PROTOCOL_LABEL}:traffic`);

  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    toBuf(ikm),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBuf, info: toBuf(info) },
    hkdfKey,
    TRAFFIC_OUT_BYTES * 8,
  );
  const out = new Uint8Array(bits);

  const initSendKey = out.slice(0, 32);
  const respSendKey = out.slice(32, 64);
  const initSendSalt = out.slice(64, 68);
  const respSendSalt = out.slice(68, 72);

  if (d.role === 'initiator') {
    return {
      sendKey: initSendKey,
      recvKey: respSendKey,
      sendSalt: initSendSalt,
      recvSalt: respSendSalt,
    };
  }
  return {
    sendKey: respSendKey,
    recvKey: initSendKey,
    sendSalt: respSendSalt,
    recvSalt: initSendSalt,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function requireHandshakeMessage(bytes: Uint8Array, name: string): void {
  if (bytes.length !== HANDSHAKE_MSG_BYTES)
    throw new Error(
      `handshake ${name}: expected ${HANDSHAKE_MSG_BYTES} bytes (got ${bytes.length})`,
    );
  if (bytes[0] !== 0x04)
    throw new Error(
      `handshake ${name}: expected uncompressed P-256 point (0x04 prefix), got 0x${(bytes[0] ?? 0).toString(16)}`,
    );
}
