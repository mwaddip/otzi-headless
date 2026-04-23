import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
}

/** Encrypt plaintext with AES-256-GCM + PBKDF2. Returns base64: salt(16) + iv(12) + tag(16) + ciphertext. */
export function encryptConfig(plaintext: string, password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/** Decrypt base64 produced by encryptConfig(). Throws on wrong password. */
export function decryptConfig(encoded: string, password: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const salt = buf.subarray(0, SALT_BYTES);
  const iv = buf.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = buf.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES);
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
