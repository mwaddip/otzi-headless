import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAddressBook } from '../address-book/store';
import { BroadcastFailedError } from '../cli/cmd/btc';
import { DaemonClientError } from '../cli/daemon-client';
import { parseVerbArgs, reportCliError, runBookCommand } from './entrypoint';

const TX_HEX = '02000000000101ab';

function report(err: unknown): string[] {
  const lines: string[] = [];
  reportCliError(err, line => lines.push(line));
  return lines;
}

describe('reportCliError', () => {
  it('prints the signed transaction hex when a broadcast failed after signing', () => {
    const lines = report(new BroadcastFailedError('broadcast failed: 400 bad-txns-inputs-missingorspent', 'ab'.repeat(32), TX_HEX));
    expect(lines[0]).toBe('broadcast failed: 400 bad-txns-inputs-missingorspent');
    expect(lines.join('\n')).toContain(`txid ${'ab'.repeat(32)}`);
    expect(lines.join('\n')).toMatch(/broadcast it by other means/);
    expect(lines[lines.length - 1]).toBe(TX_HEX);
  });

  it('prints just the message for any other error', () => {
    expect(report(new DaemonClientError(409, 'this node already holds a vault'))).toEqual([
      'this node already holds a vault',
    ]);
    expect(report(new Error('boom'))).toEqual(['boom']);
    expect(report('plain')).toEqual(['plain']);
  });
});

describe('parseVerbArgs', () => {
  const spec = { values: ['config', 'fee-rate'], booleans: ['broadcast', 'json'] };

  it('splits positionals from value and boolean flags in any order', () => {
    const r = parseVerbArgs(['--broadcast', 'proposal.json', '--config', '/x.toml'], spec);
    expect(r.positional).toEqual(['proposal.json']);
    expect(r.flags.get('config')).toBe('/x.toml');
    expect(r.flags.has('broadcast')).toBe(true);
    expect(r.flags.has('json')).toBe(false);
  });

  it('keeps negative-looking and decimal tokens as positionals', () => {
    expect(parseVerbArgs(['tb1qaddr', '0.5btc', '--fee-rate', '7.5'], spec)).toMatchObject({
      positional: ['tb1qaddr', '0.5btc'],
      flags: new Map([['fee-rate', '7.5']]),
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseVerbArgs(['--fee_rate', '5'], spec)).toThrow("unknown flag '--fee_rate'");
  });

  it('rejects a value flag without a value', () => {
    expect(() => parseVerbArgs(['--config'], spec)).toThrow("flag '--config' needs a value");
    expect(() => parseVerbArgs(['--config', '--json'], spec)).toThrow("flag '--config' needs a value");
  });
});

describe('otzi book', () => {
  const ADDR_A = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const ADDR_B = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

  let tmp: string;
  let config: string;
  let bookPath: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-entrypoint-book-'));
    config = join(tmp, 'daemon.toml');
    bookPath = join(tmp, 'address-book.otzi.json');
    await writeFile(
      config,
      `
[share]
path = "/tmp/otzi-test-share.json"
password_env = "OTZI_TEST_PASSWORD"
[node]
id = "a"
[network]
name = "testnet4"
[transport]
kind = "peer-mesh"
advertised_endpoint = "127.0.0.1:8800"
[[peers]]
endpoint = "127.0.0.1:8801"
[gate]
strategy = "auto"
`,
    );
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.join(' ')));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  const book = (...args: string[]) => runBookCommand([...args, '--config', config], bookPath);

  it('add, list, export, remove: machine output on stdout, messages on stderr', async () => {
    await book('add', 'treasury', ADDR_A, '--note', 'cold storage');
    await book('add', 'exchange', ADDR_B);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('treasury');
    expect((await stat(bookPath)).mode & 0o777).toBe(0o640);

    stderr.length = 0;
    await book('list');
    expect(stdout).toEqual([`treasury\t${ADDR_A}\tcold storage\nexchange\t${ADDR_B}\t`]);
    expect(stderr).toEqual([]);

    stdout.length = 0;
    await book('export');
    expect(JSON.parse(stdout[0]!)).toEqual({
      kind: 'otzi-address-book',
      version: 1,
      network: 'testnet4',
      entries: [
        { label: 'treasury', address: ADDR_A, note: 'cold storage' },
        { label: 'exchange', address: ADDR_B },
      ],
    });

    await book('remove', 'treasury');
    expect(await readAddressBook(bookPath, 'testnet4')).toEqual([{ label: 'exchange', address: ADDR_B }]);
  });

  it('export <path> writes the file and keeps stdout empty; import merges it and prints the counts', async () => {
    await book('add', 'treasury', ADDR_A);
    const out = join(tmp, 'book.otzi.json');
    stdout.length = 0;
    await book('export', out);
    expect(stdout).toEqual([]);
    expect(JSON.parse(await readFile(out, 'utf8')).entries).toEqual([{ label: 'treasury', address: ADDR_A }]);

    await rm(bookPath);
    await book('import', out);
    expect(stdout).toEqual(['added 1, updated 0, unchanged 0']);
    await book('import', out, '--replace');
    expect(stdout[1]).toBe('added 0, updated 0, unchanged 1');
    expect(await readAddressBook(bookPath, 'testnet4')).toEqual([{ label: 'treasury', address: ADDR_A }]);
  });

  it('list says so on stderr for an empty book and prints nothing on stdout', async () => {
    await book('list');
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toMatch(/empty/);
  });

  it('rejects unknown flags, wrong argument counts and unknown verbs before touching the book', async () => {
    await expect(book('add', 'x', ADDR_A, '--notes', 'typo')).rejects.toThrow("unknown flag '--notes'");
    await expect(book('add', 'x')).rejects.toThrow(/usage: otzi book add/);
    await expect(book('add', 'x', ADDR_A, 'extra')).rejects.toThrow(/usage: otzi book add/);
    await expect(book('remove')).rejects.toThrow(/usage: otzi book remove/);
    await expect(book('import')).rejects.toThrow(/usage: otzi book import/);
    await expect(book('import', 'a.json', '--merge')).rejects.toThrow("unknown flag '--merge'");
    await expect(book('export', 'a', 'b')).rejects.toThrow(/usage: otzi book export/);
    await expect(book('list', 'extra')).rejects.toThrow(/unexpected argument 'extra'/);
    await expect(book('frobnicate')).rejects.toThrow(/usage:/);
    await expect(runBookCommand([], bookPath)).rejects.toThrow(/usage:/);
    await expect(stat(bookPath)).rejects.toThrow(/ENOENT/);
  });

  it('reports an invalid address as an error and writes nothing', async () => {
    await expect(book('add', 'x', 'nope')).rejects.toThrow(/not a valid testnet4 address/);
    await expect(stat(bookPath)).rejects.toThrow(/ENOENT/);
  });

  it('reads the network from --config', async () => {
    await expect(runBookCommand(['list', '--config', join(tmp, 'absent.toml')], bookPath)).rejects.toThrow(/absent\.toml/);
  });
});
