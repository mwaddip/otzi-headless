# Daemon API

The daemon exposes a single endpoint, `POST /`, that dispatches on the request
body's `op` field. There are three ops: `vault-info`, `dkg` and `sign`. The
`otzi` CLI wraps `dkg` (`otzi generate`) and `sign` (`otzi btc send` /
`otzi btc sign`); operator backends call `sign` directly. Ceremonies always run
across every node in the ring; an op only fires one from *this* node as leader.

The daemon has no chain access. `sign` takes a Bitcoin transaction proposal and
returns the signed transaction; the caller reads UTXOs, picks the fee rate and
broadcasts. Per-daemon configuration (triggers, gate strategy, deadlines) is
documented in [`config.md`](./config.md).

## Transport + auth

The operator API listens on a Unix domain socket by default:

- **UDS path:** `/var/run/otzi/otzi.sock` (configurable via `[[triggers]] kind="uds" path=...`).
- **Auth:** filesystem permissions. The socket is `chmod 660 root:otzi`. Any user in the `otzi` group can connect; nobody else.
- **Wire shape:** HTTP/1.1 over the UDS, identical to TCP HTTP. Use Node's `http.request({ socketPath })` or `curl --unix-socket`.
- **Method:** `POST`. Anything else → `405`.
- **Content-Type:** JSON body, max 1 MB. A `sign` request (one proposal of at most 255 inputs) fits well inside the cap.

`[[triggers]] kind="http"` opts into a TCP listener. The parser enforces a
loopback bind (`127.0.0.1`, `::1`, `localhost`); external binds are rejected at
startup with a `ConfigError`. Loopback-only binding is what makes mTLS
unnecessary: the daemon is reachable only from the local machine.

When `[[triggers]] kind="http" auth_token_env="…"` is set, the daemon reads the
token from that env var at startup and requires a matching
`Authorization: Bearer <token>` on every request. Missing or mismatched → `401`
with `{ "error": "unauthorized" }`. UDS triggers do not use Bearer auth
(filesystem permissions are the auth model).

```bash
# Debugging example.
curl --unix-socket /var/run/otzi/otzi.sock -X POST http://localhost/ \
  -H 'content-type: application/json' -d '{"op":"vault-info"}'
```

## Common rules

Every request body is a JSON object with an `op`. Unknown top-level fields are
rejected with `400`, as are unknown ops.

| Field | Type | Notes |
|---|---|---|
| `op` | string, required | `vault-info`, `dkg` or `sign`. |
| `ceremonyId` | string, optional (`dkg`, `sign`) | Matches `^[A-Za-z0-9._:-]{1,128}$`. When omitted, the daemon generates `"<op>-<uuid>"`. |

A `ceremonyId` must not repeat within the blob retention window (5 minutes
after a signing ceremony ends on a node, 15 minutes after a DKG). Omit it to get
a fresh one.

`dkg` and `sign` success bodies include:

| Field | Type | Notes |
|---|---|---|
| `ceremonyId` | string | The request's ID, or the generated one. |
| `status` | `"done"` | Success marker. Failures are non-2xx. |

## Error shapes

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "error": "<detail>" }` | Malformed body, unknown op, unknown top-level field, invalid `ceremonyId` / `signers` / `proposal`, or a proposal this node's analysis rejects (the message comes from `analyzeProposal`). Nothing was announced to peers. |
| `401` | `{ "error": "unauthorized" }` | HTTP trigger with `auth_token_env`, token missing or wrong. |
| `403` | `{ "error": "gate rejected", "decision": "reject"\|"pending", "ceremonyId": "…" }` | This daemon's own gate did not approve. Nothing was announced to peers. See [`gates.md`](./gates.md). |
| `405` | `{ "error": "method not allowed" }` | Non-POST method. |
| `409` | `{ "error": "<detail>" }` | `vault-info` / `sign`: no vault is loaded (`no vault loaded — run otzi generate, then restart the daemon`). `dkg`: this node already holds a vault, or a DKG is already running on this node. `dkg` / `sign`: the `ceremonyId` is already in use on this node — by a live ceremony, or by one that ended here within its retention period (5 min signing, 15 min DKG). Nothing was announced to peers. |
| `500` | `{ "error": "<detail>", "ceremonyId": "…" }` | Ceremony failure after the announce: a peer dropped or rejected, the ceremony deadline passed (`ceremony deadline of <ms> ms passed`, from `[deadlines]`), a blob failed sender binding, a signature failed verification. Check the daemon logs; the cause names the offending party where one is known. |

## `op: "vault-info"`

Read-only vault metadata for operator backends and tooling: the vault address and
keys, the network, the threshold and the ring's party IDs. `otzi vault` does not
call it; it reads `vault-pubkey.json`.

Request:

```jsonc
{ "op": "vault-info" }
```

Response (`200`):

```jsonc
{
  "partyIds": [0, 1, 2],             // every ring member, ascending
  "threshold": 3,
  "parties": 3,
  "network": "testnet4",
  "address": "tb1p…",                // bech32m key-path-only P2TR — fund here
  "internalKey": "02…",              // 33-byte SEC1 hex, the untweaked group key
  "outputKey": "…"                   // 32-byte x-only hex, the BIP341 output key
}
```

`409` when no share is loaded (no DKG has run, or the daemon was not restarted
after `dkg`).

## `op: "dkg"`

Runs the run-once distributed key generation across the whole ring. The node
that receives the call generates the 32-byte session ID and announces; every
node plays the same role in the protocol (see
[`signing-flows.md`](./signing-flows.md)).

`parties` is the ring size (the number of entries in the pubkey book) and
`threshold = parties`: the vault is n-of-n. The request carries no parameters
besides an optional `ceremonyId`.

Request:

```jsonc
{
  "op": "dkg",
  "ceremonyId": "setup-2026-10-10"   // optional; daemon auto-generates if absent
}
```

Response (`200`):

```jsonc
{
  "ceremonyId": "setup-2026-10-10",
  "status": "done",
  "address": "tb1p…",
  "internalKey": "02…",              // 33-byte SEC1 hex
  "network": "testnet4"              // mirrors [network].name
}
```

The call returns after every node has confirmed the same vault key. By then
each node has written its Ötzi v4 share (`0600`) to `[share].path` and
`vault-pubkey.json` to `/var/lib/otzi/`. A running daemon does not load the new
share until it restarts: restart every daemon before the first `sign`.

Preconditions and failures:

- Every node in the ring is running and holds no vault (no share loaded, no file
  at the share path). A node that holds one drops the announce, so the ceremony
  cannot complete.
- `409` (`this node already holds a vault`) when the receiving node itself holds
  a vault; nothing is announced. Replacing a vault is an operator action: move
  the share file away and restart the daemon.
- `409` (`a DKG is already running on this node`) while the node leads or takes
  part in another DKG, or (`ceremony id <id> is already in use on this node`)
  for an ID used here within the last 15 minutes; nothing is announced.
- `403` when the receiving node's gate does not approve the DKG spec.
- `500` when the ceremony fails or times out (`[deadlines].dkg_ms`). Every node
  deletes its staged `<share path>.pending` file.

## `op: "sign"`

Signs a Bitcoin transaction proposal with the vault key. Every node in the
signer set analyses the proposal against its own key and network and evaluates
its own gate before it signs; the leader finalizes the signed transaction and
returns it.

Request:

```jsonc
{
  "op": "sign",
  "ceremonyId": "withdrawal-0042",     // optional
  "signers": [0, 1, 2],                // optional; default: every ring member
  "proposal": {
    "network": "testnet4",
    "tx": "0200000001…",               // unsigned transaction, hex
    "prevouts": [
      { "txid": "9f1c…e2", "vout": 0, "amount": 100000, "script": "5120…" }
    ]
  }
}
```

Response (`200`):

```jsonc
{
  "ceremonyId": "withdrawal-0042",
  "status": "done",
  "txid": "4d2a…",
  "signedTxHex": "02000000000101…",    // witnesses in place, ready to broadcast
  "signaturesHex": ["…"]               // one 64-byte BIP340 signature per input, input order
}
```

The daemon does not broadcast. `otzi btc send` posts `signedTxHex` to Esplora;
a backend does the same with its own broadcaster.

### Input rules

| Field | Rule |
|---|---|
| `signers` | Unique ring party IDs, including this node, at least the share's threshold. Defaults to every ring member. A vault created by `otzi generate` has `threshold = parties`, so every node signs. |
| `proposal` | An object with a string `tx` and an array `prevouts` of 1 to 255 entries. Hex fields (`tx`, `prevouts[].txid`, `prevouts[].script`) are normalized to lowercase. |
| `prevouts[]` | `{ txid, vout, amount, script }`: `txid` 64 hex characters, `vout` and `amount` (sats) non-negative safe integers, `script` the prevout's scriptPubKey hex. |

At most 255 inputs fit in one ceremony. The CLI refuses a larger send before
calling the daemon; consolidate UTXOs first.

### What every node checks

After the shape checks above, each node runs `analyzeProposal` against the
public key package in its own share and its own configured network. The proposal
is rejected unless all of these hold:

| Rule | Why |
|---|---|
| `proposal.network` equals this node's network. | A leader cannot sign for a different chain. |
| Input `i` spends `prevouts[i]`, and input and prevout counts match. | Prevout data binds the sighashes. |
| Every prevout script is this vault's output script (`OP_1 <outputKey>`). | The vault signs only its own coins. |
| Every input sequence is `0xfffffffd`; `lockTime` is `0`. | Fixed transaction shape. |
| There is at least one output, every output has a standard address, and `fee ≥ 0`. | Sane transactions only. |

Change is any output paying this vault's own script. Sighashes are never sent
over the wire: each node computes them from the proposal. BIP341 sighashes
commit to every input amount and script, so a proposal with false prevout data
produces signatures that are invalid on chain.

On the leader a rejected proposal is a `400` and nothing is announced. A
`ceremonyId` already in use on the leader (live, or used there within its
retention period) is a `409` before analysis and the gate, so it consumes no
gate approval. On a
participant it is a silent drop with a log line; to the leader the participant
is indistinguishable from an offline node, and the leader's ceremony fails (`500`).

### Gate

After analysis, the node's gate sees a signing spec built from that analysis
(outputs with `isChange`, amount, fee, fee rate, labels from the node's own
address book). A leader whose gate does not approve returns `403`. See
[`gates.md`](./gates.md).

### Failure after the announce

The leader broadcasts `signoff-aborted` and returns `500`. Participants settle
as aborted and release their state. A retry uses a new `ceremonyId`; every
session draws fresh nonces.

## Vault key fields

Keep these apart. The transport identity is never a vault key.

| Field | What | Used for |
|---|---|---|
| `address` | bech32m key-path-only P2TR (`bc1p…` mainnet, `tb1p…` testnet4 and signet) | Receiving funds; the only script the vault signs for |
| `internalKey` | 33-byte SEC1 hex, the untweaked FROST group key | P2TR internal key; derives `address` |
| `outputKey` | 32-byte x-only hex, the BIP341 tweaked key | The key every signature verifies against |
| `publicKeyHex` (pubkey book) | 65-byte uncompressed P-256 key, 130 hex characters | Transport authentication and `partyId` only |

`CLAUDE.md` § Identity Model is the authoritative cheat sheet.
