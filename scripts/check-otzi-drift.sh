#!/usr/bin/env bash
# Verify that every file under src/otzi/ is byte-identical to its Ötzi source.
#
# Usage: scripts/check-otzi-drift.sh <otzi-checkout>
#
# Mapping (see facts/otzi.md):
#   src/otzi/lib/<name>      <->  <otzi-checkout>/src/lib/<name>
#   src/otzi/backend/<name>  <->  <otzi-checkout>/backend/src/lib/<name>
#
# The lifted set is listed below (21 files). A file under src/otzi/lib or
# src/otzi/backend that is not on the list, or a listed file that is missing,
# fails the check, as does any byte difference from the checkout. The checkout
# must be a git checkout (its HEAD is reported).
#
# Prints "DRIFT <path>" for each file that differs from, or is missing in, the
# checkout, and exits 1. On success prints "OK: 21 files match <otzi HEAD>".
set -euo pipefail

LIB_FILES=(
  address-book.test.ts address-book.ts bitcoin.test.ts bitcoin.ts crypto.ts
  dkg.fixture.ts dkg.test.ts dkg.ts frost-sign.test.ts frost-sign.ts hex.ts
  share-file.test.ts share-file.ts vault-types.ts
)
BACKEND_FILES=(
  bitcoin.test.ts bitcoin.ts btc-message.test.ts btc-message.ts esplora.ts
  test-vault.fixture.ts types.ts
)
EXPECTED=$(( ${#LIB_FILES[@]} + ${#BACKEND_FILES[@]} ))

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 <otzi-checkout>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OTZI_DIR="$(cd "$1" && pwd)"

# The checkout itself must be a git work tree's top level: a plain copy (or a
# directory inside some other repository) has no HEAD of its own to report.
OTZI_TOP="$(git -C "$OTZI_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$OTZI_TOP" ] || [ "$(cd "$OTZI_TOP" && pwd -P)" != "$(cd "$OTZI_DIR" && pwd -P)" ] \
  || ! OTZI_HEAD="$(git -C "$OTZI_DIR" rev-parse --verify HEAD 2>/dev/null)"; then
  echo "error: $OTZI_DIR is not a git checkout of Ötzi (no HEAD of its own)" >&2
  exit 2
fi

shopt -s nullglob

checked=0
drifted=0

# check_dir <headless dir, relative to repo root> <otzi dir, absolute> <expected names...>
check_dir() {
  local rel="$1" ref_dir="$2" file name
  shift 2
  local expected=" $* "
  for file in "$ROOT/$rel"/*; do
    [ -f "$file" ] || continue
    name="$(basename "$file")"
    if [[ "$expected" != *" $name "* ]]; then
      echo "DRIFT $rel/$name (not a lifted file; headless code lives outside src/otzi/)"
      drifted=$((drifted + 1))
    fi
  done
  for name in "$@"; do
    file="$ROOT/$rel/$name"
    checked=$((checked + 1))
    if [ ! -f "$file" ]; then
      echo "DRIFT $rel/$name (missing here)"
      drifted=$((drifted + 1))
    elif [ ! -f "$ref_dir/$name" ]; then
      echo "DRIFT $rel/$name (missing in $ref_dir)"
      drifted=$((drifted + 1))
    elif ! cmp -s "$file" "$ref_dir/$name"; then
      echo "DRIFT $rel/$name"
      drifted=$((drifted + 1))
    fi
  done
}

check_dir src/otzi/lib "$OTZI_DIR/src/lib" "${LIB_FILES[@]}"
check_dir src/otzi/backend "$OTZI_DIR/backend/src/lib" "${BACKEND_FILES[@]}"

if [ "$checked" -ne "$EXPECTED" ]; then
  echo "error: checked $checked files, expected $EXPECTED" >&2
  exit 1
fi

if [ "$drifted" -gt 0 ]; then
  echo "error: $drifted problem(s) among the $EXPECTED lifted files (checkout $OTZI_DIR)" >&2
  exit 1
fi

echo "OK: $checked files match $OTZI_HEAD"
