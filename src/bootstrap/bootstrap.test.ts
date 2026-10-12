import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { generateIdentity, type IdentityKeyPair } from '../transport/identity';
import { toHex } from '../otzi/lib/hex';
import {
  buildBook,
  computeFingerprint,
  keyId,
  parseBook,
  serializeBook,
  type PubkeyBookEntry,
} from './pubkey-book';
import { BOOTSTRAP_FULL_ERROR, runMasterBootstrap } from './master';
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
  _label: string,
  port: number,
): Promise<{
  identity: IdentityKeyPair;
  advertisedEndpoint: string;
}> {
  return {
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
      partyId: i,
      publicKeyHex: toHex(p.identity.publicKeyRaw),
      advertisedEndpoint: p.advertisedEndpoint,
    }));
    const book = buildBook(entries);
    const text = serializeBook(book);
    const parsed = parseBook(text);
    expect(parsed.entries).toEqual(book.entries);
  });

  it('sorts by partyId', () => {
    const unsorted: PubkeyBookEntry[] = [
      { partyId: 2, publicKeyHex: '04' + '00'.repeat(64), advertisedEndpoint: '127.0.0.1:18802' },
      { partyId: 0, publicKeyHex: '04' + '11'.repeat(64), advertisedEndpoint: '127.0.0.1:18800' },
      { partyId: 1, publicKeyHex: '04' + '22'.repeat(64), advertisedEndpoint: '127.0.0.1:18801' },
    ];
    const book = buildBook(unsorted);
    expect(book.entries.map((e) => e.partyId)).toEqual([0, 1, 2]);
  });

  it('rejects duplicate partyIds', () => {
    expect(() =>
      buildBook([
        { partyId: 0, publicKeyHex: '04' + '00'.repeat(64), advertisedEndpoint: '127.0.0.1:18800' },
        { partyId: 0, publicKeyHex: '04' + '11'.repeat(64), advertisedEndpoint: '127.0.0.1:18801' },
      ]),
    ).toThrow(/duplicate partyId/);
  });

  it('rejects wrong pubkey length', () => {
    expect(() =>
      buildBook([{ partyId: 0, publicKeyHex: '04abc', advertisedEndpoint: '127.0.0.1:18800' }]),
    ).toThrow(/130 chars/);
  });

  it('rejects non-0x04 prefix', () => {
    expect(() =>
      buildBook([{ partyId: 0, publicKeyHex: '02' + '00'.repeat(64), advertisedEndpoint: '127.0.0.1:18800' }]),
    ).toThrow(/0x04/);
  });

  it('fingerprint is 96 bits in six groups', async () => {
    const [a, b, c] = await Promise.all([
      makePeer('a', 18800),
      makePeer('b', 18801),
      makePeer('c', 18802),
    ]);
    const book = buildBook(
      [a, b, c].map((p, i) => ({
        partyId: i,
        publicKeyHex: toHex(p.identity.publicKeyRaw),
        advertisedEndpoint: p.advertisedEndpoint,
      })),
    );
    const fp = await computeFingerprint(book);
    expect(fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
    const raw = createHash('sha256')
      .update(Buffer.concat(book.entries.map((e) => Buffer.from(e.publicKeyHex, 'hex'))))
      .digest('hex')
      .slice(0, 24);
    expect(fp.replaceAll('-', '')).toBe(raw);
  });

  it('fingerprint changes if any pubkey is substituted', async () => {
    const [a, b] = await Promise.all([makePeer('a', 18800), makePeer('b', 18801)]);
    const book1 = buildBook([
      { partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw), advertisedEndpoint: a.advertisedEndpoint },
      { partyId: 1, publicKeyHex: toHex(b.identity.publicKeyRaw), advertisedEndpoint: b.advertisedEndpoint },
    ]);
    const impostor = await generateIdentity();
    const book2 = buildBook([
      { partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw), advertisedEndpoint: a.advertisedEndpoint },
      { partyId: 1, publicKeyHex: toHex(impostor.publicKeyRaw), advertisedEndpoint: b.advertisedEndpoint },
    ]);
    const fp1 = await computeFingerprint(book1);
    const fp2 = await computeFingerprint(book2);
    expect(fp1).not.toBe(fp2);
  });
});

describe('pubkey-book — advertisedEndpoint', () => {
  const VALID_PUBKEY = '04' + 'aa'.repeat(64);

  it('round-trips an entry with canonicalized advertisedEndpoint', () => {
    const book = buildBook([
      {
        partyId: 0,
        publicKeyHex: VALID_PUBKEY,
        advertisedEndpoint: canonicalizeEndpoint('Node-B.example.com'),
      },
    ]);
    expect(book.entries[0]!.advertisedEndpoint).toBe('node-b.example.com:8800');
    const text = serializeBook(book);
    const parsed = parseBook(text);
    expect(parsed.entries[0]!.advertisedEndpoint).toBe('node-b.example.com:8800');
  });

  it('round-trips a book whose entries have no advertisedEndpoint', () => {
    const book = buildBook([
      { partyId: 0, publicKeyHex: '04' + '11'.repeat(64) },
      { partyId: 1, publicKeyHex: '04' + '22'.repeat(64) },
    ]);
    const text = serializeBook(book);
    // The key is omitted from the file, not written as null.
    expect(text).not.toContain('advertisedEndpoint');
    const parsed = parseBook(text);
    expect(parsed.entries).toStrictEqual(book.entries);
    for (const e of parsed.entries) expect('advertisedEndpoint' in e).toBe(false);
  });

  it('round-trips a book that mixes entries with and without advertisedEndpoint', () => {
    const book = buildBook([
      { partyId: 0, publicKeyHex: '04' + '11'.repeat(64), advertisedEndpoint: '127.0.0.1:18800' },
      { partyId: 1, publicKeyHex: '04' + '22'.repeat(64) },
    ]);
    const parsed = parseBook(serializeBook(book));
    expect(parsed.entries).toStrictEqual(book.entries);
    expect(parsed.entries[0]!.advertisedEndpoint).toBe('127.0.0.1:18800');
    expect('advertisedEndpoint' in parsed.entries[1]!).toBe(false);
  });

  it('rejects an empty-string advertisedEndpoint', () => {
    const entry = { partyId: 0, publicKeyHex: VALID_PUBKEY, advertisedEndpoint: '' };
    expect(() => buildBook([entry])).toThrow(/advertisedEndpoint must be non-empty/);
    expect(() => parseBook(JSON.stringify({ entries: [entry] }))).toThrow(
      /advertisedEndpoint must be non-empty/,
    );
  });

  it('rejects a null advertisedEndpoint (present means a string)', () => {
    const obj = {
      entries: [{ partyId: 0, publicKeyHex: VALID_PUBKEY, advertisedEndpoint: null }],
    };
    expect(() => parseBook(JSON.stringify(obj))).toThrow(/advertisedEndpoint must be a string/);
  });

  it('rejects an advertisedEndpoint that is not a string', () => {
    const obj = {
      entries: [
        { partyId: 0, publicKeyHex: VALID_PUBKEY, advertisedEndpoint: 1234 },
      ],
    };
    expect(() => parseBook(JSON.stringify(obj))).toThrow(/advertisedEndpoint must be a string/);
  });

  it('rejects entries containing legacy nodeId field', () => {
    const obj = {
      entries: [
        {
          nodeId: 'a',
          partyId: 0,
          publicKeyHex: VALID_PUBKEY,
          advertisedEndpoint: '127.0.0.1:8800',
        },
      ],
    };
    expect(() => parseBook(JSON.stringify(obj))).toThrow(/nodeId is no longer supported/);
  });
});

describe('pubkey-book — key ids', () => {
  it('keyId is the first 16 hex chars (64 bits) of sha256(raw pubkey)', async () => {
    const identity = await generateIdentity();
    const hex = toHex(identity.publicKeyRaw);
    const expected = createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 16);
    expect(keyId(hex)).toBe(expected);
    expect(keyId(hex)).toMatch(/^[0-9a-f]{16}$/);
    // Fixed vector: sha256 of 04 || 64 x 0x11.
    const fixed = '04' + '11'.repeat(64);
    expect(keyId(fixed)).toBe(
      createHash('sha256').update(Buffer.from(fixed, 'hex')).digest('hex').slice(0, 16),
    );
  });

  it('keyId known answer: 04 || 64 x 0x11 gives f0b9315a0459dab7', () => {
    // Pinned literal (sha256 = f0b9315a0459dab7ab5fa690…, computed with
    // sha256sum, openssl dgst and Python's hashlib). Operators compare key ids
    // by eye across nodes, so the printed format must never drift.
    expect(keyId('04' + '11'.repeat(64))).toBe('f0b9315a0459dab7');
  });

  it('keyId is lowercase whatever the case of the input hex', () => {
    const lower = '04' + 'ab'.repeat(64);
    expect(keyId(lower.toUpperCase())).toBe(keyId(lower));
    expect(keyId(lower)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keyId rejects input that is not a 65-byte hex pubkey', () => {
    expect(() => keyId('04abc')).toThrow(/130/);
    expect(() => keyId('zz'.repeat(65))).toThrow(/hex/);
  });

  it('fingerprint ignores endpoints', async () => {
    const [a, b] = await Promise.all([makePeer('a', 18800), makePeer('b', 18801)]);
    const withEndpoints = buildBook([
      { partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw), advertisedEndpoint: a.advertisedEndpoint },
      { partyId: 1, publicKeyHex: toHex(b.identity.publicKeyRaw), advertisedEndpoint: b.advertisedEndpoint },
    ]);
    const withoutEndpoints = buildBook([
      { partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw) },
      { partyId: 1, publicKeyHex: toHex(b.identity.publicKeyRaw) },
    ]);
    const differentEndpoints = buildBook([
      { partyId: 0, publicKeyHex: toHex(a.identity.publicKeyRaw), advertisedEndpoint: 'other.example:9000' },
      { partyId: 1, publicKeyHex: toHex(b.identity.publicKeyRaw) },
    ]);
    const fp = await computeFingerprint(withEndpoints);
    expect(await computeFingerprint(withoutEndpoints)).toBe(fp);
    expect(await computeFingerprint(differentEndpoints)).toBe(fp);
  });
});

describe('pubkey-book — pubkey uniqueness', () => {
  const PUBKEY_A = '04' + 'aa'.repeat(64);
  const PUBKEY_B = '04' + 'bb'.repeat(64);

  it('rejects two entries with the same publicKeyHex', () => {
    expect(() =>
      buildBook([
        { partyId: 0, publicKeyHex: PUBKEY_A, advertisedEndpoint: '127.0.0.1:18800' },
        { partyId: 1, publicKeyHex: PUBKEY_A, advertisedEndpoint: '127.0.0.1:18801' },
      ]),
    ).toThrow(/duplicate publicKey/i);
  });

  it('accepts entries with distinct publicKeyHex', () => {
    const book = buildBook([
      { partyId: 0, publicKeyHex: PUBKEY_A, advertisedEndpoint: '127.0.0.1:18800' },
      { partyId: 1, publicKeyHex: PUBKEY_B, advertisedEndpoint: '127.0.0.1:18801' },
    ]);
    expect(book.entries.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3-peer bootstrap end-to-end
// ─────────────────────────────────────────────────────────────────────────

describe('bootstrap — 3-peer end-to-end (endpoints admission unchanged)', () => {
  it('master + 2 members: all derive matching books + fingerprints', async () => {
    const master = await makePeer('node-a', 18800);
    const memberB = await makePeer('node-b', 18801);
    const memberC = await makePeer('node-c', 18802);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [
          { advertisedEndpoint: memberB.advertisedEndpoint },
          { advertisedEndpoint: memberC.advertisedEndpoint },
        ],
      },
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
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [],
      },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]!.publicKeyHex.toLowerCase()).toBe(
      toHex(master.identity.publicKeyRaw).toLowerCase(),
    );
    expect(book.entries[0]!.advertisedEndpoint).toBe(master.advertisedEndpoint);
    expect(fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
  }, 10_000);

  it('partyId assigned by sorted-pubkey-bytes — registration timing does NOT affect partyIds', async () => {
    const runOnce = async (delay: number) => {
      const master = await makePeer('master', 18800);
      const memberB = await makePeer('b', 18801);
      const memberC = await makePeer('c', 18802);
      const port = await freePort();

      const masterDone = runMasterBootstrap({
        self: { identity: master.identity },
        admission: {
          kind: 'endpoints',
          selfEndpoint: master.advertisedEndpoint,
          expectedPeers: [
            { advertisedEndpoint: memberB.advertisedEndpoint },
            { advertisedEndpoint: memberC.advertisedEndpoint },
          ],
        },
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

describe('bootstrap — error paths (endpoints admission unchanged)', () => {
  it('endpoint NOT on allowlist → master rejects with 404', async () => {
    const master = await makePeer('node-a', 18800);
    const stranger = await makePeer('uninvited', 19999);
    const port = await freePort();

    const masterDone = runMasterBootstrap({
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [{ advertisedEndpoint: '127.0.0.1:18801' }],
      },
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
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [{ advertisedEndpoint: 'node-b.example.com:8800' }],
      },
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
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [
          { advertisedEndpoint: memberB.advertisedEndpoint },
          { advertisedEndpoint: memberC.advertisedEndpoint },
        ],
      },
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
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [
          { advertisedEndpoint: memberB.advertisedEndpoint },
          { advertisedEndpoint: '127.0.0.1:19999' }, // ghost peer
        ],
      },
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

// ─────────────────────────────────────────────────────────────────────────
// Count admission (relay) and transport-aware member errors
// ─────────────────────────────────────────────────────────────────────────

type RegisterReply = { status: number; json: { error?: string; book?: unknown; fingerprint?: string } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pubHex = (id: IdentityKeyPair) => toHex(id.publicKeyRaw);
const byRawPubkey = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

async function postRegister(port: number, body: unknown): Promise<RegisterReply> {
  const res = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as RegisterReply['json'] };
}

/**
 * Opens a POST /register whose headers reach the leader (it answers
 * `100 Continue`, so its handler is running) but whose body is held back until
 * `send`. Lets a test deliver a registration after the count is reached on a
 * connection the leader accepted before it closed.
 */
function openHeldRegistration(port: number): Promise<{ send: (body: unknown) => Promise<RegisterReply> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/register',
      headers: { 'content-type': 'application/json', expect: '100-continue' },
    });
    const reply = new Promise<RegisterReply>((res, rej) => {
      req.on('response', (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () =>
          res({ status: r.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
        );
        r.on('error', rej);
      });
      req.on('error', rej);
    });
    reply.catch(() => {});
    req.on('continue', () =>
      resolve({
        send: (body) => {
          req.end(JSON.stringify(body));
          return reply;
        },
      }),
    );
    req.on('error', reject);
    req.flushHeaders();
  });
}

/** A fake leader that answers every POST /register with `reply` and records the bodies. */
async function stubMaster(
  reply: () => Promise<{ status: number; json: unknown }>,
): Promise<{ url: string; bodies: unknown[]; close: () => Promise<void> }> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      void reply().then(({ status, json }) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('connection', 'close');
        res.end(JSON.stringify(json));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A 200 `{ book, fingerprint }` reply over `keys` (partyIds by sorted pubkey), with an endpoint on each key named in `endpoints`. */
async function bookReply(
  keys: string[],
  endpoints: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const book = buildBook(
    [...keys].sort(byRawPubkey).map((publicKeyHex, partyId) => ({
      partyId,
      publicKeyHex,
      ...(endpoints[publicKeyHex] !== undefined ? { advertisedEndpoint: endpoints[publicKeyHex] } : {}),
    })),
  );
  return { status: 200, json: { book, fingerprint: await computeFingerprint(book) } };
}

describe('bootstrap — count admission (relay)', () => {
  it('count admission: completes after parties − 1 registrations without endpoints', async () => {
    const [master, b, c] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 3 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 10_000,
    });
    await sleep(50);

    const [m, rb, rc] = await Promise.all([
      masterDone,
      runMemberRegister({ self: { identity: b }, masterUrl: url, timeoutMs: 10_000 }),
      runMemberRegister({ self: { identity: c }, masterUrl: url, timeoutMs: 10_000 }),
    ]);

    // A book of 3, the same on every node.
    expect(m.book.entries).toHaveLength(3);
    expect(serializeBook(rb.book)).toBe(serializeBook(m.book));
    expect(serializeBook(rc.book)).toBe(serializeBook(m.book));
    expect(rb.fingerprint).toBe(m.fingerprint);
    expect(rc.fingerprint).toBe(m.fingerprint);

    // partyIds follow the sorted raw pubkey bytes.
    const sorted = [master, b, c].map(pubHex).sort(byRawPubkey);
    expect(m.book.entries.map((e) => e.publicKeyHex)).toEqual(sorted);
    expect(m.book.entries.map((e) => e.partyId)).toEqual([0, 1, 2]);

    // No entry carries an endpoint, the leader's own included.
    for (const e of m.book.entries) expect('advertisedEndpoint' in e).toBe(false);
    expect(serializeBook(m.book)).not.toContain('advertisedEndpoint');
  }, 15_000);

  it('count admission: a registration with an endpoint gets 400', async () => {
    const [master, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 2 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);

    const withEndpoint = await postRegister(port, {
      public_key_hex: pubHex(b),
      advertised_endpoint: '127.0.0.1:18801',
    });
    expect(withEndpoint.status).toBe(400);
    expect(withEndpoint.json.error).toBe("'advertised_endpoint' not used in relay mode");

    // The key alone is refused, whatever its spelling or value.
    const camelEmpty = await postRegister(port, { public_key_hex: pubHex(b), advertisedEndpoint: '' });
    expect(camelEmpty.status).toBe(400);
    expect(camelEmpty.json.error).toBe("'advertised_endpoint' not used in relay mode");

    // The refused registrations took no slot: b still completes the book.
    const rb = await runMemberRegister({
      self: { identity: b },
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    expect(rb.book.entries).toHaveLength(2);
    await masterDone;
  }, 10_000);

  it("count admission: a duplicate pubkey or the master's own pubkey gets 409", async () => {
    const [master, b, c] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 3 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);

    const own = await postRegister(port, { public_key_hex: pubHex(master) });
    expect(own.status).toBe(409);
    expect(own.json.error).toBe("publicKey already registered (it is the leader's own key)");

    const bDone = runMemberRegister({ self: { identity: b }, masterUrl: url, timeoutMs: 5_000 });
    await sleep(100);
    // Same key again, in upper case: still the same key.
    const dup = await postRegister(port, { public_key_hex: pubHex(b).toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe('publicKey already registered');

    // Neither refusal took a slot: c completes the book of 3.
    const cDone = runMemberRegister({ self: { identity: c }, masterUrl: url, timeoutMs: 5_000 });
    const [m] = await Promise.all([masterDone, bDone, cDone]);
    expect(m.book.entries.map((e) => e.publicKeyHex).sort(byRawPubkey)).toEqual(
      [master, b, c].map(pubHex).sort(byRawPubkey),
    );
  }, 10_000);

  it('count admission: a registration after the count is reached gets 409 bootstrap is full', async () => {
    const [master, b, late] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 2 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);

    // The late party's connection is in before the book completes; its body is not.
    const held = await openHeldRegistration(port);

    const rb = await runMemberRegister({
      self: { identity: b },
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    expect(rb.book.entries).toHaveLength(2);

    const reply = await held.send({ public_key_hex: pubHex(late) });
    expect(reply.status).toBe(409);
    expect(reply.json.error).toBe('bootstrap is full');

    const m = await masterDone;
    expect(m.book.entries.map((e) => e.publicKeyHex)).not.toContain(pubHex(late));
  }, 10_000);

  it('count admission: the result counts the refused registrations by reason', async () => {
    const [master, b, c, late] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 3 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);

    expect((await postRegister(port, { public_key_hex: pubHex(c), advertised_endpoint: '127.0.0.1:1' })).status).toBe(400);
    expect((await postRegister(port, { public_key_hex: pubHex(master) })).status).toBe(409);
    const bDone = runMemberRegister({ self: { identity: b }, masterUrl: url, timeoutMs: 5_000 });
    await sleep(100);
    expect((await postRegister(port, { public_key_hex: pubHex(b) })).status).toBe(409);
    // Malformed requests are not registrations and are not counted.
    expect((await postRegister(port, { public_key_hex: 'zz' })).status).toBe(400);
    const held = await openHeldRegistration(port);
    const cDone = runMemberRegister({ self: { identity: c }, masterUrl: url, timeoutMs: 5_000 });
    await Promise.all([bDone, cDone]);
    expect((await held.send({ public_key_hex: pubHex(late) })).status).toBe(409);

    const m = await masterDone;
    expect(m.refused).toEqual({ full: 1, duplicate: 2, endpointPresent: 1, notAllowed: 0 });
  }, 10_000);

  it('endpoints admission: the result counts duplicates and registrations off the allowlist', async () => {
    const master = await makePeer('node-a', 18800);
    const memberB = await makePeer('node-b', 18801);
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [{ advertisedEndpoint: memberB.advertisedEndpoint }, { advertisedEndpoint: '127.0.0.1:18802' }],
      },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);
    const stranger = pubHex(await generateIdentity());
    expect((await postRegister(port, { public_key_hex: stranger, advertised_endpoint: '127.0.0.1:19999' })).status).toBe(404);
    expect((await postRegister(port, { public_key_hex: stranger })).status).toBe(400);
    // An allowlisted, free endpoint with the leader's own key.
    expect((await postRegister(port, { public_key_hex: pubHex(master.identity), advertised_endpoint: '127.0.0.1:18802' })).status).toBe(409);
    const bDone = runMemberRegister({ self: memberB, masterUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000 });
    await sleep(100);
    expect((await postRegister(port, { public_key_hex: stranger, advertised_endpoint: memberB.advertisedEndpoint })).status).toBe(409);
    const c = await generateIdentity();
    await runMemberRegister({
      self: { identity: c, advertisedEndpoint: '127.0.0.1:18802' },
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await bDone;
    const m = await masterDone;
    expect(m.refused).toEqual({ full: 0, duplicate: 2, endpointPresent: 0, notAllowed: 2 });
  }, 10_000);

  it('count admission: four concurrent registrations for one free slot admit exactly one', async () => {
    const master = await generateIdentity();
    const racers = await Promise.all([0, 1, 2, 3].map(() => generateIdentity()));
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 2 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);

    const results = await Promise.allSettled(
      racers.map((id) => postRegister(port, { public_key_hex: pubHex(id) })),
    );
    const m = await masterDone;

    // Exactly one 200; every other racer got 409 bootstrap is full or a
    // connection error (it arrived after the leader stopped listening).
    const winners = results.flatMap((r, i) =>
      r.status === 'fulfilled' && r.value.status === 200 ? [i] : [],
    );
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected' || r.value.status === 200) continue;
      expect(r.value.status).toBe(409);
      expect(r.value.json.error).toBe('bootstrap is full');
    }

    // The book holds the leader and the one winner, and the winner got that book.
    expect(m.book.entries).toHaveLength(2);
    const winner = racers[winners[0]!]!;
    expect(m.book.entries.map((e) => e.publicKeyHex).sort(byRawPubkey)).toEqual(
      [pubHex(master), pubHex(winner)].sort(byRawPubkey),
    );
    const won = results[winners[0]!] as PromiseFulfilledResult<RegisterReply>;
    expect(won.value.json.fingerprint).toBe(m.fingerprint);
  }, 10_000);

  it('a member that arrives after the leader completed gets a hint to compare key ids', async () => {
    const [master, b, late] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 2 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });
    await sleep(50);
    await runMemberRegister({ self: { identity: b }, masterUrl: url, timeoutMs: 5_000 });
    await masterDone; // the leader has stopped listening

    const err = await runMemberRegister({ self: { identity: late }, masterUrl: url, timeoutMs: 5_000 }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^register: POST failed: .*\(ECONNREFUSED\); /);
    expect((err as Error).message).toContain(
      'the leader is not accepting registrations — it may not be started yet, or setup already completed without this node; if the leader has finished, compare key ids with the other operators, and if one is unknown delete pubkeys.json on every node and redo setup',
    );
  }, 10_000);

  it('leader timeout names received vs expected registrations', async () => {
    const [master, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 3 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 500,
    });
    await sleep(50);
    const bDone = runMemberRegister({
      self: { identity: b },
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    });

    await expect(masterDone).rejects.toThrow(/timed out after 500ms: received 1 of 2 registrations/);
    // The waiting member hears the same shortfall in its 408.
    await expect(bDone).rejects.toThrow(/408: .*received 1 of 2 registrations/);
  }, 10_000);

  it('endpoints admission timeout names received vs expected registrations too', async () => {
    const master = await makePeer('node-a', 18800);
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [{ advertisedEndpoint: '127.0.0.1:18801' }, { advertisedEndpoint: '127.0.0.1:18802' }],
      },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 300,
    });
    await expect(masterDone).rejects.toThrow(/received 0 of 2 registrations/);
  }, 10_000);

  it('count admission refuses parties below 2', async () => {
    const master = await generateIdentity();
    for (const parties of [1, 0, 2.5, Number.NaN]) {
      await expect(
        runMasterBootstrap({
          self: { identity: master },
          admission: { kind: 'count', parties },
          bind: '127.0.0.1:0',
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(/parties/);
    }
  });
});

describe('bootstrap — member checks by transport', () => {
  it('member in relay mode refuses a book whose own entry has an endpoint', async () => {
    const [m, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const stub = await stubMaster(() => bookReply([pubHex(m), pubHex(b)], { [pubHex(b)]: '127.0.0.1:18801' }));
    try {
      await expect(
        runMemberRegister({ self: { identity: b }, masterUrl: stub.url, timeoutMs: 5_000 }),
      ).rejects.toThrow(
        "register: the leader's book gives this node advertisedEndpoint='127.0.0.1:18801'; a relay node registers none",
      );
      // A relay member sends no advertised_endpoint key at all.
      expect(stub.bodies).toEqual([{ public_key_hex: pubHex(b) }]);
    } finally {
      await stub.close();
    }
  });

  it('peer-mesh member refuses a book whose own entry has no endpoint', async () => {
    const [m, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const stub = await stubMaster(() => bookReply([pubHex(m), pubHex(b)], {}));
    try {
      await expect(
        runMemberRegister({
          self: { identity: b, advertisedEndpoint: '127.0.0.1:18801' },
          masterUrl: stub.url,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        "register: the leader's book has no advertisedEndpoint for this node; it registered '127.0.0.1:18801'",
      );
    } finally {
      await stub.close();
    }
  });

  it('a relay-mode member registering with an endpoints-mode master gets an error naming the transport mismatch', async () => {
    const master = await makePeer('node-a', 18800);
    const b = await generateIdentity();
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master.identity },
      admission: {
        kind: 'endpoints',
        selfEndpoint: master.advertisedEndpoint,
        expectedPeers: [{ advertisedEndpoint: '127.0.0.1:18801' }],
      },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 500,
    }).catch((err: unknown) => err);
    await sleep(50);

    const err = await runMemberRegister({
      self: { identity: b },
      masterUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 2_000,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/transport/);
    expect((err as Error).message).toMatch(/relay/);
    expect((err as Error).message).toBe(
      'setup: the leader expects peer-mesh registrations (an advertised endpoint); this node is configured for relay — use the same transport on every node',
    );
    await masterDone;
  }, 10_000);

  it('a peer-mesh member registering with a count-mode master gets an error naming the transport mismatch', async () => {
    const [master, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const port = await freePort();
    const masterDone = runMasterBootstrap({
      self: { identity: master },
      admission: { kind: 'count', parties: 2 },
      bind: `127.0.0.1:${port}`,
      timeoutMs: 500,
    }).catch((err: unknown) => err);
    await sleep(50);

    await expect(
      runMemberRegister({
        self: { identity: b, advertisedEndpoint: '127.0.0.1:18801' },
        masterUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(
      'setup: the leader expects relay registrations (no advertised endpoint); this node is configured for peer-mesh — use the same transport on every node',
    );
    await masterDone;
  }, 10_000);

  it('member maps 409 bootstrap is full to the abort-and-redo error', async () => {
    const b = await generateIdentity();
    // The member matches master.ts's constant, so a rewording cannot silently break the mapping.
    const stub = await stubMaster(async () => ({ status: 409, json: { error: BOOTSTRAP_FULL_ERROR } }));
    try {
      await expect(
        runMemberRegister({ self: { identity: b }, masterUrl: stub.url, timeoutMs: 5_000 }),
      ).rejects.toThrow(
        "setup: bootstrap is full — another party registered in this node's place, or the leader's [bootstrap] parties is lower than the number of nodes; abort, delete pubkeys.json on every node, check the leader's parties, and redo setup with the bootstrap port reachable only by the members",
      );
    } finally {
      await stub.close();
    }
  });
});
