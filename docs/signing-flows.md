# Ceremony flow reference

Visual reference for the two ceremonies the daemons run: key generation (DKG) and
transaction signing. Both are FROST (RFC 9591, secp256k1) over a key-path-only
Taproot vault. Signatures are standard BIP340 and look like single-key signatures
on chain.

The ceremonies are **pull-based**. Each node produces its blobs locally and stores
them; a node that needs round-N inputs pulls them from their producers. There are
no periodic state broadcasts, no barriers and no ceremony heartbeats. Four small control
messages announce and close ceremonies; everything else is blobs.

---

## Building blocks

### Control messages

Broadcast, UTF-8 JSON with `v: 2`. A parser accepts exactly these four kinds and
drops anything else.

| Kind | Sent by | Carries |
|---|---|---|
| `announce-dkg` | The node whose trigger fired | `ceremonyId`, `sessionIdHex` (32 bytes), `threshold`, `parties`, `network` |
| `announce-sign` | The leader | `ceremonyId`, `signers`, the whole `proposal` (`network`, `tx`, `prevouts`) |
| `signoff-done` | The signing leader, after finalizing | `ceremonyId`, `signaturesHex` (64-byte BIP340 signatures, input order) |
| `signoff-aborted` | Any node that fails a DKG; the signing leader on failure | `ceremonyId`, optional `reason` |

Every `ceremonyId` matches `^[A-Za-z0-9._:-]{1,128}$`. Sighashes never appear in a
message: each signer computes them from the proposal.

### Blobs

Blobs use the same payload layouts as web Ötzi (`frost-r1`, `frost-r2`,
`frost-sign-r1`, `frost-sign-r2`).

| Ceremony | Round key | Payload | Addressing |
|---|---|---|---|
| DKG | `dkg-r1` | `frost-r1` (commitments + proof of knowledge) | broadcast |
| DKG | `dkg-r2` | `frost-r2` (a secret share) | addressed to one recipient |
| DKG | `dkg-verify-r1`, `dkg-verify-r2` | `frost-sign-r1/r2` over the verification message | broadcast |
| DKG | `dkg-verified` | the raw 64-byte aggregate signature | broadcast |
| Signing | `sign-r1`, `sign-r2` | `frost-sign-r1/r2` over the transaction sighashes | broadcast |

### Rules every pull obeys

- **Addressed blobs** (`dkg-r2`) are served only to their recipient. Anyone else
  gets the same answer as for a blob that does not exist yet.
- **Sender binding.** For every pulled blob, the party ID inside it equals the
  authenticated node it was pulled from. For signing blobs, every entry's FROST
  identifier equals that party ID + 1. A mismatch aborts the ceremony with a
  reason naming the sender.
- **Pull until the deadline.** A blob that is not available yet is pulled again
  until it arrives or the ceremony deadline (`[deadlines]`) passes. A blob that is
  still unavailable at the deadline fails the ceremony.
- **Retention.** When a ceremony ends on a node (either role, any outcome), the
  node clears its blobs 5 minutes later for signing, 15 minutes later for DKG, so
  lagging peers can still pull. DKG secret shares never outlive that window.

---

## DKG (key generation)

Run once, on a set of nodes that hold no vault. The ceremony is **symmetric**:
every node plays the same role. The node whose trigger fired (`otzi generate`)
generates the 32-byte session ID and announces; it has no other special role.
`parties` is the ring size and `threshold = parties`.

The DKG runs under a setup trust assumption: one administrator sets up the
federation, or a trusted group does it live. The checks below make a faulty or
inconsistent setup fail loudly. Once a vault exists, no DKG can touch it.

```
 Node A (trigger)             Node B                     Node C
 ────────────────             ──────                     ──────
 ① ANNOUNCE
 announce-dkg ──────────────► checks ──────────────────► checks
 (session ID, t, n, network)  no vault · network · ring size · 2 ≤ t ≤ n · gate

 ② ROUND 1
 dkg-r1 ◄════════════ every node pulls from every other node ═══════════►
 · exactly `threshold` commitments per package

 ③ ROUND 2
 dkg-r2 ◄════ one blob per recipient, served only to that recipient ════►
 · finalize → this node's key package + the vault's public key package

 ④ VERIFY
 M = hash of the session, network and the public key package this node computed
 dkg-verify-r1 ◄══ all N nodes FROST-sign M ══► dkg-verify-r2
 · each node aggregates with the full public key package and verifies

 ⑤ STAGE
 share (Ötzi v4) → <share path>.pending, mode 0600, synced to disk

 ⑥ CONFIRM
 dkg-verified ◄═══ each node pulls the other N−1 signatures and verifies ═►

 ⑦ COMPLETE
 link .pending → share path (never replaces) · unlink .pending · write vault-pubkey.json · settle done
```

### Steps

1. **Announce.** `announce-dkg {ceremonyId, sessionIdHex, threshold, parties,
   network}`. A node drops the announce unless it holds no vault (no share
   loaded, no file at the share path), `network` equals its configured network,
   `parties` equals its ring size, `2 ≤ threshold ≤ parties`, and its gate
   approves the DKG spec. The announcing node applies the no-vault rule before it
   announces (the `dkg` op returns `409`).
2. **Round 1.** Each node generates its round-1 package and stores it as
   `dkg-r1`, then pulls `dkg-r1` from the other N−1 nodes. Each package must
   carry exactly `threshold` commitments.
3. **Round 2.** Each node derives one `dkg-r2` per peer, addressed to that peer,
   and pulls the N−1 `dkg-r2` blobs addressed to itself. Finalizing verifies every
   received share and yields this node's key package.
4. **Verify.** Each node computes the verification message `M` from its own
   result: the session ID, the network, the group key, the threshold and every
   verifying share. All N nodes FROST-sign `M` with the key-path tweak: round 1
   (`dkg-verify-r1`), then round 2 (`dkg-verify-r2`, nonces dropped right after
   they are used). Each node aggregates and checks the signature against the vault
   output key. If any node saw a different session, network, key, threshold or
   share, the signature fails and no node proceeds.
5. **Stage.** The node writes its Ötzi v4 share, encrypted with the share
   password, to `<share path>.pending` (mode 0600), replacing any earlier
   `.pending`, and syncs the file and its directory to disk.
6. **Confirm.** Each node publishes the aggregate signature as `dkg-verified`,
   pulls the other N−1, and checks each against `M` and its own vault key.
7. **Complete.** Once all N−1 confirmations verify, the node commits even if the
   ceremony is aborted meanwhile: it links `.pending` to the share path (refused
   if anything exists there, so a vault is never replaced), syncs the directory,
   removes `.pending`, syncs the directory again,
   writes `vault-pubkey.json` (a failed write is only a warning; startup rewrites
   it), and settles as done.

A node completes only when every node has produced a signature under the same
vault key over the same transcript and has staged its share durably to disk.

**Failure at any step.** The failing node broadcasts `signoff-aborted
{ceremonyId, reason}` and settles as aborted. Because the DKG is symmetric, a node
accepts a DKG `signoff-aborted` from any ring member and stops. A node that had
not yet published its `dkg-verified` deletes the `.pending` file this ceremony
staged, if any (a ceremony that staged nothing leaves an existing `.pending`
alone): no node can have committed without its confirmation. A node that had published it keeps the file,
because another node may already have committed the vault, and logs an error
naming the file, the vault address and the recovery: run `otzi vault` on the
other nodes; if any shows that address, rename `.pending` to the share path and
restart the daemon, otherwise remove it. A `.pending` file found at startup is
logged at warn level with the same recovery and never loaded; the next DKG
overwrites it. If it is the loaded share's own file (a second name left by a
failed removal after the commit), startup removes it and logs at info level.

**After the DKG.** The new share is on disk but not loaded. Restart every daemon
so each loads its share; until then `sign` returns `409`. Replacing an existing
vault is an operator action: move the share file away and restart the daemon.

### What each node holds afterwards

| Data | Where | Purpose |
|---|---|---|
| Encrypted share file (Ötzi v4) | `[share].path`, mode 0600 | This node's FROST key package and the vault's public key package; opens in web Ötzi |
| Vault metadata (`vault-pubkey.json`) | `/var/lib/otzi/`, mode 0644 | Public: address, keys, threshold, parties; lets the CLI build transactions |
| Nothing else | — | No node ever holds another node's share |

---

## Transaction signing

Signing is **leader-driven and single-attempt**. The leader is the node whose
trigger fired (`otzi btc send`, `otzi btc sign`, or an operator backend's
`sign` call): a static role for this ceremony, not an elected one. FROST
aggregation is deterministic, so there are no retries.

The caller supplies a **proposal**: an unsigned transaction plus the prevouts it
spends. The daemon never reads the chain; the CLI (or the backend) fetches UTXOs,
builds the proposal and broadcasts the result.

```
 Leader (trigger)                              Participants
 ────────────────                              ────────────
 validate the request           ─ 400
 analyse proposal, own key      ─ 400
 own gate                       ─ 403
 announce-sign {signers, proposal} ──────────► sender is the pinned leader
                                               ceremonyId new · signers valid
                                               analyse proposal, own key
                                               own gate

 sign-r1 ◄═══ every signer pulls sign-r1 from every other signer ═══►

 sign-r2 produce; pull from the others         sign-r2 produce, then stop
 aggregate per input (full public key package)
 verify each signature against the output key
 finalizeSend → signed transaction

 signoff-done {signaturesHex} ───────────────► verify each signature against
 return {txid, signedTxHex, signaturesHex}     own sighashes + output key → done
```

### Leader

1. **Validate the request**: the `ceremonyId` pattern, the `signers` rules, the
   proposal shape and the 255-input limit. A violation is a `400`.
2. **Analyse the proposal** against the public key package in its own share and
   its own network. A rejection is a `400` and nothing is announced.
3. **Build the signing spec** from that analysis and evaluate its own gate. A
   reject is a `403` and nothing is announced.
4. **Announce.** Broadcast `announce-sign {ceremonyId, signers, proposal}`.
   Sighashes are not sent.
5. **Sign.** Run `sign-r1` and `sign-r2`: produce its own blob, pull the other
   signers' blobs.
6. **Aggregate** per input with the full public key package, so a cheating signer
   is named. Check each signature against the vault output key.
7. **Finalize.** `finalizeSend` places the signatures as key-path witnesses
   (verifying each under BIP340 again) and yields the signed transaction and its
   txid.
8. **Sign off.** Broadcast `signoff-done {ceremonyId, signaturesHex}` and return
   `{ceremonyId, txid, signedTxHex, signaturesHex}` to the caller.
9. **On any failure after the announce**, broadcast `signoff-aborted` and return
   `500`.

### Participant

A participant drops the announce silently, with a log line naming the reason,
unless all of these hold:

- the sender is the leader pinned for this `ceremonyId` (first announce wins);
- the `ceremonyId` has no live session on this node;
- this node and the leader are in `signers`; `signers` has no duplicates,
  contains only ring members, and has at least as many entries as the share's
  threshold;
- the proposal has at most 255 inputs;
- the leader has fewer than 32 signing ceremonies live on this node (a
  ceremony is live until its sign-off, abort or deadline, or until it is
  rejected; one waiting on a slow gate counts), so a compromised ring member
  cannot make every participant hold ceremonies without bound;
- the proposal passes the same analysis against this node's own key package and
  network;
- this node's gate approves the spec built from that analysis.

It then produces `sign-r1`, pulls `sign-r1` from every other signer, produces
`sign-r2`, and stops: it pulls no `sign-r2` and never aggregates.

### Nonce rules

These hold for both roles.

- Round 2 runs at most once per session; the guard is set before any work.
- The commitment list used in round 2 is exactly one pulled set per signer in
  `signers`, frozen when round 2 starts.
- The nonces are dropped immediately after round 2.
- A second announce for a `ceremonyId` with a live session is dropped. A reused
  `ceremonyId` cannot reuse nonces: each session draws fresh ones, and the blob
  store rejects a conflicting `sign-r1`.

### Sign-off

A participant stays live until the leader's sign-off or its signing deadline.

| Event | Local outcome |
|---|---|
| `signoff-done` from the pinned leader; every signature is valid against the sighashes this node computed and its own output key | `done` |
| `signoff-done` with any invalid signature | `invalid-signoff` (error log) |
| `signoff-aborted` from the pinned leader | `aborted` |
| Analysis failed or this node's gate did not approve | `rejected` |
| The signing deadline passes first | `timeout` |

---

## Where each check happens

| Check | Where | On failure |
|---|---|---|
| Request shape: unknown fields, `ceremonyId` pattern, `signers` rules, proposal shape, at most 255 inputs | Daemon API (leader) | `400`, nothing announced |
| Proposal analysis against the node's **own** key and network | Leader before the announce; every participant on the announce | Leader `400`; participant silent drop |
| Gate on a spec built from that analysis | Leader before the announce; every participant on the announce | Leader `403`; participant silent drop |
| Announce comes from the pinned leader; `ceremonyId` is new | Participant | Dropped, logged |
| The leader has fewer than 32 live signing ceremonies on this node | Participant | Dropped, logged (warn); the 33rd is accepted once one settles |
| `signers` valid: contains self and leader, unique, ring members, at least the threshold | Participant | Dropped, logged |
| DKG announce: no vault, matching network, `parties` = ring size, `2 ≤ threshold ≤ parties`, gate | Each node | Dropped; the `dkg` op returns `409` when the receiving node holds a vault |
| Sender binding on every pulled blob | Every node, both ceremonies | Ceremony aborts, reason names the sender |
| DKG round 1 carries exactly `threshold` commitments | Every node | Ceremony aborts |
| Addressed blobs go only to their recipient | Every node's blob server | The puller gets "not available" |
| Round 2 runs once; frozen commitment set; nonces dropped | Every signer | Session error |
| FROST aggregation with the full public key package (names a cheating signer) | Leader (signing); every node (DKG verification) | Ceremony aborts naming the signer |
| Each signature verified against the vault output key | Leader per input; `finalizeSend` again under BIP340 | Leader `500` |
| `signoff-done` signatures against own sighashes and output key | Participant | `invalid-signoff` |
| Sign-offs accepted only from the pinned leader (signing); aborts from any ring member (DKG) | Participant | Ignored |
| DKG verification signature, then all-N confirmation | Every node | `signoff-aborted`; `.pending` deleted on a node that had not confirmed, kept (with the recovery logged) on one that had |
| Startup: the share decrypts, its network matches `[network].name`, `partyId` and `parties` match the pubkey book | Each daemon | Refuses to start |
| Input count, confirmed UTXOs, recipient resolution | `otzi btc send` | Error before any daemon call |
| Prevout amounts and scripts | Bitcoin consensus: sighashes commit to every input amount and script | Signatures from false prevout data are invalid on chain |

A node that fails a check on an announce stays silent. To its peers it is
indistinguishable from an offline node, and the leader's ceremony fails.
