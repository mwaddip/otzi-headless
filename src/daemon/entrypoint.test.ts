import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { readAddressBook } from '../address-book/store';
import { BroadcastFailedError } from '../cli/cmd/btc';
import { DaemonClientError } from '../cli/daemon-client';
import { RelayServer } from '../transport/relay/server';
import { parseVerbArgs, reportCliError, runBookCommand, runRelayCommand } from './entrypoint';

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
    expect(stdout).toEqual(['added 1, updated 0, unchanged 0, removed 0']);
    await book('import', out, '--replace');
    expect(stdout[1]).toBe('added 0, updated 0, unchanged 1, removed 0');
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

describe('otzi relay', () => {
  const ENTRYPOINT = fileURLToPath(new URL('./entrypoint.ts', import.meta.url));
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  /** Run `otzi relay <args>` as its own process, so signals and the exit code are the real ones. */
  function spawnRelay(args: string[]) {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT, 'relay', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    const watchers: Array<() => void> = [];
    child.stdout!.on('data', (d: Buffer) => void (stdout += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      for (const w of [...watchers]) w();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    /** Resolves with the first match of `re` in stderr, however early or late it was written. */
    const stderrMatch = (re: RegExp) =>
      new Promise<RegExpMatchArray>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no stderr match for ${re} in:\n${stderr}`)), 30_000);
        const check = () => {
          const m = re.exec(stderr);
          if (!m) return;
          clearTimeout(timer);
          watchers.splice(watchers.indexOf(check), 1);
          resolve(m);
        };
        watchers.push(check);
        check();
      });
    return {
      child,
      exited,
      stdout: () => stdout,
      stderr: () => stderr,
      port: async () => Number((await stderrMatch(/RelayServer: listening \{"host":"127\.0\.0\.1","port":(\d+)\}/))[1]),
      stderrMatch,
    };
  }

  function nextMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      ws.once('message', data => resolve(JSON.parse(data.toString('utf8'))));
      ws.once('error', reject);
    });
  }

  it('otzi relay --listen 127.0.0.1:0 starts a relay that accepts a hello and stops on SIGTERM', async () => {
    const relay = spawnRelay(['--listen', '127.0.0.1:0']);
    const port = await relay.port();
    expect(port).toBeGreaterThan(0);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ kind: 'hello', ringId: 'ring-a', partyId: 0 }));
    expect(await reply).toEqual({ kind: 'ack', roster: [] });
    await relay.stderrMatch(/relay: hello \{"ringId":"ring-a","partyId":0,"rosterSize":1\}/);

    relay.child.kill('SIGTERM');
    expect(await relay.exited).toEqual({ code: 0, signal: null });
    await closed;
    expect(relay.stderr()).toContain('RelayServer: stopped');
    expect(relay.stdout()).toBe('');
  }, 60_000);

  it('a client that never sent hello does not delay the exit on SIGTERM', async () => {
    const relay = spawnRelay(['--listen', '127.0.0.1:0']);
    const port = await relay.port();
    const silent = new WebSocket(`ws://127.0.0.1:${port}`);
    silent.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        silent.once('open', () => resolve());
        silent.once('error', reject);
      });
      const signalled = Date.now();
      relay.child.kill('SIGTERM');
      expect(await relay.exited).toEqual({ code: 0, signal: null });
      // Well under the 5 s hard deadline: the relay stopped, nothing timed out.
      expect(Date.now() - signalled).toBeLessThan(4_000);
      expect(relay.stderr()).toContain('RelayServer: stopped');
      expect(relay.stderr()).not.toContain('did not finish');
    } finally {
      silent.terminate();
    }
  }, 60_000);

  it('stops on SIGINT too, with exit status 0 and nothing on stdout', async () => {
    const relay = spawnRelay(['--listen', '127.0.0.1:0']);
    await relay.port();
    relay.child.kill('SIGINT');
    expect(await relay.exited).toEqual({ code: 0, signal: null });
    expect(relay.stderr()).toContain('RelayServer: stopped');
    expect(relay.stdout()).toBe('');
  }, 60_000);

  it('otzi relay without --listen fails with usage', async () => {
    await expect(runRelayCommand([])).rejects.toThrow(/usage:[\s\S]*otzi relay --listen <host:port>/);
    // The process level: exit status 1, the usage on stderr, nothing on stdout.
    const relay = spawnRelay([]);
    expect(await relay.exited).toEqual({ code: 1, signal: null });
    expect(relay.stderr()).toMatch(/usage:[\s\S]*otzi relay --listen <host:port>/);
    expect(relay.stdout()).toBe('');
  }, 60_000);

  it('otzi relay rejects an unknown flag', async () => {
    await expect(runRelayCommand(['--listen', '127.0.0.1:0', '--bind', '127.0.0.1:1'])).rejects.toThrow(
      "unknown flag '--bind'",
    );
    await expect(runRelayCommand(['--listen'])).rejects.toThrow("flag '--listen' needs a value");
  });

  it('otzi relay takes no positional argument', async () => {
    await expect(runRelayCommand(['--listen', '127.0.0.1:0', 'extra'])).rejects.toThrow(/unexpected argument 'extra'/);
  });

  it('otzi relay rejects a listen address without a host or port, and one already in use, without leaving signal handlers behind', async () => {
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');
    await expect(runRelayCommand(['--listen', '7100'])).rejects.toThrow(/invalid listen '7100'/);
    await expect(runRelayCommand(['--listen', ':7100'])).rejects.toThrow(/invalid listen ':7100'/);

    const taken = new RelayServer({ listen: '127.0.0.1:0' });
    await taken.start();
    try {
      await expect(runRelayCommand(['--listen', `127.0.0.1:${taken.address()!.port}`])).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await taken.stop();
    }
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });

  it('otzi relay exits 0 at a hard 5 s deadline when stopping the relay hangs', async () => {
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    const added = (signal: 'SIGINT' | 'SIGTERM') => process.listeners(signal).filter(l => !before[signal].includes(l));
    const realStop = RelayServer.prototype.stop;
    let running: RelayServer | undefined;
    vi.spyOn(RelayServer.prototype, 'stop').mockImplementation(function (this: RelayServer) {
      running = this;
      return new Promise<void>(() => {}); // never settles
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += `${args.join(' ')}\n`;
    });
    try {
      await runRelayCommand(['--listen', '127.0.0.1:0']);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      for (const handler of added('SIGTERM')) (handler as (signal: string) => void)('SIGTERM');
      await vi.advanceTimersByTimeAsync(4_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(stderr).toContain('received SIGTERM, shutting down');
      expect(stderr).toContain('otzi relay: shutdown did not finish within 5 s; exiting');
    } finally {
      vi.useRealTimers();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) for (const handler of added(signal)) process.off(signal, handler);
      vi.restoreAllMocks();
      if (running) await realStop.call(running);
    }
  });

  it('otzi relay has its signal handlers in place when it writes the listen line', async () => {
    // The listen line is the ready signal: a SIGINT/SIGTERM sent the moment it appears must reach the
    // handlers, not the default action that kills the process.
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    const added = (signal: 'SIGINT' | 'SIGTERM') => process.listeners(signal).filter(l => !before[signal].includes(l));
    const atListenLine: Array<{ SIGINT: number; SIGTERM: number }> = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      if (String(chunk).includes('RelayServer: listening'))
        atListenLine.push({ SIGINT: added('SIGINT').length, SIGTERM: added('SIGTERM').length });
      return true;
    }) as typeof process.stderr.write);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    try {
      await runRelayCommand(['--listen', '127.0.0.1:0']);
      expect(atListenLine).toEqual([{ SIGINT: 1, SIGTERM: 1 }]);
    } finally {
      // The relay's own SIGTERM handler stops it (process.exit is stubbed); then both handlers go.
      for (const handler of added('SIGTERM')) (handler as (signal: string) => void)('SIGTERM');
      if (added('SIGTERM').length > 0) await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      for (const signal of ['SIGINT', 'SIGTERM'] as const) for (const handler of added(signal)) process.off(signal, handler);
      vi.restoreAllMocks();
    }
  });
});
