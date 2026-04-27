import { describe, it, expect } from 'vitest';
import type { Psbt } from '@btc-vision/bitcoin';
import { CaptureSigner } from './capture-signer';

// Constant key bytes — the actual values don't matter for the state-machine
// tests below (we never run BIP-340 verification). The integration / live
// signet path in scripts/testnet-e2e.ts is the byte-correctness gate.
const TWEAKED_SEC1 = new Uint8Array([0x02, ...new Uint8Array(32).fill(1)]);
const UNTWEAKED_SEC1 = new Uint8Array([0x02, ...new Uint8Array(32).fill(2)]);
const INTERNAL_XONLY = new Uint8Array(32).fill(3);

interface StubInput {
  tapInternalKey?: Uint8Array;
  tapLeafScript?: Array<unknown>;
}

/**
 * Stub PSBT-like that satisfies the surface CaptureSigner.multiSignPsbt
 * touches: `data.inputs` (array of taproot-shaped inputs) and
 * `signTaprootInputAsync(idx, signer)` (which we intercept to drive the
 * signer's signSchnorr callback with a deterministic fake hash, mirroring
 * what the real bitcoin lib does in production).
 */
function stubPsbt(inputs: StubInput[]): Psbt {
  return {
    data: { inputs },
    async signTaprootInputAsync(
      idx: number,
      signer: { publicKey: Uint8Array; signSchnorr: (h: Uint8Array) => Uint8Array | Promise<Uint8Array> },
    ) {
      const fakeHash = new Uint8Array(32).fill(idx + 1);
      await signer.signSchnorr(fakeHash);
    },
  } as never as Psbt;
}

describe('CaptureSigner', () => {
  it('exposes publicKey set to the untweaked SEC1 pubkey', () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    expect(Buffer.from(signer.publicKey).equals(Buffer.from(UNTWEAKED_SEC1))).toBe(true);
  });

  it("satisfies the SDK's `'multiSignPsbt' in signer` check", () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    expect('multiSignPsbt' in signer).toBe(true);
  });

  it('records one CapturedCall per multiSignPsbt invocation', async () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    const psbt = stubPsbt([{ tapInternalKey: INTERNAL_XONLY }]);

    await signer.multiSignPsbt([psbt]);

    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.sighashes).toHaveLength(1);
    expect(signer.calls[0]!.sighashes[0]!.inputIndex).toBe(0);
    expect(signer.calls[0]!.sighashes[0]!.type).toBe('key-path');
    expect(signer.calls[0]!.sighashes[0]!.hash.length).toBe(32);
  });

  it('classifies key-path vs script-path inputs', async () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    const psbt = stubPsbt([
      { tapLeafScript: [{ leafVersion: 0xc0, script: new Uint8Array() }] }, // input 0: script-path
      { tapInternalKey: INTERNAL_XONLY },                                    // input 1: key-path
    ]);

    await signer.multiSignPsbt([psbt]);

    expect(signer.calls[0]!.sighashes).toHaveLength(2);
    expect(signer.calls[0]!.sighashes[0]!.type).toBe('script-path');
    expect(signer.calls[0]!.sighashes[1]!.type).toBe('key-path');
  });

  it('accumulates across multiple multiSignPsbt calls', async () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    const psbt = stubPsbt([{ tapInternalKey: INTERNAL_XONLY }]);

    await signer.multiSignPsbt([psbt]);
    await signer.multiSignPsbt([psbt, psbt]);

    expect(signer.calls).toHaveLength(3);
    expect(signer.allSighashes).toHaveLength(3);
  });

  it('skips inputs whose tapInternalKey does not match the configured internalXOnly', async () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    const otherKey = new Uint8Array(32).fill(99);
    const psbt = stubPsbt([{ tapInternalKey: otherKey }]);

    await signer.multiSignPsbt([psbt]);

    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.sighashes).toHaveLength(0);
  });

  it('skips inputs that are not taproot at all', async () => {
    const signer = new CaptureSigner(TWEAKED_SEC1, INTERNAL_XONLY, UNTWEAKED_SEC1);
    const psbt = stubPsbt([{}]); // empty input → isTaprootInput returns false

    await signer.multiSignPsbt([psbt]);

    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.sighashes).toHaveLength(0);
  });
});
