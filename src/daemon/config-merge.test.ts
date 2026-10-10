import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../config/parse';
import type { Logger } from '../orchestrator/types';
import { vaultPayment } from '../otzi/lib/bitcoin';
import { toVaultKey } from '../otzi/lib/dkg';
import { encryptShareFile, type ShareFile } from '../otzi/lib/share-file';
import { testVault, type TestVault } from '../testing/proposal';
import { loadAndValidate } from './config-merge';
import { readVaultPubkeyFile } from './vault-pubkey';
import { pendingPath } from './vault-share';

const PASSWORD = 'config-merge-password';

let vault: TestVault;
let shareFile: ShareFile;

beforeAll(async () => {
  vault = testVault(3, 3);
  shareFile = await encryptShareFile(vault.keyPackages[2]!, vault.publicKeyPackage, 'testnet4', 2, PASSWORD);
});

function capturingLogger(): { logger: Logger; warnings: Array<{ msg: string; extra?: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const noop = () => {};
  return {
    logger: { debug: noop, info: noop, error: noop, warn: (msg, extra) => warnings.push({ msg, extra }) },
    warnings,
  };
}

describe('loadAndValidate', () => {
  let dir: string;
  let configPath: string;
  let sharePath: string;
  let vaultPubkeyPath: string;
  const env = { OTZI_SHARE_PASSWORD: PASSWORD };

  function toml(opts: { network?: string; extra?: string } = {}): string {
    return `
[share]
path = "${sharePath}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-c"

[network]
name = "${opts.network ?? 'testnet4'}"
${opts.extra ?? ''}

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8802"

[[peers]]
endpoint = "127.0.0.1:8800"

[[peers]]
endpoint = "127.0.0.1:8801"

[gate]
strategy = "auto"
`;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-merge-test-'));
    configPath = join(dir, 'daemon.toml');
    sharePath = join(dir, 'state', 'share.json');
    vaultPubkeyPath = join(dir, 'meta', 'vault-pubkey.json');
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(configPath, toml());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeShare = (file: unknown = shareFile) => writeFile(sharePath, JSON.stringify(file), { mode: 0o600 });

  it('loads the config and the decrypted share, and writes vault-pubkey.json', async () => {
    await writeShare();
    const state = await loadAndValidate(configPath, { env, vaultPubkeyPath });
    expect(state.config.network).toEqual({ name: 'testnet4' });
    expect(state.password).toBe(PASSWORD);
    expect(state.share).toBeDefined();
    expect(state.share!.partyId).toBe(2);
    expect(state.share!.keyPackage.signingShare).toBe(vault.keyPackages[2]!.signingShare);
    const vp = await readVaultPubkeyFile(vaultPubkeyPath);
    expect(vp.address).toBe(vaultPayment(toVaultKey(vault.publicKeyPackage), 'testnet4').address);
    expect(vp.vaultKey).toEqual(toVaultKey(vault.publicKeyPackage));
    expect(vp.threshold).toBe(3);
    expect(vp.parties).toBe(3);
  });

  it('rewrites a stale vault-pubkey.json on every start', async () => {
    await writeShare();
    await mkdir(join(dir, 'meta'), { recursive: true });
    await writeFile(vaultPubkeyPath, '{"stale":true}');
    await loadAndValidate(configPath, { env, vaultPubkeyPath });
    expect((await readVaultPubkeyFile(vaultPubkeyPath)).address.startsWith('tb1p')).toBe(true);
  });

  it('starts without a share, keeps the password and writes nothing', async () => {
    const state = await loadAndValidate(configPath, { env, vaultPubkeyPath });
    expect(state.share).toBeUndefined();
    expect(state.password).toBe(PASSWORD);
    expect(existsSync(vaultPubkeyPath)).toBe(false);
  });

  it('requires the password env var even without a share', async () => {
    await expect(loadAndValidate(configPath, { env: {}, vaultPubkeyPath })).rejects.toThrow(
      /OTZI_SHARE_PASSWORD.*not set/,
    );
    await expect(
      loadAndValidate(configPath, { env: { OTZI_SHARE_PASSWORD: '' }, vaultPubkeyPath }),
    ).rejects.toThrow(/OTZI_SHARE_PASSWORD.*not set/);
  });

  it('reads the password from process.env by default', async () => {
    const prior = process.env.OTZI_SHARE_PASSWORD;
    process.env.OTZI_SHARE_PASSWORD = PASSWORD;
    try {
      const state = await loadAndValidate(configPath, { vaultPubkeyPath });
      expect(state.password).toBe(PASSWORD);
    } finally {
      if (prior === undefined) delete process.env.OTZI_SHARE_PASSWORD;
      else process.env.OTZI_SHARE_PASSWORD = prior;
    }
  });

  it('refuses a wrong password without leaking it, and writes nothing', async () => {
    await writeShare();
    const err = await loadAndValidate(configPath, {
      env: { OTZI_SHARE_PASSWORD: 'wrong-password-value' },
      vaultPubkeyPath,
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toBe(
      `cannot decrypt share file ${sharePath}: wrong password or corrupted file`,
    );
    expect(err!.message).not.toContain('wrong-password-value');
    expect(existsSync(vaultPubkeyPath)).toBe(false);
  });

  it('refuses a share for another network and writes nothing', async () => {
    await writeShare();
    await writeFile(configPath, toml({ network: 'signet' }));
    await expect(loadAndValidate(configPath, { env, vaultPubkeyPath })).rejects.toThrow(
      'This share file belongs to a different vault',
    );
    expect(existsSync(vaultPubkeyPath)).toBe(false);
  });

  it('never treats a bad share as "no vault"', async () => {
    await writeFile(sharePath, 'garbage', { mode: 0o600 });
    await expect(loadAndValidate(configPath, { env, vaultPubkeyPath })).rejects.toThrow(
      `share file ${sharePath} is not valid JSON`,
    );
  });

  it('surfaces config errors', async () => {
    await writeFile(configPath, toml({ extra: 'opnet_rpc = "https://x"' }));
    await expect(loadAndValidate(configPath, { env, vaultPubkeyPath })).rejects.toBeInstanceOf(ConfigError);
  });

  it('logs a warning and still starts when vault-pubkey.json cannot be written', async () => {
    await writeShare();
    await writeFile(join(dir, 'blocker'), 'x');
    const { logger, warnings } = capturingLogger();
    const state = await loadAndValidate(configPath, {
      env,
      vaultPubkeyPath: join(dir, 'blocker', 'vault-pubkey.json'),
      logger,
    });
    expect(state.share).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toMatch(/vault-pubkey\.json/);
    expect(JSON.stringify(warnings)).not.toContain(PASSWORD);
  });

  it('warns about a leftover .pending file next to a loaded share, without loading it', async () => {
    await writeShare();
    await writeFile(pendingPath(sharePath), 'unfinished');
    const { logger, warnings } = capturingLogger();
    const state = await loadAndValidate(configPath, { env, vaultPubkeyPath, logger });
    expect(state.share!.partyId).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain(pendingPath(sharePath));
  });

  it('warns about a leftover .pending file on a node without a share', async () => {
    await writeFile(pendingPath(sharePath), 'unfinished');
    const { logger, warnings } = capturingLogger();
    const state = await loadAndValidate(configPath, { env, vaultPubkeyPath, logger });
    expect(state.share).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain(pendingPath(sharePath));
  });

  it('does not warn when there is no .pending file', async () => {
    await writeShare();
    const { logger, warnings } = capturingLogger();
    await loadAndValidate(configPath, { env, vaultPubkeyPath, logger });
    expect(warnings).toEqual([]);
  });
});
