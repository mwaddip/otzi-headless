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
import { BroadcastFailedError, btcBalance, btcSend, btcSign, type CliDeps } from './btc';

const NETWORK = 'testnet4' as const;
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const MAINNET_DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const { vault, tweakedSecret } = makeTestVault(2, 3);
const outputKey = vaultPayment(vault, NETWORK).outputKey;

interface SignReply {
  ceremonyId: string;
  status: string;
  txid: string;
  signedTxHex: string;
  signaturesHex: string[];
}

/** Stands in for the daemon's `sign` op: analyses, signs every sighash with the vault key, finalizes. */
class FakeDaemon {
  requests: Array<{ op: string; proposal: SendProposal }> = [];
  /** What the daemon answered, in order. */
  replies: SignReply[] = [];
  /** Everything that happened, in order: `summary` (CLI), `sign` (daemon request). */
  events: string[] = [];
  fail: Error | null = null;
  reply: unknown = undefined;
  /** Rewrites the honest reply, as a broken or hostile daemon would. */
  tamper: ((reply: SignReply, proposal: SendProposal) => SignReply) | null = null;

  get lastProposal(): SendProposal {
    return this.requests[this.requests.length - 1]!.proposal;
  }

  /** The reply an honest daemon gives for `proposal`. */
  signed(proposal: SendProposal): SignReply {
    const analysis = analyzeProposal(proposal, vault, NETWORK);
    const signatures = analysis.sighashes.map(s => ({
      index: s.index,
      signature: hex.encode(schnorr.sign(hex.decode(s.hash), tweakedSecret)),
    }));
    const { hex: signedTxHex, txid } = finalizeSend(proposal.tx, proposal.prevouts, signatures, outputKey);
    return { ceremonyId: 'sign-test', status: 'done', txid, signedTxHex, signaturesHex: signatures.map(s => s.signature) };
  }

  async request<T>(body: unknown): Promise<T> {
    const req = body as { op: string; proposal: SendProposal };
    this.events.push('sign');
    this.requests.push(req);
    if (this.fail) throw this.fail;
    if (this.reply !== undefined) return this.reply as T;
    const honest = this.signed(req.proposal);
    const reply = this.tamper ? this.tamper(honest, req.proposal) : honest;
    this.replies.push(reply);
    return reply as T;
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
  let summaries: string[];
  let warnings: string[];

  /** The CLI's seams: the fake daemon, and the summary/warning writers captured in order with its requests. */
  const deps = (): CliDeps => ({
    client,
    summary: text => {
      client.events.push('summary');
      summaries.push(text);
    },
    warn: text => warnings.push(text),
  });

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
    summaries = [];
    warnings = [];
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

      const r = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps());

      expect(esplora.broadcasts).toHaveLength(1);
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]!.op).toBe('sign');
      expect(client.lastProposal.network).toBe(NETWORK);
      expect(client.lastProposal.prevouts).toHaveLength(1); // the unconfirmed coin is not spent
      expect(client.lastProposal.prevouts[0]!.amount).toBe(80_000);
      expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(r.explorerUrl).toBe(`${esplora.url}/tx/${r.txid}`);
      // What reached Esplora is the daemon's signed transaction, byte for byte: the txid of a segwit
      // transaction ignores witnesses, so comparing txids alone would pass for the unsigned body.
      expect(client.replies).toHaveLength(1);
      expect(esplora.broadcasts[0]).toBe(client.replies[0]!.signedTxHex);
      expect(esplora.broadcasts[0]).not.toBe(client.lastProposal.tx);
      expect(r.txid).toBe(client.replies[0]!.txid);
      expect(btc.Transaction.fromRaw(hex.decode(esplora.broadcasts[0]!)).getInput(0).finalScriptWitness).toHaveLength(1);

      const analysis = analyzeProposal(client.lastProposal, vault, NETWORK);
      expect(analysis.outputs.find(o => !o.isChange)).toMatchObject({ address: DEST, amount: 50_000 });
      expect(analysis.outputs.filter(o => o.isChange)).toHaveLength(1);
    });

    it('prints the summary to the summary writer before the daemon is asked to sign', async () => {
      esplora.fund(address, 80_000);
      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps());

      expect(client.events).toEqual(['summary', 'sign']);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(DEST);
      expect(summaries[0]).toContain('50000 sats');
      expect(summaries[0]).toMatch(/\bchange\b/);
      expect(summaries[0]).toMatch(/fee: \d+ sats \(0\.\d{8} BTC\), 5\.\d sat\/vB/);
    });

    it('does not print a summary for a send it refuses', async () => {
      esplora.fund(address, 1_000);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps())).rejects.toThrow(/insufficient/);
      expect(summaries).toEqual([]);
    });

    it('uses the Esplora normal fee rate by default and --fee-rate when given', async () => {
      esplora.fund(address, 500_000);
      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps());
      const normal = analyzeProposal(client.lastProposal, vault, NETWORK).feeRate;
      expect(normal).toBeGreaterThanOrEqual(5);
      expect(normal).toBeLessThan(5.5);

      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate: 20 }, deps());
      const custom = analyzeProposal(client.lastProposal, vault, NETWORK).feeRate;
      expect(custom).toBeGreaterThanOrEqual(20);
      expect(custom).toBeLessThan(20.5);
    });

    it('takes amounts with units', async () => {
      esplora.fund(address, 500_000);
      await btcSend({ configPath, vaultPath, to: DEST, amount: '0.0005btc' }, deps());
      const analysis = analyzeProposal(client.lastProposal, vault, NETWORK);
      expect(analysis.outputs.find(o => !o.isChange)!.amount).toBe(50_000);
    });

    it('max spends every confirmed UTXO with no change', async () => {
      esplora.fund(address, 80_000);
      esplora.fund(address, 40_000);
      esplora.fund(address, 30_000, { confirmed: false });

      await btcSend({ configPath, vaultPath, to: DEST, amount: 'max' }, deps());

      const analysis = analyzeProposal(client.lastProposal, vault, NETWORK);
      expect(analysis.inputs).toHaveLength(2);
      expect(analysis.outputs).toHaveLength(1);
      expect(analysis.outputs[0]).toMatchObject({ address: DEST, isChange: false });
      expect(esplora.broadcasts).toHaveLength(1);
    });

    it('send refuses before signing when more than 255 inputs are needed', async () => {
      for (let i = 0; i < 300; i++) esplora.fund(address, 1_000);

      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: 'max' }, deps())).rejects.toThrow(
        'this send needs 300 inputs; at most 255 fit in one transaction — consolidate first',
      );
      expect(client.requests).toHaveLength(0);
      expect(esplora.broadcasts).toHaveLength(0);
      expect(summaries).toEqual([]);
    });

    it('send fails before signing when Esplora is unreachable', async () => {
      const dead = await startMockEsplora();
      await dead.close();
      await writeFile(configPath, configToml(dead.url));

      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps())).rejects.toThrow(
        new RegExp(`Esplora ${dead.url}`),
      );
      expect(client.requests).toHaveLength(0);
    });

    it('a rejected broadcast surfaces the signed transaction hex', async () => {
      esplora.fund(address, 80_000);
      esplora.rejectBroadcasts('bad-txns-inputs-missingorspent');

      const err = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps()).then(
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

      const err = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps()).then(
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
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '545' }, deps())).rejects.toThrow(/546 sats/);
      expect(client.requests).toHaveLength(0);
    });

    it('refuses an address that is not valid for the vault network, before reaching Esplora', async () => {
      const dead = await startMockEsplora();
      await dead.close();
      await writeFile(configPath, configToml(dead.url));
      for (const to of ['not-an-address', MAINNET_DEST]) {
        await expect(btcSend({ configPath, vaultPath, to, amount: '50000' }, deps())).rejects.toThrow(
          /not a valid testnet4 address/,
        );
      }
      expect(client.requests).toHaveLength(0);
    });

    it('refuses bad amounts and fee rates', async () => {
      esplora.fund(address, 80_000);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: 'lots' }, deps())).rejects.toThrow(/invalid amount/);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '0.5sats' }, deps())).rejects.toThrow(/integer/);
      for (const feeRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_001]) {
        await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate }, deps())).rejects.toThrow(/fee rate/);
      }
      expect(client.requests).toHaveLength(0);
    });

    it('accepts a fee rate of exactly 10000 sat/vB and no more', async () => {
      esplora.fund(address, 5_000_000);
      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate: 10_000 }, deps());
      expect(analyzeProposal(client.lastProposal, vault, NETWORK).feeRate).toBeGreaterThanOrEqual(10_000);
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate: 10_001 }, deps())).rejects.toThrow(
        /at most 10000/,
      );
      expect(client.requests).toHaveLength(1);
    });

    it('refuses an unusable Esplora fee rate, naming the URL, before any daemon call', async () => {
      // One mock per value: the Esplora client caches fee rates per base URL for a minute.
      for (const halfHourFee of [0, -3, null, 'fast', 20_000, 10_001]) {
        const mock = await startMockEsplora();
        try {
          mock.fund(address, 80_000);
          mock.setFeeRates({ fastestFee: 10, halfHourFee, hourFee: 2 });
          await writeFile(configPath, configToml(mock.url));
          const err = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps()).then(
            () => null,
            (e: unknown) => e as Error,
          );
          expect(err, `halfHourFee ${String(halfHourFee)}`).toBeInstanceOf(Error);
          expect(err!.message).toContain(`Esplora ${mock.url}`);
          expect(err!.message).toContain(`(${String(halfHourFee)} sat/vB;`);
          expect(err!.message).toMatch(/unusable fee rate/);
          expect(err!.message).toMatch(/--fee-rate/);
          expect(mock.broadcasts).toHaveLength(0);
        } finally {
          await mock.close();
        }
      }
      expect(client.requests).toHaveLength(0);
      expect(summaries).toEqual([]);
    });

    it('an explicit --fee-rate does not depend on the Esplora estimate', async () => {
      esplora.fund(address, 80_000);
      esplora.setFeeRates({ fastestFee: 10, halfHourFee: 0, hourFee: 2 });
      await btcSend({ configPath, vaultPath, to: DEST, amount: '50000', feeRate: 3 }, deps());
      expect(client.requests).toHaveLength(1);
    });

    describe('the daemon reply is checked against the proposal before anything is broadcast', () => {
      async function refused(): Promise<Error> {
        esplora.fund(address, 80_000);
        const err = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps()).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err).toBeInstanceOf(Error);
        expect(client.requests).toHaveLength(1);
        expect(esplora.broadcasts).toEqual([]);
        return err!;
      }

      it('a signed transaction for a different proposal', async () => {
        const other = client.signed(makeProposal(vault, NETWORK));
        client.tamper = reply => ({ ...reply, txid: other.txid, signedTxHex: other.signedTxHex });
        expect((await refused()).message).toMatch(/different transaction than the proposal/);
      });

      it('a txid that is not the txid of its own signed transaction', async () => {
        client.tamper = reply => ({ ...reply, txid: 'ab'.repeat(32) });
        const err = await refused();
        expect(err.message).toMatch(/names txid abab/);
        expect(err.message).toMatch(/signed transaction is [0-9a-f]{64}/);
      });

      it('the unsigned proposal returned as if it were signed', async () => {
        client.tamper = (reply, proposal) => ({ ...reply, signedTxHex: proposal.tx });
        expect((await refused()).message).toMatch(/no signature for input 0/);
      });

      it('a signed transaction that cannot be decoded', async () => {
        client.tamper = reply => ({ ...reply, signedTxHex: 'abcdef' });
        expect((await refused()).message).toMatch(/cannot be decoded/);
      });

      it('an honest reply is broadcast', async () => {
        esplora.fund(address, 80_000);
        await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps());
        expect(esplora.broadcasts).toHaveLength(1);
        expect(warnings).toEqual([]);
      });
    });

    it('warns, and still succeeds, when Esplora answers a different txid', async () => {
      esplora.fund(address, 80_000);
      esplora.answerBroadcastsWith('cd'.repeat(32));
      const r = await btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps());
      expect(r.txid).toBe(client.replies[0]!.txid);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('cd'.repeat(32));
      expect(warnings[0]).toContain(r.txid);
      expect(warnings[0]).toContain(esplora.url);
    });

    it('passes a daemon refusal through and broadcasts nothing', async () => {
      esplora.fund(address, 80_000);
      client.fail = new DaemonClientError(403, 'gate rejected');
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps())).rejects.toMatchObject({
        status: 403,
        message: 'gate rejected',
      });
      expect(esplora.broadcasts).toHaveLength(0);
    });

    it('rejects a daemon reply without a signed transaction', async () => {
      esplora.fund(address, 80_000);
      client.reply = { ceremonyId: 'sign-x', status: 'done' };
      await expect(btcSend({ configPath, vaultPath, to: DEST, amount: '50000' }, deps())).rejects.toThrow(
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

      const dry = await btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, deps());

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

      const wet = await btcSign({ configPath, vaultPath, proposalPath, broadcast: true }, deps());

      expect(esplora.broadcasts).toEqual([wet.signedTxHex]);
      expect(wet.explorerUrl).toBe(`${esplora.url}/tx/${wet.txid}`);
    });

    it('prints the summary before the daemon is asked to sign, and keeps it in the result', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, NETWORK, { outputs: [{ address: DEST, amount: 50_000 }] }));
      const r = await btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, deps());
      expect(client.events).toEqual(['summary', 'sign']);
      expect(summaries).toEqual([r.summary]);
      expect(r.summary).toContain(DEST);
    });

    it('does not print a summary for a proposal it refuses', async () => {
      const proposalPath = await writeProposal(makeProposal(makeTestVault(2, 3).vault, NETWORK));
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: true }, deps())).rejects.toThrow(/refused/);
      expect(summaries).toEqual([]);
      expect(client.events).toEqual([]);
    });

    it('does not broadcast a reply that is not the proposal, with or without --broadcast', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, NETWORK));
      const other = client.signed(makeProposal(vault, NETWORK));
      client.tamper = reply => ({ ...reply, txid: other.txid, signedTxHex: other.signedTxHex });
      for (const broadcast of [false, true]) {
        await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast }, deps())).rejects.toThrow(
          /different transaction than the proposal/,
        );
      }
      expect(esplora.broadcasts).toEqual([]);
    });

    it('warns when Esplora answers a different txid for a broadcast proposal', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, NETWORK));
      esplora.answerBroadcastsWith('cd'.repeat(32));
      const r = await btcSign({ configPath, vaultPath, proposalPath, broadcast: true }, deps());
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(r.txid);
    });

    it('a rejected broadcast of a signed proposal surfaces the signed hex', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, NETWORK));
      esplora.rejectBroadcasts('txn-mempool-conflict');
      const err = await btcSign({ configPath, vaultPath, proposalPath, broadcast: true }, deps()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BroadcastFailedError);
      expect((err as BroadcastFailedError).signedTxHex).toMatch(/^[0-9a-f]+$/);
    });

    it('fails analysis before any daemon call for a proposal this vault would not sign', async () => {
      const other = makeTestVault(2, 3).vault;
      const proposalPath = await writeProposal(makeProposal(other, NETWORK));
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, deps())).rejects.toThrow(
        /does not spend a coin of this vault/,
      );
      expect(client.requests).toHaveLength(0);
    });

    it('refuses a proposal for another network before any daemon call', async () => {
      const proposalPath = await writeProposal(makeProposal(vault, 'mainnet'));
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, deps())).rejects.toThrow(
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
      await expect(btcSign({ configPath, vaultPath, proposalPath, broadcast: false }, deps())).rejects.toThrow(
        'proposal has 256 inputs; at most 255 fit in one transaction',
      );
      expect(client.requests).toHaveLength(0);
    });

    it('names the file when it is missing, not JSON, or not a proposal', async () => {
      const missing = join(tmp, 'absent.json');
      await expect(btcSign({ configPath, vaultPath, proposalPath: missing, broadcast: false }, deps())).rejects.toThrow(
        /absent\.json/,
      );
      const notJson = join(tmp, 'garbage.json');
      await writeFile(notJson, '{nope');
      await expect(btcSign({ configPath, vaultPath, proposalPath: notJson, broadcast: false }, deps())).rejects.toThrow(
        /garbage\.json.*JSON/,
      );
      const wrongShape = await writeProposal({ network: NETWORK });
      await expect(btcSign({ configPath, vaultPath, proposalPath: wrongShape, broadcast: false }, deps())).rejects.toThrow(
        /proposal must be/,
      );
      expect(client.requests).toHaveLength(0);
    });
  });
});
