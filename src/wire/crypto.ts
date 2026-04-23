/**
 * AES-256-GCM encryption/decryption for PERMAFROST share files.
 * Uses Web Crypto API (available in all modern browsers).
 * Key derivation: PBKDF2 (600k iterations, SHA-256) from password.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** Cast to satisfy Web Crypto BufferSource types in strict TS. */
function buf(arr: Uint8Array): ArrayBuffer {
  return new Uint8Array(arr).buffer as ArrayBuffer;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt data with AES-256-GCM using a password.
 * Returns base64 string: salt(16) + iv(12) + ciphertext.
 */
export async function encrypt(data: Uint8Array, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(data),
  );
  // Concatenate: salt + iv + ciphertext
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
  let binary = '';
  for (let i = 0; i < combined.length; i++) {
    binary += String.fromCharCode(combined[i]!);
  }
  return btoa(binary);
}

/**
 * Decrypt a base64 string produced by encrypt().
 * Returns the original plaintext bytes.
 * Throws on wrong password or corrupted data.
 */
export async function decrypt(encoded: string, password: string): Promise<Uint8Array> {
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const salt = combined.slice(0, SALT_BYTES);
  const iv = combined.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = combined.slice(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(password, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(ciphertext),
  );
  return new Uint8Array(plaintext);
}
