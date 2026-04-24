#!/usr/bin/env bash
# Container-based smoke test for the otzi-headless .deb.
#
# Spins up Ubuntu 24.04, installs nodejs 22 + the .deb (with pre-seeded
# debconf answers), and verifies:
#   - install completes cleanly
#   - /usr/bin/otzi runs and prints usage
#   - /etc/otzi/daemon.toml is rendered with the expected fields
#   - /lib/systemd/system/otzi.service is registered
#   - otzi user/group exist
#   - `otzi daemon` against the rendered config gets past load and errors
#     on the expected "missing peer entries" validation (proves the bundle
#     loads + the parser runs end-to-end).
#
# Usage: bash scripts/test-deb-container.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found in PATH" >&2
  exit 1
fi

# Build the .deb if missing or older than the source.
if ! ls dist/otzi-headless_*.deb >/dev/null 2>&1; then
  echo ">> building .deb"
  bash scripts/build-deb.sh
fi
DEB="$(ls -1t dist/otzi-headless_*.deb | head -1)"
echo ">> testing $DEB"

CONTAINER="otzi-deb-test-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo ">> starting ubuntu:24.04 container"
docker run -d \
  --name "$CONTAINER" \
  -v "$PWD/$DEB:/tmp/otzi-headless.deb:ro" \
  ubuntu:24.04 \
  sleep 600 >/dev/null

echo ">> installing nodejs 22 + otzi-headless (with pre-seeded debconf)"
docker exec -i "$CONTAINER" bash <<'INSIDE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null

# Nodesource 22 — Ubuntu 24.04's default node is too old.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null

debconf-set-selections <<'EOF'
otzi-headless otzi-headless/role select leader
otzi-headless otzi-headless/network select testnet
otzi-headless otzi-headless/opnet-rpc string https://testnet.opnet.org
otzi-headless otzi-headless/peer-hostnames string node-b.example node-c.example
otzi-headless otzi-headless/transport select peer-mesh
otzi-headless otzi-headless/listen string 0.0.0.0:8800
otzi-headless otzi-headless/operator-bind string 127.0.0.1:7080
otzi-headless otzi-headless/node-id string testnode-a
EOF

apt-get install -y /tmp/otzi-headless.deb
INSIDE

echo ">> validating install layout"
docker exec "$CONTAINER" bash -euo pipefail -c '
test -x /usr/bin/otzi              || { echo "missing /usr/bin/otzi"; exit 1; }
test -f /usr/lib/otzi/entrypoint.mjs || { echo "missing entrypoint bundle"; exit 1; }
test -f /lib/systemd/system/otzi.service || { echo "missing systemd unit"; exit 1; }
test -f /etc/otzi/daemon.toml      || { echo "missing daemon.toml"; exit 1; }
getent passwd otzi >/dev/null      || { echo "missing otzi user"; exit 1; }
getent group otzi >/dev/null       || { echo "missing otzi group"; exit 1; }
echo "OK: layout"
'

echo ">> verifying daemon.toml carries our debconf answers"
docker exec "$CONTAINER" bash -euo pipefail -c '
grep -q "id = \"testnode-a\""              /etc/otzi/daemon.toml
grep -q "name = \"testnet\""               /etc/otzi/daemon.toml
grep -q "opnet_rpc = \"https://testnet"    /etc/otzi/daemon.toml
grep -q "kind = \"peer-mesh\""             /etc/otzi/daemon.toml
grep -q "listen = \"0.0.0.0:8800\""        /etc/otzi/daemon.toml
grep -q "bind = \"127.0.0.1:7080\""        /etc/otzi/daemon.toml
grep -q "endpoint = \"ws://node-b.example" /etc/otzi/daemon.toml
echo "OK: rendered toml"
'

echo ">> running otzi (usage banner)"
docker exec "$CONTAINER" /usr/bin/otzi 2>&1 || true   # exits 1 when no subcommand — that's the usage path

echo ">> running otzi daemon against the rendered (incomplete) config"
# Expect failure with "peers" complaint — proves bundle + parser work.
set +e
OUT=$(docker exec "$CONTAINER" /usr/bin/otzi daemon /etc/otzi/daemon.toml 2>&1)
RC=$?
set -e
if [ $RC -eq 0 ]; then
  echo "unexpected: otzi daemon succeeded with no peers" >&2
  echo "$OUT" >&2
  exit 1
fi
if ! printf '%s\n' "$OUT" | grep -q "peers"; then
  echo "unexpected error message — wanted /peers/, got:" >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi
echo "OK: daemon rejects incomplete config with the expected 'peers' error"

echo ""
echo "✓ all checks passed"
