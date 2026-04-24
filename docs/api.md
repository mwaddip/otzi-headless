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

- **Method:** `POST`. Anything else → `405`.
- **Content-Type:** JSON body, max 1 MB.
- **Bind:** operator-configured via `[[triggers]].params.bind` as `host:port`
  (default suggestion `127.0.0.1:7080`). The daemon does not enforce a
  loopback constraint yet — prefer loopback or a Unix socket fronting
  (operator responsibility until the binding-constraint work lands). An
  exposed operator API on a leaf is equivalent to an attacker owning it —
  the gate is the only thing between forged triggers and a co-signed
  transaction.
- **Bearer auth:** when `[[triggers]].params.auth_token_env` is set, the
  daemon reads the token from that env var at startup and requires matching
  `Authorization: Bearer <token>` on every request. Missing/mismatched →
  `401` with `{ "error": "unauthorized" }`.

## Common fields

Every request body is a JSON object. All ceremony requests accept:

| Field | Type | Notes |
|---|---|---|
| `op` | string, required | One of `dkg-combined`, `dkg-mldsa`, `dkg-frost`, `sign`. |
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

Request:

```jsonc
{
  "op": "dkg-combined",
  "threshold": 2,       // t-of-n; required
  "parties": 3,         // n; required
  "level": 44           // ML-DSA security level — OPNet requires 44
}
```

Response:

```jsonc
{
  "ceremonyId": "dkg-combined-…",
  "status": "done",
  "mldsaPublicKeyHex": "…",           // 1312B hex at level 44
  "frostVerifyingKeyHex": "…"         // 33B SEC1 compressed, tweaked aggregate key
}
```

## `op: "dkg-mldsa"`

Pure ML-DSA DKG. Produces an ML-DSA key share only — no FROST, no
`frostLegacySig`. Useful when the federation isn't using FROST (signing
arbitrary bytes via `scheme='mldsa'`).

Request:

```jsonc
{
  "op": "dkg-mldsa",
  "threshold": 2,
  "parties": 3,
  "level": 44
}
```

Response:

```jsonc
{ "ceremonyId": "…", "status": "done", "mldsaPublicKeyHex": "…" }
```

## `op: "dkg-frost"`

Pure FROST DKG (secp256k1). Produces a FROST key share only — no ML-DSA.

Request:

```jsonc
{ "op": "dkg-frost", "threshold": 2, "parties": 3 }
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
| `protocol` | `"btc"` \| `"opnet"` \| `"raw"` | See variant-specific rules below. |
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

### `scheme: "frost", protocol: "opnet"`

OPNet raw-tx + per-input prevout info + optional advisory hints. The operator
built the tx using the OPNet SDK (via `captureOpnetSighashes`). The daemon
extracts BIP-341 sighashes from the raw bytes; participants re-extract and
compare. Construction-params for OPNet is deferred (needs SDK-level UTXO
fetcher determinism — tracked).

Request:

```jsonc
{
  "op": "sign",
  "scheme": "frost",
  "protocol": "opnet",
  "signers": [0, 1],
  "unsignedTxHex": "…full unsigned tx hex…",
  "inputs": [
    {
      "scriptHex": "…prevout scriptPubKey hex…",
      "valueSat": "200000",
      "tweaked": true                  // true = key-path, false = script-path
    }
  ],
  "hints": {                            // optional — advisory only
    "contractAddress": "0x…",
    "method": "transfer",
    "amountTokenAtomic": "1000000"
  }
}
```

Hints are unverified — they populate `CeremonySpec` for policy-gate matching
(e.g. `allowed_contracts`, `allowed_methods`). The daemon never decodes ABI.
Matches federation-trust: a rogue insider can lie in hints, but the worst
case is DoS (gate-based refusal or a failed OPNet call).

Response:

```jsonc
{
  "ceremonyId": "…",
  "status": "done",
  "scheme": "frost",
  "signaturesHex": ["…", "…"]           // one per input, in ceremony order
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
