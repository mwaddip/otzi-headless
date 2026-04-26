import { initEccLib } from '@btc-vision/bitcoin';
import { createNobleBackend } from '@btc-vision/ecpair';
import { schnorr } from '@noble/curves/secp256k1.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVaultPubkeyFile } from './vault-pubkey';

// Taproot address derivation uses secp256k1 ECC — init once (idempotent).
initEccLib(createNobleBackend());

/**
 * Derive a valid 33B SEC1 compressed pubkey from a fixed scalar.
 * `payments.p2tr` validates that the x-only x-coord lies on the curve, so
 * we can't pass arbitrary bytes — they'd fail "Invalid internal pubkey".
 */
function compressedPubkeyFromScalar(scalarByte: number): Uint8Array {
  const sk = new Uint8Array(32);
  sk[31] = scalarByte;
  const xOnly = schnorr.getPublicKey(sk); // 32 bytes
  const out = new Uint8Array(33);
  out[0] = 0x02;
  out.set(xOnly, 1);
  return out;
}

describe('writeVaultPubkeyFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-pubkey-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a JSON payload with expected fields on testnet', async () => {
    const out = join(dir, 'vault.json');
    const frostUntweaked = compressedPubkeyFromScalar(7);
    const frostTweaked = new Uint8Array(32).fill(0xbb);
    const mldsa = new Uint8Array(1312).fill(0xcc);
    await writeVaultPubkeyFile({
      network: 'testnet',
      frostUntweakedPubKey: frostUntweaked,
      frostTweakedPubKey: frostTweaked,
      mldsaPubKey: mldsa,
      outputPath: out,
    });

    const json = JSON.parse(await readFile(out, 'utf8'));
    expect(json.network).toBe('testnet');
    // OPNet's bundled testnet uses bech32 prefix 'opt' (not stock Bitcoin's
    // 'tb'); see node/opnet-client.getNetwork() — 'testnet' resolves to
    // networks.opnetTestnet.
    expect(json.btcAddress).toMatch(/^opt1p/);
    expect(json.opnetAddress).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.frostUntweakedPubKey).toMatch(/^[0-9a-f]{66}$/); // 33B = 66 hex
    expect(json.frostTweakedPubKey).toBe('bb'.repeat(32));
    expect(json.mldsaPubKeyHex).toBe('cc'.repeat(1312));
  });

  it('writes mode 0o644', async () => {
    const out = join(dir, 'vault.json');
    await writeVaultPubkeyFile({
      network: 'testnet',
      frostUntweakedPubKey: compressedPubkeyFromScalar(11),
      frostTweakedPubKey: new Uint8Array(32).fill(0x77),
      mldsaPubKey: new Uint8Array(1312).fill(0x99),
      outputPath: out,
    });
    const s = await stat(out);
    expect(s.mode & 0o777).toBe(0o644);
  });

  it('handles regtest by emitting a regtest bech32m address', async () => {
    const out = join(dir, 'vault.json');
    await writeVaultPubkeyFile({
      network: 'regtest',
      frostUntweakedPubKey: compressedPubkeyFromScalar(13),
      frostTweakedPubKey: new Uint8Array(32).fill(0x44),
      mldsaPubKey: new Uint8Array(1312).fill(0x66),
      outputPath: out,
    });
    const json = JSON.parse(await readFile(out, 'utf8'));
    expect(json.network).toBe('regtest');
    // Regtest P2TR uses the bcrt1p prefix.
    expect(json.btcAddress).toMatch(/^bcrt1p/);
  });
});
