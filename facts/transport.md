# Contracts: src/transport/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/transport/

### `identity.ts`
**Purpose:** ECDH P-256 long-term keypair generation, import/export, and public-key loading for peer authentication.

**Public surface:**
- `IdentityKeyPair`
  - **Pre:** none
  - **Post:** Immutable pair of non-extractable CryptoKey private key and 65-byte raw uncompressed P-256 public key.

- `generateIdentity(extractable = false): Promise<IdentityKeyPair>`
  - **Pre:** none
  - **Post:** Generates fresh ECDH P-256 keypair. Private key is non-extractable by default (`extractable: false`); extractable only when explicitly requested (for one-time disk export at bootstrap).
  - **Throws:** Never (key generation assumed to succeed).
  - **Concurrency:** Async; safe to call in parallel.

- `importPeerPubKey(raw: Uint8Array): Promise<CryptoKey>`
  - **Pre:** `raw` is exactly 65 bytes, starting with `0x04` (uncompressed P-256 point).
  - **Post:** Returns CryptoKey for ECDH, non-extractable, marked for `deriveBits` only.
  - **Throws:** `Error` if length is not 65 or first byte is not `0x04`.
  - **Concurrency:** Async; safe to call in parallel.

- `importIdentity(privKeyPkcs8: Uint8Array, publicKeyRaw: Uint8Array, extractable = false): Promise<IdentityKeyPair>`
  - **Pre:** `privKeyPkcs8` is valid PKCS#8 DER encoding of P-256 private key. `publicKeyRaw` is exactly 65 bytes starting with `0x04`.
  - **Post:** Restores identity from disk bytes (phase 3c). Private key is non-extractable by default.
  - **Throws:** `Error` if public key is wrong size or format, or PKCS#8 import fails.
  - **Concurrency:** Async; safe to call in parallel.

- `exportPrivateKeyPkcs8(pair: IdentityKeyPair): Promise<Uint8Array>`
  - **Pre:** `pair.privateKey` was generated or imported with `extractable: true`.
  - **Post:** Returns PKCS#8 DER bytes (typically written to disk with mode 0600).
  - **Throws:** `Error` if private key is not extractable.
  - **Concurrency:** Async; safe to call in parallel.

**Invariants:**
- Public key is always 65 bytes: `0x04 || X (32B) || Y (32B)`.
- Private keys are non-extractable at runtime by default (cannot be exfiltrated from process memory once loaded).
- Private key is marked for `deriveBits` only (not for signing, decryption, or other operations).
- `extractable: true` is used once at bootstrap to export PKCS#8, then discarded.
- PKCS#8 bytes are operator-managed on disk; must be protected (chmod 0600).

**Cross-component contracts:**
- Depends on: Web Crypto API (crypto.subtle.generateKey, importKey, exportKey).
- Used by: bootstrap (exportPrivateKeyPkcs8 for one-time disk write), handshake (importIdentity to load from disk, importPeerPubKey to load peer keys), peer-mesh (identity setup).
- Wire/byte format: PKCS#8 DER for disk storage; raw 65-byte point for in-memory and wire transmission.

**Notes / gotchas:**
- `exportPrivateKeyPkcs8` requires `extractable: true` at import time; cannot retroactively extract a non-extractable key.
- Public key format is always uncompressed (`0x04 || X || Y`); no compressed variants.
- `toBuf()` helper casts Uint8Array to ArrayBuffer for strict Web Crypto typing.

---

### `handshake.ts`
**Purpose:** Noise-KK-style handshake over P-256 ECDH; derives traffic secrets from four DH outputs via HKDF-SHA-256.

**Public surface:**
- `InitiatorState`
  - **Post:** Immutable intermediate state from initiator's first step; contains own identity, ephemeral keypair, and ephemeral pubkey.

- `initiatorBegin(me: IdentityKeyPair): Promise<{ state: InitiatorState; message1: Uint8Array }>`
  - **Pre:** `me` is valid identity with 65-byte public key.
  - **Post:** Generates fresh ephemeral P-256 keypair. Returns state and 65-byte message1 (ephemeral pubkey, cleartext).
  - **Throws:** Never (key generation assumed to succeed).
  - **Concurrency:** Async; safe to call in parallel.

- `initiatorFinish(state: InitiatorState, message2: Uint8Array, peerStaticPubKeyRaw: Uint8Array): Promise<RecordSecrets>`
  - **Pre:** `state` from `initiatorBegin()`. `message2` is exactly 65 bytes (responder's ephemeral pubkey). `peerStaticPubKeyRaw` is exactly 65 bytes (responder's static pubkey from book).
  - **Post:** Computes four DH outputs (ss, es, se, ee); hashes transcript (protocol label + four pubkeys); derives 72 bytes via HKDF-Expand. Returns `RecordSecrets` with send/recv keys (32B each) and salts (4B each), oriented for initiator (initSendKey = initiator→responder).
  - **Throws:** `Error` if message2 or peer pubkey is wrong size/format.
  - **Concurrency:** Async; safe to call in parallel (no shared mutable state).

- `responderRespond(me: IdentityKeyPair, message1: Uint8Array, peerStaticPubKeyRaw: Uint8Array): Promise<{ message2: Uint8Array; secrets: RecordSecrets }>`
  - **Pre:** `me` is valid identity. `message1` is exactly 65 bytes (initiator's ephemeral pubkey). `peerStaticPubKeyRaw` is exactly 65 bytes (initiator's static pubkey).
  - **Post:** Generates fresh ephemeral keypair. Computes four DH outputs. Derives traffic secrets. Returns message2 (responder's ephemeral pubkey, cleartext) and secrets (oriented for responder: respSendKey = responder→initiator).
  - **Throws:** `Error` if message1 or peer pubkey is wrong size/format.
  - **Concurrency:** Async; single-shot (no state object to retain).

**Invariants:**
- Noise-KK message order: Initiator → Responder (message1, cleartext ephemeral), Responder → Initiator (message2, cleartext ephemeral).
- Four DH outputs: `ss` (mutual auth), `es` (initiator ephemeral × responder static), `se` (initiator static × responder ephemeral), `ee` (forward secrecy).
- HKDF-SHA-256 inputs: IKM = concat(ss, es, se, ee); salt = SHA-256(transcript); info = "otzi-xk-v1:traffic".
- HKDF-Expand output: 72 bytes = 32B initSendKey + 32B respSendKey + 4B initSendSalt + 4B respSendSalt.
- Initiator's sendKey = responder's recvKey, and vice versa (symmetric from responder's perspective).
- All four DH outputs are 32 bytes each; if any ECDH fails, the keys diverge and the first record frame fails auth.
- Authentication is implicit in DH math — no transcript signatures; Noise KK pattern.

**Cross-component contracts:**
- Depends on: `IdentityKeyPair`, `RecordSecrets`, Web Crypto API (generateKey, importKey, deriveBits).
- Used by: peer-mesh and relay transports to establish peer-pair sessions.
- Wire/byte format: Two cleartext 65-byte ephemeral pubkeys (message1 and message2). Transcript hashed includes protocol label + 4 pubkeys (static and ephemeral).

**Notes / gotchas:**
- `requireHandshakeMessage()` validates message size and 0x04 prefix.
- Ephemeral keys are generated non-extractable and immediately discarded after deriving DH outputs.
- If either side is impersonating, one of the four DH outputs yields a different value, derived keys diverge, and the first AES-GCM record fails.
- `InitiatorState` is kept only by the initiator between steps; responder is single-shot.

---

### `record.ts`
**Purpose:** AES-256-GCM record layer with monotonic per-direction counter; nonce = salt(4B) || counter(8B).

**Public surface:**
- `RecordSecrets`
  - **Post:** Immutable pair of send/recv keys (32B each) and salts (4B each) from handshake HKDF.

- `REKEY_SOFT_LIMIT = 1n << 48n`
  - **Post:** Soft re-key threshold (2^48 frames); triggers `shouldRekey()`.

- `MAX_COUNTER = (1n << 64n) - 1n`
  - **Post:** Hard overflow limit; seal/open throw if counter reaches 2^64.

- `RecordSession.create(secrets: RecordSecrets): Promise<RecordSession>`
  - **Pre:** `secrets` has 32B keys and 4B salts.
  - **Post:** Initializes session with send/recv counters at 0; imports keys as AES-GCM CryptoKeys (non-extractable); copies salt arrays for isolation.
  - **Throws:** Never (import assumed to succeed).
  - **Concurrency:** Async; safe to call in parallel.

- `seal(plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>`
  - **Pre:** Session is not closed. Plaintext can be any length. AAD (additional authenticated data) is optional.
  - **Post:** Increments send counter synchronously before async crypto call; constructs nonce = salt(4B) || counter_be64(8B); returns AES-256-GCM ciphertext + auth tag.
  - **Throws:** `Error` if send counter exhausted (>= 2^64).
  - **Concurrency:** Safe to call in parallel; counter is incremented atomically before each crypto op.

- `open(ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>`
  - **Pre:** Ciphertext is at least 16 bytes (tag). Nonce/counter expected in order (no replays).
  - **Post:** Constructs nonce and decrypts. On auth failure, throws and does NOT advance counter (session remains clean for cleanup). On success, increments recv counter.
  - **Throws:** `Error` on AES-GCM auth failure (tampering detected).
  - **Concurrency:** Assumes single-threaded ordered delivery; recv counter is NOT thread-safe.

- `sendFrames: bigint` (getter)
  - **Post:** Returns current send counter (number of successful seals).

- `recvFrames: bigint` (getter)
  - **Post:** Returns current recv counter (number of successful opens).

- `shouldRekey(threshold: bigint = REKEY_SOFT_LIMIT): boolean`
  - **Post:** Returns true if either send or recv counter >= threshold (default 2^48).

- `makeNonce(salt: Uint8Array, counter: bigint): Uint8Array`
  - **Pre:** `salt` is 4 bytes. `counter` is 0 <= counter < 2^64.
  - **Post:** Returns 12-byte nonce = salt(4B) || counter_be64(8B).
  - **Throws:** `Error` if counter is negative or > 2^64-1.

**Invariants:**
- Nonce is 12 bytes: 4B salt XOR'd per-direction (prevents direction confusion) + 8B big-endian counter.
- Send counter is strictly monotonic; bumped synchronously before each async seal call.
- Recv counter is strictly monotonic; bumped only after successful open (not on auth failure).
- AES-GCM auth failure → tear down; counter NOT advanced, session clean for caller to clean up.
- Soft re-key threshold is 2^48 (NIST comfort bound for 96-bit nonce); hard limit is 2^64.
- Counter exhaustion throws, not silent overflow; re-key is a session-layer concern.
- Salts are copied at session creation (external mutation after `create` cannot tamper).

**Cross-component contracts:**
- Depends on: Web Crypto API (generateKey, encrypt, decrypt for AES-GCM).
- Used by: peer-mesh and relay to encrypt all post-handshake frames.
- Wire/byte format: Ciphertext is opaque; nonce is internal to the crypto call (not sent on wire).

**Notes / gotchas:**
- Per TLS 1.3 convention; nonce construction prevents direction-confusion attacks.
- Concurrent `seal` calls are safe (counter bumped atomically before crypto); concurrent `open` is NOT (assumes ordered delivery).
- Per-connection serialization (in peer-mesh connection.ts) enforces single-threaded recv to prevent counter race.
- If counter exhausted, session is unrecoverable; session layer must re-key before soft limit.

---

## src/transport/peer-mesh/

### `wire.ts`
**Purpose:** JSON wire format for peer-mesh: handshake (cleartext ephemeral keys) and application messages (broadcast, pull-req, pull-resp, all encrypted).

**Public surface:**
- `Handshake1`, `Handshake2` — Immutable handshake messages with `kind`, `partyId`, and 130-char hex `ephemeralPubHex`.

- `encodeHandshake1(partyId: PartyId, ephemeralPub: Uint8Array): Uint8Array`
  - **Pre:** `ephemeralPub` is 65 bytes.
  - **Post:** Returns JSON-encoded handshake message (cleartext).

- `encodeHandshake2(partyId: PartyId, ephemeralPub: Uint8Array): Uint8Array`
  - **Pre:** `ephemeralPub` is 65 bytes.
  - **Post:** Returns JSON-encoded handshake message (cleartext).

- `parseHandshake(bytes: Uint8Array): Handshake1 | Handshake2 | null`
  - **Pre:** bytes are UTF-8 JSON.
  - **Post:** Parses and validates kind, partyId (non-negative integer), and ephemeralPubHex (non-empty string). Returns null on parse failure.

- `ephemeralFromHandshake(msg: Handshake1 | Handshake2): Uint8Array`
  - **Pre:** msg is valid handshake.
  - **Post:** Decodes `ephemeralPubHex` to raw bytes.
  - **Throws:** `Error` if hex is invalid.

- `AppBroadcast`, `AppPullRequest`, `AppPullResponse` — Immutable application message types.

- `encodeBroadcast(msg: Uint8Array): Uint8Array`
  - **Post:** Returns JSON-encoded `{ kind: 'broadcast', msgB64: '<base64>' }`.

- `encodePullRequest(requestId: string, key: BlobKey): Uint8Array`
  - **Pre:** requestId is non-empty string, key has ceremonyId, round, from (and optional to).
  - **Post:** Returns JSON-encoded pull request.

- `encodePullResponse(requestId: string, blob: Uint8Array | null): Uint8Array`
  - **Pre:** requestId is non-empty string, blob is null or Uint8Array.
  - **Post:** Returns JSON-encoded pull response with blobB64 (null if no blob).

- `parseAppMessage(bytes: Uint8Array): AppMessage | null`
  - **Pre:** bytes are UTF-8 JSON.
  - **Post:** Parses and validates all three app message types; returns null if invalid or unrecognized kind.

- `broadcastBytes(msg: AppBroadcast): Uint8Array`
  - **Pre:** msg is valid broadcast with msgB64.
  - **Post:** Decodes msgB64 to raw bytes.
  - **Throws:** `Error` if base64 is invalid.

- `pullResponseBlob(msg: AppPullResponse): Uint8Array | null`
  - **Pre:** msg is valid pull response.
  - **Post:** Decodes blobB64 to raw bytes (or null).
  - **Throws:** `Error` if base64 is invalid and not null.

- `pullRequestKey(msg: AppPullRequest): BlobKey`
  - **Pre:** msg is valid pull request.
  - **Post:** Extracts BlobKey { ceremonyId, round, from, to? }.

**Invariants:**
- Handshake messages are JSON, cleartext (one-shot at connection start).
- Application messages are JSON, encrypted via AES-GCM after handshake completion.
- Payloads are base64-encoded (msgB64, blobB64) for safe JSON transport.
- RequestId is a unique string per pull request; no structure assumed.
- partyId must be a non-negative integer.
- parseAppMessage returns null on any malformed message (no throw).

**Cross-component contracts:**
- Depends on: toHex/fromHex utilities, JSON standard library.
- Used by: peer-mesh connection and transport for message encoding/decoding.
- Wire/byte format: JSON objects, optional base64 payload encoding; all non-handshake frames are encrypted at the record layer.

**Notes / gotchas:**
- Handshake is the only cleartext on the wire; ephemeral pubkeys carry no secrets.
- Base64 codec uses btoa/atob (standard Web API); ensure payloads are binary-safe.
- Pull-resp with `blobB64: null` signals "not yet available" (producer hasn't generated).
- Parsing is lenient (returns null rather than throwing) to allow graceful drop of malformed frames.

---

### `connection.ts`
**Purpose:** Single peer-to-peer WebSocket connection with Noise-KK handshake (cleartext ephemeral exchange), AES-GCM record layer, and persistent message queue during handshake.

**Public surface:**
- `PeerConnection` — Immutable endpoint for one peer pair; ready to send/receive encrypted AppMessages after construction. Internal serialization via `processingChain` prevents counter race.

- `PeerConnection.dial(options): Promise<PeerConnection>`
  - **Pre:** `options.me` has identity and partyId. `options.peerPartyId` is target peer's partyId. `options.peerPublicKey` is 65-byte peer's static pubkey. `options.url` is WebSocket URL. `options.wsCtor` is WebSocket constructor (normally the `ws` library).
  - **Post:** Opens WebSocket, performs initiator Noise-KK handshake (send message1 ephemeral, receive message2 ephemeral, derive secrets). Returns ready-to-use PeerConnection. All frames arriving during handshake are buffered and replayed on construction.
  - **Throws:** `Error` if WebSocket connection fails, handshake times out (10s), message format is wrong, or partyId mismatch.
  - **Concurrency:** Async; safe to call in parallel for different peers.

- `PeerConnection.acceptInbound(options): Promise<PeerConnection>`
  - **Pre:** `options.ws` is an inbound WebSocket (already open). `options.me` has identity and partyId. `options.resolvePublicKey` is a function to look up peer's static pubkey by partyId.
  - **Post:** Performs responder Noise-KK handshake (receive message1, send message2, derive secrets). Returns ready-to-use PeerConnection. Frames arriving before handshake completion are buffered.
  - **Throws:** `Error` if handshake times out (10s), message format is wrong, unknown partyId, or message2 send fails.
  - **Concurrency:** Async; safe to call in parallel for different inbound connections.

- `send(msg: AppMessage): Promise<void>`
  - **Pre:** Connection is not closed. AppMessage is a valid broadcast, pull-req, or pull-resp.
  - **Post:** JSON-encodes message, seals via RecordSession, sends ciphertext over WebSocket.
  - **Throws:** `Error` if connection is closed or WebSocket send fails.
  - **Concurrency:** Safe to call in parallel (RecordSession.seal is concurrent-safe for send side).

- `onMessage(handler: (msg: AppMessage) => void): Unsubscribe`
  - **Pre:** handler is a function.
  - **Post:** Subscribes handler to receive decrypted AppMessages. Flushes any buffered messages (decrypted before any subscriber registered).
  - **Concurrency:** Safe to call before or after frames arrive (buffering handles both cases).

- `onClose(handler: () => void): Unsubscribe`
  - **Post:** Subscribes handler to close event. Fires once when connection closes (peer close, record auth failure, ws error).

- `close(): Promise<void>`
  - **Pre:** Connection is open or already closed (idempotent).
  - **Post:** Closes WebSocket (sends close frame) and prevents further I/O.
  - **Concurrency:** Idempotent; safe to call multiple times.

- `isClosed: boolean` (getter)
  - **Post:** Returns true if connection has been closed.

**Invariants:**
- Handshake is one-shot; message1 and message2 are cleartext (65B ephemeral pubkeys).
- `HandshakeQueue` attaches a persistent `ws.on('message')` listener *before* sending/awaiting hs1/hs2 to capture in-flight frames.
- All frames arriving during handshake (before RecordSession creation) are buffered; replayed through the processing chain after construction.
- Per-connection async processing chain (`processingChain` promise) serializes decryption to prevent `RecordSession.open` counter race.
- Record auth failure closes the connection immediately (no attempt to recover).
- `bufferedAppMessages` are flushed to the first `onMessage` subscriber (idempotent single flush).
- `isClosed` flag prevents re-entrance and use-after-close.
- WebSocket errors and closes are treated the same (teardown).

**Cross-component contracts:**
- Depends on: WebSocket (ws library or Node.js), handshake (Noise-KK), RecordSession.
- Used by: peer-mesh transport to establish peer-pair connections.
- Wire/byte format: Two cleartext handshake frames (65B each); all subsequent frames are AES-GCM ciphertext.

**Notes / gotchas:**
- `HandshakeQueue` is critical: any frame arriving on the wire during async handshake awaits is captured, then replayed. Without it, early frames would be lost if they arrive before `onMessage` subscriber registers.
- Per-connection serialization (via `processingChain`) is MANDATORY: concurrent decrypts would race the `RecordSession.recvCounter`.
- Handshake timeout is 10s; should be sufficient for local/LAN links.
- Record auth failure does NOT try to retry; caller must close and reconnect.
- `onClose` handlers are called exactly once; idempotent teardown.

---

### `allowlist.ts`
**Purpose:** L4 source-IP filter for peer-mesh inbound connections. Defense-in-depth against random scanners; cryptographic auth (Noise-KK + ML-DSA pubkey book) remains the primary security boundary.

**Public surface:**
- `AllowlistPeer` — `{ partyId: number; endpoint?: string }`. Endpoint-less peers (relay-only) are skipped.

- `PeerAllowlist`
  - **Pre:** Constructor takes `peers: ReadonlyArray<AllowlistPeer>` and a `Logger`.
  - **Post:** Constructed empty; no DNS performed until `resolve()` runs.

- `resolve(): Promise<void>`
  - **Pre:** None.
  - **Post:** DNS-resolves every peer endpoint's hostname via `node:dns/promises` `lookup(host, { all: true, family: 0 })` (both A and AAAA records). Populates the internal IP set, normalizing `::ffff:`-mapped IPv4 to bare IPv4.
  - **Throws:** `Error` if any endpoint hostname can't be parsed or resolved (fail-fast at startup; daemon refuses to start with a misconfigured peer list).

- `has(ip: string): boolean`
  - **Post:** True iff `ip` (after stripping `::ffff:` prefix) is in the resolved set.

- `refresh(): Promise<void>`
  - **Post:** Re-resolves all hostnames. Logs at info level under `peer-allowlist: membership changed` when the set differs (with `added` / `removed` arrays). B.1 only resolves at startup; `refresh()` is exposed for future periodic re-resolution.
  - **Throws:** `Error` on lookup failure (caller decides whether to keep the old set).

**Invariants:**
- IPs are stored in normalized form (no `::ffff:` prefix) and `has()` normalizes its input — `has('127.0.0.1')` and `has('::ffff:127.0.0.1')` are equivalent.
- Endpoints must be `ws://` or `wss://` URLs; other schemes throw at `resolve()`.
- Bracketed IPv6 hostnames (`ws://[::1]:8800`) are accepted; brackets are stripped before DNS lookup.
- The allowlist is a denylist for everything not on it; cryptographic auth still gates whoever passes the L4 check.

**Cross-component contracts:**
- Depends on: `node:dns/promises`, `Logger` (from `orchestrator/types`).
- Used by: `peer-mesh.ts` `verifyClient` filter at WS server bind.
- Wire/byte format: N/A (not a wire-format component).

**Notes / gotchas:**
- The allowlist resolves once at startup. DNS drift is operator-managed (restart the daemon when peer IPs change). `refresh()` exists for future automation.
- Relay-only peers (no `endpoint`) are skipped in the resolution loop — they don't dial in over peer-mesh.
- Logging prefix is `peer-allowlist:` (NOT `peer-mesh:`) so log scrapers like fail2ban can pin to the drop event without false positives.

---

### `peer-mesh.ts`
**Purpose:** Real-network peer-to-peer transport over persistent WebSocket connections; lower partyId dials, higher listens; exponential backoff reconnect on initiator side.

**Public surface:**
- `PeerMeshPeer` — Immutable peer descriptor with partyId, 65-byte publicKey, and optional WebSocket endpoint (required for initiators).

- `PeerMeshOptions` — Configuration with self partyId/identity, listen address, peer list, optional WebSocket constructor, logger, pull timeout.

- `PeerMeshTransport` (implements Transport) — Real-network transport layer; owns WebSocket server + peer connection state machine. Internally serialized; broadcast and pull are concurrent-safe.

- `constructor(options: PeerMeshOptions)`
  - **Pre:** `options.listen` is valid "host:port". `options.self.partyId` is not in peer list. For each peer where `peer.partyId > self.partyId` (initiator role), `peer.endpoint` must be provided.
  - **Post:** Initializes transport state (peer states, broadcast/pull handlers, pending pulls). Does not start listening yet.
  - **Throws:** `Error` if self is in peer list or an initiator peer lacks endpoint.

- `start(): Promise<void>`
  - **Pre:** Transport not already started. Every peer endpoint hostname must be DNS-resolvable.
  - **Post:** DNS-resolves all peer endpoints into the L4 IP allowlist (fail-fast — daemon refuses to start with a misconfigured peer list). Binds WebSocket server with `verifyClient` allowlist filter (non-peer source IPs are silently dropped via `socket.destroy()` before the WS handshake completes; warn line emitted under prefix `peer-allowlist:`). Registers inbound connection handler. Kicks off initiator-side dials (exponential backoff reconnect on failure).
  - **Throws:** `Error` if any peer endpoint can't be DNS-resolved or if bind fails.

- `stop(): Promise<void>`
  - **Pre:** Transport started or already stopped (idempotent).
  - **Post:** Closes all peer connections, cancels reconnect timers, rejects pending pulls, shuts down WebSocket server.

- `address(): { host: string; port: number } | null`
  - **Pre:** Transport is started.
  - **Post:** Returns the bound address (host:port), or null if not started.

- `broadcast(msg: Uint8Array): Promise<void>` (Transport interface)
  - **Pre:** msg is any byte array. Transport is started.
  - **Post:** Encrypts msg independently for each connected peer (each session has distinct AES-GCM keys); sends to all peers. Silently skips offline peers. Logs warn if individual sends fail.
  - **Throws:** Never (errors are silent and logged).
  - **Concurrency:** Concurrent-safe; each peer gets its own seal call.

- `onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void): Unsubscribe`
  - **Post:** Registers handler to receive broadcasts from any peer. Returns unsubscribe function.

- `pull(key: BlobKey): Promise<Uint8Array | null>` (Transport interface)
  - **Pre:** key.from is in the peer list.
  - **Post:** If peer is offline, returns null immediately ("not yet available"). Otherwise, sends pull-req with unique requestId, waits up to `pullTimeoutMs` (default 30s) for pull-resp. Returns blob or null on timeout.
  - **Throws:** `Error` if key.from is not in peer list (config error).

- `servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe`
  - **Pre:** handler not already registered.
  - **Post:** Registers handler to serve pull requests from peers. Returns unsubscribe function.
  - **Throws:** `Error` if handler already registered.

**Invariants:**
- Role: lower partyId dials, higher partyId listens (asymmetric).
- Initiator side redials on disconnect with exponential backoff: 1s, 2s, 4s, 8s, capped at 10s.
- Responder side waits passively for peer to reconnect; no active redial.
- Broadcast fans out to all connected peers; each peer session encrypts independently.
- Pull timeout is per-request; transient timeout returns null (not throw); BlobPuller's retry handles retries.
- Offline peers are silently skipped (broadcast) or return null (pull); no error.
- All peer connections are closed gracefully on stop(); pending pulls are rejected.
- `partyId` is immutable; peers list is derived from options and cannot change post-construction.
- Inbound connections from non-peer source IPs are silently destroyed (no WS upgrade response) before the handshake. The allowlist resolves at startup only; relay-only peers without an `endpoint` are skipped. The cryptographic layer (Noise-KK + ML-DSA pubkey book) is the security boundary; the allowlist is defense-in-depth against random scanners.

**Cross-component contracts:**
- Depends on: WebSocket (ws library), PeerConnection (handshake + record layer), wire format (broadcast, pull-req, pull-resp).
- Used by: ceremony daemon as the peer-to-peer transport layer.
- Wire/byte format: WebSocket per peer pair, Noise-KK + AES-GCM encrypted, JSON app messages.

**Notes / gotchas:**
- Reconnect is initiator-only (asymmetric); responder is passive. Operator restart required for relay reconnect.
- Broadcast is fan-out with independent encryption per peer (not a single encrypt shared to all).
- Pull timeout returning null is not an error; caller is responsible for retry logic.
- Server bind is "host:port" (no default 0.0.0.0); explicit host required.
- Pending pulls are keyed by requestId (not per-peer); unique IDs are critical.

---

## src/transport/relay/

### `wire.ts`
**Purpose:** Minimal JSON wire protocol for relay; frame routing by ringId and partyId with opaque AES-GCM payloads.

**Public surface:**
- `RelayHello`, `RelayFrame`, `RelayAck`, `RelayPeerJoined`, `RelayPeerLeft`, `RelayIncoming`, `RelayError` — Immutable message types for client-server relay protocol.

- `encodeClientMsg(msg: RelayClientMsg): string`
  - **Pre:** msg is valid RelayHello or RelayFrame.
  - **Post:** Returns JSON string.

- `encodeServerMsg(msg: RelayServerMsg): string`
  - **Pre:** msg is valid server message.
  - **Post:** Returns JSON string.

- `parseClientMsg(text: string): RelayClientMsg | null`
  - **Pre:** text is JSON string.
  - **Post:** Parses and validates client message; returns null if invalid.

- `parseServerMsg(text: string): RelayServerMsg | null`
  - **Pre:** text is JSON string.
  - **Post:** Parses and validates server message; returns null if invalid.

**Invariants:**
- `hello` message: ringId (string), partyId (non-negative integer).
- `frame` message: to (non-negative integer), payloadHex (hex string, opaque).
- `ack` response: roster (array of partyIds, excluding sender).
- `peer-joined` / `peer-left` events: partyId.
- `incoming` message: from (partyId), payloadHex (opaque).
- `error` message: human-readable string.
- Parsing is lenient (returns null on malformed messages).

**Cross-component contracts:**
- Depends on: toHex/fromHex for payload encoding.
- Used by: relay-server and relay-transport for message encoding/decoding.
- Wire/byte format: JSON over WebSocket; payloads are hex-encoded (never plaintext).

**Notes / gotchas:**
- ringId is an opaque string (SHA-256 hex from pubkey book in relay-transport).
- payloadHex is opaque to the relay; never decrypted or validated.
- Roster in ack excludes the sender (just-connected peer sees current members before itself).
- Parsing returns null (not throw) to allow graceful drop of malformed frames.

---

### `server.ts`
**Purpose:** Tiny dumb relay router; per-ring connection roster, peer-joined/peer-left notifications, frame forwarding by partyId.

**Public surface:**
- `RelayServerOptions` — Configuration with listen address ("host:port" required) and optional logger.

- `RelayServer` — Immutable relay state machine; owns per-ring rosters and WebSocket server. Internally serialized; concurrent peer joins/frames handled safely.

- `constructor(options: RelayServerOptions)`
  - **Pre:** `options.listen` is valid "host:port".
  - **Post:** Initializes relay state (rings map). Does not start listening yet.
  - **Throws:** `Error` if bind format is invalid.

- `start(): Promise<void>`
  - **Pre:** Relay not already started.
  - **Post:** Creates HTTP server + WebSocketServer, binds to listen address, registers connection handler.
  - **Throws:** `Error` if bind fails.

- `stop(): Promise<void>`
  - **Pre:** Relay started or already stopped (idempotent).
  - **Post:** Closes all peer WebSockets, clears ring map, shuts down servers.

- `address(): { host: string; port: number } | null`
  - **Pre:** Relay is started.
  - **Post:** Returns bound address, or null if not started.

**Invariants:**
- Relay is per-ring: connections grouped by ringId (opaque string from client hello).
- Each ring maintains a roster (Map<partyId, WebSocket>).
- First-come-first-served partyId slot per ring; duplicate partyId in same ring rejected (409).
- Frame routing: only to peers in the same ring; target not connected → silent drop.
- Frame to self is rejected (400 error).
- Peer joined/left events broadcast to all other members in the ring (excluding self).
- Relay sees only opaque hex payloads; never validates or decrypts (Noise KK at peer layer provides auth).
- WebSocket errors and closes both trigger cleanup.
- Graceful shutdown closes all peer sockets; no forced close.

**Cross-component contracts:**
- Depends on: Node.js http, WebSocket (ws library), relay wire format.
- Used by: relay-transport daemons connect here; operator controls network firewall.
- Wire/byte format: JSON messages over WebSocket; frame payloads are hex.

**Notes / gotchas:**
- No authentication at relay layer; first-come-first-served partyId. Noise KK protects the ceremony — squatter can't handshake with legitimate peers.
- Operator responsible for network isolation (loopback + TLS, or VPN).
- Silent frame drop (target offline) is intentional; sender learns via peer-joined notifications.
- Rings are ephemeral; auto-deleted when empty.

---

### `relay-transport.ts`
**Purpose:** Transport interface over shared relay server; per-peer Noise-KK + AES-GCM on top of opaque relay routing; lower partyId initiates.

**Public surface:**
- `RelayTransportPeer` — Immutable peer descriptor with partyId and 65-byte publicKey.

- `RelayTransportOptions` — Configuration with self identity, relay URL, ringId, peers, optional WebSocket constructor, pull timeout, logger.

- `RelayTransport` (implements Transport) — Transport layer over shared relay; single WebSocket to relay, per-peer Noise-KK sessions. Internally serialized; broadcast and pull are concurrent-safe.

- `constructor(options: RelayTransportOptions)`
  - **Pre:** `options.self.partyId` not in peer list. ringId is non-empty string (derived from pubkey book).
  - **Post:** Initializes transport state (peer states with status, pending pulls). Does not connect to relay yet.
  - **Throws:** `Error` if self is in peer list.

- `start(): Promise<void>`
  - **Pre:** Transport not already started.
  - **Post:** Connects to relay WebSocket. Registers message handler. Sends hello with ringId and partyId. Relay responds with ack + roster; triggers handshakes for all peers in roster (initiators send hs1, responders wait for hs1).
  - **Throws:** `Error` if relay connection fails.

- `stop(): Promise<void>`
  - **Pre:** Transport started or already stopped (idempotent).
  - **Post:** Rejects pending pulls, closes relay WebSocket, clears peer states.

- `broadcast(msg: Uint8Array): Promise<void>`
  - **Post:** Encrypts msg independently for each connected peer; sends via relay frames. Silently skips offline peers. Logs warn if individual sends fail.

- `onBroadcast(handler: (from: PartyId, msg: Uint8Array) => void): Unsubscribe`
  - **Post:** Registers broadcast receiver.

- `pull(key: BlobKey): Promise<Uint8Array | null>`
  - **Pre:** key.from is in peer list.
  - **Post:** If peer is not connected, returns null. Otherwise sends pull-req, waits up to `pullTimeoutMs` (default 30s), returns blob or null on timeout.
  - **Throws:** `Error` if key.from is not in peer list.

- `servePulls(handler: (from: PartyId, key: BlobKey) => Uint8Array | null): Unsubscribe`
  - **Pre:** handler not already registered.
  - **Post:** Registers pull server.
  - **Throws:** `Error` if handler already registered.

**Invariants:**
- Role: lower partyId is initiator (sends hs1 when peer appears), higher is responder (waits for hs1).
- Peer status: disconnected → waiting-for-hs1 (responder) or waiting-for-hs2 (initiator after hs1) → connected.
- Per-peer `processing` flag + `pending` FIFO queue serialize handshake and message dispatch (prevent counter race).
- Handshake: initiator sends message1 (raw ephemeral, not encrypted), responder replies with message2 (also raw), then both derive AES-GCM session.
- Peer roster discovered via relay's ack + peer-joined/peer-left events. Initiators trigger handshake on roster update.
- Relay reconnect is NOT implemented; operator restart on relay drop.
- Broadcast is fan-out with independent encryption per peer.
- Pull timeout returning null is transient; BlobPuller's retry handles retries.
- Record auth failure disconnects the peer (status = disconnected); peer can re-handshake on next relay frame.

**Cross-component contracts:**
- Depends on: WebSocket, handshake (Noise-KK), RecordSession, relay wire format.
- Used by: ceremony daemon as relay-based transport layer.
- Wire/byte format: Single WebSocket to relay; per-peer handshake frames (cleartext ephemeral), then AES-GCM encrypted app messages routed via relay frames.

**Notes / gotchas:**
- Role is symmetric (lower dials, higher listens) but implemented via relay routing. Initiator sends hs1 as frame(to=partyId, payload=hs1); responder receives incoming(from=partyId, payload=hs1).
- Per-peer `processing` flag is CRITICAL: without it, concurrent incoming frames could race the handshake state machine.
- Broadcast and pull are independent per-peer; one peer's failure doesn't affect others.

**Reconnect behavior (operator-facing):** No automatic reconnect. If the relay WebSocket drops mid-session, `handleRelayClose()` sets all peers to disconnected and clears sessions; subsequent broadcasts silently no-op (offline peers are skipped) and pulls return null. The daemon does NOT re-dial. Operators recover via `systemctl restart otzi`. Acceptable for the bootstrap/control-plane path (short-lived); production federations that need stability should use peer-mesh transport, which has initiator-side exponential-backoff reconnect built in.

---

