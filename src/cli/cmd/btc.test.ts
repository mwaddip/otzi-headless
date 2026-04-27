import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initEccLib, networks, payments, toXOnly } from '@btc-vision/bitcoin';
import { createNobleBackend } from '@btc-vision/ecpair';
import { schnorr } from '@noble/curves/secp256k1.js';

// Stub the OPNet provider so tests don't touch the network. The chain RPC
// is also stubbed; broadcast goes through provider.sendRawTransaction.
const provider = {
  utxoManager: {
    getUTXOs: vi.fn(async () => [
      { transactionId: '01'.repeat(32), outputIndex: 0, value: 1_000_000n },
      { transactionId: '02'.repeat(32), outputIndex: 1, value: 500_000n },
    ]),
  },
  sendRawTransaction: vi.fn(async () => ({ success: true, result: 'tx-mocked' })),
};
vi.mock('../../node/opnet-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../node/opnet-client')>();
  return { ...actual, getProvider: () => provider };
});

// Stub fetchBtcFees so we don't hit mempool.space in tests.
vi.mock('../../broadcast/btc-fees', () => ({
  fetchBtcFees: async () => ({ low: 1, normal: 5, high: 20 }),
}));

initEccLib(createNobleBackend());

import { UdsTrigger } from '../../triggers/uds';
import { btcSend, btcBalance } from './btc';

/**
 * Vault values we control: derive a real curve point so buildBtcTxFromParams
 * doesn't fail "Invalid internal pubkey", produce a valid tweaked pubkey for
 * the broadcast verify step, and sign each sighash with that key so the
 * daemon's BIP340-verify in broadcastBtcTx accepts them.
 */
const sk = new Uint8Array(32);
sk[31] = 7;
const xOnly = schnorr.getPublicKey(sk);
const compressedUntweaked = new Uint8Array(33);
compressedUntweaked[0] = 0x02;
compressedUntweaked.set(xOnly, 1);
const compressedTweaked = compressedUntweaked; // same key, simplest

const internalXOnly = toXOnly(Buffer.from(compressedUntweaked) as never);
const testnetVaultAddr = payments.p2tr({
  internalPubkey: internalXOnly as never,
  // OPNet's 'testnet' = networks.opnetTestnet (bech32 prefix 'opt'); see
  // node/opnet-client.getNetwork. Real production daemons funded on signet
  // resolve to addresses under this prefix too.
  network: (networks as unknown as { opnetTestnet: typeof networks.testnet }).opnetTestnet,
}).address!;

function vaultJson(network: string, btcAddr = testnetVaultAddr): string {
  return JSON.stringify({
    network,
    btcAddress: btcAddr,
    opnetAddress: '0x' + 'aa'.repeat(32),
    frostUntweakedPubKey: Buffer.from(compressedUntweaked).toString('hex'),
    frostTweakedPubKey: Buffer.from(compressedTweaked).toString('hex'),
    mldsaPubKeyHex: 'cc'.repeat(1312),
  });
}

describe('btcBalance', () => {
  let tmp: string;
  let vaultPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-btc-test-'));
    vaultPath = join(tmp, 'vault.json');
    await writeFile(vaultPath, vaultJson('testnet'));
    provider.utxoManager.getUTXOs.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('sums vault UTXOs in sats', async () => {
    const out = await btcBalance({ vaultPath });
    expect(out).toBe('1500000');
  });

  it('formats in btc when --unit btc', async () => {
    const out = await btcBalance({ vaultPath, unit: 'btc' });
    expect(out).toBe('0.015');
  });

  it('errors on regtest', async () => {
    await writeFile(vaultPath, vaultJson('regtest'));
    await expect(btcBalance({ vaultPath })).rejects.toThrow(
      /not supported.*BTC chain/,
    );
  });

  it('errors when no vault metadata', async () => {
    await rm(vaultPath);
    await expect(btcBalance({ vaultPath })).rejects.toThrow(/no vault metadata/);
  });
});

describe('btcSend', () => {
  let tmp: string;
  let vaultPath: string;
  let configPath: string;
  let socketPath: string;
  let trigger: UdsTrigger;
  let received: Array<Record<string, unknown>>;
  // Capture sighashes from buildBtcTxFromParams so the test can sign them
  // with the same scalar that produced the vault pubkey.
  let capturedSighashes: Uint8Array[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-btc-send-test-'));
    vaultPath = join(tmp, 'vault.json');
    configPath = join(tmp, 'daemon.toml');
    socketPath = join(tmp, 'sock');
    received = [];
    capturedSighashes = [];

    await writeFile(vaultPath, vaultJson('testnet'));
    await writeFile(
      configPath,
      `
[share]
path = "/tmp/x"
password_env = "X"
[node]
id = "a"
party_id = 0
[network]
name = "testnet"
opnet_rpc = "http://x"
[transport]
kind = "peer-mesh"
listen = "127.0.0.1:8800"
[[peers]]
id = "b"
party_id = 1
[gate]
strategy = "auto"
[[triggers]]
kind = "uds"
path = "${socketPath}"
`,
    );

    trigger = new UdsTrigger({
      path: socketPath,
      handler: async (req) => {
        const body = req.body as Record<string, unknown>;
        received.push(body);
        if (body.op === 'vault-info') {
          return {
            status: 200,
            body: {
              partyIds: [0, 1],
              threshold: 2,
              parties: 2,
              network: 'testnet',
              btcAddress: 'tb1pmocked',
              opnetAddress: '0x' + 'aa'.repeat(32),
            },
          };
        }
        if (body.op === 'sign' && body.scheme === 'frost' && body.protocol === 'btc') {
          // Rebuild the sighashes from the construction params + utxos and
          // sign each with our test scalar. The CLI will BIP340-verify these
          // before broadcasting, so they have to actually verify under the
          // tweaked pubkey.
          const btc = body.btc as {
            to: string;
            amountSat: string;
            feeRate: number;
            network: 'mainnet' | 'testnet';
            frostP2tr: string;
            frostUntweakedPubKeyHex: string;
            utxos: Array<{ transactionId: string; outputIndex: number; valueSat: string }>;
          };
          const { buildBtcTxFromParams } = await import('../../broadcast/btc-vault');
          const built = buildBtcTxFromParams({
            to: btc.to,
            amountSat: BigInt(btc.amountSat),
            feeRate: btc.feeRate,
            network: btc.network,
            frostP2tr: btc.frostP2tr,
            frostUntweakedPubKey: Buffer.from(btc.frostUntweakedPubKeyHex, 'hex'),
            utxos: btc.utxos.map((u) => ({
              transactionId: u.transactionId,
              outputIndex: u.outputIndex,
              value: BigInt(u.valueSat),
            })),
          });
          const signaturesHex = built.sighashes.map((s) => {
            capturedSighashes.push(s.hash);
            const sig = schnorr.sign(s.hash, sk);
            return Buffer.from(sig).toString('hex');
          });
          return { status: 200, body: { signaturesHex } };
        }
        return { status: 400, body: { error: `unhandled ${String(body.op)}` } };
      },
    });
    await trigger.start();
    provider.utxoManager.getUTXOs.mockClear();
    provider.sendRawTransaction.mockClear();
  });

  afterEach(async () => {
    await trigger.stop();
    await rm(tmp, { recursive: true, force: true });
  });

  it('runs the full BTC send flow and returns the txid', async () => {
    const result = await btcSend({
      configPath,
      vaultPath,
      toAddress: testnetVaultAddr, // any valid testnet bech32; toOutputScript will accept
      amount: '100000sats',
    });
    // Mock provider returns 'tx-mocked' from sendRawTransaction.
    expect(result.transactionId).toBe('tx-mocked');
    expect(provider.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(received[0]!.op).toBe('vault-info');
    expect(received[1]!.op).toBe('sign');
  });

  it('rejects zero amount', async () => {
    await expect(
      btcSend({ configPath, vaultPath, toAddress: testnetVaultAddr, amount: '0sats' }),
    ).rejects.toThrow(/> 0 sats/);
  });

  it('rejects when no UTXOs', async () => {
    provider.utxoManager.getUTXOs.mockImplementationOnce(async () => []);
    await expect(
      btcSend({ configPath, vaultPath, toAddress: testnetVaultAddr, amount: '100000sats' }),
    ).rejects.toThrow(/no UTXOs/);
  });
});
