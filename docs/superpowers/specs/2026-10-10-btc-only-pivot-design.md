# otzi-headless: FROST-only Bitcoin vault — design

Date: 2026-10-10
Status: approved in brainstorming; pending written-spec review
Reference: otzi `master` at `71eb9bd` (`facts/INTERFACES.md` §1, §3–§8, §11, §15)

## 1. Goal

otzi-headless becomes a headless FROST-only Bitcoin vault: N daemons hold FROST key
shares of one key-path-only Taproot key and jointly sign spends that every node has
checked against its own key and its own approval gate. Everything ML-DSA and OPNet
leaves the codebase.

The suite keeps its shape: pull-based ceremonies, Noise-KK transports, the bootstrap
pubkey book, UDS/HTTP/cron triggers, per-node approval gates, the `otzi` CLI,
backup/restore and `.deb` packaging.

### Success criteria

- `otzi generate` produces a v4 share file on every node and one vault address
  (`bc1p…` / `tb1p…`) that all N nodes have confirmed.
- A share file written by otzi-headless opens in web otzi, and the reverse.
- `otzi btc send` produces a transaction that every participant analysed against its
  own key and gate, and broadcasts it through Esplora.
- No ML-DSA or OPNet code or dependencies remain.
- Every security finding in §8 is closed, and an independent security review of the
  full diff passes before the pull request is opened.

## 2. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Existing v3 vaults | Clean break. No v3 support and no migration path. |
| D2 | Code shared with otzi | Verbatim copy of otzi modules into `src/wire/` and `src/node/`, source commit recorded, drift script. |
| D3 | Signing request | Caller sends otzi's `SendProposal`; daemon returns the signed transaction; caller broadcasts. The daemon has no chain access. |
| D4 | Manifest replacement | Per-node address book in otzi's address-book file format. Control plane, `manifest-push`, `otzi sync` and the bootstrap secret are removed. |
| D5 | OP_WALLET approver example | Ported to Bitcoin message signatures (`examples/gate-web-btc-message`). |
| D6 | Networks | `mainnet`, `testnet4`, `signet` — exactly otzi's set. |
| D7 | Approach | Pivot in place, layer by layer, in one release (0.3.0), delivered as a pull request into `master`. |

Unchanged from the existing design: operational n-of-n signing in CLI flows
(`threshold = parties` at DKG, all n signers by default); per-node gates restrict and
never widen; a rejecting node stays silent.

## 3. Compatibility surface with otzi

otzi-headless speaks its own transport and ceremony messages; it never joins an otzi
relay session. The surface it shares with otzi is:

| Shared | otzi reference | Purpose |
|---|---|---|
| Share file v4 | §3, §4 | Shares move between headless and web otzi in both directions. |
| Vault address derivation | §1 | `p2tr(xOnly(untweakedVerifyingKey))`, key-path only. |
| Blob codecs `frost-r1`, `frost-r2`, `frost-sign-r1`, `frost-sign-r2` | §5 | One implementation of the payload layouts. |
| DKG verification message `taggedHash("Otzi/dkg-verify", …)` | §6 | Same agreement check as otzi. |
| `SendProposal` + `analyzeProposal` | §8 | Same rules for what a vault signs. |
| Esplora client and defaults | §11 | Same chain API and per-network defaults. |
| Address book file | §15 | Import/export with web otzi. |

Not shared: otzi's relay protocol (§9, §10), relay text messages (`BARRIER:`,
`FROST-STATE:`, `PROPOSAL-REQ:`, …), and its REST API. Mixed ceremonies (daemons and
browser parties in one session) are out of scope.

## 4. Module map

### 4.1 Lifted verbatim from otzi `71eb9bd` ("DO NOT EDIT")

| Destination | otzi source |
|---|---|
| `src/wire/` | `src/lib/dkg.ts`, `dkg.fixture.ts`, `dkg.test.ts`, `frost-sign.ts`, `frost-sign.test.ts`, `share-file.ts`, `share-file.test.ts`, `bitcoin.ts`, `bitcoin.test.ts`, `crypto.ts`, `hex.ts`, `vault-types.ts`, `address-book.ts`, `address-book.test.ts` |
| `src/node/` | `backend/src/lib/bitcoin.ts`, `bitcoin.test.ts`, `test-vault.fixture.ts`, `esplora.ts`, `btc-message.ts`, `btc-message.test.ts`, `types.ts` |

Rules:
- Files are byte-identical to the recorded otzi commit. Headless code that needs more
  goes in sibling files.
- `facts/wire.md` and `facts/node.md` record the source commit.
- `scripts/check-otzi-drift.sh <otzi-checkout>` diffs every lifted file against the
  checkout and exits non-zero on any difference.
- Browser-only helpers (`downloadShareFile`, `downloadAddressBook`) are present but
  never called; `tsconfig` keeps the `DOM` lib so they typecheck.

### 4.2 Deleted

- `vendor/post-quantum/`
- `src/wire/`: `threshold.ts`, `serialize.ts`, `share-crypto.ts`, `share-write.ts`,
  `frost-reconstruct.ts`, `manifest.ts`, `manifest-types.ts`, `op20-methods.ts`,
  `relay-crypto.ts`, and the current `dkg.ts`, `frost-sign.ts`, `crypto.ts`, `hex.ts`,
  `vault-types.ts` (replaced by §4.1)
- `src/node/`: `encryption.ts`, `frost-link.ts`, `frost-psbt-signer.ts`,
  `opnet-client.ts`, `threshold-signer.ts`, current `types.ts` (replaced by §4.1)
- `src/broadcast/` (all files)
- `src/core/dkg-session.ts`
- `src/daemon/control-plane.ts`
- `src/cli/`: `builtin-abis.ts`, `manifest-resolver.ts`, `manifest-types.ts`,
  `manifest-validate.ts`, `validation.ts`, `cmd/sign.ts`, `cmd/op20.ts`,
  `cmd/install.ts`, `cmd/uninstall.ts`, `cmd/list.ts`, `cmd/sync.ts` (with tests)
- `examples/manifest-builder/`, `docs/headless-manifest-schema.json`,
  `docs/manifest-builder-spec.md`, `scripts/testnet-e2e.ts`, `PLAN.md`
- Dependencies: `@btc-vision/bip32`, `@btc-vision/bitcoin`, `@btc-vision/post-quantum`,
  `@btc-vision/transaction`, `opnet`, `ajv`; dev dependencies `@preact/signals`,
  `htm`, `preact`

### 4.3 Added dependencies

`@scure/btc-signer`, `@scure/base` (versions matching otzi `71eb9bd`). `@mwaddip/frots`,
`@noble/curves`, `@noble/hashes` stay.

### 4.4 Kept unchanged

`src/core/{blob-store,blob-puller,transport,in-memory-transport,types}.ts`,
`src/transport/**`, `src/triggers/**`, `src/util/**`, gate mechanics in
`src/gate/{exec,webhook,factory}.ts`, backup/restore archive mechanics, `.deb` build
mechanics, `examples/fail2ban/`.

### 4.5 Reworked

| Area | Change |
|---|---|
| `core/ceremony-messages.ts` | Four `v: 2` messages (§5.1). |
| `core/blob-server.ts` | Targeted-blob access control (§5.2). |
| `core/frost-dkg-session.ts`, `core/frost-sign-session.ts` | Sender binding, commitment count, nonce wipe (§5.2–§5.4). |
| `core/ceremony-runner.ts` | FROST DKG with verification and confirmation; proposal signing. |
| `orchestrator/*` | Participant analysis against its own key; DKG abort from any ring member; signoff verification; blob cleanup after settle. |
| `gate/types.ts`, `gate/policy.ts` | Bitcoin signing spec and rules (§6.2, §6.3). |
| `daemon/{leader,daemon,config-merge,share-persistence,vault-pubkey,entrypoint,setup}.ts` | v4 shares, new API ops, pending-share handling. |
| `config/*` | `[network]` section (§6.6). |
| `bootstrap/pubkey-book.ts` | 96-bit fingerprint (§6.7). |
| `cli/cmd/{btc,vault,backup,restore}.ts`, `cli/daemon-client.ts`, entrypoint verbs | §6.5. |
| `examples/gate-file-approver.sh` | New spec shape. |
| `examples/gate-web-opwallet/` | Becomes `examples/gate-web-btc-message/` (§6.8). |
| `packaging/deb/**` | debconf prompts (§6.7). |
| Docs | `CLAUDE.md`, `INTERFACES.md`, every `facts/*.md`, `README.md`, `docs/*`. Contract and doc text states current facts and their purpose. |

### 4.6 New

- `src/address-book/store.ts`: read/write the per-node address book (§6.4).
- `src/cli/cmd/book.ts`: `otzi book …` verbs.
- `src/testing/mock-esplora.ts`: test-only mock Esplora server (§10).
- `.github/workflows/ci.yml`: typecheck, both test suites and the drift check on push
  and pull request.
- `facts/address-book.md`.

## 5. Ceremony protocols

### 5.1 Ceremony messages

All control messages are UTF-8 JSON with `v: 2`. A parser accepts exactly these four
kinds, rejects unknown fields and wrong types, and returns `null` on anything else.
`ceremonyId` always matches `^[A-Za-z0-9._:-]{1,128}$`.

```ts
type CeremonyMessage =
  | { v: 2; kind: 'announce-dkg'; ceremonyId: string; sessionIdHex: string /* 32 bytes */;
      threshold: number; parties: number; network: NetworkName }
  | { v: 2; kind: 'announce-sign'; ceremonyId: string; signers: PartyId[]; proposal: SendProposal }
  | { v: 2; kind: 'signoff-done'; ceremonyId: string; signaturesHex: string[] /* 64-byte BIP340, input order */ }
  | { v: 2; kind: 'signoff-aborted'; ceremonyId: string; reason?: string };
```

### 5.2 Blob plumbing (both ceremonies)

- **Round keys:** `dkg-r1`, `dkg-r2`, `dkg-verify-r1`, `dkg-verify-r2`, `dkg-verified`,
  `sign-r1`, `sign-r2`.
- **Access control:** `BlobServer` serves a blob whose key has a `to` only when the
  authenticated requester equals `to`. Blobs without `to` are served to any ring
  member.
- **Cleanup:** when a ceremony ends on this node (either role, any outcome), its blobs
  are cleared after a fixed retention period — 5 minutes for signing, 15 minutes for
  DKG — so peers that are behind can still pull until then.
- **Sender binding:** for every pulled blob, the party ID inside the decoded blob
  equals the authenticated `from` of the pull. For signing blobs, every entry's FROST
  identifier equals `from + 1`. For `frost-r2`, the recipient equals this node. Any
  mismatch aborts the ceremony with a reason naming the sender.

### 5.3 DKG

Symmetric. The node whose trigger fires generates the 32-byte session ID and
announces; it has no other special role.

1. **Announce.** `announce-dkg {ceremonyId, sessionIdHex, threshold, parties, network}`.
   A node drops it unless it holds no vault (no share loaded, no file at the share
   path), `network` equals its configured network, `parties` equals its ring size,
   `2 ≤ threshold ≤ parties`, and its gate approves the DKG spec. The announcing node
   applies the same no-vault rule before announcing (`dkg` op returns 409). Replacing a vault is an operator
   action: move the share file away and restart the daemon.
2. **Round 1.** `dkgRound1`; store `dkg-r1` (otzi `frost-r1` codec). Pull `dkg-r1`
   from the other N−1 nodes. Each package must carry exactly `threshold` commitments.
3. **Round 2.** `dkgRound2`; store one `dkg-r2` per peer (otzi `frost-r2`, addressed).
   Pull the N−1 `dkg-r2` blobs addressed to this node. `dkgFinalize`.
4. **Verify.** Compute `M = dkgVerifyMessage(sessionId, network, publicKeyPackage)`
   from this node's own result. All N nodes FROST-sign `M` with `tweaked: true`:
   store `dkg-verify-r1` (otzi `frost-sign-r1`), pull from all others; store
   `dkg-verify-r2` (otzi `frost-sign-r2`, nonces dropped right after `signRound2`),
   pull from all others. Each node aggregates with its full `publicKeyPackage` and
   checks `verifySignature(sig, M, verifyingKey)`.
5. **Stage.** Write the v4 share file (`encryptShareFile`) to `<share path>.pending`,
   mode 0600, replacing any earlier `.pending`.
6. **Confirm.** Store `dkg-verified` (the raw 64-byte aggregate signature). Pull
   `dkg-verified` from all N−1 others; each must verify against `M` and this node's
   `verifyingKey`.
7. **Complete.** Rename `.pending` to the share path (refused if a file appeared at
   the share path meanwhile), write `vault-pubkey.json`, settle as done.

Failure at any step: broadcast `signoff-aborted {ceremonyId, reason}`, delete the
`.pending` file, settle as aborted. Because the DKG is symmetric, a node accepts a DKG
`signoff-aborted` from any ring member of that ceremony and stops. A `.pending` file
found at startup is logged at warn level and not loaded; the next DKG overwrites it.

Guarantee: a node completes only when every node has produced a signature under the
same vault key over the same transcript and has staged its share to disk.

### 5.4 Signing

Leader-driven, single attempt. The leader is the node whose trigger fired.

**Leader**
1. Validate the request (§6.1).
2. `analyzeProposal(proposal, toVaultKey(ownPublicKeyPackage), ownNetwork)`. A throw
   is a 400 and nothing is announced.
3. Build the signing spec (§6.2) and evaluate the gate. A reject is a 403 and nothing
   is announced.
4. Broadcast `announce-sign {ceremonyId, signers, proposal}`. Sighashes are not sent;
   every node computes them from the proposal.
5. Run `sign-r1` / `sign-r2` with the otzi `frost-sign-r1/r2` codecs; envelope sid is
   the first sighash.
6. Aggregate per input with the full `publicKeyPackage`, so frots names a cheating
   signer. Check each signature against the vault output key.
7. `finalizeSend(tx, prevouts, signatures, outputKey)` → signed hex and txid.
8. Broadcast `signoff-done {ceremonyId, signaturesHex}` and return
   `{ceremonyId, txid, signedTxHex, signaturesHex}`.
9. On any failure after the announce: broadcast `signoff-aborted`, return 500.

**Participant** — drops the announce silently, with a log line naming the reason,
unless all of the following hold:
- the sender is the leader pinned for this `ceremonyId` (first announce wins);
- the `ceremonyId` has no live tracker on this node;
- this node and the leader are in `signers`; `signers` has no duplicates, contains
  only ring members, and has at least `minSigners` entries;
- the proposal has at most 255 inputs;
- `analyzeProposal` against this node's own `publicKeyPackage` and network succeeds;
- the gate approves the spec built from that analysis.

It then produces `sign-r1`, pulls `sign-r1` from every other signer, produces
`sign-r2`, pulls `sign-r2` from every other signer, and stops (no aggregation).

**Nonce rules** (both roles)
- Round 2 runs at most once per session; the guard is set before any work.
- The commitment list used in round 2 is exactly one pulled set per signer in
  `signers`, frozen when round 2 starts.
- The nonce objects are dropped immediately after `signRound2`.
- A second announce for a `ceremonyId` with a live tracker is dropped; a reused
  `ceremonyId` cannot reuse nonces because each session draws fresh nonces and the
  blob store rejects a conflicting `sign-r1`.

**Signoff** — a participant checks every signature in `signoff-done` against the
sighashes it computed and its own output key. All valid → settled `done`. Any invalid
→ error log, settled `invalid-signoff`. `signoff-aborted` → settled `aborted`. The
signing deadline settles `timeout`.

## 6. Operator surface

### 6.1 Daemon API (UDS default, loopback HTTP optional)

Unknown top-level fields are rejected with 400.

| Op | Request | Response |
|---|---|---|
| `vault-info` | — | `{ partyIds, threshold, parties, network, address, internalKey, outputKey }`; 409 before the first DKG. |
| `dkg` | `{ ceremonyId? }` | `{ ceremonyId, status: 'done', address, internalKey, network }`. `parties` = ring size, `threshold` = `parties`. 409 when this node already holds a vault. |
| `sign` | `{ ceremonyId?, signers?, proposal }` | `{ ceremonyId, status: 'done', txid, signedTxHex, signaturesHex }`. |

Input rules:
- `ceremonyId`: `^[A-Za-z0-9._:-]{1,128}$`; generated (`<op>-<uuid>`) when absent.
- `signers`: defaults to all n; otherwise unique ring members, includes this node, at
  least `minSigners`.
- `proposal`: `{ network, tx, prevouts }` with string `tx`, array `prevouts`, at most
  255 inputs; everything else is checked by `analyzeProposal`.

Status codes: 400 bad input or proposal rejected by analysis (message from
`analyzeProposal`); 403 gate reject (`{ error, decision, ceremonyId }`); 409 no vault;
500 ceremony failure (`{ error, ceremonyId }`).

### 6.2 Gate specs

```ts
interface SigningSpec extends CeremonySpecBase {   // ceremonyId, leader, role
  kind: 'signing';
  network: NetworkName;
  txid: string;
  inputs: Array<{ txid: string; vout: number; amount: number }>;
  outputs: Array<{ address: string; amount: number; isChange: boolean; label?: string }>;
  amount: number;        // sum of non-change outputs, sats
  totalIn: number; totalOut: number;
  fee: number; vsize: number; feeRate: number;
}

interface DkgSpec extends CeremonySpecBase {
  kind: 'dkg';
  threshold: number; parties: number; network: NetworkName;
  peerIds: string[];
}
```

The signing fields come straight from `analyzeProposal`; all amounts are safe
integers. `label` is taken from this node's own address book when the address is in
it. Exec and webhook approvers receive the spec as JSON.

### 6.3 Policy rules (`[gate.params]`, strategy `policy`)

| Key | Rule |
|---|---|
| `max_sats_per_tx` | `spec.amount` ≤ cap. |
| `max_sats_per_24h` | Sum of `amount` over this node's approvals in the last 24 h, plus this spec, ≤ cap. Recorded at approval; held in memory. |
| `allowed_recipients` | Array of addresses, or the string `"address-book"`. Every non-change output address must be in the set. With `"address-book"`, the book is read at each evaluation; a missing or invalid book rejects. |
| `max_fee_sats` | `spec.fee` ≤ cap. |
| `max_fee_rate` | `spec.feeRate` ≤ cap (sat/vB). |
| `max_ceremonies_per_hour` | Unchanged. |
| `dkg_leader_allowlist` | Unchanged. |

Caps are non-negative safe integers (TOML integer or decimal string); `max_fee_rate`
may be fractional. The 24 h window counts every approval this node gives, whether or
not the ceremony then completes. Strict by default: a configured rule whose input is
missing rejects. Unknown keys are rejected. The keys `max_amount`, `destination_allowlist`, `method_allowlist`,
`max_btc_per_tx`, `allowed_btc_recipients`, `allowed_contracts` are rejected with an
error naming the replacement (or stating there is none).

### 6.4 Address book

- File: `/etc/otzi/address-book.otzi.json`, otzi `AddressBookFile`
  (`{ kind: 'otzi-address-book', version: 1, network, entries }`). The file network
  must equal the configured network.
- Ownership: `root:otzi`, mode 0640. It can widen a policy allowlist, so writing it
  takes the same privilege as editing `daemon.toml`; reading takes `otzi` group
  membership.
- Writes are atomic (temp file + rename).
- Validation and merging use the lifted `validateEntries`, `parseAddressBookFile`,
  `mergeAddressBooks`, `labelFor`.

### 6.5 CLI

| Verb | Behaviour |
|---|---|
| `otzi daemon <config>` | Run the daemon. |
| `otzi setup <config>` | Bootstrap pubkey exchange; prints the 96-bit fingerprint. |
| `otzi generate` | Daemon `dkg`; banner prints the vault address. |
| `otzi vault [--json]` | Address, network, threshold/parties; keys with `--json`. |
| `otzi btc balance [--unit]` | Esplora balance: confirmed and unconfirmed. |
| `otzi btc send <label\|address> <amount[unit]\|max> [--fee-rate N]` | Confirmed UTXOs from Esplora → `buildSend` → refuse above 255 inputs → daemon `sign` → Esplora broadcast → txid and explorer URL. Default fee rate: Esplora `normal`. |
| `otzi btc sign <proposal.json> [--broadcast]` | Sign a caller-built `SendProposal`; prints the analysis summary, txid and signed hex; `--broadcast` posts it. |
| `otzi book list` | Print entries. |
| `otzi book add <label> <address> [--note]` | Add or update an entry. |
| `otzi book remove <label\|address>` | Remove an entry. |
| `otzi book import <file> [--replace]` | Merge (default) or replace; prints added/updated/unchanged counts. |
| `otzi book export [path]` | Write the book file (stdout without a path). |
| `otzi backup` / `otzi restore` | Archive and restore node state (§6.6). |

If a broadcast fails after signing, the CLI prints the signed transaction hex so the
operator can broadcast it by other means.

### 6.6 Config and files

```toml
[network]
name = "mainnet"          # mainnet | testnet4 | signet
# esplora_url = "https://mempool.example/api"   # optional; CLI only

[share]
path = "/var/lib/otzi/share.json"
password_env = "OTZI_SHARE_PASSWORD"
```

- `esplora_url` defaults to otzi's per-network mempool.space URL (`chainApiUrl`). The
  daemon never reads it.
- Rejected with explicit errors: `network.opnet_rpc`, network names `testnet` and
  `regtest`.
- Startup: read the share JSON, `decryptShareFile`, `assertShareMatchesVault` against
  the configured network, check `partyId` against the pubkey book and `parties`
  against the ring size. Any mismatch refuses to start.
- `vault-pubkey.json` (0644): `{ network, address, internalKey, outputKey, threshold, parties }`.
- Backup archive: `daemon.toml`, share, identity key, pubkey book, address book (if
  present), `vault-pubkey.json`, `meta.json`. Archive format and encryption unchanged.

### 6.7 Packaging and bootstrap

- debconf: network choices `mainnet`, `testnet4`, `signet`; optional Esplora URL; the
  OPNet RPC and bootstrap-secret prompts are removed. postinst no longer creates
  `/var/lib/otzi/bootstrap-secret`.
- Bootstrap fingerprint: first 96 bits of SHA-256 over the sorted raw pubkeys,
  formatted `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`. Operators compare it out of band before
  any DKG.
- The release workflow's `.deb` size guard (2 MB) stays.

### 6.8 Examples

- `examples/gate-web-btc-message/`: webhook approver run with `tsx`, importing the
  lifted `src/node/btc-message.ts`. Config pins one operator Bitcoin address. Each
  decision is the message `otzi-gate:<approve|reject>:<ceremonyId>:<nonce>` signed in
  any wallet that signs messages (BIP-322 simple for P2WPKH/P2TR; legacy/BIP-137 for
  older types). The page lists pending ceremonies with outputs, labels, change, fee
  and fee rate.
- `examples/gate-file-approver.sh`: reads the new spec fields.

## 7. Error handling

| Where | Behaviour |
|---|---|
| Leader, before announce | 400 / 403; peers see nothing. |
| Leader, after announce | `signoff-aborted` with reason; 500. frots cheater identification names the signer when available. |
| Participant | Silent; structured log with reason; local outcome `rejected`, `invalid-signoff`, `aborted` or `timeout`. |
| DKG | `signoff-aborted` from the failing node; every node deletes `.pending`. |
| Deadlines | Config-driven as today (`auto`/`policy`: 5 min signing, 15 min DKG; `exec`/`webhook`: operator cap). |
| Startup | Share, network, party and ring mismatches refuse to start with a specific error. |
| CLI / Esplora | Non-2xx shows status and body (otzi `request`); failed broadcast prints the signed hex. |

## 8. Security findings closed by this design

| # | Finding in the current code | Resolution |
|---|---|---|
| S1 | `keylink` signing is accepted unverified: any peer with a trigger gets arbitrary sighashes signed. | Protocol removed; the only signing input is a proposal every node analyses. |
| S2 | Participants trust the leader's `frostP2tr`, internal key and network in `btcParams`; a fake change address hides an attacker output from policy. | `analyzeProposal` against each node's own key and network; change is only an output paying the node's own vault script. |
| S3 | `BlobServer` serves addressed blobs, including DKG round-2 secret shares, to any ring member. With `threshold < parties` one peer can rebuild the vault key. | Addressed blobs served only to their recipient (§5.2). |
| S4 | Ceremony blobs are never cleared; DKG secret shares stay in memory. | Cleared one deadline after settle (§5.2). |
| S5 | Pulled blobs are not bound to the authenticated sender. | Sender binding (§5.2). |
| S6 | DKG round-1 commitment count is not checked. | Exactly `threshold` commitments (§5.3). |
| S7 | No check that all N nodes agree on the vault key (keylink skipped on regtest, absent otherwise after removal). | Verify signature plus all-N confirmation before completion (§5.3). |
| S8 | FROST aggregation uses an empty `verifyingShares` map, disabling cheater detection. | Full `publicKeyPackage` from the v4 share. |
| S9 | Participants do not verify the leader's signatures in the signoff. | Checked against own sighashes and key (§5.4). |
| S10 | Signing nonces stay in memory until the session ends. | Dropped right after `signRound2`. |
| S11 | 32-bit bootstrap fingerprint. | 96-bit (§6.7). |
| S12 | `ceremonyId` is unvalidated from the API and from peers. | Pattern check at the API and in the message parser. |
| S13 | More than 255 inputs wraps the 1-byte count in the signing codec. | Rejected before announce, by participants, and by the CLI. |
| S14 | No fee cap: a fee-burn proposal passes amount and recipient rules. | `max_fee_sats`, `max_fee_rate`. |
| S15 | A DKG announce overwrites an existing share on every participant (the default `auto` gate approves it), so one node can destroy the vault key. | No DKG while a vault exists, on leader and participants (§5.3). |

## 9. Non-goals

Mixed web/headless ceremonies; operational t-of-n signing below n in CLI flows; OP_RETURN
or other non-standard outputs; script-path spends; fee bumping (RBF/CPFP tooling);
chain watching; persisting rate-limit windows across restarts; regtest; v3 share
support or migration; message signing by the vault.

## 10. Testing

- **Harness:** vitest for headless code. Lifted otzi tests run unchanged with
  `node --import tsx --test src/wire/*.test.ts src/node/*.test.ts`; vitest excludes
  them. `npm test` runs both.
- **Unit:** frost sessions (sender binding, commitment count, round 2 once, nonce
  drop); `BlobServer` access control; blob cleanup; message parser (strict fields,
  `ceremonyId` pattern); policy rules including the 24 h window and `"address-book"`;
  address-book store (atomic write, network mismatch, merge/replace); config parse
  rejections; API input validation; bootstrap fingerprint format; `vault-pubkey.json`.
- **In-process ring, real codecs:**
  - DKG gives every node a v4 share that `decryptShareFile` accepts, the same address
    on every node, and a `.pending`-free directory;
  - a signed proposal finalizes into a transaction whose witnesses verify;
  - an equivocating DKG node (different `dkg-r1` per puller) → no node completes;
  - a DKG announce to nodes that hold a vault → dropped, share files untouched; the
    leader's `dkg` op returns 409;
  - tampered proposals (change to a foreign script, foreign input, wrong network, fee
    burn above cap, >255 inputs) → participants silent, leader times out and aborts;
  - a blob claiming another party → abort naming the sender;
  - a pull of another node's addressed blob → `null`;
  - a forged `signoff-done` → `invalid-signoff`;
  - a non-leader `announce-sign` → dropped.
- **Integration:** the existing daemon integration test over the real transports,
  updated; a mock Esplora (Node `http`: `GET /address/:a/utxo`, `GET /address/:a`,
  `POST /tx`, `GET /v1/fees/recommended`, test-only `POST /_fund`) drives
  `otzi btc send` and `otzi btc sign --broadcast` end to end and checks the broadcast
  transaction.
- **Drift:** CI clones otzi at the recorded commit and runs
  `scripts/check-otzi-drift.sh`.

## 11. Delivery

- **Branch and PR:** work on `claude/lucid-meitner-ona23c`; deliver as a pull request
  into `master` for the owner to merge on GitHub.
- **Commit order** (explicit path lists per commit, so staged deletions do not leak
  into the next commit):
  1. this spec;
  2. contracts and docs (`CLAUDE.md`, `INTERFACES.md`, `facts/*`, `README.md`, `docs/*`);
  3. lifted modules, dependencies, drift script;
  4. core (messages, blob server, sessions, runner);
  5. gate, orchestrator, leader, daemon, config, bootstrap;
  6. CLI and address book;
  7. packaging, examples, CI.
  `npm run typecheck` and `npm test` pass at every layer boundary; the implementation
  plan fixes the exact sequence.
- **Version:** 0.3.0. The owner tags `v0.3.0` after merge.
- **Security review:** an independent review of the full diff (nonces, blob access,
  sender binding, proposal and gate inputs, DKG agreement, input validation, share
  handling) before the PR is opened; its findings are fixed first.
