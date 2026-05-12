# Contracts: src/bootstrap/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/bootstrap/

### `pubkey-book.ts`
**Purpose:** Canonical pubkey book construction, serialization, and fingerprint computation for cross-operator verification.

**Public surface:**
- `PubkeyBookEntry`
  - **Pre:** none
  - **Post:** Immutable entry with non-negative integer `partyId`, 130-char lowercase hex `publicKeyHex` (65-byte uncompressed P-256 point starting with `0x04`), and non-empty `advertisedEndpoint` in canonical `host:port` form (see `src/util/endpoint.ts::canonicalizeEndpoint`).
  - **Throws:** n/a (interface)
  - **Concurrency:** none (immutable value type)

- `PubkeyBook`
  - **Pre:** none
  - **Post:** Immutable collection of entries sorted ascending by `partyId`. Caller must not mutate.
  - **Throws:** n/a (interface)
  - **Concurrency:** none (read-only after construction)

- `buildBook(entries: Iterable<PubkeyBookEntry>): PubkeyBook`
  - **Pre:** All entries have distinct `partyId` and distinct `publicKeyHex`. Each `publicKeyHex` is valid 65-byte hex; each `advertisedEndpoint` is non-empty.
  - **Post:** Returns `PubkeyBook` with entries sorted by `partyId`. Canonical order ensures byte-identical fingerprints across all nodes.
  - **Throws:** `Error` if duplicate `partyId`, duplicate `publicKeyHex`, or entry validation fails.
  - **Concurrency:** None (pure function).

- `serializeBook(book: PubkeyBook): string`
  - **Pre:** book is valid `PubkeyBook`.
  - **Post:** Returns JSON string (pretty-printed, 2-space indent); operator-readable.
  - **Throws:** Never.
  - **Concurrency:** None (pure function).

- `parseBook(text: string): PubkeyBook`
  - **Pre:** text is JSON string matching the expected structure.
  - **Post:** Returns validated `PubkeyBook`; entries sorted by `partyId` (calls `buildBook` internally).
  - **Throws:** `Error` if JSON is invalid, structure missing, fields are wrong type, entry validation fails, or any entry carries a legacy `nodeId` field (Phase F dropped it; book files generated pre-Phase-F must be regenerated via `otzi setup`).
  - **Concurrency:** None (pure function).

- `computeFingerprint(book: PubkeyBook): Promise<string>`
  - **Pre:** book is valid `PubkeyBook`.
  - **Post:** Returns 8-character lowercase hex string = first 32 bits (4 bytes) of SHA-256 hash over concatenated raw pubkey bytes (65B each) in sorted order.
  - **Throws:** Never (crypto operation assumed to succeed).
  - **Concurrency:** Async; safe to call in parallel.

**Invariants:**
- `PubkeyBook.entries` is immutable (readonly array); sorted by `partyId` ascending.
- Every `publicKeyHex` is exactly 130 chars (65 bytes), lowercase, starts with `04`.
- `partyId` values are unique and non-negative integers, derived during bootstrap from sorted-pubkey-bytes order (every peer assigns identical mapping).
- `advertisedEndpoint` is in canonical form (lowercase host, default port 8800 filled in, RFC 5952 IPv6, no wildcards) — caller must apply `canonicalizeEndpoint` before construction.
- Fingerprint is computed over the sorted raw pubkey bytes (no metadata), so all nodes derive the same 8-char hex.
- JSON serialization is stable (JSON.stringify with fixed 2-space indent); re-parsing the same book yields the same sorted order.

**Cross-component contracts:**
- Depends on: Web Crypto API (crypto.subtle.digest for SHA-256), hex utilities (fromHex, toHex), `canonicalizeEndpoint` from `src/util/endpoint.ts`.
- Used by: `runMasterBootstrap` and `runMemberRegister` to build and distribute the final book; `transport-factory.resolveSelfFromBook` (pubkey-match) and `transport-factory.validatePeersAgainstBook` (canonical-endpoint match) at daemon startup; fingerprint shown to operators.
- Wire/byte format: On-disk JSON (pretty-printed); in-memory entries array sorted by partyId.

**Notes / gotchas:**
- `buildBook` sorts entries *in-place* after copying (not lazy); ensures canonical order immediately.
- `computeFingerprint` hashes raw P-256 bytes (0x04 || X || Y), not compressed or any other format.
- Operators must visually compare 8-char fingerprints across all daemons before proceeding; mismatch = abort + redo bootstrap.
- Legacy `nodeId` field: dropped in Phase F. `parseBook` strict-rejects entries containing it; cross-node identity is by raw pubkey, local labels live only in `config.node.id`.

---

### `master.ts`
**Purpose:** One-shot HTTP server on the leader daemon; collects registrations from all peers, validates pubkeys against the operator-supplied advertised-endpoint allowlist, deterministically assigns partyIds by sorted-pubkey-bytes order, and fans out the complete pubkey book.

**Public surface:**
- `MasterBootstrapInputs`
  - **Pre:** none
  - **Post:** Configuration object specifying self identity + advertisedEndpoint, expected non-self peers (`{ advertisedEndpoint }[]`, canonical form), bind address, optional timeout and logger.

- `MasterBootstrapResult`
  - **Pre:** none
  - **Post:** Contains final `book` and 8-char `fingerprint`.

- `runMasterBootstrap(input: MasterBootstrapInputs): Promise<MasterBootstrapResult>`
  - **Pre:** `input.bind` is valid `"host:port"` string. `input.self.identity` has 65-byte `publicKeyRaw`. `input.self.advertisedEndpoint` is canonical (caller already applied `canonicalizeEndpoint`). `input.expectedPeers[*].advertisedEndpoint` are all canonical and do not include self.
  - **Post:** HTTP server bound to `input.bind`, listening for POST /register requests. Returns only after all expected peers (plus self) have registered and all in-flight responses have been flushed to clients. Server is gracefully shut down on return (no forced close).
  - **Throws:** `Error` if bind is invalid, server listen fails, or bootstrap times out after `input.timeoutMs` (default 30 min).
  - **Concurrency:** Internally serialized by long-poll gate; multiple registrations may be in-flight, but all wait on the same `CompletionGate` promise.

- `CompletionGate` (internal)
  - **Pre:** none
  - **Post:** Single-shot promise gate; idempotent `resolve` and `reject`; swallows unhandled rejection until someone awaits.
  - **Throws:** n/a (internal helper)
  - **Concurrency:** Safe; idempotent settle (first caller wins).

**Invariants:**
- Self is pre-registered at startup (under its canonical `advertisedEndpoint` key); registration map keyed by canonical endpoint string.
- Book is not marked complete until *all* expected peers (plus self) are registered.
- On completion: registered entries are sorted by raw pubkey bytes ascending (`Buffer.compare` semantics on 65-byte arrays); each is assigned `partyId = index`. Every peer in the ring reproduces this mapping deterministically from the same book.
- HTTP status codes: 200 on success (all peers in), 400 on bad request (incl. legacy `node_id` field), 404 on advertised-endpoint not in allowlist, 409 on duplicate endpoint OR duplicate pubkey, 408 on timeout.
- Every registration response includes the complete book and fingerprint (computed at the moment gate resolves).
- Response header `connection: close` forces each client to disconnect, preventing idle keep-alive sockets from blocking server shutdown.
- Server uses graceful shutdown (`server.close()`) to allow in-flight response writers to flush before closure; `closeAllConnections()` is NOT used.
- Timeout fires only once, canceling all pending registrations with 408 error.

**Cross-component contracts:**
- Depends on: Node.js http module, `buildBook` and `computeFingerprint` from pubkey-book.ts, `canonicalizeEndpoint` from `src/util/endpoint.ts`.
- Used by: Leader daemon during bootstrap phase (called once at startup via `otzi setup`).
- Wire/byte format: HTTP POST /register with JSON body `{ public_key_hex, advertised_endpoint }`. Response body is JSON `{ book, fingerprint }` or `{ error }`.

**Notes / gotchas:**
- Single-peer ring: if leader is the only member, `completeIfReady()` resolves before the server even starts listening — idempotent.
- Request body size limited to 16 KB to prevent DoS.
- Fingerprint is computed once when the gate resolves, then included in all pending responses.
- `connection: close` header is mandatory to avoid hang on server shutdown (idle keep-alive would block).
- Legacy `node_id` field in the POST body is strict-rejected with 400 (Phase F); leaves running outdated builds receive a clear error message.
- Inbound `advertised_endpoint` is server-side canonicalized before allowlist lookup, so leaves that send slightly-non-canonical inputs (`Node-B.Example` vs `node-b.example:8800`) match correctly — but the leaf's own self-check then enforces canonical-round-trip, so leaves are expected to canonicalize upstream.

---

### `register.ts`
**Purpose:** Member-side bootstrap; POSTs identity pubkey + advertisedEndpoint to leader, awaits the complete book, validates self-entry by pubkey match.

**Public surface:**
- `MemberRegisterInputs`
  - **Post:** Configuration specifying self identity + advertisedEndpoint, leader URL, optional timeout and logger.

- `MemberRegisterResult`
  - **Post:** Contains final `book` and 8-char `fingerprint`.

- `runMemberRegister(input: MemberRegisterInputs): Promise<MemberRegisterResult>`
  - **Pre:** `input.masterUrl` is valid URL. `input.self.identity.publicKeyRaw` is 65-byte P-256 public key. `input.self.advertisedEndpoint` is canonical (caller applied `canonicalizeEndpoint`).
  - **Post:** Returns the pubkey book (parsed and validated) and the fingerprint. Validates that returned book contains an entry whose `publicKeyHex` matches self (case-insensitive), and that entry's `advertisedEndpoint` round-trips unchanged. Validates that locally-computed fingerprint matches the master-advertised one.
  - **Throws:** `Error` if leader responds with non-200 status, returned book is malformed, self-entry missing by pubkey, entry's `advertisedEndpoint` differs from input, or fingerprints disagree. Timeout (after `input.timeoutMs`, default 30 min) also throws.
  - **Concurrency:** None (member registers once at startup).

**Invariants:**
- POST body uses snake_case keys: `public_key_hex`, `advertised_endpoint`. No `node_id` (rejected by leader post-Phase-F).
- Response must include both `book` and `fingerprint` fields; absence of either throws.
- Self-entry check uses pubkey match (not nodeId; that concept is gone). The matched entry's `advertisedEndpoint` must equal what we sent — defends against leader-side canonicalization mismatching the leaf's input.
- Fingerprint check: locally computed SHA-256 must match leader's advertised value (defends against both book tamper and fingerprint mismatch).
- AbortController timeout ensures cleanup even on network hang.

**Cross-component contracts:**
- Depends on: Fetch API, `parseBook` and `computeFingerprint` from pubkey-book.ts.
- Used by: Member daemon during bootstrap phase (called once at startup via `otzi setup`).
- Wire/byte format: HTTP POST with JSON body (snake_case). Response is JSON `{ book, fingerprint }` or `{ error }`.

**Notes / gotchas:**
- Member self-check by pubkey catches a compromised leader substituting the member's pubkey for a different one.
- Fingerprint check across all nodes is the last-line defense; must be done by operators eyeball-comparing the 8-char string.
- Timeout applies to the entire POST + wait loop, not individual network operations.
- `connection: close` header is set by leader, so member's cleanup is automatic.

---
