/**
 * The order of `commit`'s file system calls (facts/daemon.md, `vault-share.ts`):
 * the new name is synced to disk before the staging name is removed. Needs
 * spies on `node:fs/promises`, which the rest of the share tests do without.
 */

import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../orchestrator/types';
import { testVault, type TestVault } from '../testing/proposal';
import { createShareStager, pendingPath } from './vault-share';

const calls = vi.hoisted(() => ({ list: [] as string[], dir: '', failDirSync: 0 }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      calls.list.push('link');
      return actual.link(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      calls.list.push('unlink');
      return actual.unlink(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] === calls.dir) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          calls.list.push('sync-dir');
          if (calls.failDirSync > 0 && --calls.failDirSync === 0) throw new Error('EIO: simulated');
          return sync();
        };
      }
      return handle;
    },
  };
});

let vault: TestVault;
beforeAll(() => {
  vault = testVault(3, 3);
});

describe('createShareStager commit order', () => {
  let dir: string;
  let path: string;
  let warnings: string[];
  let logger: Logger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-share-commit-'));
    path = join(dir, 'share.json');
    calls.dir = dir;
    calls.list = [];
    calls.failDirSync = 0;
    warnings = [];
    logger = { debug: () => {}, info: () => {}, error: () => {}, warn: msg => warnings.push(msg) };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function staged() {
    const stager = createShareStager({
      path,
      password: 'pw',
      network: 'testnet4',
      partyId: 0,
      vaultPubkeyPath: join(dir, 'vault-pubkey.json'),
      logger,
    });
    await stager.stage({ keyPackage: vault.keyPackages[0]!, publicKeyPackage: vault.publicKeyPackage });
    calls.list = [];
    return stager;
  }

  it('syncs the directory after the link and again after the unlink', async () => {
    const stager = await staged();
    await stager.commit();
    expect(calls.list).toEqual(['link', 'sync-dir', 'unlink', 'sync-dir']);
    expect(existsSync(pendingPath(path))).toBe(false);
    expect(warnings).toEqual([]);
  }, 30_000);

  it('keeps the staging name when the sync after the link fails, and still commits', async () => {
    const stager = await staged();
    calls.failDirSync = 1;
    await expect(stager.commit()).resolves.toBeUndefined();
    expect(calls.list).toEqual(['link', 'sync-dir']);
    // Both names exist and are one file: nothing was removed before the link was durable.
    expect(statSync(path).ino).toBe(statSync(pendingPath(path)).ino);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('was not synced after the link');
    expect(warnings[0]).toContain(pendingPath(path));
  }, 30_000);
});
