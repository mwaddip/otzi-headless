# Ötzi Manifest Builder

Standalone in-browser tool that produces v2 `.otzi.json` manifests for OPNet contracts.

## Usage

Run the bundled helper script to serve the directory over HTTP:

```bash
bash examples/manifest-builder/serve.sh
# → http://localhost:8765/index.html
```

Then open the printed URL. Modern browsers (Firefox + Chromium) refuse to load `<script type="module">` from `file://` URLs — every `file://` path is a unique origin and CORS blocks cross-file imports. A localhost server sidesteps that. The script uses Python's stdlib `http.server`; any other static-file server works (`npx serve`, nginx, etc.).

The page loads with no network calls beyond `localhost`. All dependencies (preact, signals, htm, ajv) ship as committed esbuild bundles under [`vendor/`](./vendor/) and are wired in via the import map in `index.html`.

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

The builder ships primarily for otzi-headless. Full mode is a forward-looking export path for when the same builder gets adopted by Ötzi's React UI repo.

| Section / Field | Headless | Full (v2) |
|---|---|---|
| `Meta.name`, `Meta.description` | ✓ | ✓ |
| `Meta.icon` | hidden | ✓ |
| `Contracts.{key, label, address, abi}` | ✓ | ✓ |
| `Operation.{id, label, description, contract, method}` | ✓ | ✓ |
| `Operation.confirm` | hidden | ✓ |
| `Operation.condition`, `Operation.ownerOnly` | hidden | ✓ |
| `Param.{name, type, scale}` | ✓ | ✓ |
| `Param.source` (`contract:` / `setting:`) | ✓ | ✓ |
| `Param.source: read:` | hidden | ✓ |
| `Param.label`, `Param.placeholder`, `Param.options` | hidden | ✓ |
| `reads`, `status`, `theme` sections | greyed | ✓ |

Output JSON is schema-valid in both modes — Headless strips fields that have no headless-CLI use (UI cosmetics, polling-dependent values, dynamic dropdowns).

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

### Regenerating schema.js

`schema.js` is a committed JS-module wrapper around `schema.json` — used because `fetch('./schema.json')` is also CORS-blocked under `file://` and inconsistent across server configs. To regenerate after a schema bump:

```bash
node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('examples/manifest-builder/schema.json','utf8')); fs.writeFileSync('examples/manifest-builder/schema.js', '// Auto-generated from schema.json — do not hand-edit.\n// Regenerate by running build-vendor.sh.\nexport default ' + JSON.stringify(s, null, 2) + ';\n');"
```

(Or hook this into `build-vendor.sh` if schema bumps become frequent.)
