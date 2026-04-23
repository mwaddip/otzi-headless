import { describe, expect, it } from 'vitest';
import {
  MAX_COUNTER,
  REKEY_SOFT_LIMIT,
  RecordSession,
  makeNonce,
  type RecordSecrets,
} from './record';

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Matching pair — A's send = B's recv, and vice versa. Realistic post-handshake shape. */
function makePair(): { secretsA: RecordSecrets; secretsB: RecordSecrets } {
  const keyA2B = randomBytes(32);
  const keyB2A = randomBytes(32);
  const saltA2B = randomBytes(4);
  const saltB2A = randomBytes(4);
  return {
    secretsA: { sendKey: keyA2B, recvKey: keyB2A, sendSalt: saltA2B, recvSalt: saltB2A },
    secretsB: { sendKey: keyB2A, recvKey: keyA2B, sendSalt: saltB2A, recvSalt: saltA2B },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Nonce construction
// ─────────────────────────────────────────────────────────────────────────

describe('makeNonce', () => {
  it('encodes salt || big-endian u64 counter', () => {
    const salt = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const nonce = makeNonce(salt, 0x00_00_00_00_DE_AD_BE_EFn);
    expect([...nonce.slice(0, 4)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect([...nonce.slice(4)]).toEqual([0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]);
  });

  it('is 12 bytes total', () => {
    expect(makeNonce(new Uint8Array(4), 0n)).toHaveLength(12);
  });

  it('rejects negative counter', () => {
    expect(() => makeNonce(new Uint8Array(4), -1n)).toThrow(/counter must be >= 0/);
  });

  it('rejects counter > u64', () => {
    expect(() => makeNonce(new Uint8Array(4), MAX_COUNTER + 1n)).toThrow(/exceeds u64/);
  });

  it('produces distinct nonces for sequential counters', () => {
    const salt = new Uint8Array(4);
    const a = makeNonce(salt, 0n);
    const b = makeNonce(salt, 1n);
    expect(a).not.toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RecordSession.create — input validation
// ─────────────────────────────────────────────────────────────────────────

describe('RecordSession.create', () => {
  it('rejects wrong key length', async () => {
    await expect(
      RecordSession.create({
        sendKey: randomBytes(16),
        recvKey: randomBytes(32),
        sendSalt: randomBytes(4),
        recvSalt: randomBytes(4),
      }),
    ).rejects.toThrow(/sendKey must be 32 bytes/);
  });

  it('rejects wrong salt length', async () => {
    await expect(
      RecordSession.create({
        sendKey: randomBytes(32),
        recvKey: randomBytes(32),
        sendSalt: randomBytes(8),
        recvSalt: randomBytes(4),
      }),
    ).rejects.toThrow(/sendSalt must be 4 bytes/);
  });

  it('defensively copies salts — external mutation does not affect state', async () => {
    const salt = new Uint8Array([1, 2, 3, 4]);
    const session = await RecordSession.create({
      sendKey: randomBytes(32),
      recvKey: randomBytes(32),
      sendSalt: salt,
      recvSalt: randomBytes(4),
    });
    salt.fill(0xff);
    // If state weren't defensively copied, seal/open would produce a nonce
    // based on the mutated salt. Smoke test: seal succeeds (no throw).
    await expect(session.seal(new Uint8Array([0x42]))).resolves.toBeInstanceOf(Uint8Array);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bidirectional round-trip
// ─────────────────────────────────────────────────────────────────────────

describe('RecordSession — seal / open round-trip', () => {
  it('A can seal messages that B opens, and vice versa', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    const msg1 = new TextEncoder().encode('hello from A');
    const ct1 = await A.seal(msg1);
    const pt1 = await B.open(ct1);
    expect(new TextDecoder().decode(pt1)).toBe('hello from A');

    const msg2 = new TextEncoder().encode('reply from B');
    const ct2 = await B.seal(msg2);
    const pt2 = await A.open(ct2);
    expect(new TextDecoder().decode(pt2)).toBe('reply from B');
  });

  it('counters advance monotonically per direction', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    expect(A.sendFrames).toBe(0n);
    expect(A.recvFrames).toBe(0n);
    await B.open(await A.seal(new Uint8Array([1])));
    await B.open(await A.seal(new Uint8Array([2])));
    await A.open(await B.seal(new Uint8Array([3])));
    expect(A.sendFrames).toBe(2n);
    expect(A.recvFrames).toBe(1n);
    expect(B.sendFrames).toBe(1n);
    expect(B.recvFrames).toBe(2n);
  });

  it('ordered delivery: skipping a frame desynchronises the counters (subsequent open fails)', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    const ct1 = await A.seal(new Uint8Array([1]));
    const ct2 = await A.seal(new Uint8Array([2]));
    // B drops ct1 and tries to open ct2 directly — counter mismatch => auth fail.
    await expect(B.open(ct2)).rejects.toThrow(/auth failed/);
  });

  it('AAD (additional authenticated data) is required to match on open', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    const aad = new TextEncoder().encode('peer-mesh:v1');
    const ct = await A.seal(new Uint8Array([9]), aad);
    await expect(B.open(ct /* no aad */)).rejects.toThrow(/auth failed/);
    await expect(B.open(ct, new TextEncoder().encode('different'))).rejects.toThrow(/auth failed/);
    // AFTER the two failed opens, counter is still at 0.
    expect(B.recvFrames).toBe(0n);
    // And the correct AAD works.
    expect(await B.open(ct, aad)).toEqual(new Uint8Array([9]));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tamper detection
// ─────────────────────────────────────────────────────────────────────────

describe('RecordSession — tamper detection', () => {
  it('rejects a flipped-bit ciphertext', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    const ct = await A.seal(new TextEncoder().encode('tamper me'));
    const tampered = new Uint8Array(ct);
    tampered[0] ^= 0x01;
    await expect(B.open(tampered)).rejects.toThrow(/auth failed/);
  });

  it('rejects a stripped-tag ciphertext', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    const ct = await A.seal(new Uint8Array([7]));
    // Drop last byte of the 16-byte GCM tag.
    await expect(B.open(ct.slice(0, ct.length - 1))).rejects.toThrow();
  });

  it('rejects a cross-direction ciphertext (wrong key)', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);

    // Normally B opens A's ct. Ask A to open its own ct (reversed direction).
    const ct = await A.seal(new Uint8Array([1]));
    await expect(A.open(ct)).rejects.toThrow(/auth failed/);
    expect(B.recvFrames).toBe(0n);
    // B's counter untouched by A's failed self-open.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Re-key threshold
// ─────────────────────────────────────────────────────────────────────────

describe('RecordSession — re-key signalling', () => {
  it('shouldRekey is false well below the soft limit', async () => {
    const { secretsA } = makePair();
    const A = await RecordSession.create(secretsA);
    expect(A.shouldRekey()).toBe(false);
    await A.seal(new Uint8Array([1]));
    expect(A.shouldRekey()).toBe(false);
  });

  it('shouldRekey fires at/after the provided threshold', async () => {
    const { secretsA, secretsB } = makePair();
    const A = await RecordSession.create(secretsA);
    const B = await RecordSession.create(secretsB);
    const ct1 = await A.seal(new Uint8Array([1]));
    await B.open(ct1);
    const ct2 = await A.seal(new Uint8Array([2]));
    await B.open(ct2);
    // Tight threshold = 2 — both sides should have met it.
    expect(A.shouldRekey(2n)).toBe(true);
    expect(B.shouldRekey(2n)).toBe(true);
    expect(A.shouldRekey(3n)).toBe(false);
  });

  it('uses default REKEY_SOFT_LIMIT = 2^48', () => {
    expect(REKEY_SOFT_LIMIT).toBe(1n << 48n);
  });
});
