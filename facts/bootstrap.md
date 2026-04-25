# Contracts: src/bootstrap/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/bootstrap/

### `pubkey-book.ts`
**Purpose:** Canonical pubkey book construction, serialization, and fingerprint computation for cross-operator verification.

**Public surface:**
- `PubkeyBookEntry`
  - **Pre:** none
  - **Post:** Immutable entry with non-empty `nodeId`, non-negative integer `partyId`, and 130-char lowercase hex `publicKeyHex` (65-byte uncompressed P-256 point starting with `0x04`)
  - **Throws:** n/a (interface)
  - **Concurrency:** none (immutable value type)

- `PubkeyBook`
  - **Pre:** none
  - **Post:** Immutable collection of entries sorted ascending by `partyId`. Caller must not mutate.
  - **Throws:** n/a (interface)
  - **Concurrency:** none (read-only after construction)

- `buildBook(entries: Iterable<PubkeyBookEntry>): PubkeyBook`
  - **Pre:** All entries have distinct `partyId` and `nodeId`. Each `publicKeyHex` is valid 65-byte hex.
  - **Post:** Returns `PubkeyBook` with entries sorted by `partyId`. Canonical order ensures byte-identical fingerprints across all nodes.
  - **Throws:** `Error` if duplicate `partyId` or `nodeId` found, or entry validation fails.
  - **Concurrency:** None (pure function).

- `serializeBook(book: PubkeyBook): string`
  - **Pre:** book is valid `PubkeyBook`.
  - **Post:** Returns JSON string (pretty-printed, 2-space indent); operator-readable.
  - **Throws:** Never.
  - **Concurrency:** None (pure function).

- `parseBook(text: string): PubkeyBook`
  - **Pre:** text is JSON string matching the expected structure.
  - **Post:** Returns validated `PubkeyBook`; entries sorted by `partyId` (calls `buildBook` internally).
  - **Throws:** `Error` if JSON is invalid, structure missing, fields are wrong type, or entry validation fails.
  - **Concurrency:** None (pure function).

- `computeFingerprint(book: PubkeyBook): Promise<string>`
  - **Pre:** book is valid `PubkeyBook`.
  - **Post:** Returns 8-character lowercase hex string = first 32 bits (4 bytes) of SHA-256 hash over concatenated raw pubkey bytes (65B each) in sorted order.
  - **Throws:** Never (crypto operation assumed to succeed).
  - **Concurrency:** Async; safe to call in parallel.

**Invariants:**
- `PubkeyBook.entries` is immutable (readonly array); sorted by `partyId` ascending.
- Every `publicKeyHex` is exactly 130 chars (65 bytes), lowercase, starts with `04`.
- `partyId` values are unique and non-negative integers.
- Fingerprint is computed over the sorted raw pubkey bytes (no metadata), so all nodes derive the same 8-char hex.
- JSON serialization is stable (JSON.stringify with fixed 2-space indent); re-parsing the same book yields the same sorted order.

**Cross-component contracts:**
- Depends on: Web Crypto API (crypto.subtle.digest for SHA-256), hex utilities (fromHex, toHex).
- Used by: `runMasterBootstrap` and `runMemberRegister` to build and distribute the final book; fingerprint shown to operators.
- Wire/byte format: On-disk JSON (pretty-printed); in-memory entries array sorted by partyId.

**Notes / gotchas:**
- `buildBook` sorts entries *in-place* after copying (not lazy); ensures canonical order immediately.
- `computeFingerprint` hashes raw P-256 bytes (0x04 || X || Y), not compressed or any other format.
- Operators must visually compare 8-char fingerprints across all daemons before proceeding; mismatch = abort + redo bootstrap.

---

### `master.ts`
**Purpose:** One-shot HTTP server on master daemon; collects registrations from all peers, validates pubkeys, and fans out the complete pubkey book.

**Public surface:**
- `MasterBootstrapInputs`
  - **Pre:** none
  - **Post:** Configuration object specifying self identity, expected non-master peers, bind address, optional timeout and logger.

- `MasterBootstrapResult`
  - **Pre:** none
  - **Post:** Contains final `book` and 8-char `fingerprint`.

- `runMasterBootstrap(input: MasterBootstrapInputs): Promise<MasterBootstrapResult>`
  - **Pre:** `input.bind` is valid `"host:port"` string. `input.self` identity has 65-byte `publicKeyRaw`. `input.expectedPeers` list does not include master's own `nodeId`. Master daemon is the only caller.
  - **Post:** HTTP server bound to `input.bind`, listening for POST /register requests. Returns only after all expected peers have registered and all in-flight responses have been flushed to clients. Server is gracefully shut down on return (no forced close).
  - **Throws:** `Error` if bind is invalid, server listen fails, or bootstrap times out after `input.timeoutMs` (default 30 min).
  - **Concurrency:** Internally serialized by long-poll gate; multiple registrations may be in-flight, but all wait on the same `CompletionGate` promise.

- `CompletionGate` (internal)
  - **Pre:** none
  - **Post:** Single-shot promise gate; idempotent `resolve` and `reject`; swallows unhandled rejection until someone awaits.
  - **Throws:** n/a (internal helper)
  - **Concurrency:** Safe; idempotent settle (first caller wins).

**Invariants:**
- Master includes itself in the book as the first entry (partyId-sorted).
- Book is not marked complete until *all* expected peers (plus master) are registered.
- HTTP status codes are: 200 on success (all peers in), 400 on bad request, 404 on unknown nodeId, 409 on duplicate nodeId, 408 on timeout.
- Every registration response includes the complete book and fingerprint (computed at the moment gate resolves).
- Response header `connection: close` forces each client to disconnect, preventing idle keep-alive sockets from blocking server shutdown.
- Server uses graceful shutdown (`server.close()`) to allow in-flight response writers to flush before closure; `closeAllConnections()` is NOT used.
- Timeout fires only once, canceling all pending registrations with 408 error.

**Cross-component contracts:**
- Depends on: Node.js http module, `buildBook` and `computeFingerprint` from pubkey-book.ts.
- Used by: Master daemon during bootstrap phase (called once at startup).
- Wire/byte format: HTTP POST /register with JSON body `{ nodeId, partyId, publicKeyHex }` (or snake_case). Response body is JSON `{ book, fingerprint }` or `{ error }`.

**Notes / gotchas:**
- Single-peer ring: if master is the only member, `completeIfReady()` resolves before the server even starts listening — idempotent.
- Request body size limited to 16 KB to prevent DoS.
- Fingerprint is computed once when the gate resolves, then included in all pending responses.
- `connection: close` header is mandatory to avoid hang on server shutdown (idle keep-alive would block).

---

### `register.ts`
**Purpose:** Member-side bootstrap; POSTs identity pubkey to master, awaits the complete book, validates self-entry.

**Public surface:**
- `MemberRegisterInputs`
  - **Post:** Configuration specifying self identity, master URL, optional timeout and logger.

- `MemberRegisterResult`
  - **Post:** Contains final `book` and 8-char `fingerprint`.

- `runMemberRegister(input: MemberRegisterInputs): Promise<MemberRegisterResult>`
  - **Pre:** `input.masterUrl` is valid URL. `input.self.identity.publicKeyRaw` is 65-byte P-256 public key. Member daemon is the only caller.
  - **Post:** Returns the pubkey book (parsed and validated) and the fingerprint. Validates that returned book contains self's entry with matching `partyId` and `publicKeyHex`. Validates that locally-computed fingerprint matches the master-advertised one.
  - **Throws:** `Error` if master responds with non-200 status, returned book is malformed, self-entry is missing or pubkey doesn't match, or fingerprints disagree. Timeout (after `input.timeoutMs`, default 30 min) also throws.
  - **Concurrency:** None (member registers once at startup).

**Invariants:**
- POST body uses snake_case keys: `node_id`, `party_id`, `public_key_hex` (client accepts both snake and camelCase from master response).
- Response must include both `book` and `fingerprint` fields; absence of either throws.
- Self-entry check is critical: verifies `partyId` matches what we sent, and `publicKeyHex` (case-insensitive) matches our identity.
- Fingerprint check: locally computed SHA-256 must match master's advertised value (defends against both book tamper and fingerprint mismatch).
- AbortController timeout ensures cleanup even on network hang.

**Cross-component contracts:**
- Depends on: Fetch API, parseBook and computeFingerprint from pubkey-book.ts.
- Used by: Member daemon during bootstrap phase (called once at startup).
- Wire/byte format: HTTP POST with JSON body (snake_case). Response is JSON `{ book, fingerprint }` or `{ error }`.

**Notes / gotchas:**
- Member self-check catches a compromised master substituting the member's pubkey.
- Fingerprint check across all nodes is the last-line defense; must be done by operators.
- Timeout applies to the entire POST + wait loop, not individual network operations.
- `connection: close` header is set by master, so member's cleanup is automatic.

---

