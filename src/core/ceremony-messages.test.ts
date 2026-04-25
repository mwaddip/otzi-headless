/**
 * Wire-shape round-trip tests for `ceremony-messages`. The `announce-frost`
 * parser / encoder for the `opnet-params` variant is the focus — other
 * variants are covered indirectly by `ceremony-runner.test.ts` and
 * `orchestrator.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  announceFrostMessage,
  encodeCeremonyMessage,
  parseCeremonyMessage,
  type AnnounceOpnetParams,
} from './ceremony-messages';

function dummySighashes(): Array<{ hash: Uint8Array; tweaked: boolean }> {
  return [
    { hash: new Uint8Array(32).fill(0xaa), tweaked: true },
    { hash: new Uint8Array(32).fill(0xbb), tweaked: false },
  ];
}

function sampleOpnetParams(): AnnounceOpnetParams {
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
    mldsaThresholdSignatureHex: 'cd'.repeat(2420),
    utxos: [
      {
        transactionId: '01'.repeat(32),
        outputIndex: 0,
        value: '200000',
        scriptPubKey: { hex: '5120' + 'ff'.repeat(32), type: 'witness_v1_taproot' },
        raw: 'deadbeef',
      },
    ],
    challenge: {
      epochNumber: '42',
      mldsaPublicKey: '00',
      legacyPublicKey: '01',
      solution: 'aa',
      salt: 'bb',
      graffiti: '',
      difficulty: 3,
      verification: {
        epochHash: '00',
        epochRoot: '00',
        targetHash: '00',
        targetChecksum: '00',
        startBlock: '1',
        endBlock: '2',
        proofs: [],
      },
    },
    hints: { amountTokenAtomic: '1000000' },
  };
}

describe('announce-frost: opnet-params variant', () => {
  it('round-trips encode → decode preserving every field', () => {
    const p = sampleOpnetParams();
    const msg = announceFrostMessage('cer-1', 'cer-1', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: p,
    });
    const encoded = encodeCeremonyMessage(msg);
    const decoded = parseCeremonyMessage(encoded);
    if (!decoded) throw new Error('parse returned null');
    if (decoded.kind !== 'announce-frost') throw new Error(`wrong kind: ${decoded.kind}`);
    if (decoded.protocol !== 'opnet-params') throw new Error(`wrong protocol: ${decoded.protocol}`);
    expect(decoded.opnetParams.contractAddress).toBe(p.contractAddress);
    expect(decoded.opnetParams.method).toBe(p.method);
    expect(decoded.opnetParams.params).toEqual(p.params);
    expect(decoded.opnetParams.paramTypes).toEqual(p.paramTypes);
    expect(decoded.opnetParams.refundAddress).toBe(p.refundAddress);
    expect(decoded.opnetParams.feeRate).toBe(p.feeRate);
    expect(decoded.opnetParams.priorityFeeSat).toBe(p.priorityFeeSat);
    expect(decoded.opnetParams.maxSatToSpendSat).toBe(p.maxSatToSpendSat);
    expect(decoded.opnetParams.randomBytesSeedHex).toBe(p.randomBytesSeedHex);
    expect(decoded.opnetParams.mldsaThresholdSignatureHex).toBe(p.mldsaThresholdSignatureHex);
    expect(decoded.opnetParams.utxos).toHaveLength(1);
    expect(decoded.opnetParams.utxos[0]!.transactionId).toBe(p.utxos[0]!.transactionId);
    expect(decoded.opnetParams.utxos[0]!.outputIndex).toBe(0);
    expect(decoded.opnetParams.utxos[0]!.value).toBe('200000');
    expect(decoded.opnetParams.utxos[0]!.raw).toBe('deadbeef');
    expect(decoded.opnetParams.challenge).toEqual(p.challenge);
    expect(decoded.opnetParams.hints?.amountTokenAtomic).toBe('1000000');
  });

  it('parser rejects when protocol is opnet-params but opnetParams is missing', () => {
    const garbage = new TextEncoder().encode(JSON.stringify({
      v: 1,
      kind: 'announce-frost',
      ceremonyId: 'x',
      baseCeremonyId: 'x',
      sighashes: [{ hashHex: '00'.repeat(32), tweaked: true }],
      signers: [0, 1],
      protocol: 'opnet-params',
    }));
    expect(parseCeremonyMessage(garbage)).toBeNull();
  });

  it('parser rejects invalid random-seed hex (wrong length)', () => {
    const p = sampleOpnetParams();
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: { ...p, randomBytesSeedHex: 'ab' },
    });
    const encoded = encodeCeremonyMessage(msg);
    expect(parseCeremonyMessage(encoded)).toBeNull();
  });

  it('parser rejects non-decimal priority fee', () => {
    const p = sampleOpnetParams();
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: { ...p, priorityFeeSat: '-100' },
    });
    const encoded = encodeCeremonyMessage(msg);
    expect(parseCeremonyMessage(encoded)).toBeNull();
  });

  it('parser rejects utxo with missing scriptPubKey', () => {
    const p = sampleOpnetParams();
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: {
        ...p,
        utxos: [{
          transactionId: '01'.repeat(32),
          outputIndex: 0,
          value: '100',
          scriptPubKey: null as unknown as Record<string, unknown>,
        }],
      },
    });
    const encoded = encodeCeremonyMessage(msg);
    expect(parseCeremonyMessage(encoded)).toBeNull();
  });

  it('parser rejects missing mldsaThresholdSignatureHex', () => {
    const p = sampleOpnetParams();
    const { mldsaThresholdSignatureHex: _drop, ...withoutSig } = p;
    void _drop;
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: withoutSig as AnnounceOpnetParams,
    });
    const encoded = encodeCeremonyMessage(msg);
    expect(parseCeremonyMessage(encoded)).toBeNull();
  });

  it('parser rejects non-hex mldsaThresholdSignatureHex', () => {
    const p = sampleOpnetParams();
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: { ...p, mldsaThresholdSignatureHex: 'not-hex' },
    });
    const encoded = encodeCeremonyMessage(msg);
    expect(parseCeremonyMessage(encoded)).toBeNull();
  });

  it('parser rejects unknown paramType', () => {
    const p = sampleOpnetParams();
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: { ...p, paramTypes: ['bool' as 'address'] },
    });
    const encoded = encodeCeremonyMessage(msg);
    expect(parseCeremonyMessage(encoded)).toBeNull();
  });

  it('accepts utxos without the optional raw/witnessScript fields', () => {
    const p = sampleOpnetParams();
    const stripped: AnnounceOpnetParams = {
      ...p,
      utxos: [{
        transactionId: '01'.repeat(32),
        outputIndex: 0,
        value: '100',
        scriptPubKey: { hex: '5120' + 'ff'.repeat(32) },
      }],
    };
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: stripped,
    });
    const encoded = encodeCeremonyMessage(msg);
    const decoded = parseCeremonyMessage(encoded);
    if (!decoded) throw new Error('parse returned null');
    if (decoded.kind !== 'announce-frost') throw new Error(`wrong kind: ${decoded.kind}`);
    if (decoded.protocol !== 'opnet-params') throw new Error(`wrong protocol: ${decoded.protocol}`);
    expect(decoded.opnetParams.utxos[0]!.raw).toBeUndefined();
  });

  it('omits optional hints when not provided', () => {
    const p: AnnounceOpnetParams = { ...sampleOpnetParams() };
    delete p.hints;
    const msg = announceFrostMessage('c', 'c', dummySighashes(), [0, 1], {
      protocol: 'opnet-params',
      opnetParams: p,
    });
    const encoded = encodeCeremonyMessage(msg);
    const decoded = parseCeremonyMessage(encoded);
    if (!decoded) throw new Error('parse returned null');
    if (decoded.kind !== 'announce-frost') throw new Error(`wrong kind: ${decoded.kind}`);
    if (decoded.protocol !== 'opnet-params') throw new Error(`wrong protocol: ${decoded.protocol}`);
    expect(decoded.opnetParams.hints).toBeUndefined();
  });
});
