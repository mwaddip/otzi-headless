#!/usr/bin/env bash
# Build a Debian package for otzi-headless.
#
# Output: dist/otzi-headless_<version>_<arch>.deb
#
# Strategy: esbuild bundles src/daemon/entrypoint.ts into a single ESM file
# at /usr/lib/otzi/entrypoint.mjs. Vendor/post-quantum (pure JS) is inlined.
# No node_modules, no tsx runtime — just one .mjs + the wrapper at /usr/bin/otzi.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG_NAME="otzi-headless"
VERSION=$(node -p "require('./package.json').version")
ARCH=$(dpkg --print-architecture)
PKG_FILE="${PKG_NAME}_${VERSION}_${ARCH}.deb"

STAGE="$(mktemp -d)"
trap "rm -rf $STAGE" EXIT

echo ">> staging at $STAGE"

# Copy packaging skeleton (DEBIAN/, lib/systemd/, usr/bin/, etc/)
cp -a packaging/deb/. "$STAGE/"

# Substitute version + arch into control
sed -i "s/@@VERSION@@/$VERSION/g; s/@@ARCH@@/$ARCH/g" "$STAGE/DEBIAN/control"

# Bundle the daemon entrypoint. Banner installs createRequire so any CJS
# transitive dep (e.g. @noble/hashes/cryptoNode in bip39) can `require('node:crypto')`
# at runtime through esbuild's __require shim.
APP_DIR="$STAGE/usr/lib/otzi"
mkdir -p "$APP_DIR"
echo ">> bundling entrypoint with esbuild"
./node_modules/.bin/esbuild src/daemon/entrypoint.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --outfile="$APP_DIR/entrypoint.mjs" \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --log-level=error

# Permission baseline
find "$STAGE/DEBIAN" -type f \( -name 'postinst' -o -name 'preinst' -o -name 'postrm' -o -name 'prerm' -o -name 'config' \) -exec chmod 755 {} +
chmod 755 "$STAGE/usr/bin/otzi"

mkdir -p dist
echo ">> building dist/$PKG_FILE"
dpkg-deb --build --root-owner-group "$STAGE" "dist/$PKG_FILE"
echo ">> done: dist/$PKG_FILE"
