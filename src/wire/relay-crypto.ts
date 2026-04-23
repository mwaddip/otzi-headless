/**
 * E2E encryption for the relay: ECDH key agreement + AES-256-GCM.
 * All operations use the Web Crypto API (no external libraries).
 */

/** Wrap a Uint8Array in a fresh ArrayBuffer to satisfy strict Web Crypto typings. */
function buf(arr: Uint8Array): ArrayBuffer {
  return new Uint8Array(arr).buffer as ArrayBuffer;
}

/** Generate an ephemeral ECDH P-256 keypair. */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // not extractable (private key stays in memory)
    ['deriveBits'],
  );
}

/** Export the public key as raw bytes (65 bytes uncompressed P-256). */
export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/** Import a raw public key (65 bytes) for ECDH. */
export async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    buf(raw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

/**
 * Derive an AES-256-GCM key from ECDH shared secret + HKDF.
 * salt = session code (ASCII), info = "permafrost-relay-v1".
 */
export async function deriveAESKey(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
  sessionCode: string,
): Promise<CryptoKey> {
  // Step 1: ECDH → shared secret bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    256,
  );

  // Step 2: Import shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey'],
  );

  // Step 3: HKDF → AES-256-GCM key
  const salt = new TextEncoder().encode(sessionCode);
  const info = new TextEncoder().encode('permafrost-relay-v1');

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt plaintext with AES-256-GCM. Returns IV (12 bytes) || ciphertext. */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    buf(plaintext),
  );
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

/** Decrypt IV || ciphertext with AES-256-GCM. */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

/** Compute session fingerprint: first 8 hex chars of SHA-256(sorted pubkeys). */
export async function sessionFingerprint(pubkeys: Map<number, Uint8Array>): Promise<string> {
  const sorted = [...pubkeys.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, pk]) => pk);
  let total = 0;
  for (const pk of sorted) total += pk.length;
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const pk of sorted) {
    concat.set(pk, offset);
    offset += pk.length;
  }
  const hash = await crypto.subtle.digest('SHA-256', buf(concat));
  return Array.from(new Uint8Array(hash))
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// -- Helpers for base64 encoding used in wire protocol --

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
