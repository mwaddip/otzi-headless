import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from './install';

const validManifest = JSON.stringify({
  version: 1,
  name: 'Test',
  contracts: [
    { name: 'C', address: '0x' + 'aa'.repeat(32), type: 'OP20', decimals: 6 },
  ],
});

describe('install command', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'otzi-install-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('copies a valid manifest to the destination', async () => {
    const src = join(tmp, 'src.json');
    const dst = join(tmp, 'dst.json');
    await writeFile(src, validManifest);
    await install({ source: src, destination: dst });
    expect(JSON.parse(await readFile(dst, 'utf8')).name).toBe('Test');
  });

  it('refuses if destination exists', async () => {
    const src = join(tmp, 'src.json');
    const dst = join(tmp, 'dst.json');
    await writeFile(src, validManifest);
    await writeFile(dst, '{}');
    await expect(install({ source: src, destination: dst })).rejects.toThrow(
      /already installed/,
    );
  });

  it('rejects invalid manifests', async () => {
    const src = join(tmp, 'src.json');
    const dst = join(tmp, 'dst.json');
    await writeFile(src, JSON.stringify({ version: 99 }));
    await expect(install({ source: src, destination: dst })).rejects.toThrow(
      /schema validation failed/,
    );
  });

  it('rejects malformed JSON', async () => {
    const src = join(tmp, 'src.json');
    const dst = join(tmp, 'dst.json');
    await writeFile(src, '{ not json');
    await expect(install({ source: src, destination: dst })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('errors on missing source', async () => {
    await expect(
      install({ source: join(tmp, 'nonexistent.json'), destination: join(tmp, 'dst.json') }),
    ).rejects.toThrow(/no such file/);
  });

  it('does not leave a .tmp file behind on success', async () => {
    const src = join(tmp, 'src.json');
    const dst = join(tmp, 'dst.json');
    await writeFile(src, validManifest);
    await install({ source: src, destination: dst });
    await expect(readFile(`${dst}.tmp`, 'utf8')).rejects.toThrow();
  });
});
