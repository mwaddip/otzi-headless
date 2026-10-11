import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildBook, keyId, parseBook, serializeBook } from '../bootstrap/pubkey-book';
import { exportPrivateKeyPkcs8, generateIdentity } from '../transport/identity';
import { toHex } from '../otzi/lib/hex';
import { setupMaster, setupMember } from './setup';

const KEY_ID_INSTRUCTION =
  'Confirm every key id above belongs to one of your nodes; an unknown id means someone else registered — delete pubkeys.json on every node and redo setup.';
const NO_IDENTITY_WARNING =
  '⚠ no identity key — the daemon cannot start; restore it from a backup, or delete pubkeys.json on every node and redo setup';
const NOT_IN_BOOK_WARNING =
  "⚠ this node's key is not in this book — the daemon will not start; delete pubkeys.json on every node and redo setup";

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
        expect(banner).toContain(KEY_ID_INSTRUCTION);
        expect(banner).not.toContain(NO_IDENTITY_WARNING);
        expect(banner).not.toContain(NOT_IN_BOOK_WARNING);
        // Key ids follow the fingerprint.
        const fp = banner.findIndex((l) => l.startsWith('fingerprint: '));
        const self = banner.findIndex((l) => l.startsWith('this node: '));
        expect(fp).toBeGreaterThanOrEqual(0);
        expect(self).toBeGreaterThan(fp);
      }
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
    expect(banner).toContain(KEY_ID_INSTRUCTION);
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

  it('relay setup on a leader without [bootstrap] parties fails naming it', async () => {
    const [a] = makeNodes(dir) as [TestNode];
    await writeFile(a.configPath, nodeToml(dir, a, [], 'relay', ''));
    await expect(setupMaster(a.configPath, '127.0.0.1:0')).rejects.toThrow(/\[bootstrap\] parties/);
  });
});
