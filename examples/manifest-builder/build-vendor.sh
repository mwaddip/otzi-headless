#!/usr/bin/env bash
# Regenerates examples/manifest-builder/vendor/*.js from npm-installed
# devDependencies. Run from the repo root after upgrading any of:
# preact, @preact/signals, htm, ajv.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"

mkdir -p "$VENDOR_DIR"
cd "$REPO_ROOT"

if [ ! -x "$ESBUILD" ]; then
  echo "esbuild not found at $ESBUILD — run 'npm install' first." >&2
  exit 1
fi

# Use a project-local temp dir so esbuild's node_modules resolution
# walks up into the repo's node_modules. /tmp paths fail to resolve
# bare specifiers like "preact".
TMP="$REPO_ROOT/.esbuild-vendor-tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/preact-entry.js" <<'EOF'
export * from "preact";
EOF

cat > "$TMP/signals-entry.js" <<'EOF'
export * from "@preact/signals";
EOF

cat > "$TMP/htm-entry.js" <<'EOF'
export { default } from "htm";
EOF

cat > "$TMP/ajv-entry.js" <<'EOF'
export { default } from "ajv/dist/2020.js";
EOF

# preact: standalone bundle.
"$ESBUILD" --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$VENDOR_DIR/preact.js" --log-level=warning \
  "$TMP/preact-entry.js"

# preact/hooks: bundle the actual file directly. We can't use a re-export
# entry — esbuild's --external:preact matches subpaths too (so a
# `from "preact/hooks"` re-export becomes external). Pointing at the
# package's `module` field file forces esbuild to bundle the contents
# while keeping the inner `import "preact"` external.
PREACT_HOOKS_MODULE="$REPO_ROOT/node_modules/preact/hooks/dist/hooks.module.js"
if [ ! -f "$PREACT_HOOKS_MODULE" ]; then
  echo "preact/hooks module file not found at $PREACT_HOOKS_MODULE — preact upgrade may have changed the layout." >&2
  exit 1
fi
"$ESBUILD" --bundle --format=esm --target=es2022 --platform=browser \
  --external:preact \
  --outfile="$VENDOR_DIR/preact-hooks.js" --log-level=warning \
  "$PREACT_HOOKS_MODULE"

# @preact/signals: externalize preact + preact/* so signals shares the runtime instance.
"$ESBUILD" --bundle --format=esm --target=es2022 --platform=browser \
  --external:preact --external:preact/* \
  --outfile="$VENDOR_DIR/signals.js" --log-level=warning \
  "$TMP/signals-entry.js"

# htm: standalone, default export.
"$ESBUILD" --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$VENDOR_DIR/htm.js" --log-level=warning \
  "$TMP/htm-entry.js"

# ajv: draft-2020-12 build + default export (Ajv class).
"$ESBUILD" --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$VENDOR_DIR/ajv.js" --log-level=warning \
  "$TMP/ajv-entry.js"

echo "Vendor bundles regenerated in $VENDOR_DIR:"
ls -la "$VENDOR_DIR"
