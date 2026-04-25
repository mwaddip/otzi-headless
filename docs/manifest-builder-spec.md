# Manifest builder — design spec

Date: 2026-04-25
Status: design-locked, awaiting implementation plan
Related work: Option E from the otzi-headless roadmap (operator manifest CLI helpers + this builder).

## Goal

A standalone in-browser tool that lets a project owner produce a valid `.otzi.json` manifest for their OPNet contracts, with live schema validation and zero build tooling. Output works in both otzi-headless's CLI (operator-side `otzi sign <op-id> [params...]` against the single installed manifest) and Ötzi's React UI.

The builder is operator-side. The daemon does not change as part of this work.

## Audience

Primarily contract authors / project teams publishing manifests for federation operators to install. Federation operators who only consume manifests (load + view) are covered by the same tool as the degenerate "load-and-don't-edit" path.

## Non-goals

- No backend, no daemon coupling, no key handling.
- No network calls at any time. All dependencies (Preact, htm, signals, ajv) ship as committed bundles under `examples/manifest-builder/vendor/`. Builder works fully offline from the first load.
- No drag-and-drop reordering (use ↑↓ buttons).
- No ABI auto-fetch from a deployed contract address.
- No live OPNet RPC validation against deployed contracts.
- No import from compiled contract artifacts (`.ts`/`.json`). Operator pastes ABI.
- No support for the v1 schema. Output is v2 only.

## Schema (v2)

Bump `version` from `1` to `2`, and update the schema document's `$id` to reflect the new version. Single breaking change relative to v1:

- `Contract.address`: required `string`. Flat, single address. No network keying — manifests are network-agnostic; the project owner publishes a separate manifest per deployment.

Resolver semantics change:
- `Param.source: contract:<key>` resolves to `contracts[<key>].address` (was: "from Ötzi settings"). Same wire syntax.
- `Param.source: setting:<key>` keeps its meaning (custom operator-supplied value).

Everything else in the v1 schema (`reads`, `status`, `theme`, `Operation.condition`, `Operation.ownerOnly`, `Param.source: read:`, dynamic-dropdown `Param.options`, etc.) carries forward unchanged.

The vendored canonical schema at `docs/otzi-manifest-schema.json` is bumped to v2 in this work; the builder vendors its own copy at `examples/manifest-builder/schema.json` so it loads under `file://` without cross-directory fetches.

A separate Ötzi-side change (handled out-of-band) accepts v2 in the React UI.

## Architecture

**Form factor.** `examples/manifest-builder/index.html` plus a small set of co-located ES modules. UI built with Preact + `@preact/signals` + `htm`; validation uses `ajv`. All four libraries ship as committed bundles under `vendor/` — no runtime CDN. No build step needed to *use* the example; a one-shot `build-vendor.sh` regenerates the bundles when versions change. **Operator runs a localhost HTTP server** to serve the directory (a `serve.sh` helper using Python stdlib ships with the example) — modern browsers reject `<script type="module">` over `file://` URLs because each path becomes a unique origin and CORS blocks cross-file imports. Once served, the page works fully offline (only `localhost` traffic). Matches the `examples/gate-web-opwallet/` precedent (operator-facing static example, no daemon coupling).

**No backend, no network.** I/O is browser-native:
- Load: `<input type="file" accept=".json">` reads a `.otzi.json` chosen by the operator.
- Export: `Blob` + `a.download` triggers a save dialog.

The bundles are loaded via an `<script type="importmap">` in `index.html` so app code uses bare specifiers (`import { h } from 'preact'`) and stays portable to a future React/Vite build if the tool moves into Ötzi.

**Delivery layout.**

```
examples/manifest-builder/
  index.html              # entry point; import map → vendor/, then loads ./app.js
  app.js                  # Preact components (UI)
  model.js                # state shape + mutations + key-rename propagation
  validation.js           # schema validation + cross-field rules
  slugify.js              # filename helper
  schema.json             # vendored v2 schema (frozen here)
  vendor/
    preact.js             # esbuild bundle of preact@10
    signals.js            # esbuild bundle of @preact/signals@1 (preact externalized)
    htm.js                # esbuild bundle of htm@3
    ajv.js                # esbuild bundle of ajv@8
  build-vendor.sh         # esbuild driver — regenerates vendor/*.js from npm-installed deps
  README.md               # what it is, how to use, schema-v2 changes
  *.test.js               # vitest suites for pure modules (plain JS to match implementation)
```

The HTML file is small and inspectable end-to-end; UI components live in `app.js`. Pure logic in `model.js`/`validation.js`/`slugify.js` is unit-tested. The `vendor/` bundles are committed; `build-vendor.sh` is a maintenance script for upgrading library versions.

## UI structure

Three-column sidebar layout:

```
┌────────────────┬─────────────────────────┬─────────┐
│  Mode radio    │                         │         │
│  ─────────     │                         │         │
│  Load .otzi.json│   Active section form   │ Export  │
│  ─────────     │                         │ button  │
│  Meta          │                         │         │
│  Contracts (n) │                         │         │
│  Operations (n)│                         │         │
│  Reads (v2)    │                         │         │
│  Status (v2)   │                         │         │
│  Theme (v2)    │                         │         │
└────────────────┴─────────────────────────┴─────────┘
```

**Mode radio** at the top of the sidebar: `Headless` | `Full`. v1 ships Headless enabled; Full is selectable but disables UI-only sections (greyed with "Full mode — coming soon"). Output JSON is schema-valid in both modes.

**Sections enabled in v1 (Headless):** Meta, Contracts, Operations.

**Sections greyed in v1 (Full):** Reads, Status, Theme.

**Fields hidden in Headless mode** (UI-only — no headless consumer needs them):
- `Meta.icon`
- `Operation.confirm`, `Operation.condition`, `Operation.ownerOnly`
- `Param.label`, `Param.placeholder`, `Param.options` (dynamic dropdown)
- `Param.source: read:` (depends on the polled `reads` section)

**Fields kept in Headless mode:**
- `Meta.name`, `Meta.description`
- `Contracts.{key, label, address, abi}` — encoding needs all four
- `Operation.{id, label, description, contract, method, params}` — invocation + listing
- `Param.{name, type, scale, source}` (`source` accepts `contract:` / `setting:`)

**Section badges** show counts (`Contracts (2)`) and error counts (`Contracts ⓘ 2`) when validation fails.

**No JSON preview pane.** Validation errors render inline below offending fields; the export button is the single output.

## Data model & forms

In-memory state mirrors the v2 manifest shape one-to-one. Export is `JSON.stringify` after stripping empty optional fields. State lives in a single Preact signal/store; mutations go through `model.js` helpers so key renames cascade.

### Meta
- `name`, `description`, `icon` (URL).

### Contracts (keyed object → ordered list of cards)
Each card edits one contract:
- `key` (the JSON object key, e.g. `bhtt`)
- `label`
- `address` (flat string)
- `abi` — three sub-modes via tabs at the top of the card body:
  - **Shorthand:** dropdown of `OP_20 / OP_20S / OP_721`.
  - **Custom JSON:** `<textarea>` with prettified JSON; live `JSON.parse` + schema check; errors below.
  - **Mixed:** ordered list of entries, each entry is a tabbed sub-card (`shorthand` pill / `custom` form for one `AbiEntry`).

Card header has title + collapse toggle + reorder ↑↓ + delete ✕. Collapsed shows a summary line (e.g. `bhtt — OP_20 — bc1p…`). Adding: a single `+ Add Contract` button at the bottom of the section.

### Operations (array of cards)
Each card edits one operation:
- `id`, `label`, `description`
- `contract` — select populated from defined contracts plus `$dynamic`.
- `method` — select populated from the resolved ABI of the chosen contract; free text when `contract === '$dynamic'`.
- `params` — nested ordered list. Each param edits:
  - `name`, `type` (select: `uint256` / `address` / `bool` / `bytes`)
  - `scale` (number; placeholder `e.g. 1e8`)
  - `source` (select: `(none)` / `contract:<key>` / `setting:<key>` populated from declared keys)
- **Full-mode-only fields:** `Operation.confirm`, `Operation.condition`, `Operation.ownerOnly`, `Param.label`, `Param.placeholder`, `Param.options` (dynamic-dropdown sub-section), `Param.source: read:`. These are hidden in Headless mode and stripped from headless-mode export output.

Same card chrome as Contracts (collapse / reorder / delete).

### Cross-section reactivity
Renaming a contract `key`:
- Updates Operations' `contract` field where it referenced the old key.
- Updates `Param.source: contract:<old-key>` references.
- Updates dynamic-dropdown `options.count.contract` / `options.item.contract` references.

The builder treats keys as renamable identifiers, not opaque strings. `model.js` owns the cascade.

## Validation, load, export

### Live schema validation
The vendored `schema.json` (v2) drives a JSON-Schema validator (`ajv` from `vendor/ajv.js`). Every keystroke recomputes errors keyed by JSON path; per-field error text renders inline below the offending input. Sidebar badges show per-section error counts.

### Cross-field rules (beyond schema)
- `Operation.contract` must reference a defined contract key (or be `$dynamic`).
- `Operation.method` (when not `$dynamic`) must exist in the resolved ABI of the chosen contract.
- `Param.source: contract:<key>` referenced keys must exist (error if missing).
- `Param.source: setting:<key>` keys are arbitrary (warning only — settings are operator-supplied).
- `Operation.id` duplicates → error.
- `Contract` key duplicates → error.

### Export gating
Download button disabled while any error exists; tooltip lists section + count. Errors block export; warnings do not. JSON output strips empty optional fields and omits disabled-mode-only fields entirely (no nulls, no empty objects).

### Load
Top of sidebar: `Load .otzi.json` button (`<input type="file" accept=".json">`). On select: parse → validate → if valid, populate all sections. If invalid, surface the parse/schema error in a banner and refuse to load partial state.

### Export filename
Default `<name-slug>.otzi.json` derived from the project name (slugified, fallback `manifest.otzi.json`).

## Testing

`examples/manifest-builder/*.test.js` runs under the existing repo vitest config (vitest auto-discovers `.test.js` regardless of `tsconfig.json` `include` patterns).

Coverage:
- Schema validation roundtrip: parse-known-good → validate → re-emit → structural-equality comparison (deep-equal, not byte-equal — JSON.stringify key order is deterministic but whitespace is not relevant).
- Cross-field rule enforcement (each rule above gets a positive + negative test).
- Key-rename propagation (renaming a contract key updates all references).
- Slugify edge cases (unicode, empty, all-non-alpha).
- Error aggregation by JSON path (multiple errors in one section produce one badge with the right count).

No DOM/E2E tests — manual smoke is acceptable for a static example app. The pure-logic split (UI in `app.js`, logic in `model.js`/`validation.js`) makes the testable surface independent of Preact.

## Out of scope (deferred)

- Full-mode editors: `reads`, `status`, `theme`, recursive `condition` editor, `ownerOnly` toggle, `read:` source.
- Drag-and-drop reordering.
- ABI auto-fetch from a deployed contract address.
- Live OPNet RPC validation.
- Importing ABIs from compiled contract artifacts.
- Manifest sync over peer transport (handled separately as `otzi sync`).

## Assumptions

- Ötzi will be updated separately (out-of-band) to accept v2 manifests.
- The vendored copy of the schema at `docs/otzi-manifest-schema.json` becomes the v2 canonical reference for otzi-headless's CLI; the builder's `schema.json` is a frozen byte-equal mirror.
- Operators have a modern browser with ES module support (matches the assumption set by the existing `gate-web-opwallet` example).

## Forward-looking

The builder is designed to be portable to Ötzi's repo at a later date — it has no otzi-headless-specific assumptions, no daemon coupling, and produces a manifest format that both projects share. If Ötzi adopts it, this directory can be lifted with no changes to the pure modules.
