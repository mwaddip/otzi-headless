# Daemon HTTP API

The daemon exposes a single HTTP endpoint — `POST /` — that dispatches on the
request body's `op` field. Used by the operator's trigger infrastructure
(local CLI, cron, watchers) to initiate ceremonies against this daemon's
share. Ceremonies always run across every peer in the ring; this endpoint
only fires them from *this* node as leader.

This is the shape served by the default handler built by `buildDefaultHttpHandler`
and wired by the `[[triggers]]` of kind `http` in `daemon.toml`. Per-daemon
configuration (bind address, auth, gate strategy) is documented in
[`config.md`](./config.md).

## Transport + auth

The operator API listens on a Unix domain socket by default:

- **UDS path:** `/var/run/otzi/otzi.sock` (configurable via `[[triggers]] kind="uds" path=...`).
- **Auth:** filesystem permissions. The socket is `chmod 660 root:otzi`. Any user in the `otzi` group can connect; nobody else.
- **Wire shape:** HTTP/1.1 over the UDS, identical to TCP HTTP. Use Node's `http.request({ socketPath })` or `curl --unix-socket`.
- **Method:** `POST`. Anything else → `405`.
- **Content-Type:** JSON body, max 1 MB.

Optionally, `[[triggers]] kind="http"` can be opted into for a TCP listener — but the parser enforces loopback (`127.0.0.1`, `::1`, `localhost`) only. External binds are rejected at startup with a `ConfigError`. This is load-bearing for the security posture: the daemon is reachable only via the local CLI.

When `[[triggers]] kind="http" auth_token_env="…"` is set, the daemon reads the token from that env var at startup and requires matching `Authorization: Bearer <token>` on every request. Missing/mismatched → `401` with `{ "error": "unauthorized" }`. UDS triggers do NOT use Bearer auth (filesystem permissions are the auth model).

## Common fields

Every request body is a JSON object. All ceremony requests accept:

| Field | Type | Notes |
|---|---|---|
| `op` | string, required | One of `dkg-combined`, `dkg-mldsa`, `dkg-frost`, `sign`, `vault-info`, `sync`. |
| `ceremonyId` | string, optional | Operator-supplied. When omitted, the daemon generates `"<op>-<uuid>"`. Must not contain `#` (reserved for ML-DSA retry suffixes). |

Every successful response body includes:

| Field | Type | Notes |
|---|---|---|
| `ceremonyId` | string | Echoes back the request ID. |
| `status` | `"done"` | Success marker. Failures are surfaced as non-2xx. |

## Error shapes

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "error": "<detail>" }` | Malformed body, missing required field, or unknown enum value. |
| `401` | `{ "error": "unauthorized" }` | Auth token required but missing/wrong. |
| `403` | `{ "error": "gate rejected", "decision": "reject"\|"pending", "ceremonyId": "…" }` | This daemon's gate refused the ceremony. See [`gates.md`](./gates.md). |
| `405` | `{ "error": "method not allowed" }` | Non-POST method. |
| `500` | `{ "error": "<detail>" }` | Protocol failure (peer dropped, timeout, crypto error). Check logs. |

## `op: "dkg-combined"`

Combined ML-DSA + FROST DKG under a single `sessionId`. Produces a V3-compatible
encrypted share on **every peer** at the configured path. When the daemon's
`[network].name` is `mainnet` or `testnet`, a final n-of-n FROST sign over
`computeKeyLinkHash(...)` also runs as part of the ceremony, and the resulting
`frostLegacySig` is persisted alongside the share — required for OPNet contract
calls against the resulting vault (the SDK replays it via `withFrostLegacySig`
during tx construction). Regtest skips the keylink phase; OPNet contract
calls against such a vault will fail at capture.

`parties` is derived by the leader from its own configured peer set
(`peers.length + 1`); `threshold = parties` (v0.1 is n-of-n by design — see
`INTERFACES.md` § Trust model); `level = 44` (only level supported on OPNet).
The CLI doesn't pass any of these; the request body is just `op` + optional
`ceremonyId`.

Request:

```jsonc
{
  "op": "dkg-combined",
  "ceremonyId": "..."   // optional; daemon auto-generates if absent
}
```

Response:

```jsonc
{
  "ceremonyId": "dkg-combined-…",
  "status": "done",
  "mldsaPublicKeyHex": "…",           // 1312B hex at level 44
  "frostVerifyingKeyHex": "…",        // 33B SEC1 compressed, tweaked aggregate key
  "btcAddress": "tb1p…",              // bech32m P2TR — fund here for BTC
  "opnetAddress": "0x…",              // 0x + sha256(mldsaPubKey) — send OP20 / contract calls here
  "network": "testnet"                // mirrors [network].name
}
```

The `btcAddress` / `opnetAddress` / `network` fields match what
`/var/lib/otzi/vault-pubkey.json` will hold once the daemon is restarted.
`otzi generate` prints them in its banner so the operator doesn't have to
read the cache file separately.

## `op: "vault-info"`

Read-only metadata for the vault. Used by the CLI (`otzi sign`, `otzi btc send`)
to discover the signer set + threshold without reading the share file. Returns
the same `btcAddress` / `opnetAddress` as `dkg-combined` so callers can verify
they're talking to the right vault.

Request:

```jsonc
{ "op": "vault-info" }
```

Response (`200`):

```jsonc
{
  "partyIds": [0, 1, 2],
  "threshold": 2,
  "parties": 3,
  "network": "testnet",
  "btcAddress": "tb1p…",
  "opnetAddress": "0x…"
}
```

If the daemon has no share loaded (DKG hasn't run yet), responds `409`:
`{ "error": "vault-info: no share loaded (run `otzi generate` first)" }`.

## `op: "dkg-mldsa"`

Pure ML-DSA DKG. Produces an ML-DSA key share only — no FROST, no
`frostLegacySig`. Useful when the federation isn't using FROST (signing
arbitrary bytes via `scheme='mldsa'`). Same parameter-derivation rules as
`dkg-combined`: parties derived from configured peers, threshold = parties,
level = 44.

Request:

```jsonc
{ "op": "dkg-mldsa", "ceremonyId": "..." }   // ceremonyId optional
```

Response:

```jsonc
{ "ceremonyId": "…", "status": "done", "mldsaPublicKeyHex": "…" }
```

## `op: "dkg-frost"`

Pure FROST DKG (secp256k1). Produces a FROST key share only — no ML-DSA.
Same parameter-derivation rules as `dkg-combined`.

Request:

```jsonc
{ "op": "dkg-frost", "ceremonyId": "..." }   // ceremonyId optional
```

Response:

```jsonc
{ "ceremonyId": "…", "status": "done", "frostVerifyingKeyHex": "…" }
```

## `op: "sign"`

Dispatches to the FROST or ML-DSA signing runner. Request shape is
discriminated by `(scheme, protocol)`.

Common fields for every `sign` variant:

| Field | Type | Notes |
|---|---|---|
| `scheme` | `"frost"` \| `"mldsa"` | Required. |
| `protocol` | `"btc"` \| `"opnet"` \| `"opnet-params"` \| `"raw"` | See variant-specific rules below. |
| `signers` | `number[]` | Active signer partyIds. Must include this daemon's own `partyId` (it's the leader). |

### `scheme: "frost", protocol: "btc"`

BTC construction parameters. The leader deterministically builds the tx via
`buildBtcTxFromParams`, and every participant rebuilds the same tx locally
and verifies sighashes before signing. See `SESSION_CONTEXT.md` § BTC
construction-params.

Request:

```jsonc
{
  "op": "sign",
  "scheme": "frost",
  "protocol": "btc",
  "signers": [0, 1],
  "btc": {
    "to": "bc1p…",                      // destination bech32
    "amountSat": "50000",               // decimal string (u64-safe)
    "feeRate": 5,                       // sat/vB
    "network": "mainnet",               // or "testnet" — matches opnetTestnet
    "frostP2tr": "bc1p…",               // vault P2TR (= untweaked FROST aggregate key's P2TR)
    "frostUntweakedPubKeyHex": "…",     // 33B SEC1 compressed
    "utxos": [
      {
        "transactionId": "…64 hex chars…",
        "outputIndex": 0,
        "valueSat": "100000"            // decimal string
      }
    ]
  }
}
```

If the leader lies about UTXOs (fake, inflated, wrong script), Bitcoin
consensus rejects the tx at broadcast time — BIP-341 sighashes commit to
real prevout scripts + values. Worst case is wasted ceremony (DoS); never
theft. Matches the federation-trust model.

Response:

```jsonc
{
  "ceremonyId": "…",
  "status": "done",
  "scheme": "frost",
  "signaturesHex": ["…64-byte BIP340 hex…"]
}
```

One sig per input; the caller broadcasts the tx. `btc.ts`'s `broadcastBtcTx`
is the standard path — it injects the sigs as witness elements and does a
BIP340 verify under the tweaked aggregate key before submitting.

### `scheme: "frost", protocol: "opnet"` — DEPRECATED (returns 400)

The raw unsigned-tx path has been deprecated as of phase 9a. Participants
cannot independently verify the announced contract/method/amount against
the operator-supplied bytes (`hints` are advisory only); gate policy
evaluates untrusted fields. A rogue leader can sign something other than
what the operator intended.

Use `protocol: 'opnet-params'` (Phase 8) instead — every node rebuilds the
tx independently from construction params and sighash-checks before
signing.

The underlying broadcast helpers in `src/broadcast/opnet-capture.ts` and
`opnet-broadcast.ts` are still in the binary (still imported by the
`opnet-params` flow internally); only the public HTTP entry point is
gated off. Re-enable in `src/daemon/daemon.ts::buildDefaultHttpHandler`
only if you accept the unverifiability and have a use case the SDK
can't reach via construction params.

### `scheme: "frost", protocol: "opnet-params"`

OPNet construction parameters — the construction-params equivalent of the
`btc` protocol for OPNet contract calls. The leader fetches UTXOs + challenge
from the OPNet provider, generates a 32-byte random seed, runs the full
deterministic capture (see SESSION_CONTEXT § Deterministic OPNet capture) to
produce the template txs + sighashes, asserts all three on-wire. Participants
re-run the identical capture from asserted inputs and verify the sighashes
match before signing — policy rules evaluate **structurally verified**
`contractAddress` + `method`, not advisory hints. The daemon owns the OPNet
`captureContext` and broadcasts the tx internally after the FROST ceremony —
the operator does not broadcast externally.

Operator pre-computes `mldsaThresholdSignatureHex` via a prior
`op: "sign", scheme: "mldsa", protocol: "raw"` ceremony over
`sha256(calldata)` (calldata is produced by the OP-20 encoder in
`opnet-calldata.ts`). The daemon knows only OP-20 ABI — custom-ABI contracts
stay on the `protocol: "opnet"` (raw-tx) path.

Request:

```jsonc
{
  "op": "sign",
  "scheme": "frost",
  "protocol": "opnet-params",
  "signers": [0, 1],
  "contractAddress": "opt1…",              // OP-20 contract (bech32 or 0x hex)
  "method": "transfer",
  "params": ["0x…32-byte address hex…", "1000000"],   // positional args, JSON-safe
  "paramTypes": ["address", "u256"],        // optional; defaults OP-20 ABI inference
  "mldsaThresholdSignatureHex": "…",        // outer ML-DSA sig over sha256(calldata)
  "feeRate": 10,                            // sat/vB; optional, default 10
  "priorityFeeSat": "1000",                 // decimal string; optional, default "1000"
  "maxSatToSpendSat": "100000",             // decimal string; optional, default "100000"
  "hints": {                                // optional; advisory — amount stays unverified
    "amountTokenAtomic": "1000000"
  }
}
```

Notes:

- `contractAddress` and `method` land on the `CeremonySpec` as
  structurally-verified fields — use `allowed_contracts` + `method_allowlist`
  gate policy rules against trusted data. `amountTokenAtomic` remains
  advisory (daemon stays ABI-agnostic for amounts).
- The daemon derives the vault refund address (P2TR of the untweaked FROST
  aggregate key) locally per-peer. Operator cannot override — a bogus refund
  would be change-theft, not DoS.
- If the leader lies about UTXOs / challenge / random seed, participants'
  rebuilt sighashes differ → silent drop → ceremony aborts (DoS, not theft).
  Matches federation-trust.
- Requires a V3 share (combined DKG with `[network]` set to mainnet/testnet
  → `frostLegacySig` persisted). Regtest daemons cannot run `opnet-params`.

Response:

```jsonc
{
  "ceremonyId": "…",
  "status": "done",
  "scheme": "frost",
  "signaturesHex": ["…", "…"],              // one per captured sighash
  "transactionId": "…"                      // daemon-broadcasted OPNet txid
}
```

### `scheme: "mldsa", protocol: "raw"`

Opaque ML-DSA signing over operator-supplied bytes.

Request:

```jsonc
{
  "op": "sign",
  "scheme": "mldsa",
  "protocol": "raw",
  "signers": [0, 1],
  "messageHex": "…arbitrary hex bytes…"
}
```

Response:

```jsonc
{
  "ceremonyId": "…",
  "status": "done",
  "scheme": "mldsa",
  "signatureHex": "…"                   // 2420 B at level 44
}
```

No protocol-level decoding or policy-gate field population beyond the
generic `operation: 'generic'` marker — gate rules targeting `allowed_btc_recipients`
or `allowed_contracts` don't apply.

## `op: "sync"`

Distribute a manifest to all peers in the federation. Bootstrap-window-only
— returns `410` once the local daemon has wiped its `bootstrap-secret`
post-DKG.

The local daemon installs the manifest first (atomic write to
`/etc/otzi/manifest.otzi.json`), then broadcasts a `manifest-push` wire
message to every peer. Each peer's daemon re-verifies the HMAC, validates
the manifest against `headless-manifest-v1`, and atomically installs to
its own `/etc/otzi/manifest.otzi.json`. Per-peer success/failure is NOT
exposed in the response (the underlying transport surface is broadcast,
not unicast); operators verify peer state via `otzi list` on each node or
via daemon logs.

Request:

```jsonc
{
  "op": "sync",
  "manifest": "<.otzi.json contents as a UTF-8 string — verbatim, no canonicalization>",
  "hmac": "<hex HMAC-SHA-256(bootstrap_secret, manifest_text)>"
}
```

Response (`200`):

```jsonc
{
  "ceremonyId": "sync-…",
  "status": "done",
  "peersNotified": 2
}
```

Error responses:

| Status | Cause |
|---|---|
| `400` | HMAC mismatch, schema validation failure, JSON parse error, or a different manifest already installed locally (run `otzi uninstall` first). |
| `410` | `/var/lib/otzi/bootstrap-secret` is absent on this daemon (post-DKG, control plane closed). Use `otzi install` on each node instead. |
| `502` | Manifest installed locally, but transport.broadcast to peers failed. |

### Wire opcodes (peer-to-peer)

#### `manifest-push`

The wire message broadcast by the local daemon on `op:'sync'`. Carries the
operator's manifest text + HMAC to every peer in the ring. Bootstrap-window-only;
receivers drop with a logged warning post-DKG (their bootstrap-secret has
been wiped).

```jsonc
{
  "v": 1,
  "kind": "manifest-push",
  "manifest": "<.otzi.json contents>",
  "hmac": "<hex HMAC-SHA-256>"
}
```

The transport's `from` field already authenticates the sender as a peer in
the ring; the HMAC is additive — it proves the sender knows the
*operator-typed* shared secret, not just any peer.

## Identity of fields that look similar

Keep these straight. OPNet vaults use multiple pubkeys of different types:

| Field | What | Used for |
|---|---|---|
| `mldsaPublicKeyHex` | Raw ML-DSA aggregate pubkey (1312 B at level 44) | ML-DSA verify + outer OPNet auth |
| `frostVerifyingKeyHex` | 33 B SEC1 compressed — **tweaked** FROST aggregate | BIP340 verify for key-path P2TR spends |
| `frostUntweakedPubKeyHex` | 33 B SEC1 compressed — untweaked FROST aggregate | P2TR internal key (derives the vault address) |
| `walletAddress` (config) | `0x` + hex(SHA256(mldsaPubKey)) | Peer identity, auth |
| `frostP2tr` | bech32 P2TR encoding of the vault | Source of UTXOs + change address |

`CLAUDE.md` § Identity Model is the authoritative cheat sheet.
