/**
 * Round-trip parity check.
 *
 * Confirms that a manifest produced by the builder validates against BOTH
 * the builder's local validator AND the daemon-side validator.
 *
 * The vendored schema.json is byte-equal to docs/headless-manifest-schema.json
 * (see build-vendor.sh / README), so these two validators must agree on shape.
 * If they ever diverge, the byte-equality contract is broken — fix the
 * regen pipeline rather than papering over it here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportManifest } from './model.js';
import { validateManifest as builderValidate } from './validation.js';
import { validateManifest as daemonValidate } from '../../src/cli/manifest-validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const builderSchema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'));

function builderState() {
  return {
    version: 1,
    name: 'Round-Trip Project',
    description: 'exercises every contract type the schema admits',
    contracts: [
      { name: 'tok', address: '0x' + 'a'.repeat(64), type: 'OP20', decimals: 8 },
      { name: 'pegged', address: '0x' + 'b'.repeat(64), type: 'OP20S', decimals: 18 },
      { name: 'nft', address: '0x' + 'c'.repeat(64), type: 'OP721' },
      {
        name: 'cm', address: '0x' + 'd'.repeat(64), type: 'Custom',
        abi: [
          { name: 'doThing', params: [{ name: 'x', type: 'uint256' }] },
          { name: 'otherThing', params: [] },
        ],
      },
    ],
  };
}

describe('round-trip parity', () => {
  it('builder export round-trips through the builder validator', () => {
    const exported = exportManifest(builderState());
    const r = builderValidate(exported, builderSchema);
    expect(r.errors).toEqual([]);
  });

  it('builder export validates against the daemon-side validator', () => {
    const exported = exportManifest(builderState());
    const r = daemonValidate(exported);
    expect(r.ok).toBe(true);
  });

  it('a manifest the builder rejects, the daemon also rejects', () => {
    // Missing decimals on OP20 — both validators must flag it.
    const exported = exportManifest({
      ...builderState(),
      contracts: [{ name: 'tok', address: '0x' + 'a'.repeat(64), type: 'OP20' }],
    });
    expect(builderValidate(exported, builderSchema).errors.length).toBeGreaterThan(0);
    expect(daemonValidate(exported).ok).toBe(false);
  });

  it('a manifest the builder accepts, the daemon also accepts (custom contract)', () => {
    const m = {
      version: 1,
      name: 'Custom-only',
      contracts: [
        {
          name: 'cm', address: '0x' + '1'.repeat(64), type: 'Custom',
          abi: [{ name: 'go', params: [] }],
        },
      ],
    };
    expect(builderValidate(m, builderSchema).errors).toEqual([]);
    expect(daemonValidate(m).ok).toBe(true);
  });
});
