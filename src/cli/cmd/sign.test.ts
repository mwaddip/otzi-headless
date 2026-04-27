import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UdsTrigger } from '../../triggers/uds';
import { sign } from './sign';

describe('sign command', () => {
  let tmp: string;
  let socketPath: string;
  let manifestPath: string;
  let configPath: string;
  let trigger: UdsTrigger;
  let receivedRequests: Array<Record<string, unknown>>;

  const validManifest = {
    version: 1,
    name: 'Test',
    contracts: [
      { name: 'Coin', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
      {
        name: 'Reserve',
        address: '0x' + 'bb'.repeat(32),
        type: 'Custom',
        abi: [
          {
            name: 'emergencyWithdraw',
            params: [{ name: 'to', type: 'address' }],
          },
        ],
      },
    ],
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-sign-test-'));
    socketPath = join(tmp, 'sock');
    manifestPath = join(tmp, 'manifest.json');
    configPath = join(tmp, 'daemon.toml');
    receivedRequests = [];

    await writeFile(manifestPath, JSON.stringify(validManifest));
    await writeFile(
      configPath,
      `
[share]
path = "/tmp/x"
password_env = "X"
[node]
id = "a"
[network]
name = "regtest"
opnet_rpc = "http://x"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "127.0.0.1:8801"
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
        receivedRequests.push(body);
        if (body.op === 'vault-info') {
          return {
            status: 200,
            body: {
              partyIds: [0, 1, 2],
              threshold: 2,
              parties: 3,
              network: 'regtest',
              btcAddress: 'bcrt1pmocked',
              opnetAddress: '0x' + '11'.repeat(32),
            },
          };
        }
        if (body.op === 'sign' && body.scheme === 'mldsa') {
          return {
            status: 200,
            body: { signatureHex: 'cafe'.repeat(8) },
          };
        }
        if (body.op === 'sign' && body.scheme === 'frost' && body.protocol === 'opnet-params') {
          return {
            status: 200,
            body: {
              transactionId: '0xabcd',
              signaturesHex: ['de'.repeat(32)],
            },
          };
        }
        return { status: 400, body: { error: `unhandled op ${String(body.op)}` } };
      },
    });
    await trigger.start();
  });

  afterEach(async () => {
    await trigger.stop();
    await rm(tmp, { recursive: true, force: true });
  });

  it('runs ML-DSA pre-sign then FROST sign+broadcast and returns transactionId', async () => {
    const result = await sign({
      configPath,
      manifestPath,
      contractIdent: 'Coin',
      methodIdent: 'transfer',
      args: ['0x' + 'cc'.repeat(32), '25000000'],
    });
    expect(result.transactionId).toBe('0xabcd');

    // Verify the ceremony order: vault-info → mldsa → frost
    expect(receivedRequests.length).toBeGreaterThanOrEqual(3);
    expect(receivedRequests[0]!.op).toBe('vault-info');
    expect(receivedRequests[1]!.op).toBe('sign');
    expect(receivedRequests[1]!.scheme).toBe('mldsa');
    expect(receivedRequests[1]!.protocol).toBe('raw');
    expect(receivedRequests[2]!.op).toBe('sign');
    expect(receivedRequests[2]!.scheme).toBe('frost');
    expect(receivedRequests[2]!.protocol).toBe('opnet-params');
    // The frost call carries the mldsa sig that came back from the prior call.
    expect(receivedRequests[2]!.mldsaThresholdSignatureHex).toBe('cafe'.repeat(8));
    // Wire param types are the encoder-narrowed set.
    expect(receivedRequests[2]!.paramTypes).toEqual(['address', 'u256']);
    expect(receivedRequests[2]!.contractAddress).toBe('0x' + 'aa'.repeat(32));
  });

  it('resolves contract by 1-based index and method by letter', async () => {
    const result = await sign({
      configPath,
      manifestPath,
      contractIdent: '1',
      methodIdent: 'a',
      args: ['0x' + 'cc'.repeat(32), '1'],
    });
    expect(result.transactionId).toBe('0xabcd');
  });

  it('rejects unknown contract', async () => {
    await expect(
      sign({
        configPath,
        manifestPath,
        contractIdent: 'Bitcoin',
        methodIdent: 'transfer',
        args: ['0x' + 'cc'.repeat(32), '1'],
      }),
    ).rejects.toThrow(/no contract/);
  });

  it('rejects too few args', async () => {
    await expect(
      sign({
        configPath,
        manifestPath,
        contractIdent: 'Coin',
        methodIdent: 'transfer',
        args: ['0x' + 'cc'.repeat(32)], // missing amount
      }),
    ).rejects.toThrow(/takes 2 arg/);
  });

  it('rejects bad address arg', async () => {
    await expect(
      sign({
        configPath,
        manifestPath,
        contractIdent: 'Coin',
        methodIdent: 'transfer',
        args: ['notAnAddress', '1'],
      }),
    ).rejects.toThrow(/address/);
  });

  it('errors when manifest is missing', async () => {
    await rm(manifestPath);
    await expect(
      sign({
        configPath,
        manifestPath,
        contractIdent: 'Coin',
        methodIdent: 'transfer',
        args: ['0x' + 'cc'.repeat(32), '1'],
      }),
    ).rejects.toThrow(/no manifest installed/);
  });
});
