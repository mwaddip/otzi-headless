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

When bumping any of preact / @preact/signals / htm / ajv versions in `package.json`, regenerate the bundles:

```bash
npm install
bash examples/manifest-builder/build-vendor.sh
git add examples/manifest-builder/vendor/ package.json package-lock.json
```

The script externalizes preact when bundling signals and preact-hooks so the runtime ends up with one preact instance. The preact-hooks bundle entry points at the package's `dist/hooks.module.js` directly because esbuild's `--external:preact` matches subpaths too — a re-export entry would be left as an unresolved import.
