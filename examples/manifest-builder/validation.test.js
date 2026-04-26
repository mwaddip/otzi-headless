import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateManifest } from './validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'));

function valid() {
  return {
    version: 1,
    name: 'Test Project',
    description: 'a description',
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

describe('validateManifest — schema (round-trip valid)', () => {
  it('passes on a valid v1 manifest spanning all contract types', () => {
    const r = validateManifest(valid(), schema);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('passes on a minimal v1 manifest', () => {
    const m = {
      version: 1,
      name: 'X',
      contracts: [{ name: 'tok', address: '0x' + '0'.repeat(64), type: 'OP20', decimals: 0 }],
    };
    const r = validateManifest(m, schema);
    expect(r.errors).toEqual([]);
  });
});

describe('validateManifest — schema rejections', () => {
  it('flags wrong version', () => {
    const m = valid();
    m.version = 2;
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path === 'version')).toBe(true);
  });

  it('flags missing top-level name', () => {
    const m = valid();
    delete m.name;
    const r = validateManifest(m, schema);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('flags empty contracts array (minItems: 1)', () => {
    const m = valid();
    m.contracts = [];
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path === 'contracts')).toBe(true);
  });

  it('flags malformed address pattern', () => {
    const m = valid();
    m.contracts[0].address = 'not-an-address';
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.0.address'))).toBe(true);
  });

  it('flags malformed contract name pattern', () => {
    const m = valid();
    m.contracts[0].name = '0starts-with-digit';
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.0.name'))).toBe(true);
  });
});

describe('validateManifest — type-conditional rules', () => {
  it('flags missing decimals on OP20', () => {
    const m = valid();
    delete m.contracts[0].decimals;
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.0'))).toBe(true);
  });

  it('flags missing decimals on OP20S', () => {
    const m = valid();
    delete m.contracts[1].decimals;
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.1'))).toBe(true);
  });

  it('flags abi present on OP20', () => {
    const m = valid();
    m.contracts[0].abi = [{ name: 'transfer', params: [] }];
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.0'))).toBe(true);
  });

  it('flags abi present on OP721', () => {
    const m = valid();
    m.contracts[2].abi = [{ name: 'transferFrom', params: [] }];
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.2'))).toBe(true);
  });

  it('flags missing abi on Custom', () => {
    const m = valid();
    delete m.contracts[3].abi;
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.startsWith('contracts.3'))).toBe(true);
  });

  it('flags decimals out of range', () => {
    const m = valid();
    m.contracts[0].decimals = 99;
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => e.path.includes('decimals'))).toBe(true);
  });
});

describe('validateManifest — cross-field rules', () => {
  it('flags duplicate contract names', () => {
    const m = valid();
    m.contracts.push({
      name: 'tok', address: '0x' + 'e'.repeat(64), type: 'OP20', decimals: 8,
    });
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => /duplicate contract name/i.test(e.message))).toBe(true);
  });

  it('flags duplicate method names within a Custom contract abi', () => {
    const m = valid();
    m.contracts[3].abi.push({
      name: 'doThing', params: [{ name: 'y', type: 'address' }],
    });
    const r = validateManifest(m, schema);
    expect(r.errors.some((e) => /duplicate method name.*doThing/i.test(e.message))).toBe(true);
  });

  it('does NOT flag duplicate method names across different contracts', () => {
    const m = valid();
    m.contracts.push({
      name: 'cm2', address: '0x' + 'e'.repeat(64), type: 'Custom',
      abi: [{ name: 'doThing', params: [] }],
    });
    const r = validateManifest(m, schema);
    expect(r.errors.filter((e) => /duplicate method name/.test(e.message))).toEqual([]);
  });
});

describe('validateManifest — error path keying', () => {
  it('returns errors with path + message keys', () => {
    const m = valid();
    delete m.contracts[0].decimals;
    const r = validateManifest(m, schema);
    expect(r.errors[0]).toHaveProperty('path');
    expect(r.errors[0]).toHaveProperty('message');
  });

  it('uses dot-notation paths for nested fields', () => {
    const m = valid();
    m.contracts[0].address = 'bad';
    const r = validateManifest(m, schema);
    const addressErr = r.errors.find((e) => e.path.includes('contracts'));
    expect(addressErr.path).toMatch(/^contracts\.\d/);
  });
});
