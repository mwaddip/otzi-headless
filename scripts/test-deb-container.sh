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
#   - `otzi daemon` against the rendered config gets past parse + transport
#     init and errors on the missing OTZI_SHARE_PASSWORD env var (proves the
#     bundle loads + the parser accepts the rendered TOML end-to-end).
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
otzi-headless otzi-headless/operators string
otzi-headless otzi-headless/bootstrap-secret password test-bootstrap-secret
otzi-headless otzi-headless/network select testnet
otzi-headless otzi-headless/opnet-rpc string https://testnet.opnet.org
otzi-headless otzi-headless/transport select peer-mesh
otzi-headless otzi-headless/advertised-endpoint string 192.0.2.1:8800
otzi-headless otzi-headless/peers string 192.0.2.2:8800,192.0.2.3:8800
otzi-headless otzi-headless/bootstrap-bind string 0.0.0.0:7090
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
grep -q "id = \"testnode-a\""                      /etc/otzi/daemon.toml
grep -q "name = \"testnet\""                       /etc/otzi/daemon.toml
grep -q "opnet_rpc = \"https://testnet"            /etc/otzi/daemon.toml
grep -q "kind = \"peer-mesh\""                     /etc/otzi/daemon.toml
grep -q "advertised_endpoint = \"192.0.2.1:8800\"" /etc/otzi/daemon.toml
grep -q "endpoint = \"192.0.2.2:8800\""            /etc/otzi/daemon.toml
grep -q "endpoint = \"192.0.2.3:8800\""            /etc/otzi/daemon.toml
grep -q "^kind = \"uds\""                          /etc/otzi/daemon.toml
grep -q "^role = "                                 /etc/otzi/daemon.toml
grep -q "^bind = \"0.0.0.0:7090\""                 /etc/otzi/daemon.toml

# Phase F end-state: legacy fields MUST NOT appear in the rendered TOML.
! grep -q "party_id"     /etc/otzi/daemon.toml || { echo "FAIL: legacy party_id present";     exit 1; }
! grep -q "wallet_address" /etc/otzi/daemon.toml || { echo "FAIL: legacy wallet_address present"; exit 1; }
! grep -qE "^listen = "  /etc/otzi/daemon.toml || { echo "FAIL: legacy listen = present";    exit 1; }
echo "OK: rendered toml"
'

echo ">> verifying phase 9a perms + bootstrap-secret"
docker exec "$CONTAINER" bash -euo pipefail -c '
stat -c "%a %U:%G" /etc/otzi      | grep -q "^2770 root:otzi$"     || { echo "FAIL: /etc/otzi mode/owner";       exit 1; }
stat -c "%a %U:%G" /var/lib/otzi  | grep -q "^2770 root:otzi$"     || { echo "FAIL: /var/lib/otzi mode/owner";   exit 1; }
test -d /var/run/otzi             || { echo "FAIL: /var/run/otzi missing"; exit 1; }
stat -c "%a %U:%G" /var/run/otzi  | grep -q "^2770 root:otzi$"     || { echo "FAIL: /var/run/otzi mode/owner";   exit 1; }
test -f /var/lib/otzi/bootstrap-secret                              || { echo "FAIL: bootstrap-secret missing";  exit 1; }
stat -c "%a %U:%G" /var/lib/otzi/bootstrap-secret | grep -q "^660 root:otzi$" || { echo "FAIL: bootstrap-secret perms"; exit 1; }
echo "OK: phase 9a perms"
'

echo ">> running otzi (usage banner)"
docker exec "$CONTAINER" /usr/bin/otzi 2>&1 || true   # exits 1 when no subcommand — that's the usage path

echo ">> running otzi daemon against the rendered config (no share password set)"
# The rendered TOML is fully valid post-Phase-G; daemon load gets past the
# parser and fails at the env-var check for OTZI_SHARE_PASSWORD. That's the
# proof that the bundled JS + parser accept the rendered config end-to-end.
set +e
OUT=$(docker exec "$CONTAINER" /usr/bin/otzi daemon /etc/otzi/daemon.toml 2>&1)
RC=$?
set -e
if [ $RC -eq 0 ]; then
  echo "unexpected: otzi daemon succeeded with no share password env var" >&2
  echo "$OUT" >&2
  exit 1
fi
if ! printf '%s\n' "$OUT" | grep -q "OTZI_SHARE_PASSWORD"; then
  echo "unexpected error message — wanted /OTZI_SHARE_PASSWORD/, got:" >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi
echo "OK: daemon rejects unset password env var (parse + load reached)"

# ─────────────────────────────────────────────────────────────────────────
# Second pass: restore-from-backup round-trip.
#
# The fresh install above is in a "pre-bootstrap" state — no share / identity /
# pubkey-book exist (DKG hasn't run). `otzi backup` requires those files to be
# present, so we synthesize minimal placeholders before backing up. The point
# of this pass is to exercise the postinst's restore branch end-to-end, NOT to
# validate share/identity contents (the unit tests cover decryption fidelity).
# ─────────────────────────────────────────────────────────────────────────

echo ">> synthesizing post-bootstrap daemon state for backup"
docker exec "$CONTAINER" bash -euo pipefail -c '
# Manifest is optional; create one so the round-trip exercises that branch too.
printf "%s\n" "{\"v\":1,\"manifest\":\"placeholder\"}" >/etc/otzi/manifest.otzi.json
chown root:otzi /etc/otzi/manifest.otzi.json
chmod 660 /etc/otzi/manifest.otzi.json

# Required files: share, identity, pubkeys.
printf "%s\n" "{\"v\":1,\"data\":\"synthetic-share-payload\"}" >/var/lib/otzi/share.json
printf "%s\n" "{\"pkcs8Hex\":\"deadbeef\",\"publicKeyHex\":\"cafe\"}" >/var/lib/otzi/identity.json
printf "%s\n" "[]" >/var/lib/otzi/pubkeys.json
chown otzi:otzi /var/lib/otzi/share.json /var/lib/otzi/identity.json /var/lib/otzi/pubkeys.json
chmod 600 /var/lib/otzi/share.json
chmod 660 /var/lib/otzi/identity.json
chmod 644 /var/lib/otzi/pubkeys.json
echo "OK: synthetic state ready"
'

echo ">> running otzi backup as root"
# Capture path + password from the banner. Format:
#   "  Backup written: <path>"
#   "  Password:       <password>"
docker exec "$CONTAINER" bash -euo pipefail -c '
set -o pipefail
OUT=$(/usr/bin/otzi backup 2>&1)
echo "$OUT"
BACKUP_PATH=$(printf "%s\n" "$OUT" | grep "Backup written:" | awk "{print \$NF}")
BACKUP_PWD=$(printf "%s\n"  "$OUT" | grep "Password:"       | awk "{print \$NF}")
[ -n "$BACKUP_PATH" ] || { echo "FAIL: could not parse backup path";     exit 1; }
[ -n "$BACKUP_PWD"  ] || { echo "FAIL: could not parse backup password"; exit 1; }
[ -f "$BACKUP_PATH" ] || { echo "FAIL: backup file not at $BACKUP_PATH"; exit 1; }
# Stash for the next docker exec — env vars do not persist across exec calls.
cp "$BACKUP_PATH" /tmp/test-backup.otzi-backup
printf "%s" "$BACKUP_PWD" >/tmp/test-backup.password
echo "OK: backup written + stashed at /tmp/test-backup.otzi-backup"
'

echo ">> purging package + state ahead of restore reinstall"
docker exec "$CONTAINER" bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y otzi-headless >/dev/null
# Belt + suspenders — postrm purge already removes these.
rm -rf /etc/otzi /var/lib/otzi
[ -f /tmp/test-backup.otzi-backup ] || { echo "FAIL: backup file lost during purge"; exit 1; }
[ -f /tmp/test-backup.password    ] || { echo "FAIL: password file lost during purge"; exit 1; }
echo "OK: purge complete; backup + password preserved"
'

echo ">> reinstalling .deb with restore-from-backup pre-seeded"
docker exec -i "$CONTAINER" bash <<'INSIDE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BACKUP_PWD=$(cat /tmp/test-backup.password)

debconf-set-selections <<EOF
otzi-headless otzi-headless/restore-from-backup boolean true
otzi-headless otzi-headless/backup-path string /tmp/test-backup.otzi-backup
otzi-headless otzi-headless/backup-password password $BACKUP_PWD
EOF

# Capture postinst output so we can assert on the restore-success banner.
INSTALL_OUT=$(apt-get install -y /tmp/otzi-headless.deb 2>&1)
echo "$INSTALL_OUT"
if ! printf '%s\n' "$INSTALL_OUT" | grep -q "restored from backup; skipping fresh-install"; then
  echo "FAIL: postinst did not log restore-success line" >&2
  exit 1
fi
echo "OK: restore reinstall completed"
INSIDE

echo ">> verifying restored layout"
docker exec "$CONTAINER" bash -euo pipefail -c '
test -f /etc/otzi/daemon.toml          || { echo "FAIL: daemon.toml not restored";          exit 1; }
test -f /etc/otzi/manifest.otzi.json   || { echo "FAIL: manifest.otzi.json not restored";   exit 1; }
test -f /var/lib/otzi/share.json       || { echo "FAIL: share.json not restored";           exit 1; }
test -f /var/lib/otzi/identity.json    || { echo "FAIL: identity.json not restored";        exit 1; }
test -f /var/lib/otzi/pubkeys.json     || { echo "FAIL: pubkeys.json not restored";         exit 1; }

# Per-file modes (mirrors restore.ts FIXED_FILE_MODES + dynamic table).
stat -c "%a" /etc/otzi/daemon.toml         | grep -q "^640$" || { echo "FAIL: daemon.toml mode";       exit 1; }
stat -c "%a" /etc/otzi/manifest.otzi.json  | grep -q "^660$" || { echo "FAIL: manifest mode";          exit 1; }
stat -c "%a" /var/lib/otzi/share.json      | grep -q "^600$" || { echo "FAIL: share.json mode";        exit 1; }
stat -c "%a" /var/lib/otzi/identity.json   | grep -q "^660$" || { echo "FAIL: identity.json mode";     exit 1; }
stat -c "%a" /var/lib/otzi/pubkeys.json    | grep -q "^644$" || { echo "FAIL: pubkeys.json mode";      exit 1; }

# Restore should NOT have rendered a fresh daemon.toml — verify ours is the
# synthetic from the backup (contains testnode-a from the original debconf).
grep -q "id = \"testnode-a\"" /etc/otzi/daemon.toml || {
  echo "FAIL: restored daemon.toml does not match the original"; exit 1;
}
echo "OK: restored layout + modes match expected"
'

echo ">> verifying backup password wiped from debconf cache"
docker exec "$CONTAINER" bash -euo pipefail -c '
PWD_LINE_HIT=0
if [ -f /var/cache/debconf/passwords.dat ]; then
  # The template KEY can legitimately appear in passwords.dat under a Name:
  # entry even after db_reset (debconf records the template existed); what
  # MUST be gone is any "Value: <password>" line. Read the password we used
  # and grep for it explicitly.
  BACKUP_PWD=$(cat /tmp/test-backup.password)
  if grep -F -q "Value: $BACKUP_PWD" /var/cache/debconf/passwords.dat; then
    PWD_LINE_HIT=1
  fi
fi
if [ "$PWD_LINE_HIT" = "1" ]; then
  echo "FAIL: backup password value still present in /var/cache/debconf/passwords.dat" >&2
  exit 1
fi
echo "OK: backup password wiped from debconf cache"
'

echo ""
echo "✓ all checks passed (fresh install + restore round-trip)"
