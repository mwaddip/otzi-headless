#!/usr/bin/env bash
# Verify that every file under src/otzi/ is byte-identical to its Ötzi source.
#
# Usage: scripts/check-otzi-drift.sh <otzi-checkout>
#
# Mapping (see facts/otzi.md):
#   src/otzi/lib/<name>      <->  <otzi-checkout>/src/lib/<name>
#   src/otzi/backend/<name>  <->  <otzi-checkout>/backend/src/lib/<name>
#
# Prints "DRIFT <path>" for each file that differs from, or is missing in, the
# checkout, and exits 1. On success prints "OK: <n> files match <otzi HEAD>".
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 <otzi-checkout>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OTZI_DIR="$(cd "$1" && pwd)"

shopt -s nullglob

checked=0
drifted=0

# check_dir <headless dir, relative to repo root> <otzi dir, absolute>
check_dir() {
  local rel="$1" ref_dir="$2" file name
  for file in "$ROOT/$rel"/*; do
    [ -f "$file" ] || continue
    name="$(basename "$file")"
    checked=$((checked + 1))
    if [ ! -f "$ref_dir/$name" ]; then
      echo "DRIFT $rel/$name (missing in $ref_dir)"
      drifted=$((drifted + 1))
    elif ! cmp -s "$file" "$ref_dir/$name"; then
      echo "DRIFT $rel/$name"
      drifted=$((drifted + 1))
    fi
  done
}

check_dir src/otzi/lib "$OTZI_DIR/src/lib"
check_dir src/otzi/backend "$OTZI_DIR/backend/src/lib"

if [ "$checked" -eq 0 ]; then
  echo "error: no files found under src/otzi/lib or src/otzi/backend" >&2
  exit 1
fi

if [ "$drifted" -gt 0 ]; then
  echo "error: $drifted of $checked files drifted from $OTZI_DIR" >&2
  exit 1
fi

echo "OK: $checked files match $(git -C "$OTZI_DIR" rev-parse HEAD)"
