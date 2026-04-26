# Manifest builder — design spec

Standalone in-browser tool under `examples/manifest-builder/` that produces `.otzi.json` manifests matching `docs/headless-manifest-schema.json` (`headless-manifest-v1`).

## Purpose

Lets a contract author or project team author a v1 manifest for federation operators to install via `otzi install <path>` (or distribute via `otzi sync <path>`). Live schema validation in-browser; output round-trips through the daemon's own validator at `src/cli/manifest-validate.ts`.

The builder is operator-side. The daemon does not consume it directly; operators run the daemon-side `otzi install` command on the produced file.

## Non-goals

- No backend, no daemon coupling, no key handling.
- No network calls. All dependencies (Preact, htm, signals, ajv) ship as committed bundles under `vendor/`. Works fully offline once served.
- No ABI auto-fetch from a deployed contract address.
- No live OPNet RPC validation against deployed contracts.
- No import from compiled contract artifacts. Operator pastes ABI for `Custom` types.
- No support for Ötzi's richer `.otzi.json` shape (operations, reads, status, theme, conditional UI, dynamic dropdowns). That tool lives in the Ötzi repo.

## Schema

Authoritative schema: `docs/headless-manifest-schema.json`. The builder vendors a byte-equal copy at `examples/manifest-builder/schema.json` so it loads under `file://` without cross-directory fetches. Regenerated via the script in the README when the canonical schema changes.

Shape summary (full reference in the schema):

- `version: 1`, `name`, optional `description`, `contracts: [...]`.
- Each contract: `name`, `address` (`0x` + 64 hex), `type` ∈ `OP20` / `OP20S` / `OP721` / `Custom`.
- `OP20` / `OP20S`: require `decimals` (0..38), forbid `abi`.
- `OP721`: forbid `abi`.
- `Custom`: require `abi`. ABI is `{name, params: [{name, type}]}[]` with param types from a fixed enum (`address`, `bool`, `string`, `bytes`, `uint8..uint256`).

## Architecture

**Form factor.** `examples/manifest-builder/index.html` plus co-located ES modules. UI built with Preact + `@preact/signals` + `htm`; validation uses ajv. All four libraries ship as committed bundles under `vendor/`. Operator runs a localhost HTTP server (`serve.sh` ships a Python stdlib helper) — modern browsers reject `<script type="module">` over `file://` URLs because each path becomes a unique origin and CORS blocks cross-file imports. Once served, only `localhost` traffic.

**No backend, no network.** I/O is browser-native:
- Load: `<input type="file" accept=".json">` reads a `.otzi.json` chosen by the operator.
- Export: `Blob` + `a.download` triggers a save dialog.

**Layout.**

```
examples/manifest-builder/
  index.html          # entry; import map → vendor/, then ./app.js
  app.js              # Preact components (UI)
  model.js            # state shape + exportManifest
  validation.js       # schema + cross-field rules
  slugify.js          # filename helper
  schema.json         # vendored v1 schema (byte-equal mirror)
  schema.js           # JS-module wrapper around schema.json
  vendor/             # committed esbuild bundles
  build-vendor.sh     # esbuild driver — regenerates vendor/*.js
  serve.sh            # python http.server wrapper
  README.md           # operator-facing how-to
  *.test.js           # vitest suites
  round-trip.test.js  # cross-validates with daemon's validator
```

## UI structure

Three-column layout: sidebar (Meta / Contracts navigation + load) — main pane (active section's form) — export panel.

**Meta.** `name` + `description`.

**Contracts.** Ordered list of contract cards. Each card has:
- `name` input (identifier; pattern enforced).
- `address` input (`0x` + 64 hex; pattern enforced).
- `type` dropdown (OP20 / OP20S / OP721 / Custom).
- `decimals` input — rendered iff `type ∈ {OP20, OP20S}`.
- ABI textarea (JSON array of `{name, params: [...]}`) — rendered iff `type === Custom`.

Switching `type` drops fields that become invalid (e.g. OP20 → OP721 drops `decimals`; Custom → OP20 drops `abi`). Add-contract button appends a default OP20 stub. Delete button on each card.

Section badges show counts and per-section error counts. Export button disabled while any error exists.

## Validation

`validation.js` mirrors `src/cli/manifest-validate.ts`:
1. JSON Schema validation via ajv (`strict: false` to accommodate `if/then` over `type`-gated `properties`).
2. Cross-field: duplicate contract names → error; duplicate method names within a Custom contract's `abi[]` → error.

Errors keyed by JSON-pointer-style path render inline under offending fields and aggregate into sidebar badges.

## Round-trip parity

`round-trip.test.js` imports the daemon-side validator from `src/cli/manifest-validate.ts` and asserts that any manifest the builder accepts the daemon also accepts (and vice versa). Vitest with tsx loads the TS validator from a JS test file across the directory boundary without config tweaks.

## Testing

Pure modules (`model.js`, `validation.js`, `slugify.js`) have unit tests. UI changes are validated by manual smoke. Coverage:
- `emptyManifest` shape.
- `exportManifest` output per contract type (correct fields kept/dropped).
- Schema rejection paths (missing `decimals` on OP20, `abi` on OP20, missing `abi` on Custom, etc.).
- Cross-field rules (duplicate contract names, duplicate method names).
- Round-trip parity with the daemon validator.

## Distribution

`examples/manifest-builder/` is shipped in the repo for project teams to use locally. **Not** included in the .deb (which only contains the daemon + CLI under `src/`).
