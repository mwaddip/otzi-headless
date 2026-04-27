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
import { canonicalizeEndpoint } from '../util/endpoint';

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
  port: number,
): Promise<{
  nodeId: string;
  identity: IdentityKeyPair;
  advertisedEndpoint: string;
}> {
  return {
    nodeId,
    identity: await generateIdentity(),
    advertisedEndpoint: `127.0.0.1:${port}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// pubkey-book
// ─────────────────────────────────────────────────────────────────────────

describe('pubkey-book — serialize + parse round-trip', () => {
  it('round-trips a 3-peer book', async () => {
    const [a, b, c] = await Promise.all([
      makePeer('node-a', 18800),
      makePeer('node-b', 18801),
      makePeer('node-c', 18802),
    ]);
    const entries: PubkeyBookEntry[] = [a, b, c].map((p, i) => ({
      nodeId: p.nodeId,
      partyId: i,
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
    const a = await makePeer('a', 18800);
    const book = buildBook([
      {
        nodeId: a.nodeId,
        partyId: 0,
        publicKeyHex: toHex(a.identity.publicKeyRaw),
      },
    ]);
    const fp = await computeFingerprint(book);
    expect(fp).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(fp)).toBe(true);
  });

  it('fingerprint changes if any pubkey is substituted', async () => {
    const [a, b] = await Promise.all([makePeer('a', 18800), makePeer('b', 18801)]);
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

describe('pubkey-book — advertisedEndpoint (optional)', () => {
  const VALID_PUBKEY = '04' + 'aa'.repeat(64);

  it('round-trips an entry with advertisedEndpoint', () => {
    const book = buildBook([
      {
        nodeId: 'a',
        partyId: 0,
        publicKeyHex: VALID_PUBKEY,
        advertisedEndpoint: canonicalizeEndpoint('192.168.1.5:8800'),
      },
    ]);
    const text = serializeBook(book);
    const parsed = parseBook(text);
    expect(parsed.entries[0]!.advertisedEndpoint).toBe('192.168.1.5:8800');
  });

  it('accepts an entry without advertisedEndpoint (legacy shape)', () => {
    const book = buildBook([
      { nodeId: 'a', partyId: 0, publicKeyHex: VALID_PUBKEY },
    ]);
    expect(book.entries[0]!.advertisedEndpoint).toBeUndefined();
    const text = serializeBook(book);
    const parsed = parseBook(text);
    expect(parsed.entries[0]!.advertisedEndpoint).toBeUndefined();
  });

  it('rejects an advertisedEndpoint that is not a string', () => {
    const obj = {
      entries: [
        { nodeId: 'a', partyId: 0, publicKeyHex: VALID_PUBKEY, advertisedEndpoint: 1234 },
      ],
    };
    expect(() => parseBook(JSON.stringify(obj))).toThrow(/advertisedEndpoint must be a string/);
  });
});

describe('pubkey-book — pubkey uniqueness', () => {
  const PUBKEY_A = '04' + 'aa'.repeat(64);
  const PUBKEY_B = '04' + 'bb'.repeat(64);

  it('rejects two entries with the same publicKeyHex', () => {
    expect(() =>
      buildBook([
        { nodeId: 'a', partyId: 0, publicKeyHex: PUBKEY_A },
        { nodeId: 'b', partyId: 1, publicKeyHex: PUBKEY_A },
      ]),
    ).toThrow(/duplicate publicKey/i);
  });

  it('accepts entries with distinct publicKeyHex', () => {
    const book = buildBook([
      { nodeId: 'a', partyId: 0, publicKeyHex: PUBKEY_A },
      { nodeId: 'b', partyId: 1, publicKeyHex: PUBKEY_B },
    ]);
    expect(book.entries.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3-peer bootstrap end-to-end
// ─────────────────────────────────────────────────────────────────────────

describe('bootstrap — 3-peer end-to-end', () => {
  it('master + 2 members: all derive matching books + fingerprints', async () => {
    const master = await makePeer('node-a', 18800);
    const memberB = await makePeer('node-b', 18801);
    const memberC = await makePeer('node-c', 18802);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [
        { advertisedEndpoint: memberB.advertisedEndpoint },
        { advertisedEndpoint: memberC.advertisedEndpoint },
      ],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 10_000,
    });

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

    expect(masterResult.fingerprint).toBe(bResult.fingerprint);
    expect(bResult.fingerprint).toBe(cResult.fingerprint);

    expect(serializeBook(masterResult.book)).toBe(serializeBook(bResult.book));
    expect(serializeBook(bResult.book)).toBe(serializeBook(cResult.book));

    // Every peer's pubkey appears in the book with their advertised endpoint.
    for (const peer of [master, memberB, memberC]) {
      const entry = masterResult.book.entries.find(
        (e) => e.publicKeyHex.toLowerCase() === toHex(peer.identity.publicKeyRaw).toLowerCase(),
      );
      expect(entry).toBeDefined();
      expect(entry!.advertisedEndpoint).toBe(peer.advertisedEndpoint);
    }
  }, 15_000);

  it('single-peer ring (master only): completes immediately', async () => {
    const master = await makePeer('solo', 18800);
    const port = await freePort();
    const { book, fingerprint } = await runMasterBootstrap({
      self: master,
      expectedPeers: [],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]!.publicKeyHex.toLowerCase()).toBe(
      toHex(master.identity.publicKeyRaw).toLowerCase(),
    );
    expect(book.entries[0]!.advertisedEndpoint).toBe(master.advertisedEndpoint);
    expect(fingerprint).toHaveLength(8);
  }, 10_000);

  it('partyId assigned by sorted-pubkey-bytes — registration timing does NOT affect partyIds', async () => {
    const runOnce = async (delay: number) => {
      const master = await makePeer('master', 18800);
      const memberB = await makePeer('b', 18801);
      const memberC = await makePeer('c', 18802);
      const port = await freePort();

      const masterDone = runMasterBootstrap({
        self: master,
        expectedPeers: [
          { advertisedEndpoint: memberB.advertisedEndpoint },
          { advertisedEndpoint: memberC.advertisedEndpoint },
        ],
        bind: `127.0.0.1:${port}`,
        timeoutMs: 10_000,
      });
      await new Promise((r) => setTimeout(r, 50));

      const bDone = runMemberRegister({ self: memberB, masterUrl: `http://127.0.0.1:${port}`, timeoutMs: 10_000 });
      // memberC registers AFTER `delay` ms → in run #1 small delay, in run #2 large.
      await new Promise((r) => setTimeout(r, delay));
      const cDone = runMemberRegister({ self: memberC, masterUrl: `http://127.0.0.1:${port}`, timeoutMs: 10_000 });

      const [m] = await Promise.all([masterDone, bDone, cDone]);
      return { master, memberB, memberC, book: m.book };
    };

    const r1 = await runOnce(20);
    const r2 = await runOnce(200);

    const findPartyId = (book: typeof r1.book, peer: typeof r1.master) =>
      book.entries.find((e) => e.publicKeyHex.toLowerCase() === toHex(peer.identity.publicKeyRaw).toLowerCase())!.partyId;
    // Within ONE run, partyIds must match the pubkey-byte sort order (cross-run
    // comparison is meaningless since each run uses freshly generated identities).
    for (const r of [r1, r2]) {
      const sortedPeers = [r.master, r.memberB, r.memberC].sort((a, b) =>
        Buffer.compare(Buffer.from(a.identity.publicKeyRaw), Buffer.from(b.identity.publicKeyRaw)),
      );
      sortedPeers.forEach((peer, idx) => {
        expect(findPartyId(r.book, peer)).toBe(idx);
      });
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────

describe('bootstrap — error paths', () => {
  it('endpoint NOT on allowlist → master rejects with 404', async () => {
    const master = await makePeer('node-a', 18800);
    const stranger = await makePeer('uninvited', 19999);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [{ advertisedEndpoint: '127.0.0.1:18801' }],
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
    ).rejects.toThrow(/not on expected-peer allowlist/);
    await masterDone;
  }, 10_000);

  it('non-canonical advertised_endpoint canonicalizes server-side and matches allowlist', async () => {
    const master = await makePeer('node-a', 18800);
    // memberB sends host with uppercase; allowlist has lowercase canonical.
    const memberB = {
      ...(await makePeer('node-b', 18801)),
      advertisedEndpoint: 'NODE-B.EXAMPLE.COM:8800', // non-canonical input
    };
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [{ advertisedEndpoint: 'node-b.example.com:8800' }],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 2_000,
    });
    await new Promise((r) => setTimeout(r, 50));

    // memberB sends non-canonical; master canonicalizes → matches allowlist.
    // member's self-check then fails because returned book.advertisedEndpoint
    // is canonical but member's own input was not. Acceptable: leaves should
    // canonicalize before passing self.advertisedEndpoint.
    await expect(
      runMemberRegister({
        self: memberB,
        masterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/advertisedEndpoint='node-b\.example\.com:8800' != ours='NODE-B\.EXAMPLE\.COM:8800'/);
    await masterDone.catch(() => {}); // master times out since allowlisted member never properly registered
  }, 10_000);

  it('duplicate registration → second attempt rejected with 409', async () => {
    const master = await makePeer('node-a', 18800);
    const memberB = await makePeer('node-b', 18801);
    const memberC = await makePeer('node-c', 18802);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [
        { advertisedEndpoint: memberB.advertisedEndpoint },
        { advertisedEndpoint: memberC.advertisedEndpoint },
      ],
      bind: `127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });
    await new Promise((r) => setTimeout(r, 50));

    const bFirst = runMemberRegister({
      self: memberB,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });
    await new Promise((r) => setTimeout(r, 100));
    await expect(
      runMemberRegister({
        self: memberB,
        masterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/already registered/);

    await runMemberRegister({
      self: memberC,
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });
    await bFirst;
    await masterDone;
  }, 10_000);

  it('master timeout if a peer never registers → waiters get 408', async () => {
    const master = await makePeer('node-a', 18800);
    const memberB = await makePeer('node-b', 18801);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: master,
      expectedPeers: [
        { advertisedEndpoint: memberB.advertisedEndpoint },
        { advertisedEndpoint: '127.0.0.1:19999' }, // ghost peer
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
