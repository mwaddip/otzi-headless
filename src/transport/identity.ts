/**
 * Long-term ECDH P-256 identity keys.
 *
 * Each daemon owns one keypair. The public half is distributed to peers
 * during bootstrap (phase 3c) and pinned in the pubkey book. Handshakes
 * (3b) mix the static keys with fresh ephemeral keys to derive session
 * secrets.
 *
 * On-disk storage (handled by phase 3c):
 *   - Private key: PKCS#8 DER bytes, operator-managed file (mode 0600).
 *   - Public key: 65-byte raw uncompressed point (0x04 || X || Y).
 *
 * Runtime storage uses Web Crypto `CryptoKey` handles — private keys are
 * loaded non-extractable so they can't be exfiltrated from process memory
 * after daemon startup.
 */

export interface IdentityKeyPair {
  /** ECDH P-256 private key. Non-extractable at runtime; extractable only during bootstrap for one-time export. */
  privateKey: CryptoKey;
  /** 65 bytes — uncompressed P-256 point. Safe to copy / share. */
  publicKeyRaw: Uint8Array;
}

/** Cast a Uint8Array to ArrayBuffer for strict Web Crypto `BufferSource` typing. */
function toBuf(arr: Uint8Array): ArrayBuffer {
  return new Uint8Array(arr).buffer as ArrayBuffer;
}

/**
 * Generate a new ECDH P-256 keypair.
 * Default is `extractable: false` — the private key stays in process memory only.
 * Pass `extractable: true` once during bootstrap to export PKCS#8 for disk storage.
 */
export async function generateIdentity(extractable = false): Promise<IdentityKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    extractable,
    ['deriveBits'],
  );
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyRaw };
}

/** Import a peer's 65-byte raw public key for ECDH. */
export async function importPeerPubKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 0x04)
    throw new Error(
      `importPeerPubKey: expected 65-byte uncompressed P-256 point (0x04||X||Y), got ${raw.length} bytes starting with 0x${(raw[0] ?? 0).toString(16)}`,
    );
  return crypto.subtle.importKey(
    'raw',
    toBuf(raw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

/**
 * Load an identity from stored bytes.
 * Phase 3c writes PKCS#8 priv + raw pub to disk and re-inflates with this.
 */
export async function importIdentity(
  privKeyPkcs8: Uint8Array,
  publicKeyRaw: Uint8Array,
  extractable = false,
): Promise<IdentityKeyPair> {
  if (publicKeyRaw.length !== 65 || publicKeyRaw[0] !== 0x04)
    throw new Error(
      `importIdentity: public key must be 65-byte uncompressed P-256 (got ${publicKeyRaw.length} bytes)`,
    );
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    toBuf(privKeyPkcs8),
    { name: 'ECDH', namedCurve: 'P-256' },
    extractable,
    ['deriveBits'],
  );
  return { privateKey, publicKeyRaw: new Uint8Array(publicKeyRaw) };
}

/**
 * Export an identity's private key as PKCS#8 DER.
 * Requires the keypair to have been generated / imported with `extractable: true`.
 * Typically called exactly once during bootstrap to persist to disk, then discarded.
 */
export async function exportPrivateKeyPkcs8(pair: IdentityKeyPair): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return new Uint8Array(pkcs8);
}
