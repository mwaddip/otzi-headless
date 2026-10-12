import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UdsTrigger } from '../../triggers/uds';
import { vaultPubkeyFromPackage, writeVaultPubkeyFile, type VaultPubkeyFile } from '../../daemon/vault-pubkey';
import { makeTestVault } from '../../otzi/backend/test-vault.fixture';
import { fromVaultKey } from '../../otzi/lib/dkg';
import { DaemonClientError, type VaultInfo } from '../daemon-client';
import { vault } from './vault';

const file = vaultPubkeyFromPackage(fromVaultKey(makeTestVault(2, 3).vault), 'testnet4');
/** A different vault, for a daemon that holds another share than the file describes. */
const other = vaultPubkeyFromPackage(fromVaultKey(makeTestVault(3, 4).vault), 'mainnet');

/** What the daemon's `vault-info` says about the vault the file describes. */
function infoOf(f: VaultPubkeyFile): VaultInfo {
  return {
    partyIds: Array.from({ length: f.parties }, (_, i) => i),
    threshold: f.threshold,
    parties: f.parties,
    network: f.network,
    address: f.address,
    internalKey: f.internalKey,
    outputKey: f.outputKey,
  };
}

/** A fake daemon client: answers `vaultInfo()` with the reply, or throws it. */
function fakeClient(reply: unknown) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async vaultInfo(): Promise<VaultInfo> {
      calls += 1;
      if (reply instanceof Error) throw reply;
      return reply as VaultInfo;
    },
  };
}

function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('vault command', () => {
  let tmp: string;
  let vaultPath: string;
  let configPath: string;
  let notes: string[];
  const warn = (text: string) => void notes.push(text);

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-vault-test-'));
    vaultPath = join(tmp, 'vault-pubkey.json');
    configPath = join(tmp, 'daemon.toml');
    notes = [];
    await writeVaultPubkeyFile(file, vaultPath);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe('daemon reachable, vault loaded', () => {
    it('prints network, address and threshold when the file matches', async () => {
      const client = fakeClient(infoOf(file));
      const out = await vault({ configPath, vaultPath }, { client, warn });
      expect(out.split('\n')).toEqual([
        'network:   testnet4',
        `address:   ${file.address}`,
        'threshold: 2-of-3',
      ]);
      expect(client.calls).toBe(1);
      expect(notes).toEqual([]);
    });

    it('prints the whole file as pretty JSON with --json', async () => {
      const out = await vault({ configPath, vaultPath, json: true }, { client: fakeClient(infoOf(file)), warn });
      expect(JSON.parse(out)).toEqual(file);
      expect(out).toBe(JSON.stringify(JSON.parse(await readFile(vaultPath, 'utf8')), null, 2));
      expect(JSON.parse(out).vaultKey.minSigners).toBe(2);
      // The daemon does not send the per-party verifying shares, so the file's are printed unchecked: said on stderr.
      expect(notes).toEqual([`the per-party values of vaultKey.verifyingShares come from ${vaultPath} and are not checked against the daemon`]);
    });

    it('says nothing about the verifying shares in text mode', async () => {
      await vault({ configPath, vaultPath }, { client: fakeClient(infoOf(file)), warn });
      expect(notes).toEqual([]);
    });

    it('prints the JSON keys in the order of the file', async () => {
      // partyIds is the daemon's only extra field; it is not part of the file.
      const info = { ...infoOf(file), partyIds: [7, 8, 9] };
      const out = JSON.parse(await vault({ configPath, vaultPath, json: true }, { client: fakeClient(info), warn }));
      expect(Object.keys(out)).toEqual(['network', 'address', 'internalKey', 'outputKey', 'threshold', 'parties', 'vaultKey']);
    });

    // One case per compared field: the daemon holds a different value than the file.
    const fieldCases: [string, Partial<VaultInfo>, RegExp][] = [
      ['network', { network: 'mainnet' }, /network: file testnet4, daemon mainnet/],
      ['address', { address: other.address }, new RegExp(`address: file ${file.address}, daemon ${other.address}`)],
      ['internalKey', { internalKey: other.internalKey }, /internalKey: file 0[23][0-9a-f]+, daemon 0[23][0-9a-f]+/],
      ['outputKey', { outputKey: other.outputKey }, /outputKey: file [0-9a-f]{64}, daemon [0-9a-f]{64}/],
      ['threshold', { threshold: 3 }, /threshold: file 2, daemon 3/],
      ['parties', { parties: 4 }, /parties: file 3, daemon 4/],
    ];
    it.each(fieldCases)('refuses when %s differs, naming the field and the file', async (field, change, line) => {
      const client = fakeClient({ ...infoOf(file), ...change });
      const err = await vault({ configPath, vaultPath }, { client, warn }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(line);
      expect(err!.message).toContain(vaultPath);
      expect(err!.message).toMatch(/does not match the daemon's loaded share/);
      expect(err!.message).toMatch(/restart/i);
      // Only the changed field is named.
      const named = ['network', 'address', 'internalKey', 'outputKey', 'threshold', 'parties'].filter((f) =>
        new RegExp(`^  ${f}: file `, 'm').test(err!.message),
      );
      expect(named).toEqual([field]);
    });

    it('names every differing field, and prints nothing to stdout in --json mode either', async () => {
      const client = fakeClient({ ...infoOf(other) });
      await expect(vault({ configPath, vaultPath, json: true }, { client, warn })).rejects.toThrow(
        /network: file testnet4, daemon mainnet[\s\S]*address: file [\s\S]*internalKey: file [\s\S]*outputKey: file [\s\S]*threshold: file 2, daemon 3[\s\S]*parties: file 3, daemon 4/,
      );
    });

    it("refuses a file whose vaultKey disagrees with the daemon's keys, threshold or party count", async () => {
      const tampered: VaultPubkeyFile = {
        ...file,
        vaultKey: { ...file.vaultKey, untweakedVerifyingKey: other.internalKey, minSigners: 5, verifyingShares: {} },
      };
      await writeVaultPubkeyFile(tampered, vaultPath);
      const err = await vault({ configPath, vaultPath }, { client: fakeClient(infoOf(file)), warn }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err!.message).toMatch(/vaultKey\.untweakedVerifyingKey: file /);
      expect(err!.message).toMatch(/vaultKey\.minSigners: file 5, daemon 2/);
      expect(err!.message).toMatch(/vaultKey\.verifyingShares: file 0 entries, daemon 3/);
    });

    it('shows file text without control characters', async () => {
      await writeVaultPubkeyFile({ ...file, address: `tb1p\u001b[2Jevil\nsecond line` }, vaultPath);
      const err = await vault({ configPath, vaultPath }, { client: fakeClient(infoOf(file)), warn }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err!.message).toContain('tb1p[2Jevil second line');
      expect(err!.message).not.toMatch(/\u001b/);
    });

    it('prints the daemon values when the file is missing', async () => {
      await rm(vaultPath);
      const out = await vault({ configPath, vaultPath }, { client: fakeClient(infoOf(file)), warn });
      expect(out.split('\n')).toEqual(['network:   testnet4', `address:   ${file.address}`, 'threshold: 2-of-3']);
      expect(notes).toEqual([]);
    });

    it('--json without the file prints the daemon values and says the vaultKey is missing', async () => {
      await rm(vaultPath);
      const out = await vault({ configPath, vaultPath, json: true }, { client: fakeClient(infoOf(file)), warn });
      const { vaultKey: _vaultKey, ...withoutKey } = file;
      expect(JSON.parse(out)).toEqual(withoutKey);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/vaultKey/);
      expect(notes[0]).toContain(vaultPath);
    });

    it('refuses an unreadable file as one that does not match', async () => {
      await writeFile(vaultPath, JSON.stringify({ network: 'testnet4' }));
      const err = await vault({ configPath, vaultPath }, { client: fakeClient(infoOf(file)), warn }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err!.message).toMatch(/does not match the daemon's loaded share/);
      expect(err!.message).toMatch(/vault metadata .* 'address' must be a non-empty string/);
    });

    it('refuses a reply that is not a vault-info', async () => {
      const client = fakeClient({ address: file.address });
      await expect(vault({ configPath, vaultPath }, { client, warn })).rejects.toThrow(/daemon reply to 'vault-info'/);
    });
  });

  describe('daemon reachable, no vault loaded (409)', () => {
    const noVault = () => new DaemonClientError(409, 'no vault loaded — run otzi generate, then restart the daemon');
    const NOT_LOADED = 'the daemon has not loaded a vault — restart it to load the share; values not verified';

    it('points at otzi generate when there is no file either', async () => {
      await rm(vaultPath);
      await expect(vault({ configPath, vaultPath }, { client: fakeClient(noVault()), warn })).rejects.toThrow(
        /otzi generate/,
      );
      expect(notes).toEqual([]);
    });

    // A committed-but-not-restarted node (partly failed DKG): its file is the only place the vault shows.
    it('prints the file values with a warning on stderr when the file exists', async () => {
      const out = await vault({ configPath, vaultPath }, { client: fakeClient(noVault()), warn });
      expect(out.split('\n')).toEqual(['network:   testnet4', `address:   ${file.address}`, 'threshold: 2-of-3']);
      expect(notes).toEqual([NOT_LOADED]);
    });

    it('prints the file as pretty JSON with --json', async () => {
      const out = await vault({ configPath, vaultPath, json: true }, { client: fakeClient(noVault()), warn });
      expect(out).toBe(JSON.stringify(JSON.parse(await readFile(vaultPath, 'utf8')), null, 2));
      expect(JSON.parse(out)).toEqual(file);
      expect(notes).toEqual([NOT_LOADED]);
    });

    it('keeps the warning out of the returned (stdout) text', async () => {
      for (const json of [false, true]) {
        const out = await vault({ configPath, vaultPath, json }, { client: fakeClient(noVault()), warn });
        expect(out).not.toMatch(/not loaded|not verified|restart/i);
      }
    });

    it('writes the warning to stderr and nothing but the values to stdout by default', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await vault({ configPath, vaultPath }, { client: fakeClient(noVault()) });
        expect(log).not.toHaveBeenCalled();
        expect(error.mock.calls).toEqual([[NOT_LOADED]]);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    });

    it('still fails when the file is unreadable or invalid', async () => {
      await writeFile(vaultPath, JSON.stringify({ network: 'testnet4' }));
      await expect(vault({ configPath, vaultPath }, { client: fakeClient(noVault()), warn })).rejects.toThrow(
        /vault metadata/,
      );
      await writeFile(vaultPath, 'not json');
      await expect(vault({ configPath, vaultPath }, { client: fakeClient(noVault()), warn })).rejects.toThrow(
        /not valid JSON/,
      );
      expect(notes).toEqual([]);
    });
  });

  describe('other daemon answers', () => {
    it.each([400, 500])('passes a %i refusal through', async (status) => {
      const client = fakeClient(new DaemonClientError(status, 'daemon said no'));
      await expect(vault({ configPath, vaultPath }, { client, warn })).rejects.toMatchObject({
        status,
        message: 'daemon said no',
      });
      expect(notes).toEqual([]);
    });

    it('passes a reply that is not JSON through', async () => {
      const client = fakeClient(new Error('daemon returned invalid JSON'));
      await expect(vault({ configPath, vaultPath }, { client, warn })).rejects.toThrow(/invalid JSON/);
    });
  });

  describe('daemon unreachable', () => {
    it.each([
      ['no socket', systemError('ENOENT', 'connect ENOENT /var/run/otzi/otzi.sock')],
      ['connection refused', systemError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8080')],
      ['socket not readable', systemError('EACCES', 'connect EACCES /var/run/otzi/otzi.sock')],
    ])('prints the file values and a note on stderr: %s', async (_name, error) => {
      const out = await vault({ configPath, vaultPath }, { client: fakeClient(error), warn });
      expect(out.split('\n')).toEqual(['network:   testnet4', `address:   ${file.address}`, 'threshold: 2-of-3']);
      expect(notes).toEqual([`not verified against the daemon (${error.message})`]);
    });

    it.each([
      [401, 'unauthorized'],
      [403, 'forbidden host'],
    ])('a daemon that answers %i cannot be asked: the file values and a note naming the status', async (status, message) => {
      const out = await vault({ configPath, vaultPath }, { client: fakeClient(new DaemonClientError(status, message)), warn });
      expect(out.split('\n')).toEqual(['network:   testnet4', `address:   ${file.address}`, 'threshold: 2-of-3']);
      expect(notes).toEqual([`not verified against the daemon (${status} ${message})`]);
    });

    it('keeps the --json output of the file as it is', async () => {
      const error = systemError('ENOENT', 'connect ENOENT /nonexistent');
      const out = await vault({ configPath, vaultPath, json: true }, { client: fakeClient(error), warn });
      expect(out).toBe(JSON.stringify(JSON.parse(await readFile(vaultPath, 'utf8')), null, 2));
      expect(notes).toHaveLength(1);
    });

    it('still fails when the file is missing, pointing at otzi generate', async () => {
      await rm(vaultPath);
      const error = systemError('ENOENT', 'connect ENOENT /nonexistent');
      await expect(vault({ configPath, vaultPath }, { client: fakeClient(error), warn })).rejects.toThrow(
        /otzi generate/,
      );
    });

    it('still rejects a malformed file', async () => {
      await writeFile(vaultPath, JSON.stringify({ network: 'testnet4' }));
      const error = systemError('ENOENT', 'connect ENOENT /nonexistent');
      await expect(vault({ configPath, vaultPath }, { client: fakeClient(error), warn })).rejects.toThrow(
        /vault metadata/,
      );
    });

    it('treats a config the client cannot be built from as unreachable', async () => {
      // No client injected and no daemon.toml at configPath.
      const out = await vault({ configPath: join(tmp, 'absent.toml'), vaultPath }, { warn });
      expect(out).toContain(file.address);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^not verified against the daemon \(.*absent\.toml.*\)$/);
    });

    it('counts a daemon that does not answer within 10 s as unreachable', async () => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        const silent = {
          vaultInfo: (options?: { signal?: AbortSignal }) => {
            signal = options?.signal;
            return new Promise<VaultInfo>(() => {});
          },
        };
        const pending = vault({ configPath, vaultPath }, { client: silent, warn });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(notes).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        const out = await pending;
        expect(out).toContain(file.address);
        expect(notes).toEqual(['not verified against the daemon (no answer within 10 s)']);
        // The request is cancelled, so the CLI process can exit.
        expect(signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows the reason without control characters', async () => {
      const error = systemError('ECONNREFUSED', 'connect\u001b[31m refused\nagain');
      await vault({ configPath, vaultPath }, { client: fakeClient(error), warn });
      expect(notes).toEqual(['not verified against the daemon (connect[31m refused again)']);
    });
  });

  describe('through the daemon client', () => {
    let socketPath: string;
    let trigger: UdsTrigger | undefined;
    let reply: { status: number; body: unknown };

    beforeEach(async () => {
      socketPath = join(tmp, 'sock');
      reply = { status: 200, body: infoOf(file) };
      await writeFile(
        configPath,
        `
[share]
path = "/tmp/x"
password_env = "X"
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
[[triggers]]
kind = "uds"
path = "${socketPath}"
`,
      );
    });

    afterEach(async () => {
      await trigger?.stop();
      trigger = undefined;
    });

    async function serve(): Promise<void> {
      trigger = new UdsTrigger({
        path: socketPath,
        handler: async (req) => {
          expect(req.body).toEqual({ op: 'vault-info' });
          return reply;
        },
      });
      await trigger.start();
    }

    it('verifies the file against a running daemon', async () => {
      await serve();
      const out = await vault({ configPath, vaultPath }, { warn });
      expect(out).toContain(file.address);
      expect(notes).toEqual([]);
    });

    it('refuses a file that differs from a running daemon', async () => {
      reply = { status: 200, body: { ...infoOf(file), address: other.address } };
      await serve();
      await expect(vault({ configPath, vaultPath }, { warn })).rejects.toThrow(/address: file .*, daemon /);
    });

    it('reports the daemon 409 for a node without a vault', async () => {
      reply = { status: 409, body: { error: 'no vault loaded — run otzi generate, then restart the daemon' } };
      await serve();
      await rm(vaultPath);
      await expect(vault({ configPath, vaultPath }, { warn })).rejects.toThrow(/otzi generate/);
    });

    it('shows the file with a warning when the daemon answers 409 and the file exists', async () => {
      reply = { status: 409, body: { error: 'no vault loaded — run otzi generate, then restart the daemon' } };
      await serve();
      const out = await vault({ configPath, vaultPath }, { warn });
      expect(out).toContain(file.address);
      expect(notes).toEqual(['the daemon has not loaded a vault — restart it to load the share; values not verified']);
    });

    it('falls back to the file when nothing listens on the socket', async () => {
      const out = await vault({ configPath, vaultPath }, { warn });
      expect(out).toContain(file.address);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^not verified against the daemon \(connect ENOENT .*sock\)$/);
    });
  });
});
