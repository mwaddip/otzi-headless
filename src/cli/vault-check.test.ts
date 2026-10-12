import { afterEach, describe, expect, it, vi } from 'vitest';
import { vaultPubkeyFromPackage } from '../daemon/vault-pubkey';
import { makeTestVault } from '../otzi/backend/test-vault.fixture';
import { fromVaultKey } from '../otzi/lib/dkg';
import { DaemonClientError, type VaultInfo } from './daemon-client';
import { askDaemon, infoFromRequest, vaultMismatch } from './vault-check';

const file = vaultPubkeyFromPackage(fromVaultKey(makeTestVault(2, 3).vault), 'testnet4');
const INFO: VaultInfo = {
  partyIds: [0, 1, 2],
  threshold: file.threshold,
  parties: file.parties,
  network: file.network,
  address: file.address,
  internalKey: file.internalKey,
  outputKey: file.outputKey,
};

const systemError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('askDaemon', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the vault the daemon holds', async () => {
    expect(await askDaemon(() => ({ vaultInfo: async () => INFO }))).toEqual({ kind: 'vault', info: INFO });
  });

  it('returns no-vault for a 409', async () => {
    const client = {
      vaultInfo: async (): Promise<VaultInfo> => {
        throw new DaemonClientError(409, 'no vault loaded');
      },
    };
    expect(await askDaemon(() => client)).toEqual({ kind: 'no-vault' });
  });

  it.each([
    ['no socket', systemError('ENOENT', 'connect ENOENT /run/otzi/otzi.sock')],
    ['refused', systemError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1')],
    ['reset', systemError('ECONNRESET', 'socket hang up')],
  ])('returns unreachable, with the reason, for %s', async (_name, error) => {
    const client = {
      vaultInfo: async (): Promise<VaultInfo> => {
        throw error;
      },
    };
    expect(await askDaemon(() => client)).toEqual({ kind: 'unreachable', reason: error.message });
  });

  it('returns unreachable when the client cannot be built, awaiting an async builder too', async () => {
    expect(
      await askDaemon(() => {
        throw new Error('daemon-client: no uds or http trigger in daemon.toml');
      }),
    ).toEqual({ kind: 'unreachable', reason: 'daemon-client: no uds or http trigger in daemon.toml' });
    expect(
      await askDaemon(async () => {
        throw new Error('cannot read the config');
      }),
    ).toEqual({ kind: 'unreachable', reason: 'cannot read the config' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden host'],
  ])('a %i means the CLI cannot ask: unreachable, the status and message as the reason', async (status, message) => {
    const client = {
      vaultInfo: async (): Promise<VaultInfo> => {
        throw new DaemonClientError(status, message);
      },
    };
    expect(await askDaemon(() => client)).toEqual({ kind: 'unreachable', reason: `${status} ${message}` });
  });

  it('a 401 message is shown without control characters', async () => {
    const client = {
      vaultInfo: async (): Promise<VaultInfo> => {
        throw new DaemonClientError(401, 'un\u001b[31mauthorized\nnext');
      },
    };
    expect(await askDaemon(() => client)).toEqual({ kind: 'unreachable', reason: '401 un[31mauthorized next' });
  });

  it.each([400, 500])('throws what the daemon answered with %i', async (status) => {
    const client = {
      vaultInfo: async (): Promise<VaultInfo> => {
        throw new DaemonClientError(status, 'daemon said no');
      },
    };
    await expect(askDaemon(() => client)).rejects.toMatchObject({ status });
  });

  it('throws a reply that is not JSON, and a reply that is not a vault-info', async () => {
    const bad = {
      vaultInfo: async (): Promise<VaultInfo> => {
        throw new Error('daemon returned invalid JSON');
      },
    };
    await expect(askDaemon(() => bad)).rejects.toThrow('invalid JSON');
    await expect(askDaemon(() => ({ vaultInfo: async () => ({ address: 'x' }) as unknown as VaultInfo }))).rejects.toThrow(
      /daemon reply to 'vault-info'/,
    );
  });

  it('gives up on a daemon that does not answer within 10 s, aborting its request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const silent = {
      vaultInfo: (options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<VaultInfo>(() => {});
      },
    };
    let answer: unknown;
    const pending = askDaemon(() => silent).then(a => (answer = a));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(answer).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(answer).toEqual({ kind: 'unreachable', reason: 'no answer within 10 s' });
    expect(signal?.aborted).toBe(true);
  });

  it('ignores the failure of the request it aborted', async () => {
    vi.useFakeTimers();
    const aborts = {
      vaultInfo: (options?: { signal?: AbortSignal }) =>
        new Promise<VaultInfo>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    };
    const pending = askDaemon(() => aborts);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ kind: 'unreachable', reason: 'no answer within 10 s' });
  });

  it('leaves no timer behind once the daemon has answered', async () => {
    vi.useFakeTimers();
    await askDaemon(() => ({ vaultInfo: async () => INFO }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('infoFromRequest', () => {
  it('asks for vault-info through request, passing the options on', async () => {
    const calls: unknown[][] = [];
    const client = {
      async request<T>(body: unknown, options?: { signal?: AbortSignal }): Promise<T> {
        calls.push([body, options]);
        return INFO as T;
      },
    };
    const options = { signal: new AbortController().signal };
    expect(await infoFromRequest(client).vaultInfo(options)).toEqual(INFO);
    expect(calls).toEqual([[{ op: 'vault-info' }, options]]);
  });
});

describe('vaultMismatch', () => {
  it('is undefined when the file agrees with the daemon', () => {
    expect(vaultMismatch('/p', file, INFO)).toBeUndefined();
  });

  it('names the path and each differing field', () => {
    const err = vaultMismatch('/var/lib/otzi/vault-pubkey.json', file, { ...INFO, threshold: 3, parties: 4 });
    expect(err?.message).toContain('/var/lib/otzi/vault-pubkey.json');
    expect(err?.message).toMatch(/threshold: file 2, daemon 3/);
    expect(err?.message).toMatch(/parties: file 3, daemon 4/);
    expect(err?.message).toMatch(/does not match the daemon's loaded share/);
  });
});
