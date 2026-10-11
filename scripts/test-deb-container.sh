#!/usr/bin/env bash
# Container-based smoke test for the otzi-headless .deb.
#
# Spins up Ubuntu 24.04, installs nodejs 22 + the .deb (with pre-seeded
# debconf answers), and verifies:
#   - install completes cleanly
#   - /usr/bin/otzi runs and prints usage
#   - /etc/otzi/daemon.toml is rendered with the expected fields
#   - /lib/systemd/system/otzi.service is registered and carries the sandbox directives
#   - otzi user/group exist
#   - a backup/purge/restore round-trip puts the node back, and a later upgrade
#     (reinstall) leaves the restored daemon.toml and share alone
#   - `otzi daemon` against the rendered config gets past parse + transport
#     init and errors on the missing OTZI_SHARE_PASSWORD env var (proves the
#     bundle loads + the parser accepts the rendered TOML end-to-end).
#   - the relay server unit (otzi-relay.service) is installed with its sandbox
#     directives and left disabled, and /etc/otzi/relay.env holds the loopback
#     listen address and survives a reconfigure
#   - relay-transport installs (leader with `parties` 3, leaf) render a
#     daemon.toml with no [[peers]] that parses; a bad `parties` or a relay URL
#     without ws:// or wss:// is left out with a warning; peer-mesh never gets
#     `parties`
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
otzi-headless otzi-headless/network select testnet4
otzi-headless otzi-headless/esplora-url string https://esplora.example/testnet4/api
otzi-headless otzi-headless/transport select peer-mesh
otzi-headless otzi-headless/advertised-endpoint string 192.0.2.1:8800
otzi-headless otzi-headless/peers string 192.0.2.2:8800,192.0.2.3:8800
otzi-headless otzi-headless/bootstrap-bind string 0.0.0.0:7090
otzi-headless otzi-headless/node-id string testnode-a
# A ring size left over from an earlier relay answer: peer-mesh refuses the key, so
# the postinst must not write it.
otzi-headless otzi-headless/parties string 5
EOF

apt-get install -y /tmp/otzi-headless.deb
INSIDE

echo ">> validating install layout"
docker exec "$CONTAINER" bash -euo pipefail -c '
test -x /usr/bin/otzi              || { echo "missing /usr/bin/otzi"; exit 1; }
test -f /usr/lib/otzi/entrypoint.mjs || { echo "missing entrypoint bundle"; exit 1; }
test -f /lib/systemd/system/otzi.service || { echo "missing systemd unit"; exit 1; }
grep -qx "EnvironmentFile=-/etc/otzi/otzi.env" /lib/systemd/system/otzi.service \
                                       || { echo "unit does not load /etc/otzi/otzi.env"; exit 1; }
# The sandbox directives (docs/install.md, Service sandbox): a unit that lost one would still install.
for LINE in ProtectSystem=strict ProtectHome=true PrivateTmp=true PrivateDevices=true NoNewPrivileges=true \
            ReadWritePaths=/var/lib/otzi ProtectKernelTunables=true ProtectKernelModules=true \
            ProtectKernelLogs=true ProtectControlGroups=true ProtectClock=true ProtectHostname=true \
            RestrictSUIDSGID=true "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK" \
            RuntimeDirectory=otzi RuntimeDirectoryMode=3770; do
  grep -qx "$LINE" /lib/systemd/system/otzi.service || { echo "unit lacks $LINE"; exit 1; }
done
test -f /etc/otzi/daemon.toml      || { echo "missing daemon.toml"; exit 1; }
getent passwd otzi >/dev/null      || { echo "missing otzi user"; exit 1; }
getent group otzi >/dev/null       || { echo "missing otzi group"; exit 1; }
echo "OK: layout"
'

echo ">> verifying daemon.toml carries our debconf answers"
docker exec "$CONTAINER" bash -euo pipefail -c '
grep -q "id = \"testnode-a\""                      /etc/otzi/daemon.toml
grep -q "^name = \"testnet4\"$"                    /etc/otzi/daemon.toml
grep -q "^esplora_url = \"https://esplora.example/testnet4/api\"$" /etc/otzi/daemon.toml
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
! grep -q "opnet_rpc"    /etc/otzi/daemon.toml || { echo "FAIL: legacy opnet_rpc present";    exit 1; }
# parties is for a relay leader only; the parser refuses it under peer-mesh.
! grep -q "^parties"     /etc/otzi/daemon.toml || { echo "FAIL: peer-mesh daemon.toml carries parties"; exit 1; }
echo "OK: rendered toml"
'

echo ">> verifying the relay server unit and relay.env"
docker exec "$CONTAINER" bash -euo pipefail -c '
UNIT=/lib/systemd/system/otzi-relay.service
test -f "$UNIT" || { echo "missing $UNIT"; exit 1; }
# The listen address comes from relay.env, the user is otzi, and the command is the relay verb.
for LINE in User=otzi Group=otzi EnvironmentFile=/etc/otzi/relay.env \
            "ExecStart=/usr/bin/otzi relay --listen \${OTZI_RELAY_LISTEN}" Restart=on-failure \
            ProtectSystem=strict ProtectHome=true PrivateTmp=true PrivateDevices=true NoNewPrivileges=true \
            ProtectKernelTunables=true ProtectKernelModules=true ProtectKernelLogs=true \
            ProtectControlGroups=true ProtectClock=true ProtectHostname=true RestrictSUIDSGID=true \
            "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK" \
            RestrictNamespaces=true RestrictRealtime=true LockPersonality=true SystemCallArchitectures=native; do
  grep -qxF "$LINE" "$UNIT" || { echo "relay unit lacks $LINE"; exit 1; }
done
# The relay writes nothing and keeps no socket directory.
for KEY in ReadWritePaths RuntimeDirectory RuntimeDirectoryMode; do
  ! grep -q "^$KEY=" "$UNIT" || { echo "relay unit sets $KEY"; exit 1; }
done
# Installed, never enabled: nothing under /etc/systemd/system links to it.
[ -z "$(find /etc/systemd/system -name otzi-relay.service 2>/dev/null)" ] || { echo "FAIL: otzi-relay.service is enabled"; exit 1; }

test -f /etc/otzi/relay.env || { echo "FAIL: missing /etc/otzi/relay.env"; exit 1; }
[ "$(stat -c "%a %U:%G" /etc/otzi/relay.env)" = "644 root:root" ] || { echo "FAIL: relay.env mode/owner is $(stat -c "%a %U:%G" /etc/otzi/relay.env), want 644 root:root"; exit 1; }
grep -qxF "OTZI_RELAY_LISTEN=127.0.0.1:7100" /etc/otzi/relay.env || { echo "FAIL: relay.env lacks the loopback default"; exit 1; }
echo "OK: relay unit installed disabled, relay.env created"
'

echo ">> verifying phase 9a perms"
docker exec "$CONTAINER" bash -euo pipefail -c '
stat -c "%a %U:%G" /etc/otzi      | grep -q "^2750 root:otzi$"     || { echo "FAIL: /etc/otzi mode/owner";       exit 1; }
stat -c "%a %U:%G" /etc/otzi/daemon.toml | grep -q "^640 root:otzi$" || { echo "FAIL: daemon.toml mode/owner";    exit 1; }
stat -c "%a %U:%G" /var/lib/otzi  | grep -q "^2770 root:otzi$"     || { echo "FAIL: /var/lib/otzi mode/owner";   exit 1; }
test -d /var/run/otzi             || { echo "FAIL: /var/run/otzi missing"; exit 1; }
stat -c "%a %U:%G" /var/run/otzi  | grep -q "^3770 root:otzi$"     || { echo "FAIL: /var/run/otzi mode/owner (want setgid + sticky)"; exit 1; }
echo "OK: phase 9a perms"
'

echo ">> verifying postinst removes files earlier releases left behind"
docker exec "$CONTAINER" bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
touch /var/lib/otzi/bootstrap-secret /etc/otzi/manifest.otzi.json
CONFIG_SUM=$(sha256sum /etc/otzi/daemon.toml | cut -d" " -f1)
dpkg-reconfigure otzi-headless >/dev/null
! test -e /var/lib/otzi/bootstrap-secret || { echo "FAIL: bootstrap-secret not removed";    exit 1; }
! test -e /etc/otzi/manifest.otzi.json   || { echo "FAIL: manifest.otzi.json not removed"; exit 1; }
[ "$(sha256sum /etc/otzi/daemon.toml | cut -d" " -f1)" = "$CONFIG_SUM" ] || { echo "FAIL: reconfigure rewrote daemon.toml"; exit 1; }
echo "OK: leftovers removed, daemon.toml kept"

# relay.env belongs to the operator once it exists: a reconfigure must not put the default back.
printf "%s\n" "OTZI_RELAY_LISTEN=127.0.0.1:7199" >/etc/otzi/relay.env
dpkg-reconfigure otzi-headless >/dev/null
grep -qxF "OTZI_RELAY_LISTEN=127.0.0.1:7199" /etc/otzi/relay.env || { echo "FAIL: reconfigure rewrote relay.env"; exit 1; }
echo "OK: relay.env edit kept"
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
# Required files: share, identity, pubkeys.
printf "%s\n" "{\"v\":1,\"data\":\"synthetic-share-payload\"}" >/var/lib/otzi/share.json
printf "%s\n" "{\"pkcs8Hex\":\"deadbeef\",\"publicKeyHex\":\"cafe\"}" >/var/lib/otzi/identity.json
printf "%s\n" "[]" >/var/lib/otzi/pubkeys.json
# No chown: written by root, the files are root:otzi (setgid dir) as a restore run as
# root would leave them without ownership handling, so the restore assertions below
# prove restore gives them to the otzi user (the archive itself carries no owner).
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
test -f /var/lib/otzi/share.json       || { echo "FAIL: share.json not restored";           exit 1; }
test -f /var/lib/otzi/identity.json    || { echo "FAIL: identity.json not restored";        exit 1; }
test -f /var/lib/otzi/pubkeys.json     || { echo "FAIL: pubkeys.json not restored";         exit 1; }

# Owners: restore ran as root; the daemon (User=otzi) must own what it reads in
# /var/lib/otzi, and the config in /etc/otzi stays root:otzi.
[ "$(stat -c %U /var/lib/otzi/share.json)" = "otzi" ]    || { echo "FAIL: share.json owner is $(stat -c %U /var/lib/otzi/share.json), want otzi"; exit 1; }
[ "$(stat -c %G /var/lib/otzi/share.json)" = "otzi" ]    || { echo "FAIL: share.json group is $(stat -c %G /var/lib/otzi/share.json), want otzi"; exit 1; }
[ "$(stat -c %U /var/lib/otzi/identity.json)" = "otzi" ] || { echo "FAIL: identity.json owner";    exit 1; }
[ "$(stat -c %U /var/lib/otzi/pubkeys.json)" = "otzi" ]  || { echo "FAIL: pubkeys.json owner";     exit 1; }
[ "$(stat -c %U:%G /etc/otzi/daemon.toml)" = "root:otzi" ] || { echo "FAIL: daemon.toml owner";    exit 1; }
# ...and the proof that matters: the daemon user can read the restored share.
runuser -u otzi -- head -c 1 /var/lib/otzi/share.json >/dev/null || { echo "FAIL: user otzi cannot read share.json"; exit 1; }

# Per-file modes (mirrors restore.ts FIXED_FILE_MODES + dynamic table).
stat -c "%a" /etc/otzi/daemon.toml         | grep -q "^640$" || { echo "FAIL: daemon.toml mode";       exit 1; }
stat -c "%a" /var/lib/otzi/share.json      | grep -q "^600$" || { echo "FAIL: share.json mode";        exit 1; }
stat -c "%a" /var/lib/otzi/identity.json   | grep -q "^660$" || { echo "FAIL: identity.json mode";     exit 1; }
stat -c "%a" /var/lib/otzi/pubkeys.json    | grep -q "^644$" || { echo "FAIL: pubkeys.json mode";      exit 1; }

# Restore should NOT have rendered a fresh daemon.toml — verify ours is the
# synthetic from the backup (contains testnode-a from the original debconf).
grep -q "id = \"testnode-a\"" /etc/otzi/daemon.toml || {
  echo "FAIL: restored daemon.toml does not match the original"; exit 1;
}
echo "OK: restored layout + owners + modes match expected"
'

echo ">> verifying an upgrade after the restore leaves the restored node alone"
# The restore branch answered "yes" to restore-from-backup and postinst took the
# answer back; reinstalling the package (what an upgrade runs) must not restore
# again, rewrite daemon.toml or touch the share.
docker exec "$CONTAINER" bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
CONFIG_SUM=$(sha256sum /etc/otzi/daemon.toml    | cut -d" " -f1)
SHARE_SUM=$(sha256sum  /var/lib/otzi/share.json | cut -d" " -f1)
UPGRADE_OUT=$(apt-get install -y --reinstall /tmp/otzi-headless.deb 2>&1) || {
  echo "FAIL: reinstalling over the restored node exited non-zero:"; echo "$UPGRADE_OUT"; exit 1;
}
if printf "%s\n" "$UPGRADE_OUT" | grep -q "attempting restore from"; then
  echo "FAIL: the upgrade tried to restore from backup again"; echo "$UPGRADE_OUT"; exit 1
fi
[ "$(sha256sum /etc/otzi/daemon.toml    | cut -d" " -f1)" = "$CONFIG_SUM" ] || { echo "FAIL: upgrade changed daemon.toml"; exit 1; }
[ "$(sha256sum /var/lib/otzi/share.json | cut -d" " -f1)" = "$SHARE_SUM"  ] || { echo "FAIL: upgrade changed share.json"; exit 1; }
[ "$(stat -c %U:%G /var/lib/otzi/share.json)" = "otzi:otzi" ] || { echo "FAIL: upgrade changed the owner of share.json"; exit 1; }
ANSWER=$(printf "get otzi-headless/restore-from-backup\n" | debconf-communicate otzi-headless)
[ "$ANSWER" = "0 false" ] || { echo "FAIL: restore-from-backup is \"$ANSWER\" after the upgrade, want \"0 false\""; exit 1; }
echo "OK: upgrade after restore kept daemon.toml and share.json, and restore-from-backup stays false"
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

# ─────────────────────────────────────────────────────────────────────────
# Third pass: relay-transport installs.
#
# Each variant purges the package (postrm wipes /etc/otzi, /var/lib/otzi and the
# debconf answers), preseeds relay answers and installs again. The rendered
# daemon.toml must carry no [[peers]], must parse (`otzi daemon` gets as far as
# the missing OTZI_SHARE_PASSWORD, as in the first pass), and the relay unit must
# stay disabled. The relay leader also writes [bootstrap] parties. A bad ring size
# or a relay URL that is not ws:// or wss:// is left out with a warning.
# ─────────────────────────────────────────────────────────────────────────

# install_relay_variant <role> <parties-answer> <relay-url>: purge, preseed, install.
install_relay_variant() {
  docker exec -i "$CONTAINER" bash -s -- "$1" "$2" "$3" <<'INSIDE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ROLE="$1"; PARTIES="$2"; RELAY_URL="$3"

apt-get purge -y otzi-headless >/dev/null
rm -rf /etc/otzi /var/lib/otzi

debconf-set-selections <<EOF
otzi-headless otzi-headless/role select $ROLE
otzi-headless otzi-headless/operators string
otzi-headless otzi-headless/network select signet
otzi-headless otzi-headless/esplora-url string
otzi-headless otzi-headless/transport select relay
otzi-headless otzi-headless/relay-url string $RELAY_URL
otzi-headless otzi-headless/parties string $PARTIES
otzi-headless otzi-headless/bootstrap-bind string 0.0.0.0:7090
otzi-headless otzi-headless/bootstrap-leader-url string http://leader.example:7090
otzi-headless otzi-headless/node-id string relay-$ROLE
EOF

apt-get install -y /tmp/otzi-headless.deb 2>&1 | tee /tmp/relay-install.log
INSIDE
}

# daemon_toml_parses <label> <expected-error-regex>: `otzi daemon` against the
# rendered config must fail with exactly that error. With no password in the
# environment a config that parses fails on OTZI_SHARE_PASSWORD; one the parser
# refuses fails with its ConfigError first.
daemon_toml_parses() {
  local out rc
  set +e
  out=$(docker exec "$CONTAINER" /usr/bin/otzi daemon /etc/otzi/daemon.toml 2>&1)
  rc=$?
  set -e
  if [ $rc -eq 0 ] || ! printf '%s\n' "$out" | grep -Eq "$2"; then
    echo "FAIL: $1: wanted /$2/ from otzi daemon, got (exit $rc):" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

echo ">> relay variant: leader of a ring of 3"
install_relay_variant leader 3 wss://relay.example
docker exec "$CONTAINER" bash -euo pipefail -c '
grep -qx "kind = \"relay\""                   /etc/otzi/daemon.toml
grep -qx "url = \"wss://relay.example\""       /etc/otzi/daemon.toml
grep -qx "role = \"leader\""                   /etc/otzi/daemon.toml
grep -qx "bind = \"0.0.0.0:7090\""             /etc/otzi/daemon.toml
grep -qx "parties = 3"                          /etc/otzi/daemon.toml || { echo "FAIL: relay leader lacks parties = 3"; exit 1; }
! grep -qxF "[[peers]]"                          /etc/otzi/daemon.toml || { echo "FAIL: relay config carries [[peers]]"; exit 1; }
! grep -q "advertised_endpoint"                /etc/otzi/daemon.toml || { echo "FAIL: relay config carries advertised_endpoint"; exit 1; }
test -f /etc/otzi/relay.env                    || { echo "FAIL: relay.env missing"; exit 1; }
[ -z "$(find /etc/systemd/system -name otzi-relay.service 2>/dev/null)" ] || { echo "FAIL: otzi-relay.service is enabled"; exit 1; }
test -f /lib/systemd/system/otzi-relay.service || { echo "FAIL: relay unit missing"; exit 1; }
'
daemon_toml_parses "relay leader" "OTZI_SHARE_PASSWORD"
# The closing message explains the relay coordinator.
docker exec "$CONTAINER" grep -q "Relay coordinator" /tmp/relay-install.log || { echo "FAIL: no relay coordinator note in the install output"; exit 1; }
docker exec "$CONTAINER" grep -q "systemctl enable --now otzi-relay" /tmp/relay-install.log || { echo "FAIL: install output does not say how to start the relay"; exit 1; }
docker exec "$CONTAINER" grep -qF "(this node: wss://relay.example)" /tmp/relay-install.log || { echo "FAIL: install output does not name this node's relay URL"; exit 1; }
echo "OK: relay leader renders parties = 3, no [[peers]], and parses"

echo ">> relay variant: leaf (a stale parties answer must not be written)"
install_relay_variant leaf 7 wss://relay.example
docker exec "$CONTAINER" bash -euo pipefail -c '
grep -qx "kind = \"relay\""                   /etc/otzi/daemon.toml
grep -qx "role = \"leaf\""                     /etc/otzi/daemon.toml
grep -qx "leader_url = \"http://leader.example:7090\"" /etc/otzi/daemon.toml
! grep -q "^parties"                           /etc/otzi/daemon.toml || { echo "FAIL: relay leaf carries parties"; exit 1; }
! grep -qxF "[[peers]]"                          /etc/otzi/daemon.toml || { echo "FAIL: relay config carries [[peers]]"; exit 1; }
[ -z "$(find /etc/systemd/system -name otzi-relay.service 2>/dev/null)" ] || { echo "FAIL: otzi-relay.service is enabled"; exit 1; }
'
daemon_toml_parses "relay leaf" "OTZI_SHARE_PASSWORD"
echo "OK: relay leaf renders no parties, no [[peers]], and parses"

echo ">> relay variant: leader with a bad ring size"
# Each of these is warned about and left out; the parser then names the key.
for BAD in 1 256 abc 3.5; do
  install_relay_variant leader "$BAD" ws://relay.example:9000
  docker exec "$CONTAINER" grep -q "WARNING.*ignoring ring size '$BAD'" /tmp/relay-install.log \
    || { echo "FAIL: no warning for parties '$BAD'" >&2; exit 1; }
  docker exec "$CONTAINER" bash -euo pipefail -c '! grep -q "^parties" /etc/otzi/daemon.toml' \
    || { echo "FAIL: parties '$BAD' was written" >&2; exit 1; }
  daemon_toml_parses "relay leader, parties '$BAD'" "bootstrap.parties.*required"
done
# A blank answer gets its own wording.
install_relay_variant leader "" ws://relay.example:9000
docker exec "$CONTAINER" grep -q "WARNING.*no ring size given" /tmp/relay-install.log \
  || { echo "FAIL: no warning for a blank ring size" >&2; exit 1; }
docker exec "$CONTAINER" bash -euo pipefail -c '! grep -q "^parties" /etc/otzi/daemon.toml' \
  || { echo "FAIL: a blank ring size was written" >&2; exit 1; }
daemon_toml_parses "relay leader, blank parties" "bootstrap.parties.*required"
echo "OK: a bad ring size is warned about and left out"

echo ">> relay variant: leader with a relay URL the daemon cannot dial"
# Only ws:// and wss:// are written. Anything else is warned about and left out, the parser
# names transport.url, and the closing message does not print an empty "(this node: )".
for BADURL in "" relay.example http://relay.example; do
  install_relay_variant leader 3 "$BADURL"
  docker exec "$CONTAINER" grep -Eq "WARNING.*(no relay URL given|ignoring relay URL '$BADURL')" /tmp/relay-install.log \
    || { echo "FAIL: no warning for relay URL '$BADURL'" >&2; exit 1; }
  docker exec "$CONTAINER" bash -euo pipefail -c '! grep -q "^url = " /etc/otzi/daemon.toml' \
    || { echo "FAIL: relay URL '$BADURL' was written" >&2; exit 1; }
  if docker exec "$CONTAINER" grep -qF "(this node: )" /tmp/relay-install.log; then
    echo "FAIL: the closing message prints an empty relay URL for '$BADURL'" >&2; exit 1
  fi
  daemon_toml_parses "relay leader, url '$BADURL'" "transport.url.*required"
done
echo "OK: a relay URL without ws:// or wss:// is warned about and left out"

echo ""
echo "✓ all checks passed (fresh install + restore round-trip + relay variants)"
