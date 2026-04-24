#!/usr/bin/env bash
# Build a Debian package for otzi-headless.
#
# Output: dist/otzi-headless_<version>_<arch>.deb
#
# Strategy: ship the TS source + tsx runtime (matches dev parity — see bin/otzi).
# No tsc compile step; tsconfig.json's `module: "Preserve"` + bundler-style imports
# don't survive raw tsc emit. tsx is a regular dependency, not a dev dep.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG_NAME="otzi-headless"
VERSION=$(node -p "require('./package.json').version")
ARCH=$(dpkg --print-architecture)
PKG_FILE="${PKG_NAME}_${VERSION}_${ARCH}.deb"

STAGE="$(mktemp -d)"
INSTALL_TMP="$(mktemp -d)"
cleanup() { rm -rf "$STAGE" "$INSTALL_TMP"; }
trap cleanup EXIT

echo ">> staging at $STAGE"

# Copy packaging skeleton (DEBIAN/, lib/systemd/, etc/)
cp -a packaging/deb/. "$STAGE/"

# Substitute version + arch into control
sed -i "s/@@VERSION@@/$VERSION/g; s/@@ARCH@@/$ARCH/g" "$STAGE/DEBIAN/control"

# Stage application at /usr/lib/otzi/
APP_DIR="$STAGE/usr/lib/otzi"
mkdir -p "$APP_DIR"
cp -a src vendor bin package.json package-lock.json tsconfig.json "$APP_DIR/"

# Production node_modules — fresh install in a temp dir so the dev tree isn't
# touched. `npm ci` is deterministic against package-lock.json.
echo ">> installing production deps (npm ci --omit=dev)"
cp package.json package-lock.json "$INSTALL_TMP/"
mkdir -p "$INSTALL_TMP/vendor"
cp -a vendor/post-quantum "$INSTALL_TMP/vendor/"
( cd "$INSTALL_TMP" && npm ci --omit=dev --no-audit --no-fund --silent )
cp -a "$INSTALL_TMP/node_modules" "$APP_DIR/"

# Permission baseline — control scripts must be executable
find "$STAGE/DEBIAN" -type f \( -name 'postinst' -o -name 'preinst' -o -name 'postrm' -o -name 'prerm' -o -name 'config' \) -exec chmod 755 {} +

# Build
mkdir -p dist
echo ">> building dist/$PKG_FILE"
dpkg-deb --build --root-owner-group "$STAGE" "dist/$PKG_FILE"
echo ">> done: dist/$PKG_FILE"
