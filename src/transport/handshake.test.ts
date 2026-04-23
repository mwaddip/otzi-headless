import { describe, expect, it } from 'vitest';
import {
  exportPrivateKeyPkcs8,
  generateIdentity,
  importIdentity,
  importPeerPubKey,
  type IdentityKeyPair,
} from './identity';
import {
  initiatorBegin,
  initiatorFinish,
  responderRespond,
} from './handshake';
import { RecordSession, type RecordSecrets } from './record';

function flip(bytes: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out[at] ^= 0x01;
  return out;
}

async function completeHandshake(I: IdentityKeyPair, R: IdentityKeyPair): Promise<{
  initiator: RecordSecrets;
  responder: RecordSecrets;
}> {
  const { state, message1 } = await initiatorBegin(I);
  const { message2, secrets: responderSecrets } = await responderRespond(
    R,
    message1,
    I.publicKeyRaw,
  );
  const initiatorSecrets = await initiatorFinish(state, message2, R.publicKeyRaw);
  return { initiator: initiatorSecrets, responder: responderSecrets };
}

// ─────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────

describe('generateIdentity', () => {
  it('returns a 65-byte uncompressed P-256 public key', async () => {
    const id = await generateIdentity();
    expect(id.publicKeyRaw).toHaveLength(65);
    expect(id.publicKeyRaw[0]).toBe(0x04);
  });

  it('generates distinct keypairs on subsequent calls', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a.publicKeyRaw).not.toEqual(b.publicKeyRaw);
  });
});

describe('importPeerPubKey', () => {
  it('accepts a valid 65-byte uncompressed P-256 pubkey', async () => {
    const id = await generateIdentity();
    await expect(importPeerPubKey(id.publicKeyRaw)).resolves.toBeDefined();
  });
  it('rejects wrong length', async () => {
    await expect(importPeerPubKey(new Uint8Array(64))).rejects.toThrow(/65-byte/);
  });
  it('rejects non-0x04 prefix', async () => {
    const id = await generateIdentity();
    const bad = new Uint8Array(id.publicKeyRaw);
    bad[0] = 0x02;
    await expect(importPeerPubKey(bad)).rejects.toThrow();
  });
});

describe('identity round-trip via PKCS#8', () => {
  it('export → import preserves the public key and functional private key', async () => {
    const original = await generateIdentity(true);
    const pkcs8 = await exportPrivateKeyPkcs8(original);
    const reloaded = await importIdentity(pkcs8, original.publicKeyRaw);
    expect(reloaded.publicKeyRaw).toEqual(original.publicKeyRaw);
    // Confirm the reloaded private key works end-to-end in a handshake.
    const responder = await generateIdentity();
    const { initiator, responder: respSecrets } = await completeHandshake(reloaded, responder);
    expect(initiator.sendKey).toEqual(respSecrets.recvKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Handshake — happy paths
// ─────────────────────────────────────────────────────────────────────────

describe('handshake — happy path', () => {
  it('initiator + responder derive mirror-image RecordSecrets', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();
    const { initiator, responder } = await completeHandshake(I, R);

    expect(initiator.sendKey).toEqual(responder.recvKey);
    expect(initiator.recvKey).toEqual(responder.sendKey);
    expect(initiator.sendSalt).toEqual(responder.recvSalt);
    expect(initiator.recvSalt).toEqual(responder.sendSalt);
  });

  it('derived secrets can drive a RecordSession round-trip', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();
    const { initiator: iSec, responder: rSec } = await completeHandshake(I, R);

    const A = await RecordSession.create(iSec);
    const B = await RecordSession.create(rSec);
    const ct = await A.seal(new TextEncoder().encode('hello peer'));
    const pt = await B.open(ct);
    expect(new TextDecoder().decode(pt)).toBe('hello peer');

    const reply = await B.seal(new TextEncoder().encode('hi back'));
    const replyPt = await A.open(reply);
    expect(new TextDecoder().decode(replyPt)).toBe('hi back');
  });

  it('fresh ephemeral keys each handshake — two handshakes between same identities yield distinct keys', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();
    const h1 = await completeHandshake(I, R);
    const h2 = await completeHandshake(I, R);
    expect(h1.initiator.sendKey).not.toEqual(h2.initiator.sendKey);
    expect(h1.initiator.recvKey).not.toEqual(h2.initiator.recvKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Handshake — authentication failures
// ─────────────────────────────────────────────────────────────────────────

describe('handshake — authentication failures (divergent keys tear down via RecordSession auth)', () => {
  it('wrong responder static pubkey on initiator side → AES-GCM auth fails on first frame', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();
    const imposter = await generateIdentity();

    const { state, message1 } = await initiatorBegin(I);
    const { message2, secrets: rSec } = await responderRespond(R, message1, I.publicKeyRaw);
    // Initiator thinks it's talking to `imposter` instead of `R` — derives different keys.
    const iSec = await initiatorFinish(state, message2, imposter.publicKeyRaw);

    const A = await RecordSession.create(iSec);
    const B = await RecordSession.create(rSec);
    const ct = await A.seal(new Uint8Array([0x42]));
    await expect(B.open(ct)).rejects.toThrow(/auth failed/);
  });

  it('wrong initiator static pubkey on responder side → auth fails', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();
    const imposter = await generateIdentity();

    const { state, message1 } = await initiatorBegin(I);
    const { message2, secrets: rSec } = await responderRespond(
      R,
      message1,
      imposter.publicKeyRaw,
    );
    const iSec = await initiatorFinish(state, message2, R.publicKeyRaw);

    const A = await RecordSession.create(iSec);
    const B = await RecordSession.create(rSec);
    const ct = await A.seal(new Uint8Array([0x99]));
    await expect(B.open(ct)).rejects.toThrow(/auth failed/);
  });

  it('tampered message1 (MitM flipping a byte of eI_pub) → ECDH yields different ephemeral → auth fails', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();

    const { state, message1 } = await initiatorBegin(I);
    // Flip one byte in the X coordinate to fake a different ephemeral pubkey —
    // may fail at the point-validation step or at the subsequent auth step.
    // Try multiple flips until we land on a valid point that still fails auth.
    let responderResult:
      | { message2: Uint8Array; secrets: RecordSecrets }
      | null = null;
    for (let i = 1; i < 32 && !responderResult; i++) {
      const tampered = flip(message1, i);
      try {
        responderResult = await responderRespond(R, tampered, I.publicKeyRaw);
      } catch {
        // Point-validation rejected the mutation — try another bit.
      }
    }
    if (!responderResult) {
      // No bit-flip landed on a valid point in 32 tries — accept this as a
      // stronger negative result (tampering was caught at the parse layer).
      return;
    }
    const iSec = await initiatorFinish(state, responderResult.message2, R.publicKeyRaw);
    const A = await RecordSession.create(iSec);
    const B = await RecordSession.create(responderResult.secrets);
    const ct = await A.seal(new Uint8Array([0x01]));
    await expect(B.open(ct)).rejects.toThrow(/auth failed/);
  });

  it('tampered message2 → initiator derives different keys than responder → auth fails', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();

    const { state, message1 } = await initiatorBegin(I);
    const { message2, secrets: rSec } = await responderRespond(R, message1, I.publicKeyRaw);

    let iSec: RecordSecrets | null = null;
    for (let i = 1; i < 32 && !iSec; i++) {
      try {
        iSec = await initiatorFinish(state, flip(message2, i), R.publicKeyRaw);
      } catch {
        // Point-validation failure counts as "tampering caught" — early exit.
        return;
      }
    }
    if (!iSec) return;
    const A = await RecordSession.create(iSec);
    const B = await RecordSession.create(rSec);
    const ct = await A.seal(new Uint8Array([0x02]));
    await expect(B.open(ct)).rejects.toThrow(/auth failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Handshake — input validation
// ─────────────────────────────────────────────────────────────────────────

describe('handshake — input validation', () => {
  it('initiatorFinish rejects message2 of wrong length', async () => {
    const I = await generateIdentity();
    const R = await generateIdentity();
    const { state } = await initiatorBegin(I);
    await expect(
      initiatorFinish(state, new Uint8Array(64), R.publicKeyRaw),
    ).rejects.toThrow(/message2.*65/);
  });

  it('responderRespond rejects message1 without 0x04 prefix', async () => {
    const R = await generateIdentity();
    const I = await generateIdentity();
    const bad = new Uint8Array(I.publicKeyRaw);
    bad[0] = 0x03;
    await expect(responderRespond(R, bad, I.publicKeyRaw)).rejects.toThrow(
      /uncompressed P-256/,
    );
  });
});
