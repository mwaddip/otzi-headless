/**
 * Bootstrap CLI helpers — wraps `runMasterBootstrap` / `runMemberRegister`
 * with identity-key generation + pubkey-book persistence so an operator can
 * drive a fresh federation through two commands:
 *
 *   otzi setup master <config.toml> --bind 0.0.0.0:7090
 *   otzi setup member <config.toml> --master http://master-host:7090
 *
 * The transport picks the leader's admission: peer-mesh admits the
 * `[[peers]]` endpoints, relay admits `[bootstrap] parties − 1` registrations
 * that carry no endpoint. Every node's banner prints the fingerprint, this
 * node's key id and every ring key id.
 *
 * Idempotent: re-running after an abort is safe. If `identity_key_file`
 * already exists it is reused; if `pubkey_book_file` already exists the
 * banner is re-emitted without re-running bootstrap.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runMasterBootstrap, type MasterAdmission } from '../bootstrap/master';
import {
  computeFingerprint,
  keyId,
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
import { fromHex, toHex } from '../otzi/lib/hex';

export async function setupMaster(configPath: string, bind: string): Promise<void> {
  const config = await loadDaemonConfig(configPath);
  requireIdentityPath(config);
  requirePubkeyBookPath(config);

  const existing = await tryLoadExistingBook(config);
  if (existing) {
    await reannounce(existing, config, 'book already present — re-emitting fingerprint without re-bootstrapping');
    return;
  }

  const admission = masterAdmission(config);
  const identity = await loadOrGenerateIdentity(config);

  if (admission.kind === 'endpoints') {
    console.error(
      `otzi: setup master — listening on ${bind}, expecting ${admission.expectedPeers.length} peer(s) to register`,
    );
  } else {
    console.error(
      `otzi: setup master — listening on ${bind}, expecting ${admission.parties - 1} peer(s) to register ` +
        '(relay: the first to register are admitted — keep this port reachable only by the members)',
    );
  }
  const { book, fingerprint } = await runMasterBootstrap({
    self: { identity },
    admission,
    bind,
  });

  await writePubkeyBookFile(config, book);
  announceComplete({ fingerprint, book, selfPublicKeyHex: toHex(identity.publicKeyRaw), config });
}

export async function setupMember(configPath: string, masterUrl: string): Promise<void> {
  const config = await loadDaemonConfig(configPath);
  requireIdentityPath(config);
  requirePubkeyBookPath(config);

  const existing = await tryLoadExistingBook(config);
  if (existing) {
    await reannounce(existing, config, 'book already present — re-emitting fingerprint without re-registering');
    return;
  }

  // Relay registers no endpoint; peer-mesh registers this node's.
  const advertisedEndpoint =
    config.transport.kind === 'relay' ? undefined : requireAdvertisedEndpoint(config);

  const identity = await loadOrGenerateIdentity(config);

  console.error(`otzi: setup member — registering with ${masterUrl}`);
  const { book, fingerprint } = await runMemberRegister({
    self: { identity, ...(advertisedEndpoint !== undefined ? { advertisedEndpoint } : {}) },
    masterUrl,
  });

  await writePubkeyBookFile(config, book);
  announceComplete({ fingerprint, book, selfPublicKeyHex: toHex(identity.publicKeyRaw), config });
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

function requireAdvertisedEndpoint(config: DaemonConfig): string {
  const endpoint = config.transport.advertisedEndpoint;
  if (!endpoint)
    throw new Error(
      "setup: bootstrap requires transport.advertised_endpoint set to this node's reachable address",
    );
  return endpoint;
}

/** Peer-mesh admits the `[[peers]]` endpoints; relay admits a count. */
function masterAdmission(config: DaemonConfig): MasterAdmission {
  if (config.transport.kind === 'relay') {
    const parties = config.bootstrap?.parties;
    if (parties === undefined)
      throw new Error(
        'setup: relay mode needs [bootstrap] parties on the leader (the ring size, this node included)',
      );
    return { kind: 'count', parties };
  }
  return {
    kind: 'endpoints',
    selfEndpoint: requireAdvertisedEndpoint(config),
    expectedPeers: config.peers.map((p) => ({ advertisedEndpoint: p.endpoint })),
  };
}

/** The existing identity, or `null` when the identity file does not exist. */
async function loadIdentity(config: DaemonConfig): Promise<IdentityKeyPair | null> {
  const file = config.node.identityKeyFile!;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as { pkcs8Hex?: unknown; publicKeyHex?: unknown };
  if (typeof parsed.pkcs8Hex === 'string' && typeof parsed.publicKeyHex === 'string') {
    console.error(`otzi: loaded existing identity from ${file}`);
    return importIdentity(fromHex(parsed.pkcs8Hex), fromHex(parsed.publicKeyHex));
  }
  throw new Error(`identity file ${file} is malformed (expected pkcs8Hex + publicKeyHex)`);
}

async function loadOrGenerateIdentity(config: DaemonConfig): Promise<IdentityKeyPair> {
  const existing = await loadIdentity(config);
  if (existing) return existing;

  const file = config.node.identityKeyFile!;
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

/** The banner for a book already on disk: no identity is generated, an absent one is reported. */
async function reannounce(book: PubkeyBook, config: DaemonConfig, note: string): Promise<void> {
  const identity = await loadIdentity(config);
  announceComplete({
    fingerprint: await computeFingerprint(book),
    book,
    selfPublicKeyHex: identity ? toHex(identity.publicKeyRaw) : null,
    config,
    note,
  });
}

/**
 * The setup banner: fingerprint, this node's key id, every ring key id (with
 * the endpoint when the entry has one), and what the operator must check.
 * Written in one synchronous run so its lines stay together.
 */
function announceComplete(args: {
  fingerprint: string;
  book: PubkeyBook;
  /** `null` when a re-run finds no identity file. */
  selfPublicKeyHex: string | null;
  config: DaemonConfig;
  note?: string;
}): void {
  const { fingerprint, book, selfPublicKeyHex, config, note } = args;
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`  otzi: setup complete — ${config.node.id}`);
  console.error(`  fingerprint: ${fingerprint}`);
  console.error(
    selfPublicKeyHex !== null
      ? `  this node: ${keyId(selfPublicKeyHex)}`
      : `  this node: no identity key at ${config.node.identityKeyFile}`,
  );
  for (const e of book.entries) {
    const endpoint = e.advertisedEndpoint !== undefined ? `  ${e.advertisedEndpoint}` : '';
    console.error(`  party ${e.partyId}: ${keyId(e.publicKeyHex)}${endpoint}`);
  }
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('  ⚠ Compare this fingerprint with EVERY other operator out of band (voice call, signed message) before running any DKG.');
  console.error('  If any node reports a different value, someone tampered with');
  console.error('  the bootstrap exchange. Delete pubkey books on every node and');
  console.error('  re-run setup.');
  console.error(
    '  Confirm every key id above belongs to one of your nodes; an unknown id means someone else registered — delete pubkeys.json on every node and redo setup.',
  );
  if (note) console.error(`  note: ${note}`);
  console.error('');
}
