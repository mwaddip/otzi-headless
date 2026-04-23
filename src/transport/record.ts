/**
 * AES-256-GCM record layer for the peer-mesh and relay transports.
 *
 * Per-direction state:
 *   - 256-bit key (derived from the handshake in phase 3b via HKDF).
 *   - 32-bit salt (xor'd into the nonce — prevents direction-confusion attacks).
 *   - 64-bit frame counter (monotone; per-direction).
 *
 * Nonce = salt(4B) || counter_be64(8B) — TLS 1.3 convention. The counter is
 * bumped synchronously before each async crypto call, so concurrent `seal`
 * calls on a single session produce distinct nonces safely (send side only —
 * open assumes a single ordered-delivery consumer).
 *
 * This layer is pure: no I/O, no transport coupling, no re-key logic. Re-key
 * is a session-layer concern (3c) — the record layer signals readiness via
 * `shouldRekey()` and refuses to seal past `MAX_COUNTER`.
 *
 * AES-GCM caveat: with a 96-bit nonce, ~2^32 frames per key is the NIST
 * comfort bound. We set the soft re-key threshold at 2^48 (generous for a
 * ceremony daemon's traffic shape — thousands of frames per day); hard
 * overflow at 2^64. Session layer must re-key before the soft bound.
 */

export interface RecordSecrets {
  /** 32 bytes. Initiator's send direction = responder's recv direction. */
  sendKey: Uint8Array;
  /** 32 bytes. */
  recvKey: Uint8Array;
  /** 4 bytes. Prepended to counter to form the 12-byte nonce. */
  sendSalt: Uint8Array;
  /** 4 bytes. */
  recvSalt: Uint8Array;
}

/** 2^48 frames — soft limit, triggers `shouldRekey()`. */
export const REKEY_SOFT_LIMIT = 1n << 48n;
/** 2^64 - 1 — hard limit; seal/open throw beyond. */
export const MAX_COUNTER = (1n << 64n) - 1n;

const NONCE_LEN = 12;

export class RecordSession {
  private sendCounter = 0n;
  private recvCounter = 0n;

  private constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
    private readonly sendSalt: Uint8Array,
    private readonly recvSalt: Uint8Array,
  ) {}

  static async create(secrets: RecordSecrets): Promise<RecordSession> {
    assertLen(secrets.sendKey, 32, 'sendKey');
    assertLen(secrets.recvKey, 32, 'recvKey');
    assertLen(secrets.sendSalt, 4, 'sendSalt');
    assertLen(secrets.recvSalt, 4, 'recvSalt');
    const [sendKey, recvKey] = await Promise.all([
      importAesKey(secrets.sendKey),
      importAesKey(secrets.recvKey),
    ]);
    return new RecordSession(
      sendKey,
      recvKey,
      // Copy so external mutation after `create` can't tamper with state.
      new Uint8Array(secrets.sendSalt),
      new Uint8Array(secrets.recvSalt),
    );
  }

  async seal(plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
    const counter = this.sendCounter;
    if (counter >= MAX_COUNTER) {
      throw new Error('RecordSession: send counter exhausted — hard limit reached');
    }
    this.sendCounter = counter + 1n;
    const iv = makeNonce(this.sendSalt, counter);
    const params: AesGcmParams = aad
      ? { name: 'AES-GCM', iv: toBuf(iv), additionalData: toBuf(aad) }
      : { name: 'AES-GCM', iv: toBuf(iv) };
    const out = await crypto.subtle.encrypt(params, this.sendKey, toBuf(plaintext));
    return new Uint8Array(out);
  }

  async open(ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
    const counter = this.recvCounter;
    if (counter >= MAX_COUNTER) {
      throw new Error('RecordSession: recv counter exhausted — hard limit reached');
    }
    const iv = makeNonce(this.recvSalt, counter);
    const params: AesGcmParams = aad
      ? { name: 'AES-GCM', iv: toBuf(iv), additionalData: toBuf(aad) }
      : { name: 'AES-GCM', iv: toBuf(iv) };
    let out: ArrayBuffer;
    try {
      out = await crypto.subtle.decrypt(params, this.recvKey, toBuf(ciphertext));
    } catch (err) {
      // Per TLS 1.3: auth failure → tear down. Counter NOT advanced so the
      // session is in a clean state for cleanup. Caller must not retry open
      // on the same frame.
      throw new Error(
        `RecordSession: AES-GCM auth failed at counter ${counter} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    this.recvCounter = counter + 1n;
    return new Uint8Array(out);
  }

  /** Monotone send-side frame counter (number of successful seals). */
  get sendFrames(): bigint {
    return this.sendCounter;
  }

  /** Monotone recv-side frame counter (number of successful opens). */
  get recvFrames(): bigint {
    return this.recvCounter;
  }

  /**
   * Returns true when either direction has reached the soft re-key threshold.
   * Session layer should initiate a re-key handshake; hard overflow is a
   * protocol error.
   */
  shouldRekey(threshold: bigint = REKEY_SOFT_LIMIT): boolean {
    return this.sendCounter >= threshold || this.recvCounter >= threshold;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function assertLen(bytes: Uint8Array, want: number, name: string): void {
  if (bytes.length !== want)
    throw new Error(`RecordSession: ${name} must be ${want} bytes (got ${bytes.length})`);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBuf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Cast a Uint8Array to ArrayBuffer for Web Crypto `BufferSource` params in strict TS. */
function toBuf(arr: Uint8Array): ArrayBuffer {
  return new Uint8Array(arr).buffer as ArrayBuffer;
}

/** salt(4) || counter_be64(8) — 12-byte nonce. */
export function makeNonce(salt: Uint8Array, counter: bigint): Uint8Array {
  if (counter < 0n) throw new Error('makeNonce: counter must be >= 0');
  if (counter > MAX_COUNTER) throw new Error('makeNonce: counter exceeds u64');
  const nonce = new Uint8Array(NONCE_LEN);
  nonce.set(salt, 0);
  // Big-endian u64 at offset 4.
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setBigUint64(4, counter, false);
  return nonce;
}
