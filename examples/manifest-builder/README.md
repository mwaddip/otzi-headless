# Headless Manifest Builder

Standalone in-browser tool that produces v1 `headless-manifest` `.otzi.json` files for the Ötzi headless daemon.

## Usage

The repo ships **two equivalent forms** of the same UI; pick whichever matches how you're running it:

### Bundled (single file, opens from `file://`)

[`bundled.html`](./bundled.html) is a self-contained 154 KB file with all JS and deps inlined. Just open it from your file manager — no server needed.

```bash
xdg-open examples/manifest-builder/bundled.html   # or double-click in your file manager
```

Operators distributing the builder to others typically share `bundled.html`.

### Source (modules + importmap, requires localhost)

For development, edit the source modules and serve them over HTTP:

```bash
bash examples/manifest-builder/serve.sh
# → http://localhost:8765/index.html
```

Modern browsers (Firefox + Chromium) refuse to load `<script type="module">` from `file://` URLs — every `file://` path is a unique origin and CORS blocks cross-file imports. A localhost server sidesteps that. The script uses Python's stdlib `http.server`; any other static-file server works (`npx serve`, nginx, etc.).

Both forms load with no network calls beyond `localhost`. Source-form deps (preact, signals, htm, ajv) ship as committed esbuild bundles under [`vendor/`](./vendor/) and are wired via the import map in `index.html`. The bundled form inlines everything into one `<script>`.

## Workflow

1. Fill in **Meta** (project name, optional description).
2. Add **Contracts** — for each contract: a name (identifier), `0x`-prefixed 64-hex address, and a contract **type**:
   - **OP20** / **OP20S** — built-in token ABIs. Requires `decimals` (0..38). No `abi` field.
   - **OP721** — built-in NFT ABI. No `decimals`, no `abi`.
   - **Custom** — paste an `abi` array of `{ name, params: [{ name, type }] }`. No `decimals`.
3. Click **Download .otzi.json**. The button stays disabled while validation errors exist.

To edit an existing manifest: click **Load .otzi.json** at the top of the sidebar.

## Schema

The v1 schema is at [`schema.json`](./schema.json), mirrored byte-equal from the canonical [`docs/headless-manifest-schema.json`](../../docs/headless-manifest-schema.json). The builder validates against the vendored copy; the daemon validates against the canonical one (`src/cli/manifest-validate.ts`). A round-trip test in `round-trip.test.js` confirms both validators agree.

The builder reproduces the daemon's two cross-field rules locally:

1. Duplicate contract names within `contracts[]` are rejected.
2. Duplicate method names within a Custom contract's `abi[]` are rejected.

## Development

The pure logic modules (`model.js`, `validation.js`, `slugify.js`) have unit tests under `*.test.js`:

```bash
npx vitest run examples/manifest-builder/
```

UI changes (`app.js`, `index.html`) are validated by manual smoke testing.

### Regenerating `bundled.html`

After editing any of `app.js` / `model.js` / `validation.js` / `slugify.js` / `schema.js` / `index.html`, regenerate the single-file bundle:

```bash
bash examples/manifest-builder/build.sh
git add examples/manifest-builder/bundled.html
```

The script esbuilds `app.js` (with all relative + npm imports resolved) into one minified IIFE, then inlines it into `index.html` (replacing the importmap + module script). Output: `bundled.html`, ~154 KB.

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
