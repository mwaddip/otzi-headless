# Contracts: src/bootstrap/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/bootstrap/

### `pubkey-book.ts`
**Purpose:** Canonical pubkey book construction, serialization, and fingerprint computation for cross-operator verification.

**Public surface:**
- `PubkeyBookEntry`
  - **Pre:** none
  - **Post:** Immutable entry with non-negative integer `partyId`, 130-char lowercase hex `publicKeyHex` (65-byte uncompressed P-256 point starting with `0x04`), and an optional `advertisedEndpoint`. When present it is non-empty and in canonical `host:port` form (see `src/util/endpoint.ts::canonicalizeEndpoint`). When absent the entry has no `advertisedEndpoint` key at all (relay nodes are reached through the relay and have no dialable address); peer-mesh requires one on every peer (see `transport-factory`).
  - **Throws:** n/a (interface)
  - **Concurrency:** none (immutable value type)

- `PubkeyBook`
  - **Pre:** none
  - **Post:** Immutable collection of entries sorted ascending by `partyId`. Caller must not mutate.
  - **Throws:** n/a (interface)
  - **Concurrency:** none (read-only after construction)

- `buildBook(entries: Iterable<PubkeyBookEntry>): PubkeyBook`
  - **Pre:** All entries have distinct `partyId` and distinct `publicKeyHex`. Each `publicKeyHex` is valid 65-byte hex; each `advertisedEndpoint`, when present, is non-empty (an absent endpoint is valid; an empty string is not).
  - **Post:** Returns `PubkeyBook` with entries sorted by `partyId`. Canonical order ensures byte-identical fingerprints across all nodes.
  - **Throws:** `Error` if duplicate `partyId`, duplicate `publicKeyHex`, or entry validation fails.
  - **Concurrency:** None (pure function).

- `serializeBook(book: PubkeyBook): string`
  - **Pre:** book is valid `PubkeyBook`.
  - **Post:** Returns JSON string (pretty-printed, 2-space indent); operator-readable. An entry without `advertisedEndpoint` is written without the key (never `null`).
  - **Throws:** Never.
  - **Concurrency:** None (pure function).

- `parseBook(text: string): PubkeyBook`
  - **Pre:** text is JSON string matching the expected structure.
  - **Post:** Returns validated `PubkeyBook`; entries sorted by `partyId` (calls `buildBook` internally). An entry without an `advertisedEndpoint` key reads back without the key, so `serializeBook` then `parseBook` round-trips a book with no endpoints exactly.
  - **Throws:** `Error` if JSON is invalid, structure missing, fields are wrong type (a present `advertisedEndpoint` must be a string; `null` is rejected, and so is the empty string), entry validation fails, or any entry carries a legacy `nodeId` field (Phase F dropped it; book files generated pre-Phase-F must be regenerated via `otzi setup`).
  - **Concurrency:** None (pure function).

- `computeFingerprint(book: PubkeyBook): Promise<string>`
  - **Pre:** book is valid `PubkeyBook`.
  - **Post:** Returns the 96-bit fingerprint: the first 12 bytes of SHA-256 over the concatenated raw pubkey bytes (65B each) in book order (ascending `partyId` = ascending raw pubkey bytes), as lowercase hex in six groups of 4 joined by `-` — `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` (29 characters). Endpoints are not an input: the same pubkeys give the same fingerprint with, without, or with different endpoints.
  - **Throws:** Never (crypto operation assumed to succeed).
  - **Concurrency:** Async; safe to call in parallel.

- `keyId(publicKeyHex: string): string`
  - **Pre:** `publicKeyHex` is 130 hex characters (65 bytes; either case).
  - **Post:** Returns the first 8 lowercase hex characters of SHA-256 over the raw 65 pubkey bytes. The same key gives the same id on every node. The fingerprint proves every node holds the same book; key ids let an operator check that the book holds only their own nodes' keys.
  - **Throws:** `Error` if the input is not 130 hex characters.
  - **Concurrency:** None (pure, synchronous).

**Invariants:**
- `PubkeyBook.entries` is immutable (readonly array); sorted by `partyId` ascending.
- Every `publicKeyHex` is exactly 130 chars (65 bytes), lowercase, starts with `04`.
- `partyId` values are unique and non-negative integers, derived during bootstrap from sorted-pubkey-bytes order (every peer assigns identical mapping).
- `advertisedEndpoint`, when present, is in canonical form (lowercase host, default port 8800 filled in, RFC 5952 IPv6, no wildcards) — caller must apply `canonicalizeEndpoint` before construction. It is optional on every entry; only peer-mesh startup and the endpoint-allowlist bootstrap (`runMasterBootstrap` / `runMemberRegister`) read it.
- Fingerprint is computed over the sorted raw pubkey bytes (no metadata, no endpoints), so all nodes derive the same `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` string. The ring id in `transport-factory` hashes the same bytes and is likewise endpoint-independent.
- JSON serialization is stable (JSON.stringify with fixed 2-space indent); re-parsing the same book yields the same sorted order.

**Cross-component contracts:**
- Depends on: Web Crypto API (crypto.subtle.digest for SHA-256, fingerprint), `node:crypto` `createHash` (key id), hex utilities (fromHex, toHex), `canonicalizeEndpoint` from `src/util/endpoint.ts`.
- Used by: `runMasterBootstrap` and `runMemberRegister` to build and distribute the final book (endpoints admission writes an endpoint on every entry; count admission writes none); `transport-factory.resolveSelfFromBook` (pubkey-match) and, for peer-mesh only, `transport-factory.validatePeersAgainstBook` (canonical-endpoint match) at daemon startup; fingerprint shown to operators.
- Wire/byte format: On-disk JSON (pretty-printed); in-memory entries array sorted by partyId.

**Notes / gotchas:**
- `buildBook` sorts entries *in-place* after copying (not lazy); ensures canonical order immediately.
- `computeFingerprint` hashes raw P-256 bytes (0x04 || X || Y), not compressed or any other format.
- `keyId` hashes the same raw bytes, not the hex text; uppercase and lowercase hex of one key give one id.
- Operators compare the 96-bit fingerprint out of band across all daemons before any DKG; mismatch = abort + redo bootstrap.
- Key-id rule: every node's setup banner (`src/daemon/setup.ts`) prints this node's key id and the key id of every book entry. Operators confirm that each listed id belongs to one of their own nodes; an unknown id means someone else registered, so they delete the pubkey book on every node and redo setup. The fingerprint cannot show such an intruder, since every node receives the same book.
- Legacy `nodeId` field: dropped in Phase F. `parseBook` strict-rejects entries containing it; cross-node identity is by raw pubkey, local labels live only in `config.node.id`.

---

### `master.ts`
**Purpose:** One-shot HTTP server on the leader daemon; collects registrations, admits them by one of two rules (an advertised-endpoint allowlist for peer-mesh, a count for relay), deterministically assigns partyIds by sorted-pubkey-bytes order, and fans out the complete pubkey book.

**Public surface:**
- `MasterAdmission`
  - `{ kind: 'endpoints'; selfEndpoint: string; expectedPeers: ReadonlyArray<{ advertisedEndpoint: string }> }` — peer-mesh. `selfEndpoint` is this node's canonical endpoint; `expectedPeers` are the canonical endpoints of every other node (from `[[peers]]`), self excluded. Every book entry carries its endpoint.
  - `{ kind: 'count'; parties: number }` — relay. `parties` is the ring size, the leader included (from `[bootstrap] parties`). The leader admits the first `parties − 1` distinct pubkeys that register without an endpoint. No book entry carries an endpoint.

- `MasterBootstrapInputs`
  - **Pre:** none
  - **Post:** `{ self: { identity }, admission: MasterAdmission, bind, timeoutMs?, logger? }`.

- `MasterBootstrapResult`
  - **Pre:** none
  - **Post:** Contains final `book` and the 96-bit `fingerprint` (`computeFingerprint` format).

- `runMasterBootstrap(input: MasterBootstrapInputs): Promise<MasterBootstrapResult>`
  - **Pre:** `input.bind` is valid `"host:port"` string. `input.self.identity` has 65-byte `publicKeyRaw`. Endpoints admission: `selfEndpoint` and every `expectedPeers[*].advertisedEndpoint` are canonical (caller applied `canonicalizeEndpoint`), and `expectedPeers` excludes self. Count admission: `parties` is an integer ≥ 2 (the config parser further bounds it to 255).
  - **Post:** HTTP server bound to `input.bind`, listening for POST /register requests. Returns only after the expected total has registered (endpoints: `expectedPeers.length + 1`; count: `parties`; self included) and all in-flight responses have been flushed to clients. Server is gracefully shut down on return (no forced close).
  - **Throws:** `Error` if bind is invalid, count admission has `parties` that is not an integer ≥ 2, server listen fails, or bootstrap times out after `input.timeoutMs` (default 30 min). The timeout message names the shortfall: `master bootstrap timed out after <ms>ms: received <r> of <e> registrations` (`r` and `e` count the other nodes, self excluded), so an operator who set `parties` too high sees it.
  - **Concurrency:** Internally serialized by long-poll gate; multiple registrations may be in-flight, but all wait on the same `CompletionGate` promise.

- `CompletionGate` (internal)
  - **Pre:** none
  - **Post:** Single-shot promise gate; idempotent `resolve` and `reject`; swallows unhandled rejection until someone awaits.
  - **Throws:** n/a (internal helper)
  - **Concurrency:** Safe; idempotent settle (first caller wins).

**Invariants:**
- Self is pre-registered at startup. The registration map is keyed by canonical endpoint (endpoints admission) or by lowercase pubkey hex (count admission).
- Book is not marked complete until the expected total (self included) has registered.
- On completion: registered entries are sorted by raw pubkey bytes ascending (`Buffer.compare` semantics on 65-byte arrays); each is assigned `partyId = index`. Every peer in the ring reproduces this mapping deterministically from the same book. Endpoints admission writes each entry's canonical endpoint; count admission writes entries with no `advertisedEndpoint` key, the leader's own included.
- HTTP status codes, both modes: 200 on success (all registrations in, body `{ book, fingerprint }`); 404 for anything but `POST /register`; 400 on invalid JSON, a legacy `node_id` / `nodeId` field, or a `public_key_hex` that is not 130 hex chars starting `04`; 408 on timeout (body error is the timeout message above).
- HTTP status codes, endpoints admission (peer-mesh): 400 `'advertised_endpoint' missing or empty` or `invalid advertised_endpoint: …`; 404 advertised endpoint not on the allowlist; 409 duplicate endpoint OR duplicate pubkey.
- HTTP status codes, count admission (relay), checked in this order after the shared checks:
  1. 400 `'advertised_endpoint' not used in relay mode` when the body has an `advertised_endpoint` (or `advertisedEndpoint`) key at all, whatever its value.
  2. 409 `publicKey already registered` for a pubkey already registered, and 409 `publicKey already registered (it is the leader's own key)` for the leader's pubkey. Checked before the count, so a member that registers twice is told it is already in, not that the bootstrap is full.
  3. 409 `bootstrap is full` once `parties` registrations (self included) are in.
- Every registration response includes the complete book and fingerprint (computed at the moment gate resolves).
- Response header `connection: close` forces each client to disconnect, preventing idle keep-alive sockets from blocking server shutdown.
- Server uses graceful shutdown (`server.close()`) to allow in-flight response writers to flush before closure; `closeAllConnections()` is NOT used.
- Timeout fires only once, canceling all pending registrations with 408 error.

**Cross-component contracts:**
- Depends on: Node.js http module, `buildBook`, `computeFingerprint` and `keyId` (log field) from pubkey-book.ts, `canonicalizeEndpoint` from `src/util/endpoint.ts`.
- Used by: Leader daemon during bootstrap phase (called once via `otzi setup`; `setupMaster` picks the admission from `[transport] kind`).
- Wire/byte format: HTTP POST /register with JSON body `{ public_key_hex, advertised_endpoint }` (endpoints admission) or `{ public_key_hex }` (count admission). Response body is JSON `{ book, fingerprint }` or `{ error }`.

**Notes / gotchas:**
- Single-peer ring (endpoints admission with no expected peers): `completeIfReady()` resolves before the server even starts listening — idempotent. Count admission needs at least one other node.
- Count admission trusts whoever reaches the port first: anyone who can reach the bootstrap port during setup can take a slot. The defences are network exposure (the port reachable only by the members), the 409 `bootstrap is full` that a displaced member then gets, and the key ids in every node's setup banner.
- `bootstrap is full` reaches only a registration whose connection the server accepted before it closed. Once the book is complete the server stops accepting connections, so a member that arrives later gets connection refused instead; the leader's banner, listing a key id the operator does not recognise, is what shows the intruder then.
- Request body size limited to 16 KB to prevent DoS.
- Fingerprint is computed once when the gate resolves, then included in all pending responses.
- `connection: close` header is mandatory to avoid hang on server shutdown (idle keep-alive would block).
- Legacy `node_id` field in the POST body is strict-rejected with 400 (Phase F); leaves running outdated builds receive a clear error message.
- Inbound `advertised_endpoint` is server-side canonicalized before allowlist lookup, so leaves that send slightly-non-canonical inputs (`Node-B.Example` vs `node-b.example:8800`) match correctly — but the leaf's own self-check then enforces canonical-round-trip, so leaves are expected to canonicalize upstream.

---

### `register.ts`
**Purpose:** Member-side bootstrap; POSTs the identity pubkey (plus the advertised endpoint under peer-mesh) to the leader, awaits the complete book, validates the self entry by pubkey match.

**Public surface:**
- `MemberRegisterInputs`
  - **Post:** `{ self: { identity, advertisedEndpoint? }, masterUrl, timeoutMs?, logger? }`. A present `advertisedEndpoint` (canonical) means peer-mesh; an absent one means relay.

- `MemberRegisterResult`
  - **Post:** Contains final `book` and the 96-bit `fingerprint` (`computeFingerprint` format).

- `runMemberRegister(input: MemberRegisterInputs): Promise<MemberRegisterResult>`
  - **Pre:** `input.masterUrl` is valid URL. `input.self.identity.publicKeyRaw` is 65-byte P-256 public key. `input.self.advertisedEndpoint`, when present, is canonical (caller applied `canonicalizeEndpoint`).
  - **Post:** Returns the pubkey book (parsed and validated) and the fingerprint. Validates that the returned book contains an entry whose `publicKeyHex` matches self (case-insensitive), checks that entry's endpoint by mode (below), and validates that the locally-computed fingerprint matches the master-advertised one.
  - **Self-entry endpoint check:**
    - peer-mesh (endpoint sent): the entry's `advertisedEndpoint` must equal the one sent. Missing → `register: the leader's book has no advertisedEndpoint for this node; it registered '<sent>'`. Different → `register: master returned advertisedEndpoint='<got>' != ours='<sent>'`.
    - relay (no endpoint sent): the entry must have no `advertisedEndpoint` → otherwise `register: the leader's book gives this node advertisedEndpoint='<got>'; a relay node registers none`.
  - **Leader errors mapped to operator messages:**
    - relay member, 400 whose error starts `'advertised_endpoint' missing` (an endpoints-mode leader) → `setup: the leader expects peer-mesh registrations (an advertised endpoint); this node is configured for relay — use the same transport on every node`.
    - peer-mesh member, 400 `'advertised_endpoint' not used in relay mode` (a count-mode leader) → `setup: the leader expects relay registrations (no advertised endpoint); this node is configured for peer-mesh — use the same transport on every node`.
    - 409 `bootstrap is full` → `setup: bootstrap is full — another party registered in this node's place; abort, delete pubkeys.json on every node and redo setup with the bootstrap port reachable only by the members`.
    - Any other non-200 → `register: master responded <status>[: <error>]`.
  - **Throws:** `Error` as above, or if the returned book is malformed, the self entry is missing by pubkey, or fingerprints disagree. Timeout (after `input.timeoutMs`, default 30 min) also throws.
  - **Concurrency:** None (member registers once at startup).

**Invariants:**
- POST body uses snake_case keys: `public_key_hex`, plus `advertised_endpoint` under peer-mesh only (a relay member sends no such key). No `node_id` (rejected by leader post-Phase-F).
- Response must include both `book` and `fingerprint` fields; absence of either throws.
- Self-entry check uses pubkey match (not nodeId; that concept is gone). The matched entry's endpoint must be what this node registered — the same string under peer-mesh (defends against leader-side canonicalization mismatching the leaf's input), none under relay.
- Fingerprint check: locally computed SHA-256 must match leader's advertised value (defends against both book tamper and fingerprint mismatch).
- AbortController timeout ensures cleanup even on network hang.

**Cross-component contracts:**
- Depends on: Fetch API, `parseBook` and `computeFingerprint` from pubkey-book.ts; the error strings `master.ts` sends (`'advertised_endpoint' missing or empty`, `'advertised_endpoint' not used in relay mode`, `bootstrap is full`).
- Used by: Member daemon during bootstrap phase (called once via `otzi setup`; `setupMember` sends the endpoint only under peer-mesh).
- Wire/byte format: HTTP POST with JSON body (snake_case). Response is JSON `{ book, fingerprint }` or `{ error }`.

**Notes / gotchas:**
- Member self-check by pubkey catches a compromised leader substituting the member's pubkey for a different one.
- Fingerprint check across all nodes is the last-line defense; operators compare the `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` string out of band, then confirm every key id in the banner is one of theirs.
- Timeout applies to the entire POST + wait loop, not individual network operations.
- `connection: close` header is set by leader, so member's cleanup is automatic.

---
