# INTERFACES.md — otzi-headless contract reference

Authoritative inventory of preconditions, postconditions, and invariants for every component in this repo. Contracts for release 0.3.0: a FROST-only Bitcoin vault, compatible with web Ötzi at the commit recorded in `src/otzi/OTZI_COMMIT`. Design spec: [docs/superpowers/specs/2026-10-10-btc-only-pivot-design.md](docs/superpowers/specs/2026-10-10-btc-only-pivot-design.md).

## How to use this doc

**Rule of engagement** — every code change must touch this file before code:

1. **Read** the relevant section first. Understand what callers promise, what the component guarantees, what invariants must hold, and which other components depend on the contract you're about to touch.
2. **Re-read after context decay.** If you've been working in this conversation for >10 messages or made 60+ tool calls, re-read before editing — see OVERRIDES.md Rule 7.
3. **Update** the contract HERE before landing the code change. A change that alters behavior at an interface boundary without updating the contract is a contract violation.
4. **Cite affected contracts** in commit messages and PR descriptions whenever behavior crosses an interface.

**Code-vs-contract conflicts:** if a contract doesn't match current behavior, the contract is stale. Investigate, decide which is wrong, fix the divergence, then resume work. Never silently route around a stale contract.

**Reading order:** sections are organized bottom-up by dependency. Read in order to learn the system; jump to a section to make a targeted change.

---

## Global invariants

Cross-cutting truths that hold everywhere; subsystem sections may restate them for emphasis.

### Trust model
- **Ring membership is fixed at bootstrap.** The pubkey book pins every member's P-256 identity. Rotation = build a new federation and move the funds; there is no in-place membership change.
- **The threshold protects key material.** Compromising <t key shares yields nothing.
- **Every node signs only what it derived itself.** Leader and participants analyse every proposal against their own key and network (see § Verify-before-gate). A leader cannot misstate inputs, change, fee, network or keys to a participant; false prevout amounts or scripts yield signatures that are invalid on chain, because BIP341 sighashes commit to every input amount and script.
- **The per-node gate decides on self-derived data.** With `auto` on every node, any ring member that can fire a trigger can spend the vault; `policy` / `exec` / `webhook` gates are the defence against a compromised node used as a signing oracle. A gate only restricts; a rejecting node stays silent and is indistinguishable from offline.
- **Operational threshold = n in CLI flows.** The `dkg` op creates an n-of-n vault (`threshold = parties = ring size`) and the `sign` op's `signers` defaults to all n. An offline peer is a red flag in a headless federation (compromise / partition / sabotage), not a graceful-degradation budget. The t-of-n cryptographic property defends against <t key-share compromise; it is separate from the operational policy of all-n participation.
- **Setup trust assumption.** The DKG is a run-once setup step for unconfigured nodes and runs under a trust assumption: one administrator sets up the federation, or a trusted group does it live. Its checks make a faulty or inconsistent setup fail loudly; once a vault exists, no DKG can touch it (see § No DKG while a vault exists).
- **Network-layer pre-filter (peer-mesh only).** The peer-mesh WS server's `verifyClient` drops inbound connections from any source IP not in the resolved peer-endpoint allowlist. Drop is silent (`socket.destroy()` before the WS handshake completes; no 401 or other response on the wire) with a `peer-allowlist:` warn line for log scrapers. Independent from and additive to the cryptographic mutual-auth layer (Noise-KK + P-256 pubkey book) — both must pass for a peer to participate. **Asymmetry:** the relay transport has NO L4 filter; the relay multiplexes by `partyId` from the client `hello`, not by source IP. Cryptographic auth alone gates relay'd traffic, which is why the relay is acceptable: it sees only opaque ciphertext and cannot impersonate a peer.
- **Daemon scope is key custody.** The daemon signs `SendProposal`s it has analysed and returns the signed transaction. It has no chain access: UTXO reads, fee rates and broadcast happen in the CLI through Esplora. No chain watching, autonomous triggers, decision intelligence, or anything non-key-adjacent inside the daemon.

### Code shared with Ötzi (`src/otzi/` lift rule)
- **`src/otzi/lib/` and `src/otzi/backend/` are byte-identical copies** of Ötzi files at the commit in `src/otzi/OTZI_COMMIT` (`71eb9bd07822583ffc7424b1c419dd8d76e78e9c`). DO NOT EDIT THEM. Headless code that needs more lives in its own modules outside `src/otzi/`.
- **Drift check.** `scripts/check-otzi-drift.sh <otzi-checkout>` diffs every lifted file (the 21 it lists) against the checkout and exits non-zero on any difference, a missing or extra file under `src/otzi/lib` / `src/otzi/backend`, or a checkout that is not a git working tree of its own. CI and the release workflow clone Ötzi at the recorded commit and run it.
- **Don't rewrite imports** in lifted files (extensionless `./hex` in `lib/`, `./types.js` in `backend/` stay as Ötzi has them).
- **Share files are Ötzi v4** (`encryptShareFile` / `decryptShareFile`), mode 0600. A share written by otzi-headless opens in web Ötzi, and the reverse.
- The full lifted surface and the functions headless consumes are in [facts/otzi.md](facts/otzi.md).

### Ceremony shape
- **Pull-based.** Peers store produced blobs; consumers pull missing inputs reactively. NO leader-driven state sync, NO 500ms ticks, NO barriers.
- **Signing is leader-driven, single attempt.** The trigger assigns a static leader who analyses, gates, announces once, drives both rounds, aggregates and finalizes the transaction. Participants analyse and gate the announce themselves, produce `sign-r1` and `sign-r2`, and never aggregate.
- **DKG is symmetric:** every peer is equal. The announcing node only generates the 32-byte session ID.
- **`Transport` authenticates `from`** on every broadcast/pull callback. Test transports MUST preserve this contract even when bypassing E2E encryption.
- **`BlobStore.put` is idempotent on byte-equal; throws on byte-conflict.** Blob codecs MUST be deterministic.
- **`BlobServer` is daemon-scoped (not ceremony-scoped).** A peer that finishes keeps serving its blobs to lagging peers until the retention period clears them.
- **`servePulls` is registered once per daemon at startup**, not per ceremony.
- **Blob retention.** When a ceremony ends on a node (either role, any outcome), its blobs are cleared after 300 000 ms (signing) or 900 000 ms (DKG). DKG round-2 secret shares never outlive that window.

### Verify-before-gate
- **Leader and participants alike** run `analyzeProposal(proposal, toVaultKey(own publicKeyPackage), own network)` before the gate. A throw is a 400 on the leader (nothing announced) and a silent drop on a participant.
- **The gate sees only self-derived data:** a `SigningSpec` built from this node's analysis (outputs with `isChange`, `amount`, fee, vsize, fee rate) plus labels from this node's own address book.
- **Sighashes are never sent on the wire.** Every signer computes them from the proposal.
- **Change is only an output paying this node's own vault script**; every input must spend that script; the proposal network must equal this node's network.
- **Signoff verification.** A participant checks every signature in `signoff-done` against the sighashes it computed and its own output key before settling `done`.

### Addressed-blob access control
- `BlobServer` serves a blob whose key has a `to` only when the authenticated requester equals `to`; any other requester gets `null`. Blobs without `to` are served to any ring member. The DKG round-2 secret shares (`dkg-r2`) are the addressed blobs.
- `BlobServer` serves only blobs this node produced (`key.from` = this node); blobs it pulled from peers are never served onward.
- A pull response is accepted only from the peer the pull was sent to.

### Sender binding
- For every pulled blob, the party ID inside the decoded blob equals the authenticated `from` of the pull (the producer the blob was pulled from).
- For FROST signing blobs (`sign-r1`, `sign-r2`, `dkg-verify-r1`, `dkg-verify-r2`), every entry's FROST identifier equals `from + 1`.
- For `dkg-r2`, the recipient inside the blob equals this node.
- A DKG round-1 package carries exactly `threshold` commitments.
- Any mismatch aborts the ceremony with a reason naming the sender.

### Nonce rules (both roles)
- Round 2 runs at most once per signing session; the guard (`round2Started`) is set before any work.
- The commitment list used in round 2 is exactly one pulled set per signer in `signers`, frozen when round 2 starts.
- The nonce objects are dropped immediately after `signRound2` (`myNonces === null` once round 2 returns).
- A second announce for a `ceremonyId` with a live tracker is dropped. A reused `ceremonyId` cannot reuse nonces: each session draws fresh nonces, and the blob store rejects a conflicting `sign-r1`.

### No DKG while a vault exists
- A node with a share loaded, or any file at the share path, never runs a DKG: participants drop `announce-dkg`, and the `dkg` op returns 409 before announcing.
- The DKG stages the new share at `<share path>.pending` (mode 0600, synced to disk before this node publishes its `dkg-verified`) and moves it to the share path only after all-N confirmation, by `link` then `unlink`: the commit never replaces an entry at the share path.
- A DKG failure before this node published its `dkg-verified` deletes the `.pending` file this ceremony staged, if it staged one (no node can have committed without that confirmation); a ceremony that staged nothing never removes an existing `.pending`. After it, the file is kept: another node may have committed the vault. The error names the file, the vault address and the recovery — run `otzi vault` on the other nodes; if any shows that address, rename `.pending` to the share path and restart, otherwise remove it. A node that has verified all N−1 confirmations commits even when its ceremony was aborted meanwhile.
- A `.pending` file found at startup is logged at warn level (with the same recovery) and never loaded; the next DKG overwrites it.
- Replacing a vault is an operator action: move the share file away and restart the daemon.

### Ceremony messages
- Control messages are UTF-8 JSON with `v: 2`, exactly four kinds: `announce-dkg`, `announce-sign`, `signoff-done`, `signoff-aborted`. The parser rejects unknown keys and wrong types and returns `null` on anything else; it never throws.
- Every `ceremonyId` matches `^[A-Za-z0-9._:-]{1,128}$`, checked at the API and in the parser.
- A proposal has at most 255 inputs (the signing codec's count is one byte): rejected by the API, by participants, and by the CLI before any daemon call.
- A node holds at most `MAX_LIVE_SIGNINGS_PER_LEADER = 32` live signing trackers per remote leader (live from the announce until signoff, abort, `timeout`, `rejected` or `stop()`); the 33rd concurrent `announce-sign` from the same leader is dropped with a warn line, and other leaders and ceremonies this node leads are not counted (see [facts/orchestrator.md](facts/orchestrator.md), `orchestrator.ts`).

### Round keys
| Ceremony | Round key | Codec | Addressing |
|---|---|---|---|
| DKG | `dkg-r1` | Ötzi `frost-r1` | broadcast |
| DKG | `dkg-r2` | Ötzi `frost-r2` | addressed (`to` = recipient) |
| DKG | `dkg-verify-r1` | Ötzi `frost-sign-r1` | broadcast |
| DKG | `dkg-verify-r2` | Ötzi `frost-sign-r2` | broadcast |
| DKG | `dkg-verified` | raw 64-byte aggregate signature | broadcast |
| Signing | `sign-r1` | Ötzi `frost-sign-r1` | broadcast |
| Signing | `sign-r2` | Ötzi `frost-sign-r2` | broadcast |

### Network set
- `[network].name ∈ {mainnet, testnet4, signet}` — exactly Ötzi's `NetworkName`. Any other name is rejected at config parse.
- The share's network, `announce-dkg.network` and `proposal.network` must equal the configured network: a share mismatch refuses to start, an announce mismatch is dropped, a proposal mismatch is rejected by `analyzeProposal`.
- Addresses: mainnet uses HRP `bc`; testnet4 and signet use `tb`.

### BIP340 verify key
- Every sighash is signed with `tweaked: true` (key-path spend). Signatures verify against the BIP341 output key — `publicKeyPackage.verifyingKey` (x-only form: `vaultPayment(...).outputKey`) — never against the internal key.

### Transport encryption
- **Noise-KK** over ECDH P-256. Four DH outputs (ss, es, se, ee) → HKDF-SHA-256 → 72-byte expand → 2× 32B keys + 2× 4B salts. Authentication is IMPLICIT in DH math; **NO transcript signatures**.
- **`RecordSession`** AES-256-GCM with `salt(4B) ‖ counter(8B)` nonce. Counter is strictly monotonic per direction, and the receiver opens strictly in counter order. Both transports serialise each session in both directions: seal-then-send in call order (frames of any size reach the wire in counter order) and open in arrival order (peer-mesh `processingChain`, relay per-peer queue).
- **Transient means `null`.** `Transport.pull` returns `null` — never throws — when the producer is offline, the request cannot be sent, the connection closes while it waits, or it times out; it throws only for a producer outside the ring. A relay pair whose session breaks re-handshakes (initiator-driven).
- **Don't use `once('message')`** as the sole handshake consumer; use `HandshakeQueue`-style persistent listener.
- **Don't force-close (`closeAllConnections`)** the bootstrap master after completion; graceful `server.close()` lets in-flight responses flush.

### Operator API surface (load-bearing)
- The daemon's operator API binds to a UDS socket by default (`[[triggers]] kind="uds" path="/var/run/otzi/otzi.sock"`). Filesystem permissions (socket chmod 660 root:otzi, in a setgid and sticky `/var/run/otzi` 3770, so a group member cannot replace the daemon's socket) are the auth model.
- An optional `kind="http"` trigger is supported for the remote-CLI case, but the parser ENFORCES that the bind host is loopback (`127.0.0.1`, `::1`, `localhost`) or a UDS path. External binds are rejected at parse time.
- Ops: `vault-info`, `dkg`, `sign` (see [facts/daemon.md](facts/daemon.md)). Unknown ops and unknown top-level request fields are rejected with 400.
- Group-membership-based access is the precondition for `feedback_cli_is_primary_entrypoint` — the CLI is THE operator surface, and any user in the `otzi` group can run it without sudo.
- **`otzi <subcommand>` is THE operator-facing surface.** Direct `curl` calls to the daemon UDS are not a supported workflow. If a flow exists in production, it should be reachable via `otzi <subcommand>`. New ops added to the daemon HTTP handler should land alongside a CLI verb that wraps them; raw HTTP usage is reserved for tests + debugging.

### Ring identity
- **The raw P-256 pubkey is the only cross-node identity primitive.** Federation members agree on raw pubkeys (130-char hex) via bootstrap; everything else is derived or local.
- **The vault key is not an identity.** `internalKey` / `outputKey` / `address` (from `VaultKey` / `publicKeyPackage`) are used only to build and sign transactions — never for transport authentication.
- **`partyId` is derived**, not configured. Bootstrap collects every peer's `(publicKey, advertisedEndpoint)` pair, sorts by raw pubkey bytes ascending, and assigns `partyId = index`. Every peer reproduces the same mapping from the same book. The daemon resolves its own `partyId` at startup by matching its loaded identity's pubkey to a book entry. FROST identifier = `partyId + 1`.
- **`advertisedEndpoint` is the cross-node routing primitive.** Canonical `host:port` form (lowercase, default port 8800, RFC 5952 IPv6, no wildcards). All endpoints in pubkey-book entries and `[[peers]]` config are stored canonical post-parse; both sides must literally agree for transport-factory's `validatePeersAgainstBook` to pass.
- **`node.id` is local-only.** A logging label for `peersById[selfPartyId]`; no two operators need to agree on what they call peer N. Non-self labels in `peersById` are synthesized as `peer-${partyId}` by transport-factory.
- **Legacy fields strict-rejected.** The parser refuses `node.party_id`, `[[peers]].{id, party_id, wallet_address}`, and `transport.listen` with explicit errors pointing at the replacement (`otzi setup` for book regeneration, `transport.advertised_endpoint` for transport, the book itself for peer identifiers). Pubkey-book files containing a `nodeId` field are rejected at parse — operators regenerate via `otzi setup`.

### Authentication of `from`
- The `from` field in every `Transport` callback is cryptographically authenticated. Implementations MUST NOT forge it (InMemoryTransport respects this in tests).
- Once a leader is pinned for a signing `ceremonyId` (first announce wins), `signoff-done` and `signoff-aborted` for that ceremony are accepted only from that peer; every other announce for the `ceremonyId` is dropped.
- For a DKG, `signoff-aborted` is accepted from any ring member: the DKG is symmetric and any node may detect the failure.

### Don't-list (durable, not exhaustive)
- Don't edit files under `src/otzi/`; add a headless module instead.
- Don't add a centralized policy engine that duplicates threshold enforcement.
- Don't give the daemon chain access; chain reads and broadcast belong to the CLI.
- Don't trust a leader's view of the vault: no leader-supplied keys, addresses, change outputs or sighashes. Analyse against this node's own key.
- Don't serve an addressed blob to anyone but its recipient.
- Don't run a DKG on a node that holds a vault, and don't load a `.pending` share. Don't delete a `.pending` share once this node has published its `dkg-verified`.
- Don't keep FROST nonces past `signRound2`, and don't run round 2 twice in one session.
- Don't move proposal analysis into the gate. Analysis runs before the gate on every node; the gate decides on the analysed spec.
- Don't put decision logic (message-signature verification, SSO, wallet auth) in the daemon's gate layer. Thin delegators only (`exec`/`webhook`); opinionated auth ships under `examples/`.
- Don't try to add or remove peers from a running federation. Ring membership is fixed at bootstrap time (pubkey book + Noise-KK identities are pinned post-bootstrap). Rotation = build a new federation and migrate funds; there is no in-place membership change path by design.
- Don't bloat the .deb past 2 MB (release workflow's size-regression guard fails).

---

## Index

Per-subsystem contracts live in [`facts/`](facts/). Read in dependency order to learn the system; jump to a single file to make a targeted change.

| Subsystem | Description | File |
|---|---|---|
| `src/otzi/` | Verbatim lift of Ötzi modules at `OTZI_COMMIT`: share file v4, blob codecs, DKG verification message, `SendProposal` analysis, transaction building and finalizing, Esplora client, Bitcoin message verification, address-book file. Drift script. **DO NOT EDIT.** | [facts/otzi.md](facts/otzi.md) |
| `src/core/` | Pull-based ceremony plumbing: `Transport`, `BlobStore` / `BlobServer` (addressed-blob access) / `BlobPuller`, blob retention, ceremony messages v2, FROST DKG and signing sessions (sender binding, nonce rules), `runDkgCeremony`, `leadSigning` / `participateInSigning`, `CeremonyIo`. Test helpers in `src/testing/{ring,proposal}.ts`. | [facts/core.md](facts/core.md) |
| `src/bootstrap/` | One-shot pubkey-book exchange. `runMasterBootstrap` + `runMemberRegister`; `computeFingerprint` = 96-bit SHA-256 fingerprint `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` for out-of-band verification. | [facts/bootstrap.md](facts/bootstrap.md) |
| `src/transport/` | Real network transports. Noise-KK over ECDH P-256 + AES-256-GCM `RecordSession`. Peer-mesh (WebSocket per pair, lower partyId dials) + relay (one WS to relay, N-1 multiplexed Noise sessions). | [facts/transport.md](facts/transport.md) |
| `src/config/` | TOML daemon config: `DaemonConfig` types, `[network]` section, `parseDaemonConfigToml`, `ConfigError`, rejected keys. | [facts/config.md](facts/config.md) |
| `src/gate/` | Approval gate: `ApprovalGate` interface (single-method, signaling-only), Bitcoin `SigningSpec` / `DkgSpec`, `AutoGate` / `PolicyGate` / `ExecGate` / `WebhookGate`. Opinionated auth lives under `examples/`. | [facts/gate.md](facts/gate.md) |
| `src/address-book/` | Per-node address book at `/etc/otzi/address-book.otzi.json` (Ötzi `AddressBookFile`, mode 0640): read, atomic write, recipient resolution. | [facts/address-book.md](facts/address-book.md) |
| `src/orchestrator/` | Long-lived participant listener: announce checks, proposal analysis against its own key, spec-builder, gate, DKG and signing participation, signoff verification, deadlines, blob retention. | [facts/orchestrator.md](facts/orchestrator.md) |
| `src/triggers/` | `HttpTrigger` (loopback bind, Bearer auth, 1MB body cap) + `UdsTrigger` + `CronTrigger` (`croner` 5/6-field expressions). | [facts/triggers.md](facts/triggers.md) |
| `src/daemon/`, `src/cli/` | Composition root. `Daemon` wires blob infra + gate + orchestrator + leader + triggers. `api.ts` (request parsing), `LeaderDispatcher`, `vault-share` (v4 share load/stage/commit), `vault-pubkey`, `transport-factory`, `entrypoint` (verbs). CLI commands (`generate`, `vault`, `btc`, `book`, `backup`, `restore`), `daemon-client`, `state-paths` (the path rule backup and restore share), test helper `src/testing/mock-esplora.ts`. | [facts/daemon.md](facts/daemon.md) |

**Reading order (dependency, bottom-up):** `otzi` → `core` → `bootstrap` + `transport` → `config` + `gate` + `address-book` → `orchestrator` + `triggers` + `daemon`.
