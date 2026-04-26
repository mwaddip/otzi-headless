#!/usr/bin/env bash
# Bundles the manifest builder into a single self-contained `bundled.html`
# that opens directly from `file://` (no localhost server needed).
#
# Run from the repo root after editing any of:
#   app.js, model.js, validation.js, slugify.js, schema.js, schema.json,
#   index.html (template — styles + body markup are lifted from it).
#
# Output: examples/manifest-builder/bundled.html (single file, ~160 KB).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"

if [ ! -x "$ESBUILD" ]; then
  echo "esbuild not found at $ESBUILD — run 'npm install' first." >&2
  exit 1
fi

cd "$SCRIPT_DIR"

BUNDLE_TMP="$(mktemp)"
trap 'rm -f "$BUNDLE_TMP"' EXIT

# IIFE bundle: resolves preact / @preact/signals / htm / ajv from the repo's
# node_modules, plus the local relative imports. Output is one self-contained
# classic <script> body, safe to inline.
"$ESBUILD" app.js \
  --bundle \
  --format=iife \
  --target=es2022 \
  --platform=browser \
  --minify \
  --outfile="$BUNDLE_TMP" \
  --log-level=warning

node -e '
  const fs = require("node:fs");
  const html = fs.readFileSync("index.html", "utf8");
  const bundle = fs.readFileSync(process.argv[1], "utf8");
  // Replacement strings get $& / $1 / $$ etc. interpreted by String.replace.
  // The bundled JS contains literal $& (in ajv URI-encoding regex), so we
  // pass replacement as a function — function returns are NOT interpreted.
  const out = html
    .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, "")
    .replace(/<script type="module" src="\.\/app\.js"><\/script>/,
             () => "<script>\n" + bundle + "\n</script>");
  if (out === html) {
    console.error("build.sh: index.html template did not match expected importmap+module-script tags");
    process.exit(1);
  }
  fs.writeFileSync("bundled.html", out);
' "$BUNDLE_TMP"

SIZE_KB=$(($(wc -c < bundled.html) / 1024))
echo ">> $SCRIPT_DIR/bundled.html (${SIZE_KB} KB) — open from file:// directly, no server needed."
