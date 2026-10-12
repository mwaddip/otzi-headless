import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildBook, keyId, parseBook, serializeBook } from '../bootstrap/pubkey-book';
import { exportPrivateKeyPkcs8, generateIdentity } from '../transport/identity';
import { toHex } from '../otzi/lib/hex';
import { isWildcardBind, setupMaster, setupMember } from './setup';

// Lets a test give two keys one key id: a 64-bit collision cannot be produced for real.
const keyIdOverride = vi.hoisted(() => ({ fn: null as null | ((hex: string) => string | undefined) }));
vi.mock('../bootstrap/pubkey-book', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bootstrap/pubkey-book')>();
  return { ...actual, keyId: (hex: string) => keyIdOverride.fn?.(hex) ?? actual.keyId(hex) };
});

const KEY_ID_INSTRUCTION =
  'Confirm every key id above belongs to one of your nodes; an unknown id means someone else registered — delete pubkeys.json on every node and redo setup.';
const NO_IDENTITY_WARNING =
  '⚠ no identity key — the daemon cannot start; restore it from a backup, or delete pubkeys.json on every node and redo setup';
const NOT_IN_BOOK_WARNING =
  "⚠ this node's key is not in this book — the daemon will not start; delete pubkeys.json on every node and redo setup";
const COUNT_INSTRUCTION = 'Count the party lines: there must be exactly one per node you set up.';
const WILDCARD_WARNING_START = 'otzi: ⚠ the bootstrap bind';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/** Resolves once something accepts TCP connections on `port` (the leader's bootstrap server). */
async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`port ${port} never opened`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Transport = 'peer-mesh' | 'relay';

interface TestNode {
  id: string;
  endpoint: string;
  configPath: string;
  identityFile: string;
  bookFile: string;
}

/** A daemon.toml for one node of a three-node ring under `dir`. */
function nodeToml(
  dir: string,
  node: TestNode,
  others: TestNode[],
  transport: Transport,
  bootstrap: string,
): string {
  const transportSection =
    transport === 'peer-mesh'
      ? `[transport]\nkind = "peer-mesh"\nadvertised_endpoint = "${node.endpoint}"\n\n` +
        others.map((o) => `[[peers]]\nendpoint = "${o.endpoint}"\n`).join('\n')
      : '[transport]\nkind = "relay"\nurl = "ws://127.0.0.1:9000"\n';
  return `
[share]
path = "${path.join(dir, node.id, 'share.json')}"
password_env = "OTZI_SHARE_PASSWORD"

[node]
id = "${node.id}"
identity_key_file = "${node.identityFile}"
pubkey_book_file = "${node.bookFile}"

[network]
name = "testnet4"

${transportSection}
[gate]
strategy = "auto"
${bootstrap}`;
}

function makeNodes(dir: string): TestNode[] {
  return ['node-a', 'node-b', 'node-c'].map((id, i) => ({
    id,
    endpoint: `127.0.0.1:${18800 + i}`,
    configPath: path.join(dir, `${id}.toml`),
    identityFile: path.join(dir, id, 'identity.json'),
    bookFile: path.join(dir, id, 'pubkeys.json'),
  }));
}

async function ownPubkeyHex(node: TestNode): Promise<string> {
  return (JSON.parse(await readFile(node.identityFile, 'utf8')) as { publicKeyHex: string }).publicKeyHex;
}

/** The banner lines `announceComplete` printed for `nodeId` (trimmed), from its title to the closing blank line. */
function bannerOf(lines: string[], nodeId: string): string[] {
  const start = lines.findIndex((l) => l.includes(`setup complete — ${nodeId}`));
  expect(start, `no setup banner for ${nodeId}`).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf('', start);
  return lines.slice(start, end === -1 ? undefined : end).map((l) => l.trim());
}

describe('setup banner', () => {
  let dir: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'otzi-setup-test-'));
    lines = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe.each<Transport>(['peer-mesh', 'relay'])('%s', (transport) => {
    it("setup banner lists this node's key id and every ring key id", async () => {
      const nodes = makeNodes(dir);
      const [a, b, c] = nodes as [TestNode, TestNode, TestNode];
      const port = await freePort();
      const bind = `127.0.0.1:${port}`;
      const leaderUrl = `http://${bind}`;

      const leaderBootstrap =
        transport === 'relay'
          ? `\n[bootstrap]\nrole = "leader"\nbind = "${bind}"\nparties = 3\n`
          : `\n[bootstrap]\nrole = "leader"\nbind = "${bind}"\n`;
      const leafBootstrap = `\n[bootstrap]\nrole = "leaf"\nleader_url = "${leaderUrl}"\n`;
      for (const n of nodes) {
        const others = nodes.filter((o) => o !== n);
        await writeFile(
          n.configPath,
          nodeToml(dir, n, others, transport, n === a ? leaderBootstrap : leafBootstrap),
        );
      }

      const masterDone = setupMaster(a.configPath, bind);
      await waitForPort(port);
      await Promise.all([masterDone, setupMember(b.configPath, leaderUrl), setupMember(c.configPath, leaderUrl)]);

      // Every node wrote the same book.
      const bookText = await readFile(a.bookFile, 'utf8');
      expect(await readFile(b.bookFile, 'utf8')).toBe(bookText);
      expect(await readFile(c.bookFile, 'utf8')).toBe(bookText);
      expect(parseBook(bookText).entries).toHaveLength(3);

      // Expected party lines, built from the nodes themselves: partyIds by sorted
      // raw pubkey, the endpoint after two spaces under peer-mesh only.
      const pubkeys = new Map<TestNode, string>();
      for (const n of nodes) pubkeys.set(n, await ownPubkeyHex(n));
      const sorted = [...nodes].sort((x, y) =>
        Buffer.compare(Buffer.from(pubkeys.get(x)!, 'hex'), Buffer.from(pubkeys.get(y)!, 'hex')),
      );
      const expectedPartyLines = sorted.map(
        (n, partyId) =>
          `party ${partyId}: ${keyId(pubkeys.get(n)!)}` + (transport === 'peer-mesh' ? `  ${n.endpoint}` : ''),
      );

      for (const n of nodes) {
        const banner = bannerOf(lines, n.id);
        expect(banner).toContain(`this node: ${keyId(pubkeys.get(n)!)}`);
        expect(banner.filter((l) => l.startsWith('party '))).toEqual(expectedPartyLines);
        expect(banner).toContain('ring size: 3');
        expect(banner.indexOf('ring size: 3')).toBe(banner.findIndex((l) => l.startsWith('party ')) - 1);
        expect(banner).toContain(KEY_ID_INSTRUCTION);
        expect(banner).toContain(COUNT_INSTRUCTION);
        expect(banner.filter((l) => l.startsWith('⚠ duplicate key id'))).toEqual([]);
        // Only the leader knows what it refused.
        expect(banner.filter((l) => l.startsWith('refused registrations:'))).toEqual(
          n === a ? ['refused registrations: none'] : [],
        );
        expect(banner).not.toContain(NO_IDENTITY_WARNING);
        expect(banner).not.toContain(NOT_IN_BOOK_WARNING);
        // Key ids follow the fingerprint.
        const fp = banner.findIndex((l) => l.startsWith('fingerprint: '));
        const self = banner.findIndex((l) => l.startsWith('this node: '));
        expect(fp).toBeGreaterThanOrEqual(0);
        expect(self).toBeGreaterThan(fp);
      }
      // A loopback bind draws no exposure warning.
      expect(lines.filter((l) => l.startsWith(WILDCARD_WARNING_START))).toEqual([]);
    }, 20_000);
  });

  it('a re-run with the book present prints the same key ids', async () => {
    const [a] = makeNodes(dir) as [TestNode];
    const self = await generateIdentity(true);
    const other = await generateIdentity(true);
    const selfHex = toHex(self.publicKeyRaw);
    const otherHex = toHex(other.publicKeyRaw);
    await mkdir(path.dirname(a.identityFile), { recursive: true });
    await writeFile(
      a.identityFile,
      JSON.stringify({ pkcs8Hex: toHex(await exportPrivateKeyPkcs8(self)), publicKeyHex: selfHex }),
    );
    const sorted = [selfHex, otherHex].sort((x, y) => Buffer.compare(Buffer.from(x, 'hex'), Buffer.from(y, 'hex')));
    await writeFile(
      a.bookFile,
      serializeBook(buildBook(sorted.map((publicKeyHex, partyId) => ({ partyId, publicKeyHex })))),
    );
    await writeFile(a.configPath, nodeToml(dir, a, [], 'relay', ''));

    await setupMember(a.configPath, 'http://127.0.0.1:1');
    let banner = bannerOf(lines, a.id);
    expect(banner).toContain(`this node: ${keyId(selfHex)}`);
    expect(banner.filter((l) => l.startsWith('party '))).toEqual(
      sorted.map((h, partyId) => `party ${partyId}: ${keyId(h)}`),
    );
    expect(banner).toContain('ring size: 2');
    expect(banner).toContain(KEY_ID_INSTRUCTION);
    expect(banner).toContain(COUNT_INSTRUCTION);
    // A re-print has no registrations to report.
    expect(banner.filter((l) => l.startsWith('refused registrations:'))).toEqual([]);
    expect(banner.some((l) => l.startsWith('note: book already present'))).toBe(true);
    expect(banner).not.toContain(NO_IDENTITY_WARNING);
    expect(banner).not.toContain(NOT_IN_BOOK_WARNING);

    // With the identity file gone the banner still lists the ring and says so.
    await rm(a.identityFile);
    lines.length = 0;
    await setupMember(a.configPath, 'http://127.0.0.1:1');
    banner = bannerOf(lines, a.id);
    expect(banner).toContain(`this node: no identity key at ${a.identityFile}`);
    expect(banner).toContain(NO_IDENTITY_WARNING);
    expect(banner).not.toContain(NOT_IN_BOOK_WARNING);
    expect(banner.filter((l) => l.startsWith('party '))).toHaveLength(2);
  });

  it("a re-run warns when this node's key is not in the book", async () => {
    const [a] = makeNodes(dir) as [TestNode];
    const self = await generateIdentity(true);
    const [x, y] = [toHex((await generateIdentity()).publicKeyRaw), toHex((await generateIdentity()).publicKeyRaw)];
    await mkdir(path.dirname(a.identityFile), { recursive: true });
    await writeFile(
      a.identityFile,
      JSON.stringify({ pkcs8Hex: toHex(await exportPrivateKeyPkcs8(self)), publicKeyHex: toHex(self.publicKeyRaw) }),
    );
    const sorted = [x, y].sort((p, q) => Buffer.compare(Buffer.from(p, 'hex'), Buffer.from(q, 'hex')));
    await writeFile(
      a.bookFile,
      serializeBook(buildBook(sorted.map((publicKeyHex, partyId) => ({ partyId, publicKeyHex })))),
    );
    await writeFile(a.configPath, nodeToml(dir, a, [], 'relay', ''));

    await setupMember(a.configPath, 'http://127.0.0.1:1');
    const banner = bannerOf(lines, a.id);
    expect(banner).toContain(`this node: ${keyId(toHex(self.publicKeyRaw))}`);
    expect(banner).toContain(NOT_IN_BOOK_WARNING);
    expect(banner).not.toContain(NO_IDENTITY_WARNING);
    // The warning sits right under the line it is about.
    expect(banner.indexOf(NOT_IN_BOOK_WARNING)).toBe(banner.findIndex((l) => l.startsWith('this node: ')) + 1);
  });

  it('the banner warns about two entries with the same key id', async () => {
    const [a] = makeNodes(dir) as [TestNode];
    const self = await generateIdentity(true);
    const selfHex = toHex(self.publicKeyRaw);
    const [x, y] = [toHex((await generateIdentity()).publicKeyRaw), toHex((await generateIdentity()).publicKeyRaw)];
    await mkdir(path.dirname(a.identityFile), { recursive: true });
    await writeFile(a.identityFile, JSON.stringify({ pkcs8Hex: toHex(await exportPrivateKeyPkcs8(self)), publicKeyHex: selfHex }));
    const sorted = [selfHex, x, y].sort((p, q) => Buffer.compare(Buffer.from(p, 'hex'), Buffer.from(q, 'hex')));
    await writeFile(a.bookFile, serializeBook(buildBook(sorted.map((publicKeyHex, partyId) => ({ partyId, publicKeyHex })))));
    await writeFile(a.configPath, nodeToml(dir, a, [], 'relay', ''));
    keyIdOverride.fn = (hex) => (hex === x || hex === y ? 'abababababababab' : undefined);
    try {
      await setupMember(a.configPath, 'http://127.0.0.1:1');
    } finally {
      keyIdOverride.fn = null;
    }
    const banner = bannerOf(lines, a.id);
    expect(banner).toContain('ring size: 3');
    expect(banner.filter((l) => l.startsWith('party ') && l.endsWith('abababababababab'))).toHaveLength(2);
    expect(banner.filter((l) => l.startsWith('⚠ duplicate key id'))).toEqual(['⚠ duplicate key id abababababababab']);
  });

  it('the relay leader banner reports the registrations it refused, by reason', async () => {
    const [a, b] = makeNodes(dir) as [TestNode, TestNode];
    const port = await freePort();
    const bind = `127.0.0.1:${port}`;
    await writeFile(a.configPath, nodeToml(dir, a, [b], 'relay', `\n[bootstrap]\nrole = "leader"\nbind = "${bind}"\nparties = 2\n`));
    await writeFile(b.configPath, nodeToml(dir, b, [a], 'relay', `\n[bootstrap]\nrole = "leaf"\nleader_url = "http://${bind}"\n`));

    const masterDone = setupMaster(a.configPath, bind);
    await waitForPort(port);
    const post = async (body: unknown) =>
      (await fetch(`http://${bind}/register`, { method: 'POST', body: JSON.stringify(body) })).status;
    expect(await post({ public_key_hex: await ownPubkeyHex(a) })).toBe(409);
    expect(await post({ public_key_hex: toHex((await generateIdentity()).publicKeyRaw), advertised_endpoint: '127.0.0.1:1' })).toBe(400);
    await Promise.all([masterDone, setupMember(b.configPath, `http://${bind}`)]);

    expect(bannerOf(lines, a.id).filter((l) => l.startsWith('refused registrations:'))).toEqual([
      'refused registrations: 0 after the ring was full, 1 duplicate, 1 with an endpoint',
    ]);
    expect(bannerOf(lines, b.id).filter((l) => l.startsWith('refused registrations:'))).toEqual([]);
  }, 20_000);

  describe.each<Transport>(['relay', 'peer-mesh'])('a leader bound to every interface (%s)', (transport) => {
    it(transport === 'relay' ? 'warns that the port must be reachable only by the members' : 'draws no warning', async () => {
      const [a, b] = makeNodes(dir) as [TestNode, TestNode];
      const port = await freePort();
      const leaderBootstrap = `\n[bootstrap]\nrole = "leader"\nbind = "0.0.0.0:${port}"\n${transport === 'relay' ? 'parties = 2\n' : ''}`;
      await writeFile(a.configPath, nodeToml(dir, a, [b], transport, leaderBootstrap));
      await writeFile(b.configPath, nodeToml(dir, b, [a], transport, `\n[bootstrap]\nrole = "leaf"\nleader_url = "http://127.0.0.1:${port}"\n`));

      const masterDone = setupMaster(a.configPath, `0.0.0.0:${port}`);
      await waitForPort(port);
      await Promise.all([masterDone, setupMember(b.configPath, `http://127.0.0.1:${port}`)]);

      const warnings = lines.filter((l) => l.startsWith(WILDCARD_WARNING_START));
      if (transport === 'peer-mesh') {
        expect(warnings).toEqual([]);
      } else {
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`0.0.0.0:${port}`);
        expect(warnings[0]).toMatch(/reachable only by the members/);
        expect(warnings[0]).toMatch(/VPN/);
        expect(warnings[0]).toMatch(/SSH tunnel/);
      }
    }, 20_000);
  });

  it('isWildcardBind: 0.0.0.0 and every spelling of ::, nothing else', () => {
    for (const bind of ['0.0.0.0:7090', '[::]:7090', ':::7090', '[0:0:0:0:0:0:0:0]:7090', '[::0]:7090'])
      expect(isWildcardBind(bind), bind).toBe(true);
    for (const bind of ['127.0.0.1:7090', '10.8.0.1:7090', '[::1]:7090', 'leader.example:7090', '[fd00::1]:7090'])
      expect(isWildcardBind(bind), bind).toBe(false);
  });

  it('relay setup on a leader without [bootstrap] parties fails naming it', async () => {
    const [a] = makeNodes(dir) as [TestNode];
    await writeFile(a.configPath, nodeToml(dir, a, [], 'relay', ''));
    await expect(setupMaster(a.configPath, '127.0.0.1:0')).rejects.toThrow(/\[bootstrap\] parties/);
  });
});
