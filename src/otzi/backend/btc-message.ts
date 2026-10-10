/**
 * Bitcoin message signature verification for wallet sign-in.
 *
 * Accepts BIP-322 "simple" signatures (P2WPKH, P2TR key-path) and legacy
 * signmessage / BIP-137 signatures (P2PKH, P2SH-P2WPKH, P2WPKH).
 */

import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const te = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(te.encode(tag));
  return sha256(concat(t, t, msg));
}

/** Decode an address on mainnet or the test networks. */
function decodeAddress(address: string): { script: Uint8Array; decoded: ReturnType<ReturnType<typeof btc.Address>['decode']>; network: typeof btc.NETWORK } | null {
  for (const network of [btc.NETWORK, btc.TEST_NETWORK]) {
    try {
      const decoded = btc.Address(network).decode(address);
      return { decoded, script: btc.OutScript.encode(decoded), network };
    } catch { /* try next */ }
  }
  return null;
}

export function isValidSignInAddress(address: string): boolean {
  return decodeAddress(address) !== null;
}

// ── BIP-322 simple ──

export function bip322MessageHash(message: string): Uint8Array {
  return taggedHash('BIP0322-signed-message', te.encode(message));
}

function readWitness(bytes: Uint8Array): Uint8Array[] {
  let p = 0;
  const readVarint = (): number => {
    const first = bytes[p++];
    if (first === undefined) throw new Error('truncated');
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = bytes[p]! | (bytes[p + 1]! << 8);
      p += 2;
      return v;
    }
    throw new Error('witness item too large');
  };
  const count = readVarint();
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const len = readVarint();
    if (p + len > bytes.length) throw new Error('truncated');
    items.push(bytes.slice(p, p + len));
    p += len;
  }
  if (p !== bytes.length) throw new Error('trailing bytes');
  return items;
}

function bip322ToSign(script: Uint8Array, message: string): btc.Transaction {
  const toSpend = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  toSpend.addOutput({ script, amount: 0n });
  toSpend.addInput({
    txid: new Uint8Array(32),
    index: 0xffffffff,
    sequence: 0,
    finalScriptSig: btc.Script.encode(['OP_0', bip322MessageHash(message)]),
  });
  const toSign = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  toSign.addInput({ txid: toSpend.id, index: 0, sequence: 0, witnessUtxo: { script, amount: 0n } });
  toSign.addOutput({ script: btc.Script.encode(['RETURN']), amount: 0n });
  return toSign;
}

function verifyBip322Simple(address: string, message: string, sigBytes: Uint8Array): boolean {
  const addr = decodeAddress(address);
  if (!addr) return false;
  const witness = readWitness(sigBytes);
  const toSign = bip322ToSign(addr.script, message);
  const decoded = addr.decoded;

  if (decoded.type === 'wpkh') {
    if (witness.length !== 2) return false;
    const [sig, pub] = witness as [Uint8Array, Uint8Array];
    if (pub.length !== 33 || !equal(hash160(pub), decoded.hash)) return false;
    if (sig[sig.length - 1] !== btc.SigHash.ALL) return false;
    const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: decoded.hash });
    const preimage = toSign.preimageWitnessV0(0, scriptCode, btc.SigHash.ALL, 0n);
    return secp256k1.verify(sig.slice(0, -1), preimage, pub, { prehash: false, format: 'der', lowS: false });
  }

  if (decoded.type === 'tr') {
    if (witness.length !== 1) return false;
    const sig = witness[0]!;
    if (sig.length !== 64 && sig.length !== 65) return false;
    const hashType = sig.length === 65 ? sig[64]! : btc.SigHash.DEFAULT;
    if (hashType !== btc.SigHash.DEFAULT && hashType !== btc.SigHash.ALL) return false;
    if (sig.length === 65 && hashType === btc.SigHash.DEFAULT) return false;
    const preimage = toSign.preimageWitnessV1(0, [addr.script], hashType, [0n]);
    return schnorr.verify(sig.slice(0, 64), preimage, decoded.pubkey);
  }

  return false;
}

// ── Legacy signmessage / BIP-137 ──

export function legacyMessageHash(message: string): Uint8Array {
  const prefix = te.encode('Bitcoin Signed Message:\n');
  const body = te.encode(message);
  return sha256(sha256(concat(varint(prefix.length), prefix, varint(body.length), body)));
}

function verifyLegacy(address: string, message: string, sig: Uint8Array): boolean {
  const addr = decodeAddress(address);
  if (!addr || sig.length !== 65) return false;
  const header = sig[0]!;
  if (header < 27 || header > 42) return false;
  const recovery = (header - 27) & 3;
  const compressed = header >= 31;

  let pub: Uint8Array;
  try {
    const recovered = secp256k1.recoverPublicKey(concat(Uint8Array.of(recovery), sig.slice(1)), legacyMessageHash(message), { prehash: false });
    pub = secp256k1.Point.fromBytes(recovered).toBytes(compressed);
  } catch {
    return false;
  }

  const h = hash160(pub);
  const candidates: Uint8Array[] = [btc.OutScript.encode({ type: 'pkh', hash: h })];
  if (compressed) {
    const wpkh = btc.OutScript.encode({ type: 'wpkh', hash: h });
    candidates.push(wpkh, btc.OutScript.encode({ type: 'sh', hash: hash160(wpkh) }));
  }
  return candidates.some(c => equal(c, addr.script));
}

/** True iff `signature` (base64) is a valid signature of `message` by `address`. Never throws. */
export function verifyBitcoinMessage(address: string, message: string, signature: string): boolean {
  try {
    const sig = base64.decode(signature.trim());
    if (sig.length === 65 && verifyLegacy(address, message, sig)) return true;
    return verifyBip322Simple(address, message, sig);
  } catch {
    return false;
  }
}

