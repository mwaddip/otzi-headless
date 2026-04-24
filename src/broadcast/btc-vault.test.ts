import { describe, it, expect, vi, beforeEach } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Transaction, networks, address as btcAddress, payments, toXOnly, initEccLib } from '@btc-vision/bitcoin';
import { createNobleBackend } from '@btc-vision/ecpair';

// Taproot address derivation + sighash computation inside
// @btc-vision/bitcoin requires the secp256k1 backend to be installed. The
// daemon entrypoint (phase 5) will init this at startup; tests must do so
// explicitly. Idempotent — initEccLib is a no-op if already set.
initEccLib(createNobleBackend());

const mocks = vi.hoisted(() => ({
  getUTXOs: vi.fn(),
  sendRawTransaction: vi.fn(),
}));

vi.mock('../node/opnet-client.js', async () => {
  const { networks: realNetworks } = await import('@btc-vision/bitcoin');
  return {
    getProvider: () => ({
      utxoManager: { getUTXOs: mocks.getUTXOs },
      sendRawTransaction: mocks.sendRawTransaction,
    }),
    getNetwork: (name: string) =>
      name === 'mainnet' ? realNetworks.bitcoin : realNetworks.opnetTestnet,
  };
});

import {
  selectBtcUtxos,
  prepareBtcTx,
  broadcastBtcTx,
  decodeBtcOutputs,
  type BtcCaptureContext,
  type BtcUtxo,
} from './btc-vault';

const UNTWEAKED_SK = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 7));
const UNTWEAKED_XONLY = new Uint8Array(schnorr.getPublicKey(UNTWEAKED_SK));
const UNTWEAKED_SEC1 = Uint8Array.of(0x02, ...UNTWEAKED_XONLY);

const hex = (b: Uint8Array | Buffer) => Buffer.from(b).toString('hex');
const frostSign = (hashHex: string, sk: Uint8Array) =>
  hex(new Uint8Array(schnorr.sign(Buffer.from(hashHex, 'hex'), sk)));

// Deterministic fake UTXOs: 32-byte zero txid with configurable value.
function makeUtxo(value: bigint, txidByte = 0x11, vout = 0): BtcUtxo {
  return {
    transactionId: Buffer.alloc(32, txidByte).toString('hex'),
    outputIndex: vout,
    value,
  };
}

// Derive the P2TR bech32 address for the untweaked key, under a given network.
function p2trAddressFor(network: typeof networks.bitcoin): string {
  const internalPubkey = toXOnly(Buffer.from(UNTWEAKED_SEC1) as never);
  return payments.p2tr({ internalPubkey: internalPubkey as never, network }).address!;
}

describe('selectBtcUtxos', () => {
  it('picks the largest UTXO when it alone covers amount + fee', () => {
    const utxos = [makeUtxo(100_000n), makeUtxo(5_000n)];
    const { selected, fee, change } = selectBtcUtxos(utxos, 50_000n, 10);
    expect(selected.length).toBe(1);
    expect(selected[0]!.value).toBe(100_000n);
    expect(fee).toBeGreaterThan(0n);
    expect(change).toBe(100_000n - 50_000n - fee);
  });

  it('accumulates UTXOs greedily when the largest is insufficient', () => {
    const utxos = [makeUtxo(30_000n, 1), makeUtxo(25_000n, 2), makeUtxo(10_000n, 3)];
    const { selected, fee, change } = selectBtcUtxos(utxos, 50_000n, 5);
    const sum = selected.reduce((a, u) => a + u.value, 0n);
    expect(sum).toBeGreaterThanOrEqual(50_000n + fee);
    expect(change).toBe(sum - 50_000n - fee);
  });

  it('throws Insufficient funds when the set cannot cover amount + fee', () => {
    const utxos = [makeUtxo(10_000n)];
    expect(() => selectBtcUtxos(utxos, 50_000n, 10)).toThrow(/Insufficient funds/);
  });

  it('folds sub-dust change into the fee (change == 0)', () => {
    // Pick amount so that (selected_sum - amount - fee) is just under dust.
    // With one 100k-sat UTXO, a 1-sat/vB feeRate gives a small fee; set
    // amount near the edge so change is < 546.
    const utxos = [makeUtxo(100_000n)];
    // feeRate=1 sat/vB, one-input one-output ≈ 57.5+43+10.5 = 111 vB → fee ~111 sat.
    // Target change of 100 sat → amount = 100000 - 111 - 100 = 99789
    const amount = 99_789n;
    const { change } = selectBtcUtxos(utxos, amount, 1);
    expect(change).toBe(0n);
  });
});

describe('prepareBtcTx', () => {
  beforeEach(() => {
    mocks.getUTXOs.mockReset();
    mocks.sendRawTransaction.mockReset();
  });

  it('builds a tx, computes sighashes, and returns captureContext', async () => {
    mocks.getUTXOs.mockResolvedValue([makeUtxo(100_000n)]);

    const destAddress = p2trAddressFor(networks.opnetTestnet);
    const result = await prepareBtcTx({
      to: destAddress,
      amount: 50_000,
      feeRate: 5,
      network: 'testnet',
      frostP2tr: destAddress, // self-send for test simplicity
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    });

    expect(result.sighashes.length).toBe(1);
    expect(result.sighashes[0]!.type).toBe('key-path');
    expect(result.estimatedFee).toBeGreaterThan(0);
    expect(result.captureContext.numInputs).toBe(1);
    expect(result.captureContext.txHex.length).toBeGreaterThan(0);
    // Sanity: captureContext sighash matches the top-level sighash
    expect(result.captureContext.sighashes[0]!.hash).toBe(result.sighashes[0]!.hash);
  });

  it('rejects non-integer or non-positive amount', async () => {
    await expect(prepareBtcTx({
      to: p2trAddressFor(networks.opnetTestnet),
      amount: 0,
      feeRate: 5,
      network: 'testnet',
      frostP2tr: p2trAddressFor(networks.opnetTestnet),
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    })).rejects.toThrow(/positive integer/);

    await expect(prepareBtcTx({
      to: p2trAddressFor(networks.opnetTestnet),
      amount: 1.5,
      feeRate: 5,
      network: 'testnet',
      frostP2tr: p2trAddressFor(networks.opnetTestnet),
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    })).rejects.toThrow(/positive integer/);
  });

  it('rejects non-positive feeRate', async () => {
    await expect(prepareBtcTx({
      to: p2trAddressFor(networks.opnetTestnet),
      amount: 1000,
      feeRate: 0,
      network: 'testnet',
      frostP2tr: p2trAddressFor(networks.opnetTestnet),
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    })).rejects.toThrow(/Fee rate/);
  });

  it('rejects a destination address invalid for the network', async () => {
    // A mainnet-format address passed while network=testnet should fail
    // btcAddress.toOutputScript validation.
    const mainnetAddr = p2trAddressFor(networks.bitcoin);
    await expect(prepareBtcTx({
      to: mainnetAddr,
      amount: 1000,
      feeRate: 5,
      network: 'testnet',
      frostP2tr: p2trAddressFor(networks.opnetTestnet),
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    })).rejects.toThrow();
  });
});

describe('broadcastBtcTx', () => {
  beforeEach(() => {
    mocks.getUTXOs.mockReset();
    mocks.sendRawTransaction.mockReset();
  });

  it('broadcasts on testnet via provider with real FROST sig injected as sole witness', async () => {
    mocks.getUTXOs.mockResolvedValue([makeUtxo(100_000n)]);
    const destAddress = p2trAddressFor(networks.opnetTestnet);
    const prepared = await prepareBtcTx({
      to: destAddress,
      amount: 50_000,
      feeRate: 5,
      network: 'testnet',
      frostP2tr: destAddress,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    });

    const sighashHex = prepared.sighashes[0]!.hash;
    const sig = frostSign(sighashHex, UNTWEAKED_SK);
    mocks.sendRawTransaction.mockResolvedValue({ success: true, result: 'btc-txid-abc' });

    const result = await broadcastBtcTx({
      captureContext: prepared.captureContext,
      frostSignatures: [{ index: 0, signature: sig }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    });

    expect(result.txid).toBe('btc-txid-abc');
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);
    const [[rawTx]] = mocks.sendRawTransaction.mock.calls as [[string, boolean]];
    const parsed = Transaction.fromHex(rawTx);
    expect(parsed.ins[0]!.witness.length).toBe(1);
    expect(hex(parsed.ins[0]!.witness[0]!)).toBe(sig);
  });

  it('broadcasts on mainnet via mempool.space POST and returns the response body as txid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('mainnet-broadcast-txid\n', { status: 200 }),
    );

    // Build a valid-enough capture context manually — we don't need prepare to
    // work under mainnet since the prepare path also needs UTXOs.
    const captureContext: BtcCaptureContext = (() => {
      const tx = new Transaction();
      tx.version = 2;
      tx.addInput(Buffer.alloc(32, 0x22) as never, 0);
      tx.addOutput(Buffer.from('5120' + '00'.repeat(32), 'hex') as never, 1000n as never);
      tx.setWitness(0, [new Uint8Array(64)]);
      // Fake sighash — we'll sign exactly this.
      const fakeSighash = Buffer.alloc(32, 0x33).toString('hex');
      return {
        txHex: tx.toHex(),
        numInputs: 1,
        sighashes: [{ index: 0, hash: fakeSighash }],
        token: 'tok',
      };
    })();
    const sig = frostSign(captureContext.sighashes[0]!.hash, UNTWEAKED_SK);

    const result = await broadcastBtcTx({
      captureContext,
      frostSignatures: [{ index: 0, signature: sig }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'mainnet',
    });

    expect(result.txid).toBe('mainnet-broadcast-txid');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetchSpy.mock.calls as [[string, RequestInit]];
    expect(url).toContain('mempool.space/api/tx');
    expect(init.method).toBe('POST');
    fetchSpy.mockRestore();
  });

  it('throws when signature count does not match numInputs', async () => {
    const captureContext: BtcCaptureContext = {
      txHex: '',
      numInputs: 2,
      sighashes: [],
      token: 'tok',
    };
    await expect(broadcastBtcTx({
      captureContext,
      frostSignatures: [{ index: 0, signature: 'a'.repeat(128) }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Expected 2 signatures, got 1/);
  });

  it('throws on malformed signature hex', async () => {
    const captureContext: BtcCaptureContext = {
      txHex: '',
      numInputs: 1,
      sighashes: [{ index: 0, hash: '00'.repeat(32) }],
      token: 'tok',
    };
    await expect(broadcastBtcTx({
      captureContext,
      frostSignatures: [{ index: 0, signature: 'not-hex' }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Invalid signature at index 0/);
  });

  it('throws on BIP340 verify failure', async () => {
    const fakeSighash = Buffer.alloc(32, 0x44).toString('hex');
    // Sign a DIFFERENT hash than what's in the capture context
    const wrongSig = frostSign(Buffer.alloc(32, 0x55).toString('hex'), UNTWEAKED_SK);
    const captureContext: BtcCaptureContext = {
      txHex: '',
      numInputs: 1,
      sighashes: [{ index: 0, hash: fakeSighash }],
      token: 'tok',
    };
    await expect(broadcastBtcTx({
      captureContext,
      frostSignatures: [{ index: 0, signature: wrongSig }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/BIP340 verification failed/);
  });

  it('throws when sig index has no matching sighash entry', async () => {
    const hashHex = Buffer.alloc(32, 0x66).toString('hex');
    const sig = frostSign(hashHex, UNTWEAKED_SK);
    const captureContext: BtcCaptureContext = {
      txHex: '',
      numInputs: 1,
      sighashes: [{ index: 99, hash: hashHex }],
      token: 'tok',
    };
    await expect(broadcastBtcTx({
      captureContext,
      frostSignatures: [{ index: 0, signature: sig }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/No sighash for input index 0/);
  });

  it('surfaces a failing testnet provider broadcast', async () => {
    mocks.getUTXOs.mockResolvedValue([makeUtxo(100_000n)]);
    const destAddress = p2trAddressFor(networks.opnetTestnet);
    const prepared = await prepareBtcTx({
      to: destAddress,
      amount: 50_000,
      feeRate: 5,
      network: 'testnet',
      frostP2tr: destAddress,
      frostUntweakedPubKey: UNTWEAKED_SEC1,
    });
    const sig = frostSign(prepared.sighashes[0]!.hash, UNTWEAKED_SK);
    mocks.sendRawTransaction.mockResolvedValue({ success: false, error: 'mempool reject' });

    await expect(broadcastBtcTx({
      captureContext: prepared.captureContext,
      frostSignatures: [{ index: 0, signature: sig }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'testnet',
    })).rejects.toThrow(/Broadcast failed.*mempool reject/);
  });

  it('surfaces a failing mainnet mempool.space broadcast', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad-tx: rejected', { status: 400 }),
    );
    const hashHex = Buffer.alloc(32, 0x77).toString('hex');
    const sig = frostSign(hashHex, UNTWEAKED_SK);
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0x88) as never, 0);
    tx.addOutput(Buffer.from('5120' + '00'.repeat(32), 'hex') as never, 1000n as never);
    tx.setWitness(0, [new Uint8Array(64)]);
    const captureContext: BtcCaptureContext = {
      txHex: tx.toHex(),
      numInputs: 1,
      sighashes: [{ index: 0, hash: hashHex }],
      token: 'tok',
    };

    await expect(broadcastBtcTx({
      captureContext,
      frostSignatures: [{ index: 0, signature: sig }],
      frostTweakedPubKey: UNTWEAKED_SEC1,
      network: 'mainnet',
    })).rejects.toThrow(/Broadcast failed.*rejected/);
    fetchSpy.mockRestore();
  });
});

describe('decodeBtcOutputs', () => {
  it('decodes a multi-output P2TR tx — addresses + amounts in order', () => {
    const net = networks.opnetTestnet;
    const p2tr = p2trAddressFor(net);
    const script = btcAddress.toOutputScript(p2tr, net);

    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0x11) as never, 0);
    tx.addOutput(script as never, 70_000n as never);
    tx.addOutput(script as never, 30_000n as never);

    const outs = decodeBtcOutputs(tx.toHex(), 'testnet');
    expect(outs.length).toBe(2);
    expect(outs[0]!.address).toBe(p2tr);
    expect(outs[0]!.amountSat).toBe(70_000n);
    expect(outs[1]!.address).toBe(p2tr);
    expect(outs[1]!.amountSat).toBe(30_000n);
    expect(outs[0]!.scriptHex).toBe(Buffer.from(script).toString('hex'));
  });

  it('returns address=null for OP_RETURN outputs but preserves amountSat + scriptHex', () => {
    const net = networks.opnetTestnet;
    const p2tr = p2trAddressFor(net);
    const p2trScript = btcAddress.toOutputScript(p2tr, net);
    // OP_RETURN <4 bytes> — classic data carrier.
    const opReturnScript = Buffer.from('6a04deadbeef', 'hex');

    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0x22) as never, 0);
    tx.addOutput(p2trScript as never, 50_000n as never);
    tx.addOutput(opReturnScript as never, 0n as never);

    const outs = decodeBtcOutputs(tx.toHex(), 'testnet');
    expect(outs.length).toBe(2);
    expect(outs[0]!.address).toBe(p2tr);
    expect(outs[1]!.address).toBe(null);
    expect(outs[1]!.amountSat).toBe(0n);
    expect(outs[1]!.scriptHex).toBe('6a04deadbeef');
  });

  it('handles a tx with zero outputs', () => {
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0x33) as never, 0);
    const outs = decodeBtcOutputs(tx.toHex(), 'testnet');
    expect(outs).toEqual([]);
  });

  it('decodes mainnet P2WPKH output under mainnet network', () => {
    // Canonical P2WPKH scriptPubKey: OP_0 <20 bytes>
    const script = Buffer.from('0014' + '11'.repeat(20), 'hex');
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0x44) as never, 0);
    tx.addOutput(script as never, 1_000n as never);

    const outs = decodeBtcOutputs(tx.toHex(), 'mainnet');
    expect(outs.length).toBe(1);
    expect(outs[0]!.address).toMatch(/^bc1q/);
    expect(outs[0]!.amountSat).toBe(1_000n);
  });
});
