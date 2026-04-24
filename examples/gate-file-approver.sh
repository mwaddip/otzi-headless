#!/usr/bin/env bash
#
# Reference `exec` gate approver — file-drop pattern.
#
# How it fits in: the daemon is configured with
#
#   [gate]
#   strategy = "exec"
#   [gate.params]
#   command = ["/etc/otzi/gate-file-approver.sh"]
#   timeout_sec = 86400   # 24h
#
# and spawns this script per pending ceremony, writing the CeremonySpec JSON
# on our stdin. We:
#
#   1. Parse the ceremonyId out of the spec.
#   2. Drop the spec as /var/otzi/pending/<ceremonyId>.json for the operator
#      (web UI, email-on-poll, whatever) to display.
#   3. Block on inotifywait until the operator drops a decision file at
#      /var/otzi/decisions/<ceremonyId> with content "approve" or "reject".
#   4. Echo the decision to stdout (first line) and exit 0.
#
# Clean-up: the pending file is removed after the decision is read. The
# decision file is left in place for audit.
#
# Requirements on the host: bash, jq, inotify-tools. If inotifywait is
# unavailable, replace the block with a polling loop (`while ! test -f "$DECISION"; do sleep 2; done`).

set -euo pipefail

PENDING_DIR="${OTZI_GATE_PENDING_DIR:-/var/otzi/pending}"
DECISIONS_DIR="${OTZI_GATE_DECISIONS_DIR:-/var/otzi/decisions}"

mkdir -p "$PENDING_DIR" "$DECISIONS_DIR"

# Read the full CeremonySpec JSON from stdin.
spec="$(cat)"

# Extract ceremonyId. `jq -r` = raw output (no quotes).
ceremony_id="$(printf '%s' "$spec" | jq -r '.ceremonyId')"
if [[ -z "$ceremony_id" || "$ceremony_id" == "null" ]]; then
  echo "gate-file-approver: spec missing ceremonyId" >&2
  exit 2
fi

pending_file="$PENDING_DIR/${ceremony_id}.json"
decision_file="$DECISIONS_DIR/${ceremony_id}"

# Drop the spec for the operator to pick up.
printf '%s\n' "$spec" > "$pending_file"

cleanup() {
  rm -f "$pending_file"
}
trap cleanup EXIT

# Block until the decision file appears.
while [[ ! -f "$decision_file" ]]; do
  # -e create,moved_to: triggered on new file creation or atomic mv-in.
  # -t: seconds until return without event (0 = infinite).
  inotifywait -qq -e create,moved_to -t 0 "$DECISIONS_DIR" >/dev/null 2>&1 || true
done

# Normalize to approve/reject.
decision="$(tr -d '[:space:]' < "$decision_file")"
case "$decision" in
  approve|reject)
    printf '%s\n' "$decision"
    ;;
  *)
    echo "gate-file-approver: unexpected decision in $decision_file: '$decision'" >&2
    exit 3
    ;;
esac
