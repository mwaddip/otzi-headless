import { beforeAll, describe, expect, it } from 'vitest';
import { buildBook, type PubkeyBook } from '../bootstrap/pubkey-book';
import { parseDaemonConfigToml } from '../config/parse';
import type { DaemonConfig } from '../config/types';
import { toHex } from '../otzi/lib/hex';
import { encryptShareFile, decryptShareFile, type DecryptedShare } from '../otzi/lib/share-file';
import { testVault } from '../testing/proposal';
import { generateIdentity, type IdentityKeyPair } from '../transport/identity';
import type { LoadedDaemonState } from './config-merge';
import { buildTransportFromMemory } from './transport-factory';

const CONFIG: DaemonConfig = parseDaemonConfigToml(`
[share]
path = "/etc/otzi/share.json"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"

[network]
name = "testnet4"

[transport]
kind = "relay"
url = "ws://127.0.0.1:1"

[[peers]]
endpoint = "127.0.0.1:8801"

[gate]
strategy = "auto"
`);

const PEER_MESH_CONFIG: DaemonConfig = parseDaemonConfigToml(`
[share]
path = "/etc/otzi/share.json"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"

[network]
name = "testnet4"

[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"

[[peers]]
endpoint = "127.0.0.1:8801"

[[peers]]
endpoint = "127.0.0.1:8802"

[gate]
strategy = "auto"
`);

const RELAY_NO_PEERS_CONFIG: DaemonConfig = parseDaemonConfigToml(`
[share]
path = "/etc/otzi/share.json"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "node-a"

[network]
name = "testnet4"

[transport]
kind = "relay"
url = "ws://127.0.0.1:1"

[gate]
strategy = "auto"
`);

/** A book whose entries carry no `advertisedEndpoint` (relay bootstrap output). */
function endpointlessBookOf(identities: IdentityKeyPair[]): PubkeyBook {
  return buildBook(
    identities.map((id, partyId) => ({ partyId, publicKeyHex: toHex(id.publicKeyRaw) })),
  );
}

function bookOf(identities: IdentityKeyPair[]): PubkeyBook {
  return buildBook(
    identities.map((id, partyId) => ({
      partyId,
      publicKeyHex: toHex(id.publicKeyRaw),
      advertisedEndpoint: `127.0.0.1:${8800 + partyId}`,
    })),
  );
}

describe('transport-factory share/book cross-checks', () => {
  let identities: IdentityKeyPair[];
  let shares: DecryptedShare[];

  beforeAll(async () => {
    identities = await Promise.all([0, 1, 2, 3].map(() => generateIdentity()));
    const vault = testVault(3, 3);
    shares = await Promise.all(
      vault.keyPackages.map(async (kp, partyId) =>
        decryptShareFile(
          await encryptShareFile(kp, vault.publicKeyPackage, 'testnet4', partyId, 'pw'),
          'pw',
        ),
      ),
    );
  });

  const stateWith = (share?: DecryptedShare): LoadedDaemonState => ({
    config: CONFIG,
    password: 'pw',
    ...(share ? { share } : {}),
  });

  it('builds a transport when the share matches the book (partyId and party count)', async () => {
    const book = bookOf(identities.slice(0, 3));
    const bundle = await buildTransportFromMemory(stateWith(shares[1]), identities[1]!, book);
    expect(bundle.selfPartyId).toBe(1);
    expect(bundle.peersById.size).toBe(3);
    expect(bundle.peersById.get(1)).toBe('node-a');
  });

  it('builds a transport on a node without a share', async () => {
    const book = bookOf(identities.slice(0, 3));
    const bundle = await buildTransportFromMemory(stateWith(), identities[2]!, book);
    expect(bundle.selfPartyId).toBe(2);
  });

  it("rejects a share whose partyId differs from the book's self entry", async () => {
    const book = bookOf(identities.slice(0, 3));
    await expect(
      buildTransportFromMemory(stateWith(shares[0]), identities[1]!, book),
    ).rejects.toThrow(
      'buildTransport: share.partyId (0) does not match book self entry partyId (1)',
    );
  });

  it('rejects a share for a different party count than the book', async () => {
    const book = bookOf(identities); // four entries, share is for three parties
    await expect(
      buildTransportFromMemory(stateWith(shares[0]), identities[0]!, book),
    ).rejects.toThrow(new Error('share is for 3 parties but the pubkey book has 4'));
    const small = bookOf(identities.slice(0, 2));
    await expect(
      buildTransportFromMemory(stateWith(shares[0]), identities[0]!, small),
    ).rejects.toThrow(new Error('share is for 3 parties but the pubkey book has 2'));
  });

  it('reports the partyId mismatch before the party-count mismatch', async () => {
    const book = bookOf(identities);
    await expect(
      buildTransportFromMemory(stateWith(shares[0]), identities[1]!, book),
    ).rejects.toThrow(/share\.partyId \(0\) does not match/);
  });
});

describe('transport-factory pubkey book endpoints', () => {
  let identities: IdentityKeyPair[];

  beforeAll(async () => {
    identities = await Promise.all([0, 1, 2].map(() => generateIdentity()));
  });

  const stateFor = (config: DaemonConfig): LoadedDaemonState => ({ config, password: 'pw' });

  it('peer-mesh refuses a book entry without an endpoint, naming the party', async () => {
    // Party 1 has no endpoint; parties 0 and 2 do.
    const book = buildBook(
      identities.map((id, partyId) => ({
        partyId,
        publicKeyHex: toHex(id.publicKeyRaw),
        ...(partyId === 1 ? {} : { advertisedEndpoint: `127.0.0.1:${8800 + partyId}` }),
      })),
    );
    await expect(
      buildTransportFromMemory(stateFor(PEER_MESH_CONFIG), identities[0]!, book),
    ).rejects.toThrow(/party 1 has no advertisedEndpoint/);
    await expect(
      buildTransportFromMemory(stateFor(PEER_MESH_CONFIG), identities[0]!, book),
    ).rejects.toThrow(
      'transport-factory: pubkey book entry for party 1 has no advertisedEndpoint; peer-mesh needs one for every peer',
    );
  });

  it('peer-mesh refuses an all-endpointless book before comparing it with [[peers]]', async () => {
    const book = endpointlessBookOf(identities);
    // [[peers]] lists endpoints the book lacks: the endpoint-less error comes first,
    // not "[[peers]] endpoint ... not found in pubkey book".
    await expect(
      buildTransportFromMemory(stateFor(PEER_MESH_CONFIG), identities[2]!, book),
    ).rejects.toThrow(/party 0 has no advertisedEndpoint/);
  });

  it('peer-mesh does not need the self entry to carry an endpoint', async () => {
    const book = buildBook(
      identities.map((id, partyId) => ({
        partyId,
        publicKeyHex: toHex(id.publicKeyRaw),
        ...(partyId === 0 ? {} : { advertisedEndpoint: `127.0.0.1:${8800 + partyId}` }),
      })),
    );
    const bundle = await buildTransportFromMemory(
      stateFor(PEER_MESH_CONFIG),
      identities[0]!,
      book,
    );
    expect(bundle.selfPartyId).toBe(0);
  });

  it('relay accepts a book without endpoints', async () => {
    const book = endpointlessBookOf(identities);
    const bundle = await buildTransportFromMemory(
      stateFor(RELAY_NO_PEERS_CONFIG),
      identities[1]!,
      book,
    );
    expect(bundle.selfPartyId).toBe(1);
    expect(bundle.peersById.size).toBe(3);
    // The ring id hashes the pubkeys only: the same with and without endpoints.
    const withEndpoints = await buildTransportFromMemory(
      stateFor(RELAY_NO_PEERS_CONFIG),
      identities[1]!,
      bookOf(identities),
    );
    expect(bundle.ringId).toBe(withEndpoints.ringId);
  });
});

