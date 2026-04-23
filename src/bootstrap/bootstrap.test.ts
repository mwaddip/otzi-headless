import { describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { generateIdentity, type IdentityKeyPair } from '../transport/identity';
import { toHex } from '../wire/hex';
import {
  buildBook,
  computeFingerprint,
  parseBook,
  serializeBook,
  type PubkeyBookEntry,
} from './pubkey-book';
import { runMasterBootstrap } from './master';
import { runMemberRegister } from './register';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('freePort: no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function makePeer(
  nodeId: string,
  partyId: number,
): Promise<{ nodeId: string; partyId: number; identity: IdentityKeyPair }> {
  return { nodeId, partyId, identity: await generateIdentity() };
}

// ─────────────────────────────────────────────────────────────────────────
// pubkey-book
// ─────────────────────────────────────────────────────────────────────────

describe('pubkey-book — serialize + parse round-trip', () => {
  it('round-trips a 3-peer book', async () => {
    const [a, b, c] = await Promise.all([
      makePeer('node-a', 0),
      makePeer('node-b', 1),
      makePeer('node-c', 2),
    ]);
    const entries: PubkeyBookEntry[] = [a, b, c].map((p) => ({
      nodeId: p.nodeId,
      partyId: p.partyId,
      publicKeyHex: toHex(p.identity.publicKeyRaw),
    }));
    const book = buildBook(entries);
    const text = serializeBook(book);
    const parsed = parseBook(text);
    expect(parsed.entries).toEqual(book.entries);
  });

  it('sorts by partyId', () => {
    const unsorted: PubkeyBookEntry[] = [
      { nodeId: 'c', partyId: 2, publicKeyHex: '04' + '00'.repeat(64) },
      { nodeId: 'a', partyId: 0, publicKeyHex: '04' + '11'.repeat(64) },
      { nodeId: 'b', partyId: 1, publicKeyHex: '04' + '22'.repeat(64) },
    ];
    const book = buildBook(unsorted);
    expect(book.entries.map((e) => e.partyId)).toEqual([0, 1, 2]);
  });

  it('rejects duplicate partyIds', () => {
    expect(() =>
      buildBook([
        { nodeId: 'a', partyId: 0, publicKeyHex: '04' + '00'.repeat(64) },
        { nodeId: 'b', partyId: 0, publicKeyHex: '04' + '11'.repeat(64) },
      ]),
    ).toThrow(/duplicate partyId/);
  });

  it('rejects duplicate nodeIds', () => {
    expect(() =>
      buildBook([
        { nodeId: 'same', partyId: 0, publicKeyHex: '04' + '00'.repeat(64) },
        { nodeId: 'same', partyId: 1, publicKeyHex: '04' + '11'.repeat(64) },
      ]),
    ).toThrow(/duplicate nodeId/);
  });

  it('rejects wrong pubkey length', () => {
    expect(() =>
      buildBook([{ nodeId: 'a', partyId: 0, publicKeyHex: '04abc' }]),
    ).toThrow(/130 chars/);
  });

  it('rejects non-0x04 prefix', () => {
    expect(() =>
      buildBook([{ nodeId: 'a', partyId: 0, publicKeyHex: '02' + '00'.repeat(64) }]),
    ).toThrow(/0x04/);
  });

  it('fingerprint is 8 hex chars', async () => {
    const [a] = await Promise.all([makePeer('a', 0)]);
    const book = buildBook([
      {
        nodeId: a.nodeId,
        partyId: a.partyId,
        publicKeyHex: toHex(a.identity.publicKeyRaw),
      },
    ]);
    const fp = await computeFingerprint(book);
    expect(fp).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(fp)).toBe(true);
  });

  it('fingerprint changes if any pubkey is substituted', async () => {
    const [a, b] = await Promise.all([makePeer('a', 0), makePeer('b', 1)]);
    const book1 = buildBook([
      { nodeId: a.nodeId, partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw) },
      { nodeId: b.nodeId, partyId: 1, publicKeyHex: toHex(b.identity.publicKeyRaw) },
    ]);
    const impostor = await generateIdentity();
    const book2 = buildBook([
      { nodeId: a.nodeId, partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw) },
      { nodeId: b.nodeId, partyId: 1, publicKeyHex: toHex(impostor.publicKeyRaw) },
    ]);
    const fp1 = await computeFingerprint(book1);
    const fp2 = await computeFingerprint(book2);
    expect(fp1).not.toBe(fp2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3-peer bootstrap end-to-end
// ─────────────────────────────────────────────────────────────────────────

describe('bootstrap — 3-peer end-to-end', () => {
  it('master + 2 members: all derive matching books + fingerprints', async () => {
    const master = await makePeer('node-a', 0);
    const memberB = await makePeer('node-b', 1);
    const memberC = await makePeer('node-c', 2);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [
        { nodeId: memberB.nodeId, partyId: memberB.partyId },
        { nodeId: memberC.nodeId, partyId: memberC.partyId },
      ],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 10_000,
    });

    // Give the server a moment to bind before members hit it.
    await new Promise((r) => setTimeout(r, 50));

    const bDone = runMemberRegister({
      self: memberB,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 10_000,
    });
    const cDone = runMemberRegister({
      self: memberC,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 10_000,
    });

    const [masterResult, bResult, cResult] = await Promise.all([masterDone, bDone, cDone]);

    expect(masterResult.book.entries).toHaveLength(3);
    expect(bResult.book.entries).toHaveLength(3);
    expect(cResult.book.entries).toHaveLength(3);

    // All three fingerprints identical — the operator-eyeball check passes.
    expect(masterResult.fingerprint).toBe(bResult.fingerprint);
    expect(bResult.fingerprint).toBe(cResult.fingerprint);

    // Book contents agree byte-for-byte.
    expect(serializeBook(masterResult.book)).toBe(serializeBook(bResult.book));
    expect(serializeBook(bResult.book)).toBe(serializeBook(cResult.book));

    // Each pubkey in the book matches the party's actual identity.
    for (const peer of [master, memberB, memberC]) {
      const entry = masterResult.book.entries.find((e) => e.nodeId === peer.nodeId)!;
      expect(entry.publicKeyHex).toBe(toHex(peer.identity.publicKeyRaw));
    }
  }, 15_000);

  it('single-peer ring (master only): completes immediately', async () => {
    const master = await makePeer('solo', 0);
    const port = await freePort();
    const { book, fingerprint } = await runMasterBootstrap({
      self: master,
      expectedPeers: [],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]!.nodeId).toBe('solo');
    expect(fingerprint).toHaveLength(8);
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────

describe('bootstrap — error paths', () => {
  it('unknown nodeId → master rejects with 404', async () => {
    const master = await makePeer('node-a', 0);
    const stranger = await makePeer('uninvited', 99);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [{ nodeId: 'node-b', partyId: 1 }],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 2_000,
    }).catch((err) => ({ err }));
    await new Promise((r) => setTimeout(r, 50));

    await expect(
      runMemberRegister({
        self: stranger,
        masterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/unknown node_id/);
    await masterDone;
  }, 10_000);

  it('partyId mismatch → master rejects with 400', async () => {
    const master = await makePeer('node-a', 0);
    const expectedB = { nodeId: 'node-b', partyId: 1 };
    const wrongB = await makePeer('node-b', 5); // right nodeId, wrong partyId
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [expectedB],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 2_000,
    }).catch((err) => ({ err }));
    await new Promise((r) => setTimeout(r, 50));

    await expect(
      runMemberRegister({
        self: wrongB,
        masterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/party_id mismatch/);
    await masterDone;
  }, 10_000);

  it('duplicate registration → second attempt rejected with 409', async () => {
    const master = await makePeer('node-a', 0);
    const memberB = await makePeer('node-b', 1);
    const memberC = await makePeer('node-c', 2);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [
        { nodeId: memberB.nodeId, partyId: memberB.partyId },
        { nodeId: memberC.nodeId, partyId: memberC.partyId },
      ],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });
    await new Promise((r) => setTimeout(r, 50));

    // First member registers successfully (will wait long-poll).
    const bFirst = runMemberRegister({
      self: memberB,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });
    // Second time the *same* memberB tries to register — should be rejected.
    await new Promise((r) => setTimeout(r, 100));
    await expect(
      runMemberRegister({
        self: memberB,
        masterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/already registered/);

    // Let memberC complete things so master can shut down.
    await runMemberRegister({
      self: memberC,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });
    await bFirst;
    await masterDone;
  }, 10_000);

  it('master timeout if a peer never registers → waiters get 408', async () => {
    const master = await makePeer('node-a', 0);
    const memberB = await makePeer('node-b', 1);
    // memberC is expected but never shows up.
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [
        { nodeId: 'node-b', partyId: 1 },
        { nodeId: 'node-c-ghost', partyId: 2 },
      ],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 500,
    });
    await new Promise((r) => setTimeout(r, 50));
    const bRegister = runMemberRegister({
      self: memberB,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });

    await expect(masterDone).rejects.toThrow(/timed out/);
    await expect(bRegister).rejects.toThrow();
  }, 10_000);
});
