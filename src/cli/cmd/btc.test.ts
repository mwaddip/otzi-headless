/**
 * `otzi btc balance|send|sign` against an in-process mock Esplora and a fake
 * daemon that signs with a known dealer-generated vault key
 * (facts/daemon.md, `btc.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DaemonClientError } from '../daemon-client';
import { vaultPubkeyFromPackage, writeVaultPubkeyFile } from '../../daemon/vault-pubkey';
import { finalizeSend, vaultPayment } from '../../otzi/backend/bitcoin';
import { makeTestVault } from '../../otzi/backend/test-vault.fixture';
import { analyzeProposal } from '../../otzi/lib/bitcoin';
import { fromVaultKey } from '../../otzi/lib/dkg';
import type { SendProposal } from '../../otzi/lib/vault-types';
import { startMockEsplora, type MockEsplora } from '../../testing/mock-esplora';
import { makeProposal } from '../../testing/proposal';
import { BroadcastFailedError, btcBalance, btcSend, btcSign } from './btc';

const NETWORK = 'testnet4' as const;
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const MAINNET_DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const { vault, tweakedSecret } = makeTestVault(2, 3);
const outputKey = vaultPayment(vault, NETWORK).outputKey;

/** Stands in for the daemon's `sign` op: analyses, signs every sighash with the vault key, finalizes. */
class FakeDaemon {
  requests: Array<{ op: string; proposal: SendProposal }> = [];
  fail: Error | null = null;
  reply: unknown = undefined;

  get lastProposal(): SendProposal {
    return this.requests[this.requests.length - 1]!.proposal;
  }

  async request<T>(body: unknown): Promise<T> {
    const req = body as { op: string; proposal: SendProposal };
    this.requests.push(req);
    if (this.fail) throw this.fail;
    if (this.reply !== undefined) return this.reply as T;
    const analysis = analyzeProposal(req.proposal, vault, NETWORK);
    const signatures = analysis.sighashes.map(s => ({
      index: s.index,
      signature: hex.encode(schnorr.sign(hex.decode(s.hash), tweakedSecret)),
    }));
    const { hex: signedTxHex, txid } = finalizeSend(req.proposal.tx, req.proposal.prevouts, signatures, outputKey);
    return { ceremonyId: 'sign-test', status: 'done', txid, signedTxHex, signaturesHex: signatures.map(s => s.signature) } as T;
  }
}

function configToml(esploraUrl: string, network = 'testnet4'): string {
  return `
[share]
path = "/tmp/otzi-test-share.json"
password_env = "OTZI_TEST_PASSWORD"
[node]
id = "a"
[network]
name = "${network}"
esplora_url = "${esploraUrl}"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "127.0.0.1:8801"
[gate]
strategy = "auto"
[[triggers]]
kind = "uds"
path = "/tmp/otzi-test.sock"
`;
}

describe('otzi btc', () => {
  let tmp: string;
  let configPath: string;
  let vaultPath: string;
  let address: string;
  let esplora: MockEsplora;
  let client: FakeDaemon;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-btc-test-'));
    configPath = join(tmp, 'daemon.toml');
    vaultPath = join(tmp, 'vault-pubkey.json');
    const file = vaultPubkeyFromPackage(fromVaultKey(vault), NETWORK);
    address = file.address;
    await writeVaultPubkeyFile(file, vaultPath);
    esplora = await startMockEsplora();
    await writeFile(configPath, configToml(esplora.url));
    client = new FakeDaemon();
  });

  afterEach(async () => {
    await esplora.close();
    await rm(tmp, { recursive: true, force: true });
  });

  describe('btcBalance', () => {
    it('reports confirmed and unconfirmed sats', async () => {
      esplora.fund(address, 80_000);
      esplora.fund(address, 20_000);
      esplora.fund(address, 30_000, { confirmed: false });
      expect(await btcBalance({ configPath, vaultPath })).toBe('confirmed: 100000\nunconfirmed: 30000');
    });

    it('formats in the requested unit', async () => {
      esplora.fund(address, 150_000);
      expect(await btcBalance({ configPath, vaultPath, unit: 'btc' })).toBe('confirmed: 0.0015\nunconfirmed: 0');
    });

    it('fails with the Esplora URL when Esplora is unreachable', async () => {
      const dead = await startMockEsplora();
      await dead.close();
      await writeFile(configPath, configToml(dead.url));
      await expect(btcBalance({ configPath, vaultPath })).rejects.toThrow(new RegExp(`Esplora ${dead.url}`));
    });

    it('points at otzi generate when there is no vault metadata', async () => {
      await expect(btcBalance({ configPath, vaultPath: join(tmp, 'absent.json') })).rejects.toThrow(/otzi generate/);
    });

    it('refuses a config whose network differs from the vault', async () => {
      await writeFile(configPath, configToml(esplora.url, 'signet'));
      await expect(btcBalance({ configPath, vaultPath })).rejects.toThrow(/testnet4.*signet|signet.*testnet4/);
    });
  });

  describe('btcSend', () => {
    it('send builds a proposal from confirmed UTXOs, signs and broadcasts', async () => {
      esplora.fund(address, 80_000);
      esplora.fund(address, 30_000, { confirmed: false });

      const r = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client });

      expect(esplora.broadcasts).toHaveLength(1);
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]!.op).toBe('sign');
      expect(client.lastProposal.network).toBe(NETWORK);
      expect(client.lastProposal.prevouts).toHaveLength(1); // the unconfirmed coin is not spent
      expect(client.lastProposal.prevouts[0]!.amount).toBe(80_000);
      expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(r.explorerUrl).toBe(`${esplora.url}/tx/${r.txid}`);
      expect(btc.Transaction.fromRaw(hex.decode(esplora.broadcasts[0]!)).id).toBe(r.txid);

      const analysis = analyzeProposal(client.lastProposal, vault, NETWORK);
      expect(analysis.outputs.find(o => !o.isChange)).toMatchObject({ address: DEST, amount: 50_000 });
      expect(analysis.outputs.filter(o => o.isChange)).toHaveLength(1);
    });

    it('uses the Esplora normal fee rate by default and --fee-rate when given', async () => {
      esplora.fund(address, 500_000);
      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client });
      const normal = analyzeProposal(client.lastProposal, vault, NETWORK).feeRate;
      expect(normal).toBeGreaterThanOrEqual(5);
      expect(normal).toBeLessThan(5.5);

      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate: 20 }, { client });
      const custom = analyzeProposal(client.lastProposal, vault, NETWORK).feeRate;
      expect(custom).toBeGreaterThanOrEqual(20);
      expect(custom).toBeLessThan(20.5);
    });

    it('takes amounts with units', async () => {
      esplora.fund(address, 500_000);
      await btcSend({ configPath, vaultPath, to: DEST, amount: '0.0005btc' }, { client });
      const analysis = analyzeProposal(client.lastProposal, vault, NETWORK);
      expect(analysis.outputs.find(o => !o.isChange)!.amount).toBe(50_000);
    });

    it('max spends every confirmed UTXO with no change', async () => {
      esplora.fund(address, 80_000);
      esplora.fund(address, 40_000);
      esplora.fund(address, 30_000, { confirmed: false });

      await btcSend({ configPath, vaultPath, to: DEST, amount: 'max' }, { client });

      const analysis = analyzeProposal(client.lastProposal, vault, NETWORK);
      expect(analysis.inputs).toHaveLength(2);
      expect(analysis.outputs).toHaveLength(1);
      expect(analysis.outputs[0]).toMatchObject({ address: DEST, isChange: false });
      expect(esplora.broadcasts).toHaveLength(1);
    });

    it('send refuses before signing when more than 255 inputs are needed', async () => {
      for (let i = 0; i < 300; i++) esplora.fund(address, 1_000);

      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: 'max' }, { client })).rejects.toThrow(
        'this send needs 300 inputs; at most 255 fit in one transaction — consolidate first',
      );
      expect(client.requests).toHaveLength(0);
      expect(esplora.broadcasts).toHaveLength(0);
    });

    it('send fails before signing when Esplora is unreachable', async () => {
      const dead = await startMockEsplora();
      await dead.close();
      await writeFile(configPath, configToml(dead.url));

      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client })).rejects.toThrow(
        new RegExp(`Esplora ${dead.url}`),
      );
      expect(client.requests).toHaveLength(0);
    });

    it('a rejected broadcast surfaces the signed transaction hex', async () => {
      esplora.fund(address, 80_000);
      esplora.rejectBroadcasts('bad-txns-inputs-missingorspent');

      const err = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(BroadcastFailedError);
      const failed = err as BroadcastFailedError;
      expect(failed.message).toContain('bad-txns-inputs-missingorspent');
      expect(failed.signedTxHex).toMatch(/^[0-9a-f]+$/);
      const signed = btc.Transaction.fromRaw(hex.decode(failed.signedTxHex));
      expect(signed.id).toBe(failed.txid);
      expect(signed.getInput(0).finalScriptWitness).toHaveLength(1); // the signature is in place
      expect(client.requests).toHaveLength(1);
      expect(esplora.broadcasts).toHaveLength(0);
    });

    it('reports insufficient funds in sats and BTC, before any daemon call', async () => {
      esplora.fund(address, 1_000);
      esplora.fund(address, 90_000, { confirmed: false });

      const err = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client }).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/insufficient funds/i);
      expect(err!.message).toContain('1000 sats (0.00001000 BTC)');
      expect(err!.message).toMatch(/50\d{3} sats \(0\.000\d{5} BTC\)/); // needed: amount plus fee
      expect(err!.message).toContain('90000 sats'); // unconfirmed coins are named, not spent
      expect(client.requests).toHaveLength(0);
    });

    it('refuses a send below the minimum amount', async () => {
      esplora.fund(address, 80_000);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '545' }, { client })).rejects.toThrow(/546 sats/);
      expect(client.requests).toHaveLength(0);
    });

    it('refuses an address that is not valid for the vault network, before reaching Esplora', async () => {
      const dead = await startMockEsplora();
      await dead.close();
      await writeFile(configPath, configToml(dead.url));
      for (const to of ['not-an-address', MAINNET_DEST]) {
        await expect(btcSend({ configPath, vaultPath, to, amount: '50000' }, { client })).rejects.toThrow(
          /not a valid testnet4 address/,
        );
      }
      expect(client.requests).toHaveLength(0);
    });

    it('refuses bad amounts and fee rates', async () => {
      esplora.fund(address, 80_000);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: 'lots' }, { client })).rejects.toThrow(/invalid amount/);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '0.5sats' }, { client })).rejects.toThrow(/integer/);
      for (const feeRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate }, { client })).rejects.toThrow(/fee rate/);
      }
      expect(client.requests).toHaveLength(0);
    });

    it('passes a daemon refusal through and broadcasts nothing', async () => {
      esplora.fund(address, 80_000);
      client.fail = new DaemonClientError(403, 'gate rejected');
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client })).rejects.toMatchObject({
        status: 403,
        message: 'gate rejected',
      });
      expect(esplora.broadcasts).toHaveLength(0);
    });

    it('rejects a daemon reply without a signed transaction', async () => {
      esplora.fund(address, 80_000);
      client.reply = { ceremonyId: 'sign-x', status: 'done' };
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, { client })).rejects.toThrow(
        /daemon reply/,
      );
      expect(esplora.broadcasts).toHaveLength(0);
    });
  });

  describe('btcSign', () => {
    async function writeProposal(proposal: unknown): Promise<string> {
      const path = join(tmp, 'proposal.json');
      await writeFile(path, JSON.stringify(proposal));
      return path;
    }

    it('sign prints the analysis and broadcasts only with --broadcast', async () => {
      const proposal = makeProposal(vault, NETWORK, {
        inputs: [{ amount: 100_000 }],
        outputs: [{ address: DEST, amount: 50_000 }],
        change: 49_000,
      });
      const proposalPath = await writeProposal(proposal);

      const dry = await btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, { client });

      expect(esplora.broadcasts).toHaveLength(0);
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]!.proposal).toEqual(proposal);
      expect(dry.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(btc.Transaction.fromRaw(hex.decode(dry.signedTxHex)).id).toBe(dry.txid);
      expect(dry.explorerUrl).toBeUndefined();
      expect(dry.summary).toContain(DEST);
      expect(dry.summary).toContain('50000 sats');
      expect(dry.summary).toMatch(/change/);
      expect(dry.summary).toContain('49000 sats');
      expect(dry.summary).toMatch(/fee: 1000 sats \(0\.00001000 BTC\)/);
      expect(dry.summary).toMatch(/\d+(\.\d+)? sat\/vB/);

      const wet = await btcSign({ configPath, vaultPath, proposalPath, broadcast: true }, { client });

      expect(esplora.broadcasts).toEqual([wet.signedTxHex]);
      expect(wet.explorerUrl).toBe(`${esplora.url}/tx/${wet.txid}`);
    });

    it('a rejected broadcast of a signed proposal surfaces the signed hex', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, NETWORK));
      esplora.rejectBroadcasts('txn-mempool-conflict');
      const err = await btcSign({ configPath, vaultPath, proposalPath, broadcast: true }, { client }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BroadcastFailedError);
      expect((err as BroadcastFailedError).signedTxHex).toMatch(/^[0-9a-f]+$/);
    });

    it('fails analysis before any daemon call for a proposal this vault would not sign', async () => {
      const other = makeTestVault(2, 3).vault;
      const proposalPath = await writeProposal(makeProposal(other, NETWORK));
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, { client })).rejects.toThrow(
        /does not spend a coin of this vault/,
      );
      expect(client.requests).toHaveLength(0);
    });

    it('refuses a proposal for another network before any daemon call', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, 'mainnet'));
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, { client })).rejects.toThrow(
        /mainnet.*testnet4/,
      );
      expect(client.requests).toHaveLength(0);
    });

    it('refuses more than 255 prevouts before any daemon call', async () => {
      const proposal = makeProposal(vault, NETWORK, {
        inputs: Array.from({ length: 256 }, () => ({ amount: 1_000 })),
        outputs: [{ address: DEST, amount: 200_000 }],
        change: 0,
      });
      const proposalPath = await writeProposal(proposal);
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, { client })).rejects.toThrow(
        'proposal has 256 inputs; at most 255 fit in one transaction',
      );
      expect(client.requests).toHaveLength(0);
    });

    it('names the file when it is missing, not JSON, or not a proposal', async () => {
      const missing = join(tmp, 'absent.json');
      await expect(btcSign({ configPath, vaultPath, proposalPath: missing, broadcast: false }, { client })).rejects.toThrow(
        /absent\.json/,
      );
      const notJson = join(tmp, 'garbage.json');
      await writeFile(notJson, '{nope');
      await expect(btcSign({ configPath, vaultPath, proposalPath: notJson, broadcast: false }, { client })).rejects.toThrow(
        /garbage\.json.*JSON/,
      );
      const wrongShape = await writeProposal({ network: NETWORK });
      await expect(btcSign({ configPath, vaultPath, proposalPath: wrongShape, broadcast: false }, { client })).rejects.toThrow(
        /proposal must be/,
      );
      expect(client.requests).toHaveLength(0);
    });
  });
});
