import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDkg } from './dkg.fixture';
import { encryptShareFile, decryptShareFile, assertShareMatchesVault, shareFileName } from './share-file';
import { toVaultKey } from './dkg';
import { toHex } from './hex';

test('share file v4 round-trips and validates', async () => {
  const { keyPackages, publicKeyPackages } = runDkg(2, 3);
  const file = await encryptShareFile(keyPackages[1]!, publicKeyPackages[1]!, 'signet', 1, 'correct horse');
  assert.equal(file.version, 4);
  assert.equal(file.partyId, 1);
  assert.equal(file.threshold, 2);
  assert.equal(file.parties, 3);
  assert.match(shareFileName(file), /^otzi-share-signet-p2-[a-z0-9]{8}\.json$/);

  const share = await decryptShareFile(JSON.parse(JSON.stringify(file)), 'correct horse');
  assert.equal(share.keyPackage.signingShare, keyPackages[1]!.signingShare);
  assert.equal(share.keyPackage.untweakedSigningShare, keyPackages[1]!.untweakedSigningShare);
  assert.equal(toHex(share.publicKeyPackage.verifyingKey), toHex(publicKeyPackages[0]!.verifyingKey));
  assert.equal(share.publicKeyPackage.verifyingShares.size, 3);

  const vault = toVaultKey(publicKeyPackages[0]!);
  assertShareMatchesVault(share, 'signet', vault);
  assert.throws(() => assertShareMatchesVault(share, 'mainnet', vault), /different vault/);
  assert.throws(() => assertShareMatchesVault(share, 'signet', toVaultKey(runDkg(2, 2).publicKeyPackages[0]!)), /different vault/);
});

test('wrong password, wrong version and tampered headers are rejected', async () => {
  const { keyPackages, publicKeyPackages } = runDkg(2, 2);
  const file = await encryptShareFile(keyPackages[0]!, publicKeyPackages[0]!, 'testnet4', 0, 'pw-pw-pw-pw');
  await assert.rejects(() => decryptShareFile(file, 'nope'));
  await assert.rejects(() => decryptShareFile({ ...file, version: 3 }, 'pw-pw-pw-pw'), /Unsupported share file version/);
  await assert.rejects(() => decryptShareFile({ ...file, partyId: 1 }, 'pw-pw-pw-pw'), /corrupted/);
  await assert.rejects(() => decryptShareFile({ ...file, threshold: 1 }, 'pw-pw-pw-pw'), /corrupted/);
  await assert.rejects(() => decryptShareFile({ ...file, network: 'mainnet' }, 'pw-pw-pw-pw'), /corrupted/);
  const other = runDkg(2, 2).publicKeyPackages[0]!;
  await assert.rejects(() => decryptShareFile({ ...file, internalKey: toHex(other.untweakedVerifyingKey) }, 'pw-pw-pw-pw'), /corrupted/);
  await assert.rejects(() => encryptShareFile(keyPackages[0]!, publicKeyPackages[0]!, 'testnet4', 1, 'x'), /does not belong/);
});
