import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateManifest } from './validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, 'schema.json'), 'utf8'));

function valid() {
  return {
    version: 2,
    name: 'Test Vault',
    contracts: {
      tok: { label: 'Token', abi: 'OP_20', address: '0xabc' },
    },
    operations: [{
      id: 'op1', label: 'Transfer', contract: 'tok', method: 'transfer',
      params: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    }],
  };
}

describe('validateManifest — schema', () => {
  it('passes on a valid v2 manifest', () => {
    const r = validateManifest(valid(), 'headless', schema);
    expect(r.errors).toEqual([]);
  });

  it('flags missing Contract.address', () => {
    const m = valid();
    delete m.contracts.tok.address;
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors.some((e) => e.path.includes('contracts.tok'))).toBe(true);
  });

  it('flags wrong version', () => {
    const m = valid();
    m.version = 1;
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors.some((e) => e.path.includes('version'))).toBe(true);
  });
});

describe('validateManifest — cross-field rules', () => {
  it('flags Operation.contract referencing an undefined key', () => {
    const m = valid();
    m.operations[0].contract = 'missing';
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors.some((e) => /undefined contract key/i.test(e.message))).toBe(true);
  });

  it('allows Operation.contract === "$dynamic"', () => {
    const m = valid();
    m.operations[0].contract = '$dynamic';
    m.operations[0].params.unshift({ name: '$contract', type: 'address' });
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors).toEqual([]);
  });

  it('flags Operation.method missing from resolved ABI', () => {
    const m = valid();
    m.operations[0].method = 'doesNotExist';
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors.some((e) => /not found in ABI/i.test(e.message))).toBe(true);
  });

  it('flags duplicate Operation.id', () => {
    const m = valid();
    m.operations.push({ ...m.operations[0] });
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors.some((e) => /duplicate.*id/i.test(e.message))).toBe(true);
  });

  it('flags Param.source: contract:<key> referencing undefined key', () => {
    const m = valid();
    m.operations[0].params[0].source = 'contract:missing';
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors.some((e) => /undefined contract key/i.test(e.message))).toBe(true);
  });

  it('warns (does not error) on Param.source: setting:<key>', () => {
    const m = valid();
    m.operations[0].params[0].source = 'setting:apiKey';
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('validateManifest — error path keying', () => {
  it('returns errors keyed by JSON path', () => {
    const m = valid();
    delete m.contracts.tok.address;
    const r = validateManifest(m, 'headless', schema);
    expect(r.errors[0]).toHaveProperty('path');
    expect(r.errors[0]).toHaveProperty('message');
    expect(r.errors[0].path).toMatch(/contracts/);
  });
});
