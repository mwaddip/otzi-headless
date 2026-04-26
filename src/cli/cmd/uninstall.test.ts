import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uninstall } from './uninstall';

describe('uninstall command', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-uninstall-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('removes an existing manifest', async () => {
    const path = join(tmp, 'manifest.json');
    await writeFile(path, '{}');
    const r = await uninstall({ manifestPath: path });
    expect(r.removed).toBe(true);
  });

  it('returns removed=false for missing manifest', async () => {
    const r = await uninstall({ manifestPath: join(tmp, 'absent.json') });
    expect(r.removed).toBe(false);
  });
});
