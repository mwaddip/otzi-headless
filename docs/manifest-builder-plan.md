# Manifest builder implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a static-file in-browser manifest builder under `examples/manifest-builder/` that produces v2 `.otzi.json` files with live schema validation, plus the v2 schema bump to the canonical schema document.

**Architecture:** HTML entry point with co-located ES modules. Dependencies (preact, signals, htm, ajv) ship as committed esbuild bundles under `vendor/` — no runtime CDN, fully offline. Pure logic split into testable modules (`model.js`, `validation.js`, `slugify.js`); UI composes them in `app.js`. Browser-native I/O (`<input type="file">` for load, `Blob` + `a.download` for export). Vendored `schema.json` is a byte-equal mirror of `docs/otzi-manifest-schema.json`. App code uses bare specifiers; an import map in `index.html` resolves them to `./vendor/*.js`.

**Tech Stack:** Preact 10 + `@preact/signals` 1 + htm 3 + ajv 8 (vendored via esbuild from local `node_modules`), JSON Schema draft 2020-12, vitest 2.1 + esbuild 0.28 (already in repo). Plain JS — no TS compilation for the example dir.

**Spec:** [`docs/manifest-builder-spec.md`](manifest-builder-spec.md)

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/otzi-manifest-schema.json` | Modify | Bump to v2: `version: 2`, `Contract.address` required, update `$id`. |
| `examples/manifest-builder/schema.json` | Create | Byte-equal mirror of the v2 canonical schema. |
| `examples/manifest-builder/slugify.js` | Create | Pure helper: project name → filename slug. |
| `examples/manifest-builder/slugify.test.js` | Create | vitest suite for `slugify`. |
| `examples/manifest-builder/validation.js` | Create | `validateManifest(state, mode)` → `{errors, warnings}` keyed by JSON path. Uses ajv + cross-field rules. |
| `examples/manifest-builder/validation.test.js` | Create | vitest suite for schema + cross-field rules. |
| `examples/manifest-builder/model.js` | Create | Initial state shape, mutations, key-rename propagation, export-shape stripping. |
| `examples/manifest-builder/model.test.js` | Create | vitest suite for state mutations + propagation + export shape. |
| `examples/manifest-builder/build-vendor.sh` | Create | One-shot esbuild driver: bundles preact/signals/htm/ajv from `node_modules` into `vendor/*.js`. |
| `examples/manifest-builder/vendor/preact.js` | Create | esbuild bundle of preact@10 (committed). |
| `examples/manifest-builder/vendor/signals.js` | Create | esbuild bundle of @preact/signals@1 with preact externalized (committed). |
| `examples/manifest-builder/vendor/htm.js` | Create | esbuild bundle of htm@3 (committed). |
| `examples/manifest-builder/vendor/ajv.js` | Create | esbuild bundle of ajv@8 (committed). |
| `examples/manifest-builder/app.js` | Create | Preact UI components (sidebar, mode radio, section editors, load/export). |
| `examples/manifest-builder/index.html` | Create | Entry point: import map → vendor/ + load `app.js`, mounts root. |
| `examples/manifest-builder/README.md` | Create | What it is, how to use, schema-v2 changes, how to rebuild vendor bundles. |

---

## Task 1: Bump canonical schema to v2

**Files:**
- Modify: `docs/otzi-manifest-schema.json` (multiple lines — see steps)

- [ ] **Step 1: Read the current schema**

Run: read `docs/otzi-manifest-schema.json` end-to-end to confirm the current shape.
Expected: `version` is `{"const": 1, ...}`, `$id` ends in `v1.schema.json`, `Contract` requires `["label", "abi"]`, comment under `contracts` says "Addresses are configured separately in Ötzi settings — NOT stored in the manifest."

- [ ] **Step 2: Update `$id` to v2**

Change the `$id` field at the top of the document from `https://github.com/mwaddip/otzi/otzi-manifest-v1.schema.json` to `https://github.com/mwaddip/otzi/otzi-manifest-v2.schema.json`.

- [ ] **Step 3: Bump `version` constant**

Replace:
```json
"version": {
  "const": 1,
  "description": "Schema version. Must be 1."
},
```
With:
```json
"version": {
  "const": 2,
  "description": "Schema version. Must be 2."
},
```

- [ ] **Step 4: Add `address` to `Contract` (required)**

In `$defs.Contract`, change:
```json
"Contract": {
  "type": "object",
  "required": ["label", "abi"],
  "additionalProperties": false,
  "properties": {
    "label": { ... },
    "abi": { ... }
  }
}
```
To:
```json
"Contract": {
  "type": "object",
  "required": ["label", "abi", "address"],
  "additionalProperties": false,
  "properties": {
    "label": { ... },
    "abi": { ... },
    "address": {
      "type": "string",
      "minLength": 1,
      "description": "On-chain contract address. Manifests are network-agnostic — publish a separate manifest per deployment."
    }
  }
}
```
(Preserve the existing `label` and `abi` definitions verbatim.)

- [ ] **Step 5: Update top-level `contracts` description**

In the top-level `properties.contracts.description`, replace:
> `"Contract definitions keyed by logical name. Addresses are configured separately in Ötzi settings — NOT stored in the manifest."`

With:
> `"Contract definitions keyed by logical name. Each contract carries its address inline."`

- [ ] **Step 6: Update `Param.source` description**

In `$defs.Param.properties.source`, replace the description:
> `"Auto-fill source. 'contract:<key>' = address from settings. 'setting:<key>' = custom setting value. 'read:<key>' = value from reads. When set, the field is pre-filled and disabled."`

With:
> `"Auto-fill source. 'contract:<key>' = address from contracts[key].address. 'setting:<key>' = custom setting value. 'read:<key>' = value from reads. When set, the field is pre-filled and disabled."`

- [ ] **Step 7: Update `Read.params.source` description (mirror)**

In `$defs.Read.properties.params.items.properties.source`, replace:
> `"Auto-fill source. 'contract:<key>' = address from settings. 'setting:<key>' = custom setting value."`

With:
> `"Auto-fill source. 'contract:<key>' = address from contracts[key].address. 'setting:<key>' = custom setting value."`

- [ ] **Step 8: Verify the file is valid JSON**

Run: `node --eval "JSON.parse(require('fs').readFileSync('docs/otzi-manifest-schema.json','utf8'))"`
Expected: no output (silent success).

- [ ] **Step 9: Commit**

```bash
git add docs/otzi-manifest-schema.json
git commit -m "feat(schema): bump otzi-manifest schema to v2

- version: 1 → 2
- Contract.address now required (flat string, no network keying)
- \$id updated to v2.schema.json
- Param.source 'contract:<key>' now resolves from manifest, not settings"
```

---

## Task 2: Vendor v2 schema into the example directory

**Files:**
- Create: `examples/manifest-builder/schema.json`

- [ ] **Step 1: Create the example directory**

Run: `mkdir -p examples/manifest-builder`
Expected: directory exists.

- [ ] **Step 2: Copy the canonical schema verbatim**

Run: `cp docs/otzi-manifest-schema.json examples/manifest-builder/schema.json`
Expected: byte-equal copy.

- [ ] **Step 3: Verify byte-equality**

Run: `diff docs/otzi-manifest-schema.json examples/manifest-builder/schema.json && echo OK`
Expected: `OK` (no diff output).

- [ ] **Step 4: Commit**

```bash
git add examples/manifest-builder/schema.json
git commit -m "feat(manifest-builder): vendor v2 schema mirror

Frozen byte-equal mirror of docs/otzi-manifest-schema.json so the
builder loads it under file:// without cross-directory fetches."
```

---

## Task 3: Implement and test slugify.js

**Files:**
- Create: `examples/manifest-builder/slugify.js`
- Test: `examples/manifest-builder/slugify.test.js`

- [ ] **Step 1: Write the failing test**

Create `examples/manifest-builder/slugify.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { slugify } from './slugify.js';

describe('slugify', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugify('My Vault')).toBe('my-vault');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugify('PERMAFROST Vault!@#')).toBe('permafrost-vault');
  });

  it('collapses runs of separators', () => {
    expect(slugify('foo   bar___baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  --foo--  ')).toBe('foo');
  });

  it('returns the fallback for empty input', () => {
    expect(slugify('')).toBe('manifest');
    expect(slugify('   ')).toBe('manifest');
    expect(slugify('!!!')).toBe('manifest');
  });

  it('handles unicode by stripping non-ascii', () => {
    expect(slugify('Ötzi Vault')).toBe('tzi-vault');
  });

  it('truncates very long names to 64 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBe(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run examples/manifest-builder/slugify.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement slugify.js**

Create `examples/manifest-builder/slugify.js`:

```javascript
const FALLBACK = 'manifest';
const MAX_LEN = 64;

export function slugify(input) {
  if (typeof input !== 'string') return FALLBACK;
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0) return FALLBACK;
  return normalized.slice(0, MAX_LEN);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run examples/manifest-builder/slugify.test.js`
Expected: PASS — 7 passed.

- [ ] **Step 5: Commit**

```bash
git add examples/manifest-builder/slugify.js examples/manifest-builder/slugify.test.js
git commit -m "feat(manifest-builder): add slugify helper for filename derivation"
```

---

## Task 4: Implement and test model.js (state shape + mutations)

**Files:**
- Create: `examples/manifest-builder/model.js`
- Test: `examples/manifest-builder/model.test.js`

- [ ] **Step 1: Write the failing test**

Create `examples/manifest-builder/model.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  emptyManifest,
  renameContractKey,
  exportManifest,
  resolveAbiMethods,
} from './model.js';

describe('emptyManifest', () => {
  it('returns a valid v2 skeleton', () => {
    const m = emptyManifest();
    expect(m.version).toBe(2);
    expect(m.name).toBe('');
    expect(m.contracts).toEqual({});
    expect(m.operations).toEqual([]);
  });
});

describe('renameContractKey', () => {
  it('updates contracts object key', () => {
    const m = {
      version: 2, name: 'x', contracts: { old: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [],
    };
    const next = renameContractKey(m, 'old', 'new');
    expect(next.contracts.new).toBeDefined();
    expect(next.contracts.old).toBeUndefined();
  });

  it('updates Operation.contract references', () => {
    const m = {
      version: 2, name: 'x', contracts: { tok: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [{ id: 'op1', label: 'Op', contract: 'tok', method: 'transfer', params: [] }],
    };
    const next = renameContractKey(m, 'tok', 'token');
    expect(next.operations[0].contract).toBe('token');
  });

  it('updates Param.source contract references', () => {
    const m = {
      version: 2, name: 'x', contracts: { tok: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [{
        id: 'op1', label: 'Op', contract: 'tok', method: 'transfer',
        params: [{ name: 'to', type: 'address', source: 'contract:tok' }],
      }],
    };
    const next = renameContractKey(m, 'tok', 'token');
    expect(next.operations[0].params[0].source).toBe('contract:token');
  });

  it('updates dynamic dropdown references in Param.options', () => {
    const m = {
      version: 2, name: 'x',
      contracts: { src: { label: 'L', abi: 'OP_20', address: 'a' } },
      operations: [{
        id: 'op1', label: 'Op', contract: 'src', method: 'm',
        params: [{
          name: 'idx', type: 'uint256',
          options: { count: { contract: 'src', method: 'count' }, item: { contract: 'src', method: 'at' } },
        }],
      }],
    };
    const next = renameContractKey(m, 'src', 'list');
    expect(next.operations[0].params[0].options.count.contract).toBe('list');
    expect(next.operations[0].params[0].options.item.contract).toBe('list');
  });

  it('returns the input unchanged when source key does not exist', () => {
    const m = { version: 2, name: 'x', contracts: {}, operations: [] };
    expect(renameContractKey(m, 'nope', 'new')).toEqual(m);
  });

  it('refuses to rename onto an existing key', () => {
    const m = {
      version: 2, name: 'x',
      contracts: { a: { label: 'A', abi: 'OP_20', address: '0x1' }, b: { label: 'B', abi: 'OP_20', address: '0x2' } },
      operations: [],
    };
    expect(() => renameContractKey(m, 'a', 'b')).toThrow(/already exists/);
  });
});

describe('exportManifest', () => {
  it('strips empty optional fields', () => {
    const m = {
      version: 2, name: 'x', description: '', icon: '',
      contracts: {}, operations: [], reads: {}, status: [],
    };
    const out = exportManifest(m, 'headless');
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('icon');
    expect(out).not.toHaveProperty('reads');
    expect(out).not.toHaveProperty('status');
  });

  it('preserves populated optional fields', () => {
    const m = {
      version: 2, name: 'x', description: 'desc',
      contracts: {}, operations: [],
    };
    const out = exportManifest(m, 'headless');
    expect(out.description).toBe('desc');
  });

  it('omits Operation.condition and ownerOnly in headless mode', () => {
    const m = {
      version: 2, name: 'x',
      contracts: {},
      operations: [{
        id: 'op1', label: 'Op', contract: 'c', method: 'm', params: [],
        condition: { read: 'x', eq: 1 }, ownerOnly: true,
      }],
    };
    const out = exportManifest(m, 'headless');
    expect(out.operations[0]).not.toHaveProperty('condition');
    expect(out.operations[0]).not.toHaveProperty('ownerOnly');
  });

  it('preserves Operation.condition and ownerOnly in full mode', () => {
    const m = {
      version: 2, name: 'x',
      contracts: {},
      operations: [{
        id: 'op1', label: 'Op', contract: 'c', method: 'm', params: [],
        condition: { read: 'x', eq: 1 }, ownerOnly: true,
      }],
    };
    const out = exportManifest(m, 'full');
    expect(out.operations[0].condition).toEqual({ read: 'x', eq: 1 });
    expect(out.operations[0].ownerOnly).toBe(true);
  });

  it('omits Param.source: read: in headless mode', () => {
    const m = {
      version: 2, name: 'x', contracts: {},
      operations: [{
        id: 'op1', label: 'Op', contract: 'c', method: 'm',
        params: [{ name: 'p', type: 'uint256', source: 'read:foo' }],
      }],
    };
    const out = exportManifest(m, 'headless');
    expect(out.operations[0].params[0]).not.toHaveProperty('source');
  });
});

describe('resolveAbiMethods', () => {
  it('returns OP_20 standard method names for shorthand', () => {
    const methods = resolveAbiMethods('OP_20');
    expect(methods).toContain('transfer');
    expect(methods).toContain('balanceOf');
    expect(methods).toContain('approve');
  });

  it('extracts names from a custom AbiEntry array', () => {
    const abi = [
      { name: 'foo', type: 'Function', inputs: [], outputs: [] },
      { name: 'Bar', type: 'Event', inputs: [] },
    ];
    expect(resolveAbiMethods(abi)).toEqual(['foo']);
  });

  it('handles a mixed array', () => {
    const abi = [
      'OP_20',
      { name: 'customMethod', type: 'Function', inputs: [], outputs: [] },
    ];
    const methods = resolveAbiMethods(abi);
    expect(methods).toContain('transfer');
    expect(methods).toContain('customMethod');
  });

  it('returns empty array for unknown shorthand', () => {
    expect(resolveAbiMethods('UNKNOWN')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run examples/manifest-builder/model.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement model.js**

Create `examples/manifest-builder/model.js`:

```javascript
const SHORTHAND_METHODS = {
  OP_20: ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'transfer', 'transferFrom', 'approve'],
  OP_20S: ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance', 'transfer', 'transferFrom', 'approve', 'pegRate', 'setPegRate'],
  OP_721: ['name', 'symbol', 'totalSupply', 'balanceOf', 'ownerOf', 'tokenURI', 'transferFrom', 'approve', 'setApprovalForAll'],
};

export function emptyManifest() {
  return {
    version: 2,
    name: '',
    description: '',
    icon: '',
    contracts: {},
    operations: [],
  };
}

export function renameContractKey(manifest, oldKey, newKey) {
  if (oldKey === newKey) return manifest;
  if (!(oldKey in manifest.contracts)) return manifest;
  if (newKey in manifest.contracts) {
    throw new Error(`Contract key '${newKey}' already exists`);
  }
  const nextContracts = {};
  for (const [k, v] of Object.entries(manifest.contracts)) {
    nextContracts[k === oldKey ? newKey : k] = v;
  }
  const nextOps = manifest.operations.map((op) => {
    const next = { ...op };
    if (op.contract === oldKey) next.contract = newKey;
    if (Array.isArray(op.params)) {
      next.params = op.params.map((p) => {
        const np = { ...p };
        if (p.source === `contract:${oldKey}`) np.source = `contract:${newKey}`;
        if (p.options) {
          np.options = {
            count: { ...p.options.count },
            item: { ...p.options.item },
          };
          if (np.options.count.contract === oldKey) np.options.count.contract = newKey;
          if (np.options.item.contract === oldKey) np.options.item.contract = newKey;
        }
        return np;
      });
    }
    return next;
  });
  return { ...manifest, contracts: nextContracts, operations: nextOps };
}

function stripOperation(op, mode) {
  const out = {
    id: op.id, label: op.label, contract: op.contract, method: op.method,
    params: (op.params ?? []).map((p) => stripParam(p, mode)),
  };
  if (op.description) out.description = op.description;
  if (op.confirm) out.confirm = op.confirm;
  if (mode === 'full') {
    if (op.condition !== undefined) out.condition = op.condition;
    if (op.ownerOnly) out.ownerOnly = op.ownerOnly;
  }
  return out;
}

function stripParam(p, mode) {
  const out = { name: p.name, type: p.type };
  if (p.label) out.label = p.label;
  if (typeof p.scale === 'number') out.scale = p.scale;
  if (p.placeholder) out.placeholder = p.placeholder;
  if (p.source) {
    if (mode === 'headless' && p.source.startsWith('read:')) {
      // omit
    } else {
      out.source = p.source;
    }
  }
  if (p.options) out.options = p.options;
  return out;
}

export function exportManifest(manifest, mode) {
  const out = {
    version: manifest.version,
    name: manifest.name,
    contracts: {},
    operations: (manifest.operations ?? []).map((op) => stripOperation(op, mode)),
  };
  if (manifest.description) out.description = manifest.description;
  if (manifest.icon) out.icon = manifest.icon;
  for (const [k, v] of Object.entries(manifest.contracts ?? {})) {
    out.contracts[k] = { label: v.label, abi: v.abi, address: v.address };
  }
  if (mode === 'full') {
    if (manifest.theme) out.theme = manifest.theme;
    if (manifest.reads && Object.keys(manifest.reads).length > 0) out.reads = manifest.reads;
    if (Array.isArray(manifest.status) && manifest.status.length > 0) out.status = manifest.status;
  }
  return out;
}

export function resolveAbiMethods(abi) {
  if (typeof abi === 'string') return SHORTHAND_METHODS[abi] ?? [];
  if (!Array.isArray(abi)) return [];
  const methods = [];
  for (const entry of abi) {
    if (typeof entry === 'string') {
      methods.push(...(SHORTHAND_METHODS[entry] ?? []));
    } else if (entry && entry.type === 'Function' && typeof entry.name === 'string') {
      methods.push(entry.name);
    }
  }
  return methods;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run examples/manifest-builder/model.test.js`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add examples/manifest-builder/model.js examples/manifest-builder/model.test.js
git commit -m "feat(manifest-builder): add model state + key-rename propagation + export shaping"
```

---

## Task 5: Implement and test validation.js

**Files:**
- Create: `examples/manifest-builder/validation.js`
- Test: `examples/manifest-builder/validation.test.js`

- [ ] **Step 1: Write the failing test**

Create `examples/manifest-builder/validation.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run examples/manifest-builder/validation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Add ajv as a dev dependency**

Run: `npm install --save-dev ajv`
Expected: ajv ~8.x installed.

- [ ] **Step 4: Implement validation.js**

Create `examples/manifest-builder/validation.js`:

```javascript
import Ajv from 'ajv';
import { resolveAbiMethods } from './model.js';

let cachedSchema = null;
let cachedValidator = null;

function getValidator(schema) {
  if (cachedSchema !== schema) {
    cachedSchema = schema;
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

function pathFromInstancePath(instancePath) {
  if (!instancePath) return '';
  return instancePath.replace(/^\//, '').replace(/\//g, '.');
}

function schemaErrors(manifest, schema) {
  const validator = getValidator(schema);
  const ok = validator(manifest);
  if (ok) return [];
  return (validator.errors ?? []).map((e) => ({
    path: pathFromInstancePath(e.instancePath),
    message: e.message ?? 'invalid',
  }));
}

function crossFieldErrors(manifest) {
  const errors = [];
  const warnings = [];
  const contracts = manifest.contracts ?? {};
  const operations = manifest.operations ?? [];

  const idCounts = new Map();
  for (const op of operations) {
    if (op?.id) idCounts.set(op.id, (idCounts.get(op.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push({ path: `operations`, message: `duplicate operation id '${id}'` });
  }

  operations.forEach((op, i) => {
    if (!op || typeof op !== 'object') return;
    if (op.contract && op.contract !== '$dynamic' && !(op.contract in contracts)) {
      errors.push({
        path: `operations.${i}.contract`,
        message: `undefined contract key '${op.contract}'`,
      });
    }
    if (op.contract && op.contract !== '$dynamic' && op.method && contracts[op.contract]) {
      const methods = resolveAbiMethods(contracts[op.contract].abi);
      if (methods.length > 0 && !methods.includes(op.method)) {
        errors.push({
          path: `operations.${i}.method`,
          message: `method '${op.method}' not found in ABI for contract '${op.contract}'`,
        });
      }
    }
    (op.params ?? []).forEach((p, j) => {
      if (typeof p?.source !== 'string') return;
      const m = p.source.match(/^(contract|setting|read):(.+)$/);
      if (!m) return;
      const [, kind, key] = m;
      if (kind === 'contract' && !(key in contracts)) {
        errors.push({
          path: `operations.${i}.params.${j}.source`,
          message: `undefined contract key '${key}' in source`,
        });
      } else if (kind === 'setting') {
        warnings.push({
          path: `operations.${i}.params.${j}.source`,
          message: `setting key '${key}' is operator-supplied — verify it exists in your environment`,
        });
      }
    });
  });

  return { errors, warnings };
}

export function validateManifest(manifest, mode, schema) {
  const errors = schemaErrors(manifest, schema);
  const cross = crossFieldErrors(manifest);
  return {
    errors: [...errors, ...cross.errors],
    warnings: cross.warnings,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run examples/manifest-builder/validation.test.js`
Expected: PASS — all describe blocks green.

- [ ] **Step 6: Commit**

```bash
git add examples/manifest-builder/validation.js examples/manifest-builder/validation.test.js package.json package-lock.json
git commit -m "feat(manifest-builder): add schema + cross-field validation

- schema validation via ajv (added as dev dep)
- cross-field rules: contract refs, ABI methods, duplicate ids,
  Param.source resolution
- errors keyed by JSON path; setting:<key> emits warning"
```

---

## Task 6: Vendor dependencies via esbuild

**Files:**
- Create: `examples/manifest-builder/build-vendor.sh`
- Create: `examples/manifest-builder/vendor/preact.js`
- Create: `examples/manifest-builder/vendor/signals.js`
- Create: `examples/manifest-builder/vendor/htm.js`
- Create: `examples/manifest-builder/vendor/ajv.js`
- Modify: `package.json` (add devDependencies: preact, @preact/signals, htm)

Goal: produce committed esbuild bundles of the four runtime libraries so the builder loads with zero CDN dependency.

- [ ] **Step 1: Install the libraries as devDependencies**

Run:
```bash
npm install --save-dev preact@10 @preact/signals@1 htm@3
```
Expected: three packages added to `package.json` `devDependencies`. ajv was already added in Task 5.

- [ ] **Step 2: Write `build-vendor.sh`**

Create `examples/manifest-builder/build-vendor.sh`:

```bash
#!/usr/bin/env bash
# Regenerates examples/manifest-builder/vendor/*.js from npm-installed
# devDependencies. Run from the repo root after upgrading any of:
# preact, @preact/signals, htm, ajv.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor"
mkdir -p "$VENDOR_DIR"

cd "$REPO_ROOT"

bundle() {
  local lib="$1"
  local outfile="$2"
  shift 2
  npx esbuild \
    --bundle \
    --format=esm \
    --target=es2022 \
    --platform=browser \
    "$@" \
    --outfile="$VENDOR_DIR/$outfile" \
    --log-level=warning \
    <(printf 'export * from "%s";\n' "$lib")
}

# preact: standalone bundle.
npx esbuild --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$VENDOR_DIR/preact.js" \
  --log-level=warning \
  <(printf 'export * from "preact";\n')

# @preact/signals: externalize preact so signals shares the runtime instance.
npx esbuild --bundle --format=esm --target=es2022 --platform=browser \
  --external:preact \
  --outfile="$VENDOR_DIR/signals.js" \
  --log-level=warning \
  <(printf 'export * from "@preact/signals";\n')

# htm: standalone, default export.
npx esbuild --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$VENDOR_DIR/htm.js" \
  --log-level=warning \
  <(printf 'export { default } from "htm";\n')

# ajv: standalone, default export (Ajv class).
npx esbuild --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$VENDOR_DIR/ajv.js" \
  --log-level=warning \
  <(printf 'export { default } from "ajv";\n')

echo "Vendor bundles regenerated in $VENDOR_DIR:"
ls -la "$VENDOR_DIR"
```

- [ ] **Step 3: Make it executable and run it**

Run:
```bash
chmod +x examples/manifest-builder/build-vendor.sh
bash examples/manifest-builder/build-vendor.sh
```
Expected:
- Four files produced in `examples/manifest-builder/vendor/`: `preact.js`, `signals.js`, `htm.js`, `ajv.js`.
- Approximate sizes: preact ~10 KB, signals ~7 KB, htm ~3 KB, ajv ~120 KB (unminified).
- No esbuild errors.

- [ ] **Step 4: Smoke-test that signals.js externalizes preact correctly**

Run:
```bash
grep -E "from ['\"](preact|\.\/preact)" examples/manifest-builder/vendor/signals.js | head -3
```
Expected: at least one `import ... from "preact"` (bare — the import map in `index.html` will resolve it to `./preact.js`). If you see preact's source bundled inline (e.g., a `function Component()` declaration), the externalization failed.

- [ ] **Step 5: Verify ajv.js loads without errors in Node**

Run:
```bash
node --input-type=module -e "
import('./examples/manifest-builder/vendor/ajv.js').then((m) => {
  const Ajv = m.default;
  const ajv = new Ajv();
  ajv.compile({ type: 'object' });
  console.log('OK');
});
"
```
Expected: `OK` (silently confirms the bundled ajv loads as ESM).

- [ ] **Step 6: Commit**

```bash
git add examples/manifest-builder/build-vendor.sh \
        examples/manifest-builder/vendor/ \
        package.json package-lock.json
git commit -m "feat(manifest-builder): vendor preact + signals + htm + ajv as esbuild bundles

Removes runtime CDN dependency. Bundles are committed; build-vendor.sh
regenerates them from npm-installed devDependencies when versions
change. signals externalizes preact so the runtime shares one instance
(import map in index.html resolves the bare 'preact' specifier)."
```

---

## Task 7: Implement app.js (Preact UI)

**Files:**
- Create: `examples/manifest-builder/app.js`

This is a UI module — no unit tests; manual smoke-test via the browser at the end. Implementation is one task because the components are interlinked through the shared signal-based store. Total ~400 LOC.

- [ ] **Step 1: Write the full app.js**

Create `examples/manifest-builder/app.js` (uses bare specifiers — the import map in `index.html` resolves them to `./vendor/*.js`):

```javascript
import { h, render } from 'preact';
import { signal, computed } from '@preact/signals';
import htm from 'htm';
import { emptyManifest, renameContractKey, exportManifest, resolveAbiMethods } from './model.js';
import { validateManifest } from './validation.js';
import { slugify } from './slugify.js';

const html = htm.bind(h);

const state = signal(emptyManifest());
const mode = signal('headless'); // 'headless' | 'full'
const activeSection = signal('meta');
const schema = signal(null);
const banner = signal(null);

fetch('./schema.json').then((r) => r.json()).then((s) => { schema.value = s; });

const validation = computed(() => {
  if (!schema.value) return { errors: [], warnings: [] };
  return validateManifest(state.value, mode.value, schema.value);
});

const errorsBySection = computed(() => {
  const map = { meta: 0, contracts: 0, operations: 0 };
  for (const e of validation.value.errors) {
    if (e.path.startsWith('contracts')) map.contracts++;
    else if (e.path.startsWith('operations')) map.operations++;
    else map.meta++;
  }
  return map;
});

function update(fn) {
  state.value = fn(structuredClone(state.value));
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!schema.value) {
        banner.value = { kind: 'error', text: 'Schema not loaded yet — try again.' };
        return;
      }
      const r = validateManifest(parsed, mode.value, schema.value);
      if (r.errors.length > 0) {
        banner.value = { kind: 'error', text: `Invalid manifest: ${r.errors[0].message} at ${r.errors[0].path || '<root>'}` };
        return;
      }
      state.value = parsed;
      banner.value = { kind: 'ok', text: `Loaded ${file.name}` };
    } catch (err) {
      banner.value = { kind: 'error', text: `Parse error: ${err.message}` };
    }
  };
  reader.readAsText(file);
}

function exportFile() {
  if (validation.value.errors.length > 0) return;
  const out = exportManifest(state.value, mode.value);
  const json = JSON.stringify(out, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(state.value.name)}.otzi.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function Sidebar() {
  const errs = errorsBySection.value;
  const counts = {
    contracts: Object.keys(state.value.contracts).length,
    operations: state.value.operations.length,
  };
  const sectionItem = (key, label, count, errCount, disabled) => html`
    <button
      class=${`nav-item ${activeSection.value === key ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
      onClick=${() => !disabled && (activeSection.value = key)}
      disabled=${disabled}>
      ${label}${count != null ? ` (${count})` : ''}${errCount > 0 ? html`<span class="err-badge">⚠ ${errCount}</span>` : null}
    </button>`;
  const fullDisabled = mode.value === 'headless';
  return html`
    <aside class="sidebar">
      <div class="mode">
        <label><input type="radio" name="mode" checked=${mode.value === 'headless'}
          onChange=${() => (mode.value = 'headless')}/> Headless</label>
        <label><input type="radio" name="mode" checked=${mode.value === 'full'}
          onChange=${() => (mode.value = 'full')}/> Full</label>
      </div>
      <label class="load-btn">
        Load .otzi.json
        <input type="file" accept=".json" onChange=${(e) => e.target.files[0] && loadFile(e.target.files[0])}/>
      </label>
      <hr/>
      ${sectionItem('meta', 'Meta', null, errs.meta, false)}
      ${sectionItem('contracts', 'Contracts', counts.contracts, errs.contracts, false)}
      ${sectionItem('operations', 'Operations', counts.operations, errs.operations, false)}
      ${sectionItem('reads', 'Reads', null, 0, fullDisabled)}
      ${sectionItem('status', 'Status', null, 0, fullDisabled)}
      ${sectionItem('theme', 'Theme', null, 0, fullDisabled)}
    </aside>`;
}

function ExportPanel() {
  const errCount = validation.value.errors.length;
  return html`
    <aside class="export-panel">
      <button class="export-btn" disabled=${errCount > 0} onClick=${exportFile}>
        Download .otzi.json
      </button>
      ${errCount > 0 ? html`<p class="hint">${errCount} error${errCount === 1 ? '' : 's'} — fix to enable export.</p>` : null}
    </aside>`;
}

function FieldErrors({ path }) {
  const errs = validation.value.errors.filter((e) => e.path === path);
  if (errs.length === 0) return null;
  return html`<ul class="field-errors">${errs.map((e) => html`<li>${e.message}</li>`)}</ul>`;
}

function MetaSection() {
  return html`
    <section>
      <h2>Project metadata</h2>
      <label>Project name <input value=${state.value.name}
        onInput=${(e) => update((s) => ({ ...s, name: e.target.value }))}/></label>
      <label>Description <input value=${state.value.description ?? ''}
        onInput=${(e) => update((s) => ({ ...s, description: e.target.value }))}/></label>
      <label>Icon URL <input value=${state.value.icon ?? ''}
        onInput=${(e) => update((s) => ({ ...s, icon: e.target.value }))}/></label>
    </section>`;
}

function ContractCard({ key, contract }) {
  const abiMode = typeof contract.abi === 'string' ? 'shorthand' : Array.isArray(contract.abi) ? 'mixed' : 'custom';
  return html`
    <div class="card">
      <header><strong>${key || '(unnamed)'}</strong> — ${contract.label || ''}</header>
      <label>Key <input value=${key} onChange=${(e) => {
        try { update((s) => renameContractKey(s, key, e.target.value)); }
        catch (err) { banner.value = { kind: 'error', text: err.message }; }
      }}/></label>
      <label>Label <input value=${contract.label}
        onInput=${(e) => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], label: e.target.value } } }))}/></label>
      <label>Address <input value=${contract.address}
        onInput=${(e) => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], address: e.target.value } } }))}/></label>
      <div class="abi-tabs">
        <label><input type="radio" name=${`abi-${key}`} checked=${abiMode === 'shorthand'}
          onChange=${() => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: 'OP_20' } } }))}/> Shorthand</label>
        <label><input type="radio" name=${`abi-${key}`} checked=${abiMode === 'custom'}
          onChange=${() => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: [] } } }))}/> Custom</label>
      </div>
      ${abiMode === 'shorthand' ? html`
        <select value=${contract.abi}
          onChange=${(e) => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: e.target.value } } }))}>
          <option>OP_20</option><option>OP_20S</option><option>OP_721</option>
        </select>` : html`
        <textarea rows="6" value=${JSON.stringify(contract.abi, null, 2)}
          onChange=${(e) => {
            try { const v = JSON.parse(e.target.value); update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: v } } })); }
            catch (err) { banner.value = { kind: 'error', text: `ABI JSON: ${err.message}` }; }
          }}></textarea>`}
      <button class="delete" onClick=${() => update((s) => {
        const next = { ...s, contracts: { ...s.contracts } };
        delete next.contracts[key];
        return next;
      })}>Delete</button>
    </div>`;
}

function ContractsSection() {
  return html`
    <section>
      <h2>Contracts</h2>
      ${Object.entries(state.value.contracts).map(([key, contract]) => html`<${ContractCard} key=${key} contract=${contract}/>`)}
      <button onClick=${() => {
        let i = 1;
        while (`contract${i}` in state.value.contracts) i++;
        update((s) => ({ ...s, contracts: { ...s.contracts, [`contract${i}`]: { label: '', abi: 'OP_20', address: '' } } }));
      }}>+ Add Contract</button>
    </section>`;
}

function ParamCard({ opIndex, paramIndex, param }) {
  const setParam = (mut) => update((s) => {
    const ops = [...s.operations];
    const op = { ...ops[opIndex] };
    const params = [...op.params];
    params[paramIndex] = mut(params[paramIndex]);
    op.params = params;
    ops[opIndex] = op;
    return { ...s, operations: ops };
  });
  const contractKeys = Object.keys(state.value.contracts);
  const sourceOptions = ['(none)', ...contractKeys.map((k) => `contract:${k}`)];
  if (mode.value === 'full') {
    sourceOptions.push('setting:', 'read:');
  } else {
    sourceOptions.push('setting:');
  }
  return html`
    <div class="param-card">
      <label>Name <input value=${param.name} onInput=${(e) => setParam((p) => ({ ...p, name: e.target.value }))}/></label>
      <label>Type <select value=${param.type} onChange=${(e) => setParam((p) => ({ ...p, type: e.target.value }))}>
        <option>uint256</option><option>address</option><option>bool</option><option>bytes</option>
      </select></label>
      <label>Label <input value=${param.label ?? ''} onInput=${(e) => setParam((p) => ({ ...p, label: e.target.value }))}/></label>
      <label>Placeholder <input value=${param.placeholder ?? ''} onInput=${(e) => setParam((p) => ({ ...p, placeholder: e.target.value }))}/></label>
      <label>Scale <input type="number" value=${param.scale ?? ''} onInput=${(e) => setParam((p) => ({ ...p, scale: e.target.value === '' ? undefined : Number(e.target.value) }))}/></label>
      <label>Source <input value=${param.source ?? ''} placeholder="contract:foo or setting:bar"
        onInput=${(e) => setParam((p) => ({ ...p, source: e.target.value || undefined }))}/></label>
      <${FieldErrors} path=${`operations.${opIndex}.params.${paramIndex}.source`}/>
    </div>`;
}

function OperationCard({ index, op }) {
  const setOp = (mut) => update((s) => {
    const ops = [...s.operations];
    ops[index] = mut(ops[index]);
    return { ...s, operations: ops };
  });
  const contractKeys = Object.keys(state.value.contracts);
  const methods = op.contract && op.contract !== '$dynamic' && state.value.contracts[op.contract]
    ? resolveAbiMethods(state.value.contracts[op.contract].abi)
    : [];
  return html`
    <div class="card">
      <header><strong>${op.id || '(unnamed)'}</strong> — ${op.label || ''}</header>
      <label>ID <input value=${op.id} onInput=${(e) => setOp((o) => ({ ...o, id: e.target.value }))}/></label>
      <label>Label <input value=${op.label} onInput=${(e) => setOp((o) => ({ ...o, label: e.target.value }))}/></label>
      <label>Description <input value=${op.description ?? ''} onInput=${(e) => setOp((o) => ({ ...o, description: e.target.value }))}/></label>
      <label>Confirm prompt <input value=${op.confirm ?? ''} onInput=${(e) => setOp((o) => ({ ...o, confirm: e.target.value }))}/></label>
      <label>Contract <select value=${op.contract} onChange=${(e) => setOp((o) => ({ ...o, contract: e.target.value }))}>
        <option value="">(pick)</option>
        ${contractKeys.map((k) => html`<option>${k}</option>`)}
        <option value="$dynamic">$dynamic</option>
      </select></label>
      <${FieldErrors} path=${`operations.${index}.contract`}/>
      <label>Method ${op.contract === '$dynamic' || methods.length === 0
        ? html`<input value=${op.method} onInput=${(e) => setOp((o) => ({ ...o, method: e.target.value }))}/>`
        : html`<select value=${op.method} onChange=${(e) => setOp((o) => ({ ...o, method: e.target.value }))}>
            <option value="">(pick)</option>
            ${methods.map((m) => html`<option>${m}</option>`)}
          </select>`}
      </label>
      <${FieldErrors} path=${`operations.${index}.method`}/>
      <h4>Params</h4>
      ${(op.params ?? []).map((p, j) => html`<${ParamCard} opIndex=${index} paramIndex=${j} param=${p}/>`)}
      <button onClick=${() => setOp((o) => ({ ...o, params: [...(o.params ?? []), { name: '', type: 'uint256' }] }))}>+ Add Param</button>
      <button class="delete" onClick=${() => update((s) => ({ ...s, operations: s.operations.filter((_, i) => i !== index) }))}>Delete Operation</button>
    </div>`;
}

function OperationsSection() {
  return html`
    <section>
      <h2>Operations</h2>
      ${state.value.operations.map((op, i) => html`<${OperationCard} index=${i} op=${op}/>`)}
      <button onClick=${() => update((s) => {
        let i = 1;
        const ids = new Set(s.operations.map((o) => o.id));
        while (ids.has(`op${i}`)) i++;
        return { ...s, operations: [...s.operations, { id: `op${i}`, label: '', contract: '', method: '', params: [] }] };
      })}>+ Add Operation</button>
    </section>`;
}

function App() {
  let body;
  switch (activeSection.value) {
    case 'meta': body = html`<${MetaSection}/>`; break;
    case 'contracts': body = html`<${ContractsSection}/>`; break;
    case 'operations': body = html`<${OperationsSection}/>`; break;
    default: body = html`<section><p class="hint">Full mode — coming in v2.</p></section>`;
  }
  return html`
    <div class="layout">
      <${Sidebar}/>
      <main>
        ${banner.value ? html`<div class=${`banner ${banner.value.kind}`}>${banner.value.text} <button onClick=${() => (banner.value = null)}>×</button></div>` : null}
        ${body}
      </main>
      <${ExportPanel}/>
    </div>`;
}

render(html`<${App}/>`, document.body);
```

- [ ] **Step 2: Commit**

```bash
git add examples/manifest-builder/app.js
git commit -m "feat(manifest-builder): add Preact UI components

Sidebar with mode radio + section nav, meta/contracts/operations
editors, load/export, inline field errors, banner notifications."
```

---

## Task 8: Implement index.html

**Files:**
- Create: `examples/manifest-builder/index.html`

- [ ] **Step 1: Write index.html**

Create `examples/manifest-builder/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ötzi Manifest Builder</title>
<style>
  :root {
    --fg: #222; --bg: #fafafa; --panel-bg: #fff; --border: #ddd;
    --accent: #2e6fdb; --error: #c04040; --warning: #b07c00; --ok: #2e8b57;
    --disabled: #aaa;
  }
  body { margin: 0; font-family: system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  .layout { display: grid; grid-template-columns: 220px 1fr 220px; min-height: 100vh; }
  .sidebar, .export-panel { background: var(--panel-bg); border-right: 1px solid var(--border); padding: 1rem; }
  .export-panel { border-left: 1px solid var(--border); border-right: 0; }
  main { padding: 1.5rem; overflow-y: auto; }
  .mode { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .nav-item { display: block; width: 100%; text-align: left; padding: 0.5rem 0.75rem;
    background: transparent; border: 0; cursor: pointer; border-radius: 4px;
    color: var(--fg); font: inherit; }
  .nav-item.active { background: var(--accent); color: #fff; }
  .nav-item.disabled, .nav-item:disabled { color: var(--disabled); cursor: not-allowed; }
  .err-badge { background: var(--error); color: #fff; border-radius: 10px; padding: 0 0.4rem;
    font-size: 0.75em; margin-left: 0.4rem; }
  .load-btn { display: block; margin: 0.5rem 0 1rem; padding: 0.5rem; border: 1px dashed var(--border);
    border-radius: 4px; cursor: pointer; text-align: center; }
  .load-btn input { display: none; }
  .export-btn { width: 100%; padding: 0.7rem; background: var(--accent); color: #fff;
    border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
  .export-btn:disabled { background: var(--disabled); cursor: not-allowed; }
  .card, .param-card { background: var(--panel-bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
  .param-card { background: #f5f5f5; }
  .card header { font-size: 1.05em; margin-bottom: 0.6rem; }
  label { display: block; margin: 0.4rem 0; }
  label input, label select, label textarea { display: block; width: 100%; margin-top: 0.2rem;
    padding: 0.4rem; border: 1px solid var(--border); border-radius: 3px; font: inherit;
    box-sizing: border-box; }
  label textarea { font-family: monospace; font-size: 0.9em; }
  .abi-tabs { margin: 0.5rem 0; }
  .abi-tabs label { display: inline-block; margin-right: 1rem; }
  .delete { background: var(--error); color: #fff; border: 0; padding: 0.3rem 0.7rem;
    border-radius: 4px; cursor: pointer; }
  .field-errors { margin: 0.2rem 0; padding-left: 1.2rem; color: var(--error); font-size: 0.9em; }
  .banner { padding: 0.7rem 1rem; border-radius: 4px; margin-bottom: 1rem; display: flex;
    justify-content: space-between; align-items: center; }
  .banner.error { background: #ffe5e5; color: var(--error); border: 1px solid var(--error); }
  .banner.ok { background: #e5f5ea; color: var(--ok); border: 1px solid var(--ok); }
  .banner button { background: transparent; border: 0; cursor: pointer; font-size: 1.1em; }
  .hint { color: #666; font-size: 0.9em; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 0.8rem 0; }
  h2 { margin-top: 0; }
  button { font: inherit; }
</style>
</head>
<body>
<script type="importmap">
{
  "imports": {
    "preact": "./vendor/preact.js",
    "@preact/signals": "./vendor/signals.js",
    "htm": "./vendor/htm.js",
    "ajv": "./vendor/ajv.js"
  }
}
</script>
<script type="module" src="./app.js"></script>
</body>
</html>
```

The import map lets `app.js` and `validation.js` use bare specifiers (`import Ajv from 'ajv'`). Browser resolves them to `./vendor/*.js` (the committed esbuild bundles from Task 6). vitest resolves them from `node_modules` (preact, signals, htm, ajv are all installed as devDependencies — Tasks 5 and 6).

- [ ] **Step 2: Commit**

```bash
git add examples/manifest-builder/index.html
git commit -m "feat(manifest-builder): add HTML entry point with inline styles"
```

---

## Task 9: Write README.md

**Files:**
- Create: `examples/manifest-builder/README.md`

- [ ] **Step 1: Write the README**

Create `examples/manifest-builder/README.md`:

```markdown
# Ötzi Manifest Builder

Standalone in-browser tool that produces v2 `.otzi.json` manifests for OPNet contracts.

## Usage

Open `index.html` in any modern browser:

```
xdg-open examples/manifest-builder/index.html   # Linux
open examples/manifest-builder/index.html       # macOS
```

The page loads with no build step and no network calls. All dependencies (preact, signals, htm, ajv) ship as committed esbuild bundles under [`vendor/`](./vendor/) and are wired in via the import map in `index.html`.

## Workflow

1. Switch to **Headless** mode (default; **Full** mode is reserved for v2).
2. Fill in **Meta** (project name, description, icon).
3. Add **Contracts** — pick a key, label, address, and either a shorthand ABI (`OP_20` / `OP_20S` / `OP_721`) or paste a custom `AbiEntry[]` array.
4. Add **Operations** — pick a contract + method, then add params with types, scaling, sources.
5. Click **Download .otzi.json**. The button is disabled while validation errors exist.

To edit an existing manifest: click **Load .otzi.json** at the top of the sidebar.

## What changed in v2

- `Contract.address` is now a **required** field (flat string, not a per-network map). Manifests are network-agnostic — publish a separate file per deployment.
- `Param.source: contract:<key>` resolves from `contracts[key].address` in the manifest itself, not from a separate Ötzi settings store.

The full v2 schema is at [`schema.json`](./schema.json), mirrored byte-equal from [`docs/otzi-manifest-schema.json`](../../docs/otzi-manifest-schema.json).

## Headless vs Full mode

| Section / Field | Headless | Full (v2) |
|---|---|---|
| Meta | ✓ | ✓ |
| Contracts (key, label, address, ABI) | ✓ | ✓ |
| Operations (id, label, contract, method, params) | ✓ | ✓ |
| `Operation.condition` | hidden | ✓ |
| `Operation.ownerOnly` | hidden | ✓ |
| `Param.source: read:` | hidden | ✓ |
| `reads`, `status`, `theme` sections | greyed | ✓ |

Output JSON is schema-valid in both modes — Headless simply omits the disabled fields.

## Development

The pure logic modules (`model.js`, `validation.js`, `slugify.js`) have unit tests under `*.test.js`:

```bash
npx vitest run examples/manifest-builder/
```

UI changes (`app.js`, `index.html`) are validated by manual smoke testing.

### Upgrading vendored dependencies

When bumping any of preact / signals / htm / ajv versions in `package.json`, regenerate the bundles:

```bash
npm install
bash examples/manifest-builder/build-vendor.sh
git add examples/manifest-builder/vendor/ package.json package-lock.json
```

The script externalizes preact when bundling signals so the runtime ends up with one preact instance.
```

- [ ] **Step 2: Commit**

```bash
git add examples/manifest-builder/README.md
git commit -m "docs(manifest-builder): add README"
```

---

## Task 10: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Open the builder in a browser**

Run: `xdg-open examples/manifest-builder/index.html` (or open via your platform's equivalent).
Expected: 3-column layout with sidebar, main panel, export panel.

- [ ] **Step 2: Walk the golden path**

Verify each step works in the browser:
1. **Mode radio** is set to Headless; clicking "Full" greys the disabled section nav items.
2. **Meta:** type a name, description, icon URL — fields persist when switching sections.
3. **Contracts:** click `+ Add Contract`, set key=`tok`, label=`Token`, address=`0xabc`, ABI=`OP_20`. Card header updates to `tok — Token`.
4. **Operations:** click `+ Add Operation`. Set id=`transfer1`, label=`Transfer`, pick contract=`tok` (dropdown shows `tok`). Method dropdown should now show `transfer`/`balanceOf`/etc. Pick `transfer`. Add two params: `to: address`, `amount: uint256` with scale=`1e8`.
5. **Validation:** sidebar shows no error badges. Export button is enabled.
6. **Download:** click `Download .otzi.json`. File downloads as `<slug>.otzi.json`. Open it — JSON should match v2 shape, no extra fields, address present.

- [ ] **Step 3: Walk error paths**

1. Delete the contract; sidebar `Operations` should show error badge (operation references deleted contract).
2. Re-add contract with same key; error clears.
3. Set Operation method to a name not in the OP_20 ABI (e.g., type `nonexistent` if free-text appears). Error badge appears on Operations.
4. Set Operation id duplicate by adding a second op with same id. Duplicate error appears.
5. Export button disabled while errors present; tooltip lists count.

- [ ] **Step 4: Walk load path**

1. Click `Load .otzi.json`, pick the file you just exported. Sidebar populates; banner says `Loaded <filename>`.
2. Try loading a malformed file (e.g. `{"version": 1, ...}` from old Ötzi). Banner shows error; state unchanged.

- [ ] **Step 5: Confirm typecheck + tests still green**

Run:
```bash
npx vitest run examples/manifest-builder/
npx tsc --noEmit
```
Expected: vitest reports all tests passing. tsc reports no errors (the example dir is not in tsconfig.include, so this is a sanity check on the rest of the repo).

- [ ] **Step 6: Final commit (if any tweaks were needed)**

If smoke test surfaced bugs, fix and commit. Otherwise no commit needed — task is verification only.

---

## Self-review

Spec coverage walk-through:

- **Goal** (browser tool produces valid v2 `.otzi.json`) — Tasks 1, 2, 6, 7, 8, 10.
- **Audience** (project owners + degenerate consumer) — covered by load + edit + export flow in app.js (Task 7) and README (Task 9).
- **Schema v2 bump** — Task 1.
- **Architecture (HTML + ES modules + vendored bundles, browser I/O, no backend)** — Tasks 6, 7, 8.
- **Delivery layout** — Tasks 2, 3-5 (pure modules + tests), 6 (vendor/), 7 (app.js), 8 (index.html), 9 (README) produce exactly the file structure in the spec.
- **No runtime CDN** — Task 6 vendors the four runtime libraries as committed esbuild bundles; Task 8's import map points at `./vendor/*.js`.
- **UI structure (3-column, mode radio, sidebar nav, badges)** — Task 7 (app.js) + Task 8 (index.html styles).
- **Data model & forms (Meta / Contracts with ABI tabs / Operations / Params / cross-section reactivity)** — Tasks 4 (model logic), 7 (UI).
- **Validation (live schema + cross-field rules + error keying)** — Task 5.
- **Load + export + filename** — Task 7 (app.js handlers), Task 4 (`exportManifest`), Task 3 (`slugify`).
- **Testing (vitest, pure modules)** — Tasks 3, 4, 5; manual smoke in Task 10.
- **Out of scope** — explicitly not implemented (no condition editor, no read auto-fill UI, no drag-drop, no ABI fetch, no live RPC).
- **Forward-looking (portable to Ötzi)** — implementation has no otzi-headless-specific assumptions; pure modules are framework-agnostic; bare specifiers + import map make swapping the bundler trivial.

Type / signature consistency check:

- `emptyManifest()`, `renameContractKey(m, old, new)`, `exportManifest(m, mode)`, `resolveAbiMethods(abi)` — defined in Task 4, used in Tasks 5 (model.test, validation.js) and 7 (app.js). Names match.
- `validateManifest(manifest, mode, schema)` returns `{errors, warnings}` with `{path, message}` items — defined in Task 5, consumed in Task 7 (app.js's `validation` computed signal).
- `slugify(string)` — defined in Task 3, used in Task 7 (`exportFile`).
- `mode` values: `'headless' | 'full'` — used consistently across tasks.
- `errorsBySection` keys: `meta` / `contracts` / `operations` — defined in Task 7, matched by sidebar render.
- Import map keys (`preact` / `@preact/signals` / `htm` / `ajv`) match the bare specifiers in Task 7's `app.js` and Task 5's `validation.js`. Map values match the file paths produced by Task 6's `build-vendor.sh`.

No placeholders. All test code, implementation code, and commands are concrete. Each task is self-contained.
