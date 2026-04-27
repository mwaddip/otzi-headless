/**
 * Bootstrap CLI helpers — wraps `runMasterBootstrap` / `runMemberRegister`
 * with identity-key generation + pubkey-book persistence so an operator can
 * drive a fresh federation through two commands:
 *
 *   otzi setup master <config.toml> --bind 0.0.0.0:7090
 *   otzi setup member <config.toml> --master http://master-host:7090
 *
 * Idempotent: re-running after an abort is safe. If `identity_key_file`
 * already exists it is reused; if `pubkey_book_file` already exists the
 * fingerprint is re-emitted without re-running bootstrap.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runMasterBootstrap } from '../bootstrap/master';
import {
  computeFingerprint,
  parseBook,
  serializeBook,
  type PubkeyBook,
} from '../bootstrap/pubkey-book';
import { runMemberRegister } from '../bootstrap/register';
import { loadDaemonConfig } from '../config/load';
import type { DaemonConfig } from '../config/types';
import {
  exportPrivateKeyPkcs8,
  generateIdentity,
  importIdentity,
  type IdentityKeyPair,
} from '../transport/identity';
import { fromHex, toHex } from '../wire/hex';

export async function setupMaster(configPath: string, bind: string): Promise<void> {
  const config = await loadDaemonConfig(configPath);
  requireIdentityPath(config);
  requirePubkeyBookPath(config);

  const existing = await tryLoadExistingBook(config);
  if (existing) {
    const fp = await computeFingerprint(existing);
    announceComplete(fp, config, 'book already present — re-emitting fingerprint without re-bootstrapping');
    return;
  }

  if (config.transport.kind !== 'peer-mesh') {
    throw new Error('setup: bootstrap requires transport.kind = "peer-mesh"');
  }
  const selfAdvertisedEndpoint = config.transport.advertisedEndpoint;
  if (!selfAdvertisedEndpoint) {
    throw new Error(
      "setup: bootstrap requires transport.advertised_endpoint set to this node's reachable address",
    );
  }

  const expectedPeers = config.peers.map((p) => ({ advertisedEndpoint: p.endpoint }));

  const identity = await loadOrGenerateIdentity(config);

  console.error(
    `otzi: setup master — listening on ${bind}, expecting ${expectedPeers.length} peer(s) to register`,
  );
  const { book, fingerprint } = await runMasterBootstrap({
    self: { identity, advertisedEndpoint: selfAdvertisedEndpoint },
    expectedPeers,
    bind,
  });

  await writePubkeyBookFile(config, book);
  announceComplete(fingerprint, config);
}

export async function setupMember(configPath: string, masterUrl: string): Promise<void> {
  const config = await loadDaemonConfig(configPath);
  requireIdentityPath(config);
  requirePubkeyBookPath(config);

  const existing = await tryLoadExistingBook(config);
  if (existing) {
    const fp = await computeFingerprint(existing);
    announceComplete(fp, config, 'book already present — re-emitting fingerprint without re-registering');
    return;
  }

  if (config.transport.kind !== 'peer-mesh') {
    throw new Error('setup: bootstrap requires transport.kind = "peer-mesh"');
  }
  const selfAdvertisedEndpoint = config.transport.advertisedEndpoint;
  if (!selfAdvertisedEndpoint) {
    throw new Error(
      "setup: bootstrap requires transport.advertised_endpoint set to this node's reachable address",
    );
  }

  const identity = await loadOrGenerateIdentity(config);

  console.error(`otzi: setup member — registering with ${masterUrl}`);
  const { book, fingerprint } = await runMemberRegister({
    self: { identity, advertisedEndpoint: selfAdvertisedEndpoint },
    masterUrl,
  });

  await writePubkeyBookFile(config, book);
  announceComplete(fingerprint, config);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function requireIdentityPath(config: DaemonConfig): asserts config is DaemonConfig & {
  node: { identityKeyFile: string };
} {
  if (!config.node.identityKeyFile)
    throw new Error('setup: config [node] identity_key_file is required');
}

function requirePubkeyBookPath(config: DaemonConfig): asserts config is DaemonConfig & {
  node: { pubkeyBookFile: string };
} {
  if (!config.node.pubkeyBookFile)
    throw new Error('setup: config [node] pubkey_book_file is required');
}

async function loadOrGenerateIdentity(config: DaemonConfig): Promise<IdentityKeyPair> {
  const file = config.node.identityKeyFile!;
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as { pkcs8Hex?: unknown; publicKeyHex?: unknown };
    if (typeof parsed.pkcs8Hex === 'string' && typeof parsed.publicKeyHex === 'string') {
      console.error(`otzi: loaded existing identity from ${file}`);
      return importIdentity(fromHex(parsed.pkcs8Hex), fromHex(parsed.publicKeyHex));
    }
    throw new Error(`identity file ${file} is malformed (expected pkcs8Hex + publicKeyHex)`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  console.error(`otzi: generating new identity at ${file}`);
  const identity = await generateIdentity(true);
  const pkcs8 = await exportPrivateKeyPkcs8(identity);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      { pkcs8Hex: toHex(pkcs8), publicKeyHex: toHex(identity.publicKeyRaw) },
      null,
      2,
    ),
    { mode: 0o660 },
  );
  return identity;
}

async function writePubkeyBookFile(config: DaemonConfig, book: PubkeyBook): Promise<void> {
  const file = config.node.pubkeyBookFile!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeBook(book), { mode: 0o644 });
  console.error(`otzi: wrote pubkey book to ${file}`);
}

async function tryLoadExistingBook(config: DaemonConfig): Promise<PubkeyBook | null> {
  const file = config.node.pubkeyBookFile!;
  try {
    const text = await readFile(file, 'utf8');
    return parseBook(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function announceComplete(fingerprint: string, config: DaemonConfig, note?: string): void {
  const nodeId = config.node.id;
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`  otzi: setup complete — ${nodeId}`);
  console.error(`  fingerprint: ${fingerprint}`);
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('  ⚠ Verify this fingerprint is identical on EVERY other node.');
  console.error('  If any node reports a different value, someone tampered with');
  console.error('  the bootstrap exchange. Delete pubkey books on every node and');
  console.error('  re-run setup.');
  if (note) console.error(`  note: ${note}`);
  console.error('');
}
