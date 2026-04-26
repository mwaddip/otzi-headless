import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlPlane,
  ControlPlaneClosed,
  HmacMismatch,
  ManifestExists,
  ManifestRejected,
} from './control-plane';

const VALID_MANIFEST = JSON.stringify({
  version: 1,
  name: 'X',
  contracts: [
    { name: 'C', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
  ],
});

function hmacOf(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

describe('ControlPlane.installPushedManifest', () => {
  let tmp: string;
  let secretPath: string;
  let manifestPath: string;
  let cp: ControlPlane;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cp-test-'));
    secretPath = join(tmp, 'secret');
    manifestPath = join(tmp, 'manifest.json');
    cp = new ControlPlane({ secretPath, manifestPath });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('throws ControlPlaneClosed when secret is absent', async () => {
    await expect(
      cp.installPushedManifest({ manifest: VALID_MANIFEST, hmacHex: 'aa'.repeat(32) }),
    ).rejects.toBeInstanceOf(ControlPlaneClosed);
  });

  it('throws ControlPlaneClosed when secret is empty', async () => {
    await writeFile(secretPath, '   \n  ');
    await expect(
      cp.installPushedManifest({ manifest: VALID_MANIFEST, hmacHex: 'aa'.repeat(32) }),
    ).rejects.toBeInstanceOf(ControlPlaneClosed);
  });

  it('throws HmacMismatch on bad hmac', async () => {
    await writeFile(secretPath, 'shared');
    await expect(
      cp.installPushedManifest({ manifest: VALID_MANIFEST, hmacHex: 'aa'.repeat(32) }),
    ).rejects.toBeInstanceOf(HmacMismatch);
  });

  it('throws HmacMismatch on hmac wrong length (constant-time path)', async () => {
    await writeFile(secretPath, 'shared');
    await expect(
      cp.installPushedManifest({ manifest: VALID_MANIFEST, hmacHex: 'aa'.repeat(16) }),
    ).rejects.toBeInstanceOf(HmacMismatch);
  });

  it('throws ManifestRejected when manifest is not JSON', async () => {
    await writeFile(secretPath, 'shared');
    const bad = '{ not json';
    await expect(
      cp.installPushedManifest({ manifest: bad, hmacHex: hmacOf('shared', bad) }),
    ).rejects.toBeInstanceOf(ManifestRejected);
  });

  it('throws ManifestRejected on schema failure', async () => {
    await writeFile(secretPath, 'shared');
    const bad = JSON.stringify({ version: 99 });
    await expect(
      cp.installPushedManifest({ manifest: bad, hmacHex: hmacOf('shared', bad) }),
    ).rejects.toBeInstanceOf(ManifestRejected);
  });

  it('installs valid manifest with matching HMAC', async () => {
    await writeFile(secretPath, 'shared');
    await cp.installPushedManifest({
      manifest: VALID_MANIFEST,
      hmacHex: hmacOf('shared', VALID_MANIFEST),
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(VALID_MANIFEST);
  });

  it('is idempotent on a byte-identical existing manifest', async () => {
    await writeFile(secretPath, 'shared');
    await writeFile(manifestPath, VALID_MANIFEST);
    await cp.installPushedManifest({
      manifest: VALID_MANIFEST,
      hmacHex: hmacOf('shared', VALID_MANIFEST),
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(VALID_MANIFEST);
  });

  it('throws ManifestExists when an existing manifest differs', async () => {
    await writeFile(secretPath, 'shared');
    await writeFile(manifestPath, '{"version":1,"name":"OTHER","contracts":[]}');
    await expect(
      cp.installPushedManifest({
        manifest: VALID_MANIFEST,
        hmacHex: hmacOf('shared', VALID_MANIFEST),
      }),
    ).rejects.toBeInstanceOf(ManifestExists);
  });

  it('trims trailing whitespace before identical-comparison', async () => {
    await writeFile(secretPath, 'shared');
    await writeFile(manifestPath, VALID_MANIFEST + '\n');
    await cp.installPushedManifest({
      manifest: VALID_MANIFEST,
      hmacHex: hmacOf('shared', VALID_MANIFEST),
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(VALID_MANIFEST + '\n');
  });
});
