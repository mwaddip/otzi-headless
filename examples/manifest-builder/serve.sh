#!/usr/bin/env bash
# Serves the manifest builder over HTTP so ES modules can load.
# Modern browsers (Firefox + Chromium) refuse to load `<script type="module">`
# from file:// URLs — every file:// path is treated as a unique origin.
#
# Usage: bash examples/manifest-builder/serve.sh [port]
# Default port is 8765.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8765}"

cd "$SCRIPT_DIR"

if command -v python3 >/dev/null 2>&1; then
  echo "Serving $SCRIPT_DIR on http://localhost:$PORT/"
  echo "Open: http://localhost:$PORT/index.html"
  echo "Ctrl-C to stop."
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  echo "Serving $SCRIPT_DIR on http://localhost:$PORT/"
  echo "Open: http://localhost:$PORT/index.html"
  exec python -m SimpleHTTPServer "$PORT"
else
  echo "Need python3 (or python) to serve. Install one or use any other static-file server pointed at $SCRIPT_DIR." >&2
  exit 1
fi
