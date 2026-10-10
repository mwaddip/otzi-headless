#!/usr/bin/env bash
#
# Reference `exec` gate approver — file-drop pattern.
#
# How it fits in: the daemon is configured with
#
#   [gate]
#   strategy    = "exec"
#   command     = ["/etc/otzi/gate-file-approver.sh"]
#   timeout_sec = 86400   # 24h
#
# (gate parameters sit directly under [gate], next to `strategy`) and spawns this
# script per ceremony, writing the CeremonySpec JSON on our stdin. We:
#
#   1. Parse the ceremonyId out of the spec and take the first 16 hex characters
#      of the SHA-256 of the spec text as its digest. Together they name this
#      request: <key> = <ceremonyId>.<digest>
#   2. Drop the spec as /var/otzi/pending/<key>.json for the operator
#      (web UI, email-on-poll, whatever) to display.
#   3. Wait until the operator drops a decision file named exactly
#      /var/otzi/decisions/<key> with content "approve" or "reject". The name is
#      the pending file's name without ".json"; copy it from there. Create the
#      file under another name outside decisions/ and `mv` it in, so it appears whole.
#   4. Remove the decision file, echo the decision to stdout (first line) and exit 0.
#      The pending file is removed on the way out.
#
# A decision applies to the exact spec it was made for, and only once. The digest
# ties the file name to the spec content, so a decision file left over from an
# earlier ceremony with the same ceremonyId (ids can recur once the nodes have
# forgotten them) does not match a new spec, and a decision is deleted when it is
# used, so it cannot approve the same spec a second time.
#
# What the operator sees in the pending file. The node built the spec from its own
# analysis of the proposal, so none of it is the leader's say-so (facts/gate.md):
#
#   Signing spec (kind = "signing"):
#     ceremonyId, leader, role ("leader" | "participant"), network, txid,
#     inputs   [{ txid, vout, amount }]
#     outputs  [{ address, amount, isChange, label? }]  every output, in order;
#              isChange is true for an output paying this node's own vault;
#              label is present when the address is in this node's address book
#     amount   sats sent to non-change outputs
#     totalIn, totalOut, fee (sats), vsize, feeRate (sat/vB, may be fractional)
#
#   DKG spec (kind = "dkg"):
#     ceremonyId, leader, role, network, threshold, parties, peerIds
#
# Review the outputs, not just `amount`. For example:
#
#   jq -r '.outputs[] | "\(.address)  \(.amount) sats  \(.label // "(no label)")  \(if .isChange then "change" else "" end)"' pending/<key>.json
#   jq '{txid, amount, fee, feeRate}' pending/<key>.json
#
# Under the packaged systemd unit the daemon (and so this script) can write only
# under /var/lib/otzi. Point both directories there with the gate's `env`:
#
#   env = { OTZI_GATE_PENDING_DIR = "/var/lib/otzi/gate/pending", OTZI_GATE_DECISIONS_DIR = "/var/lib/otzi/gate/decisions" }
#
# Requirements on the host: bash, jq, coreutils (sha256sum). inotify-tools makes the
# wait event-driven; without it the script polls every 2 s.

set -euo pipefail

PENDING_DIR="${OTZI_GATE_PENDING_DIR:-/var/otzi/pending}"
DECISIONS_DIR="${OTZI_GATE_DECISIONS_DIR:-/var/otzi/decisions}"

mkdir -p "$PENDING_DIR" "$DECISIONS_DIR"

# Read the full CeremonySpec JSON from stdin.
spec="$(cat)"

# Extract ceremonyId. `jq -r` = raw output (no quotes). The id becomes part of a
# file name, so only the characters ceremony ids may contain are accepted.
ceremony_id="$(printf '%s' "$spec" | jq -r 'if (.ceremonyId | type) == "string" then .ceremonyId else empty end')"
if [[ ! "$ceremony_id" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
  echo "gate-file-approver: spec has a missing or malformed ceremonyId" >&2
  exit 2
fi

digest="$(printf '%s' "$spec" | sha256sum | cut -c1-16)"
key="${ceremony_id}.${digest}"
pending_file="$PENDING_DIR/${key}.json"
decision_file="$DECISIONS_DIR/${key}"

# Drop the spec for the operator to pick up.
printf '%s\n' "$spec" > "$pending_file"

cleanup() {
  rm -f "$pending_file"
}
trap cleanup EXIT

# Block until the decision file appears (and has content).
while [[ ! -s "$decision_file" ]]; do
  if command -v inotifywait >/dev/null 2>&1; then
    # -e create,moved_to: triggered on new file creation or atomic mv-in.
    # -t 5: look again after 5 s even without an event, so a file that landed
    # between the test above and the watch starting is not missed.
    inotifywait -qq -e create,moved_to -t 5 "$DECISIONS_DIR" >/dev/null 2>&1 || true
  else
    sleep 2
  fi
done

# The decision is used up as it is read.
decision="$(tr -d '[:space:]' < "$decision_file")"
rm -f "$decision_file"

# Normalize to approve/reject.
case "$decision" in
  approve|reject)
    printf '%s\n' "$decision"
    ;;
  *)
    echo "gate-file-approver: unexpected decision for $key: '$decision'" >&2
    exit 3
    ;;
esac
