import { describe, it, expect } from 'vitest';
import { ChallengeSolution } from '@btc-vision/transaction';
import type { AnnounceOpnetParams, AnnounceOpnetUtxoRaw } from '../core/ceremony-messages';
import {
  buildCaptureInputsFromParams,
  reconstructChallengeSolution,
  reconstructOpnetUtxos,
  serializeChallengeForWire,
  serializeOpnetParams,
  type OpnetParamsKeyMat,
  type SerializeOpnetParamsInputs,
} from './opnet-params-reconstruct';

// Valid secp256k1 compressed public key (the generator) — needed because
// ChallengeSolution.toRaw() derives legacy pubkey hex via EC curve ops.
const VALID_SECP_COMPRESSED = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

function sampleChallengeRaw(): Record<string, unknown> {
  return {
    epochNumber: '42',
    mldsaPublicKey: 'aa'.repeat(32),
    legacyPublicKey: VALID_SECP_COMPRESSED,
    solution: 'cc'.repeat(32),
    salt: 'dd'.repeat(32),
    graffiti: '',
    difficulty: 3,
    verification: {
      epochHash: '00'.repeat(32),
      epochRoot: '00'.repeat(32),
      targetHash: '00'.repeat(32),
      targetChecksum: '00'.repeat(32),
      startBlock: '1',
      endBlock: '2',
      proofs: [],
    },
  };
}

function sampleUtxoRaw(): AnnounceOpnetUtxoRaw {
  return {
    transactionId: '01'.repeat(32),
    outputIndex: 0,
    value: '200000',
    scriptPubKey: { hex: '5120' + 'ff'.repeat(32), type: 'witness_v1_taproot' },
  };
}

function sampleKeyMat(): OpnetParamsKeyMat {
  return {
    mldsaPubKey: new Uint8Array(1312),
    frostTweakedPubKey: new Uint8Array(33).fill(2),
    frostUntweakedPubKey: new Uint8Array(33).fill(3),
    network: 'testnet',
  };
}

describe('reconstructOpnetUtxos', () => {
  it('produces UTXO instances with bigint value + pass-through scriptPubKey', () => {
    const [u] = reconstructOpnetUtxos([sampleUtxoRaw()]);
    expect(u).toBeDefined();
    expect(u!.transactionId).toBe('01'.repeat(32));
    expect(u!.outputIndex).toBe(0);
    expect(u!.value).toBe(200000n);
    expect(u!.isCSV).toBe(false);
    expect((u!.scriptPubKey as { hex?: string }).hex).toBe('5120' + 'ff'.repeat(32));
  });

  it('preserves optional raw (base64 nonWitnessUtxo)', () => {
    const raw: AnnounceOpnetUtxoRaw = { ...sampleUtxoRaw(), raw: 'AQID' };
    const [u] = reconstructOpnetUtxos([raw]);
    expect(u).toBeDefined();
    // `nonWitnessUtxoBase64` is the canonical stash; nonWitnessUtxo lazy-decodes it.
    expect(u!.nonWitnessUtxoBase64).toBe('AQID');
  });

  it('marks UTXOs as CSV when raw.isCSV is true', () => {
    const raw: AnnounceOpnetUtxoRaw = { ...sampleUtxoRaw(), isCSV: true };
    const [u] = reconstructOpnetUtxos([raw]);
    expect(u!.isCSV).toBe(true);
  });
});

describe('reconstructChallengeSolution', () => {
  it('reconstructs a ChallengeSolution with bigint epochNumber', () => {
    const raw = sampleChallengeRaw();
    const challenge = reconstructChallengeSolution(raw);
    expect(challenge).toBeInstanceOf(ChallengeSolution);
    expect(challenge.epochNumber).toBe(42n);
    expect(challenge.difficulty).toBe(3);
  });

  it('round-trips via toRaw() back to an equivalent raw structure', () => {
    const raw = sampleChallengeRaw();
    const challenge = reconstructChallengeSolution(raw);
    const roundTripped = challenge.toRaw();
    expect(roundTripped.epochNumber).toBe('42');
    expect(roundTripped.difficulty).toBe(3);
  });

  it('throws on malformed raw (missing mldsaPublicKey)', () => {
    const raw = { ...sampleChallengeRaw() };
    delete (raw as Record<string, unknown>).mldsaPublicKey;
    expect(() => reconstructChallengeSolution(raw)).toThrow();
  });

  it('round-trips via toRaw() — reconstructed instance can be re-serialized without losing legacy', () => {
    // This is the actual leader-side flow: the live challenge from RPC is
    // serialized via toRaw() (yielding 32-byte tweaked legacyPublicKey hex),
    // shipped on-wire, and reconstructed on the participant side. The
    // participant's SDK call invokes toRaw() AGAIN internally during
    // tx construction — it must not throw "Legacy public key not set".
    const initialRaw = sampleChallengeRaw();
    const initial = reconstructChallengeSolution(initialRaw);
    const wireRaw = initial.toRaw() as unknown as Record<string, unknown>;
    const reconstructed = reconstructChallengeSolution(wireRaw);
    expect(() => reconstructed.toRaw()).not.toThrow();
    const finalRaw = reconstructed.toRaw();
    expect(finalRaw.legacyPublicKey).toBe((wireRaw as { legacyPublicKey: string }).legacyPublicKey);
  });
});

describe('serializeChallengeForWire', () => {
  it('preserves originalPublicKey so reconstruct triggers autoFormat (originalPublicKeyBuffer available)', () => {
    // Build a challenge with a 33-byte SEC1 compressed legacy (autoFormat ran).
    const initial = reconstructChallengeSolution(sampleChallengeRaw());
    expect(initial.publicKey.originalPublicKey?.length).toBe(33);

    // Wire-serialize via the fix path (NOT bare `toRaw`).
    const wire = serializeChallengeForWire(initial);
    expect((wire.legacyPublicKey as string).length).toBe(2 + 33 * 2); // 0x + 66 hex chars

    // Reconstruct on the "participant" side.
    const reconstructed = reconstructChallengeSolution(wire);

    // The SDK calls these during tx construction — both must succeed.
    expect(() => reconstructed.publicKey.originalPublicKeyBuffer()).not.toThrow();
    expect(() => reconstructed.toRaw()).not.toThrow();

    // And the original bytes match.
    expect(Buffer.from(reconstructed.publicKey.originalPublicKey!).toString('hex'))
      .toBe(Buffer.from(initial.publicKey.originalPublicKey!).toString('hex'));
  });

  it('falls back gracefully when original is unavailable (32-byte already-tweaked input)', () => {
    // Construct a challenge with a 32-byte tweaked legacy (no autoFormat path).
    const initialRaw = sampleChallengeRaw();
    initialRaw.legacyPublicKey = '00'.repeat(32);
    const initial = reconstructChallengeSolution(initialRaw);
    // No originalPublicKey when starting from 32-byte tweaked.
    expect(initial.publicKey.originalPublicKey?.length ?? 0).toBe(0);

    // serializeChallengeForWire should still work (just falls through to toRaw's tweaked form).
    const wire = serializeChallengeForWire(initial);
    expect(wire.legacyPublicKey).toBeDefined();
  });
});

describe('buildCaptureInputsFromParams', () => {
  function params(): AnnounceOpnetParams {
    return {
      contractAddress: 'opt1abc',
      method: 'transfer',
      params: ['0x' + 'ab'.repeat(32), '1000000'],
      paramTypes: ['address', 'u256'],
      refundAddress: 'bc1p' + 'r'.repeat(58),
      feeRate: 5,
      priorityFeeSat: '1000',
      maxSatToSpendSat: '100000',
      randomBytesSeedHex: 'a'.repeat(64),
      mldsaThresholdSignatureHex: 'cd'.repeat(100),
      utxos: [sampleUtxoRaw()],
      challenge: sampleChallengeRaw(),
    };
  }

  it('populates every OpnetCaptureInputs field, decoding bigints + hex', () => {
    const p = params();
    const keyMat = sampleKeyMat();
    const inputs = buildCaptureInputsFromParams(p, keyMat);

    expect(inputs.contractAddress).toBe(p.contractAddress);
    expect(inputs.method).toBe(p.method);
    expect(inputs.params).toEqual(p.params);
    expect(inputs.paramTypes).toEqual(p.paramTypes);
    expect(inputs.network).toBe('testnet');
    expect(inputs.feeRate).toBe(5);
    expect(inputs.priorityFee).toBe(1000n);
    expect(inputs.maximumAllowedSatToSpend).toBe(100000n);
    expect(inputs.refundAddress).toBe(p.refundAddress);
    expect(inputs.mldsaPubKey).toBe(keyMat.mldsaPubKey);
    expect(inputs.frostTweakedPubKey).toBe(keyMat.frostTweakedPubKey);
    expect(inputs.frostUntweakedPubKey).toBe(keyMat.frostUntweakedPubKey);
    expect(inputs.rndBytesSeed).toBeInstanceOf(Uint8Array);
    expect(inputs.rndBytesSeed!.length).toBe(32);
    expect(inputs.mldsaThresholdSignature).toBeInstanceOf(Uint8Array);
    expect(inputs.mldsaThresholdSignature.length).toBe(100);
    expect(inputs.utxos).toHaveLength(1);
    expect(inputs.utxos![0]!.value).toBe(200000n);
    expect(inputs.challenge).toBeInstanceOf(ChallengeSolution);
  });

  it('omits frostLegacySig when keyMat does not supply one', () => {
    const inputs = buildCaptureInputsFromParams(params(), sampleKeyMat());
    expect(inputs.frostLegacySig).toBeUndefined();
  });

  it('threads frostLegacySig when present on keyMat', () => {
    const sig = new Uint8Array(64).fill(7);
    const inputs = buildCaptureInputsFromParams(params(), { ...sampleKeyMat(), frostLegacySig: sig });
    expect(inputs.frostLegacySig).toBe(sig);
  });

  it('omits paramTypes when wire does not carry them', () => {
    const p = params();
    const { paramTypes: _drop, ...pNoTypes } = p;
    void _drop;
    const inputs = buildCaptureInputsFromParams(pNoTypes as AnnounceOpnetParams, sampleKeyMat());
    expect(inputs.paramTypes).toBeUndefined();
  });
});

describe('serializeOpnetParams', () => {
  function serializeInput(): SerializeOpnetParamsInputs {
    const challenge = reconstructChallengeSolution(sampleChallengeRaw());
    const utxos = reconstructOpnetUtxos([sampleUtxoRaw()]);
    return {
      contractAddress: 'opt1abc',
      method: 'transfer',
      params: ['0x' + 'ab'.repeat(32), '1000000'],
      paramTypes: ['address', 'u256'],
      refundAddress: 'bc1p' + 'r'.repeat(58),
      feeRate: 5,
      priorityFee: 1000n,
      maximumAllowedSatToSpend: 100000n,
      randomBytesSeed: new Uint8Array(32).fill(9),
      mldsaThresholdSignature: new Uint8Array(100).fill(0xcd),
      utxos,
      challenge,
    };
  }

  it('serializes bigints to decimal strings + Uint8Arrays to hex', () => {
    const out = serializeOpnetParams(serializeInput());
    expect(out.priorityFeeSat).toBe('1000');
    expect(out.maxSatToSpendSat).toBe('100000');
    expect(out.randomBytesSeedHex).toBe('09'.repeat(32));
    expect(out.mldsaThresholdSignatureHex).toBe('cd'.repeat(100));
  });

  it('round-trips through buildCaptureInputsFromParams preserving core fields', () => {
    const wire = serializeOpnetParams(serializeInput());
    const inputs = buildCaptureInputsFromParams(wire, sampleKeyMat());
    expect(inputs.priorityFee).toBe(1000n);
    expect(inputs.maximumAllowedSatToSpend).toBe(100000n);
    expect(inputs.rndBytesSeed).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(inputs.rndBytesSeed!).toString('hex')).toBe('09'.repeat(32));
  });

  it('emits hints when provided and omits when absent', () => {
    const withHints = { ...serializeInput(), hints: { amountTokenAtomic: '42' } };
    expect(serializeOpnetParams(withHints).hints?.amountTokenAtomic).toBe('42');
    expect(serializeOpnetParams(serializeInput()).hints).toBeUndefined();
  });
});
