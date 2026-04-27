import { describe, it, expect, vi, beforeEach } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Transaction } from '@btc-vision/bitcoin';
import { randomBytes } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  sendRawTransaction: vi.fn(),
  sendRawTransactionPackage: vi.fn(),
}));

vi.mock('../node/opnet-client.js', () => ({
  getProvider: () => ({
    sendRawTransaction: mocks.sendRawTransaction,
    sendRawTransactionPackage: mocks.sendRawTransactionPackage,
  }),
  getNetwork: () => ({}),
}));

import { broadcastOpnetTx } from './opnet-broadcast';
import type { OpnetCaptureContext } from './opnet-capture';

// Two independent schnorr keypairs stand in for the "tweaked" and "untweaked"
// FROST aggregate keys. Because toXOnly strips the SEC1 parity byte, any 0x02
// prefix is fine for test purposes.
const TWEAKED_SK = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const UNTWEAKED_SK = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 33));
const TWEAKED_XONLY = new Uint8Array(schnorr.getPublicKey(TWEAKED_SK));
const UNTWEAKED_XONLY = new Uint8Array(schnorr.getPublicKey(UNTWEAKED_SK));
const TWEAKED_SEC1 = Uint8Array.of(0x02, ...TWEAKED_XONLY);
const UNTWEAKED_SEC1 = Uint8Array.of(0x02, ...UNTWEAKED_XONLY);

function hex(b: Uint8Array | Buffer): string {
  return Buffer.from(b).toString('hex');
}

function frostSign(hashHex: string, sk: Uint8Array): string {
  return hex(new Uint8Array(schnorr.sign(Buffer.from(hashHex, 'hex'), sk)));
}

function makeTemplateTx(witnesses: Uint8Array[][]): string {
  const tx = new Transaction();
  tx.version = 2;
  for (let i = 0; i < witnesses.length; i++) {
    tx.addInput(Buffer.alloc(32, i + 1) as never, 0);
  }
  // Arbitrary P2TR-shaped output so the tx is well-formed (OP_1 <32B>).
  tx.addOutput(Buffer.from('5120' + '00'.repeat(32), 'hex') as never, 1000n as never);
  for (let i = 0; i < witnesses.length; i++) {
    tx.setWitness(i, witnesses[i]!);
  }
  return tx.toHex();
}

// Matches the shape the SDK produces for script-path inputs:
//   [contractSecret, scriptSignerSig, mainSignerSig(dummy), script, controlBlock]
function scriptPathWitness(): Uint8Array[] {
  return [
    new Uint8Array(32),       // contractSecret (placeholder)
    new Uint8Array(64),       // scriptSigner sig (placeholder)
    new Uint8Array(64),       // main-signer sig — this is what we replace
    Uint8Array.of(0x51),      // script (OP_1, placeholder)
    new Uint8Array(33),       // controlBlock (placeholder)
  ];
}

function keyPathWitness(): Uint8Array[] {
  return [new Uint8Array(64)]; // tapKeySig (dummy)
}

describe('broadcastOpnetTx', () => {
  beforeEach(() => {
    mocks.sendRawTransaction.mockReset();
    mocks.sendRawTransactionPackage.mockReset();
  });

  it('broadcasts a single key-path tx via sendRawTransaction with the FROST sig injected at witness[0]', async () => {
    mocks.sendRawTransaction.mockResolvedValue({ success: true, result: 'txid-abc' });

    const hashHex = hex(randomBytes(32));
    const sig = frostSign(hashHex, TWEAKED_SK);
    const txHex = makeTemplateTx([keyPathWitness()]);

    const captureContext: OpnetCaptureContext = {
      templateTxs: [txHex],
      sighashMap: new Map([[hashHex, { txIndex: 0, inputIndex: 0, type: 'key-path' }]]),
    };

    const result = await broadcastOpnetTx({
      captureContext,
      frostSignatures: [{ hash: hashHex, signature: sig }],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    });

    expect(result).toEqual({ transactionId: 'txid-abc' });
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.sendRawTransactionPackage).not.toHaveBeenCalled();

    const broadcasted = mocks.sendRawTransaction.mock.calls[0]![0] as string;
    const parsed = Transaction.fromHex(broadcasted);
    expect(hex(parsed.ins[0]!.witness[0]!)).toBe(sig);
  });

  it('broadcasts a 2-tx package and returns the interaction txid; script-path sig lands at witness[2]', async () => {
    mocks.sendRawTransactionPackage.mockResolvedValue({
      success: true,
      sequentialResults: [
        { success: true, txid: 'funding-txid' },
        { success: true, txid: 'interaction-txid' },
      ],
    });

    const hFunding = hex(randomBytes(32));
    const hInteraction = hex(randomBytes(32));
    const sigFunding = frostSign(hFunding, UNTWEAKED_SK); // script-path ⇒ untweaked
    const sigInteraction = frostSign(hInteraction, TWEAKED_SK); // key-path ⇒ tweaked

    const captureContext: OpnetCaptureContext = {
      templateTxs: [
        makeTemplateTx([scriptPathWitness()]),
        makeTemplateTx([keyPathWitness()]),
      ],
      sighashMap: new Map([
        [hFunding, { txIndex: 0, inputIndex: 0, type: 'script-path' }],
        [hInteraction, { txIndex: 1, inputIndex: 0, type: 'key-path' }],
      ]),
    };

    const result = await broadcastOpnetTx({
      captureContext,
      frostSignatures: [
        { hash: hFunding, signature: sigFunding },
        { hash: hInteraction, signature: sigInteraction },
      ],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    });

    expect(result).toEqual({ transactionId: 'interaction-txid' });

    const [[pkgTxs]] = mocks.sendRawTransactionPackage.mock.calls as [[string[], boolean]];
    const funding = Transaction.fromHex(pkgTxs[0]!);
    const interaction = Transaction.fromHex(pkgTxs[1]!);
    // Script-path: witness[2] replaced; untouched slots preserved
    expect(hex(funding.ins[0]!.witness[2]!)).toBe(sigFunding);
    expect(funding.ins[0]!.witness[0]!.length).toBe(32); // contractSecret preserved
    // Key-path: witness[0] replaced
    expect(hex(interaction.ins[0]!.witness[0]!)).toBe(sigInteraction);
  });

  it('rejects signatures that do not match the 128-hex-char BIP340 shape', async () => {
    const hashHex = hex(randomBytes(32));
    const captureContext: OpnetCaptureContext = {
      templateTxs: [makeTemplateTx([keyPathWitness()])],
      sighashMap: new Map([[hashHex, { txIndex: 0, inputIndex: 0, type: 'key-path' }]]),
    };
    await expect(broadcastOpnetTx({
      captureContext,
      frostSignatures: [{ hash: hashHex, signature: 'too-short' }],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Invalid FROST signature/);
  });

  it('rejects when a mapped sighash has no accompanying FROST signature', async () => {
    const h0 = hex(randomBytes(32));
    const h1 = hex(randomBytes(32));
    const sig0 = frostSign(h0, TWEAKED_SK);
    const captureContext: OpnetCaptureContext = {
      templateTxs: [makeTemplateTx([keyPathWitness(), keyPathWitness()])],
      sighashMap: new Map([
        [h0, { txIndex: 0, inputIndex: 0, type: 'key-path' }],
        [h1, { txIndex: 0, inputIndex: 1, type: 'key-path' }],
      ]),
    };
    await expect(broadcastOpnetTx({
      captureContext,
      frostSignatures: [{ hash: h0, signature: sig0 }],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Missing FROST signature/);
  });

  it('rejects when BIP340 verify fails (sig signed under wrong key for mapped path type)', async () => {
    const hashHex = hex(randomBytes(32));
    // Key-path must verify under TWEAKED; we sign under UNTWEAKED to force a mismatch.
    const wrongSig = frostSign(hashHex, UNTWEAKED_SK);
    const captureContext: OpnetCaptureContext = {
      templateTxs: [makeTemplateTx([keyPathWitness()])],
      sighashMap: new Map([[hashHex, { txIndex: 0, inputIndex: 0, type: 'key-path' }]]),
    };
    await expect(broadcastOpnetTx({
      captureContext,
      frostSignatures: [{ hash: hashHex, signature: wrongSig }],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/BIP340 verification failed/);
  });

  it('rejects when templateTxs is empty', async () => {
    await expect(broadcastOpnetTx({
      captureContext: { templateTxs: [], sighashMap: new Map() },
      frostSignatures: [],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/No template transactions/);
  });

  it('surfaces a package-broadcast failure from the provider', async () => {
    mocks.sendRawTransactionPackage.mockResolvedValue({ success: false, error: 'insufficient fees' });

    const h0 = hex(randomBytes(32));
    const h1 = hex(randomBytes(32));
    const sig0 = frostSign(h0, TWEAKED_SK);
    const sig1 = frostSign(h1, TWEAKED_SK);
    const captureContext: OpnetCaptureContext = {
      templateTxs: [makeTemplateTx([keyPathWitness()]), makeTemplateTx([keyPathWitness()])],
      sighashMap: new Map([
        [h0, { txIndex: 0, inputIndex: 0, type: 'key-path' }],
        [h1, { txIndex: 1, inputIndex: 0, type: 'key-path' }],
      ]),
    };
    await expect(broadcastOpnetTx({
      captureContext,
      frostSignatures: [{ hash: h0, signature: sig0 }, { hash: h1, signature: sig1 }],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Package broadcast failed.*insufficient fees/);
  });

  it('surfaces a failed interaction result even when the package call claims success', async () => {
    mocks.sendRawTransactionPackage.mockResolvedValue({
      success: true,
      sequentialResults: [
        { success: true, txid: 'funding-txid' },
        { success: false, error: 'interaction reverted' },
      ],
    });
    const h0 = hex(randomBytes(32));
    const h1 = hex(randomBytes(32));
    const captureContext: OpnetCaptureContext = {
      templateTxs: [makeTemplateTx([keyPathWitness()]), makeTemplateTx([keyPathWitness()])],
      sighashMap: new Map([
        [h0, { txIndex: 0, inputIndex: 0, type: 'key-path' }],
        [h1, { txIndex: 1, inputIndex: 0, type: 'key-path' }],
      ]),
    };
    await expect(broadcastOpnetTx({
      captureContext,
      frostSignatures: [
        { hash: h0, signature: frostSign(h0, TWEAKED_SK) },
        { hash: h1, signature: frostSign(h1, TWEAKED_SK) },
      ],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Interaction tx failed.*interaction reverted/);
  });

  it('rejects script-path injection when the template witness is too short', async () => {
    const hashHex = hex(randomBytes(32));
    const sig = frostSign(hashHex, UNTWEAKED_SK);
    // Script-path expects 5 elements; provide 3 to trigger the guard.
    const txHex = makeTemplateTx([[new Uint8Array(32), new Uint8Array(64), new Uint8Array(64)]]);
    const captureContext: OpnetCaptureContext = {
      templateTxs: [txHex],
      sighashMap: new Map([[hashHex, { txIndex: 0, inputIndex: 0, type: 'script-path' }]]),
    };
    await expect(broadcastOpnetTx({
      captureContext,
      frostSignatures: [{ hash: hashHex, signature: sig }],
      frostTweakedPubKey: TWEAKED_SEC1,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Unexpected witness length 3/);
  });
});
