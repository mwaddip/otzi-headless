# gate-web-btc-message — webhook gate approver with Bitcoin message signatures

This example is a standalone service that sits between the `otzi-headless` daemon and a human operator. It speaks the daemon's `webhook` gate interface and enforces one operator-auth policy: **every approve/reject decision must carry a valid Bitcoin message signature from one pinned operator address**, made in any wallet that signs messages.

The daemon has no knowledge of message signatures or of this auth scheme. That separation is deliberate: the daemon exposes a generic signaling surface (`ApprovalGate.approve(spec) → decision`); the decision logic lives here, outside the daemon, and can be swapped for any other auth mechanism without touching the daemon. This approver imports the lifted `src/otzi/backend/btc-message.ts` for verification; the daemon never does.

## Architecture

```
           ┌──────────┐                   ┌──────────────┐  GET  /          ┌─────────┐
           │          │  POST /webhook    │              │◀─────────────────│         │
  daemon ──▶ webhook  │ ─────────────────▶│  approver    │  GET  /pending   │ browser │
           │   gate   │                   │              │◀─────────────────│    +    │
           │          │◀── { decision } ──│              │  POST /decide    │ wallet  │
           └──────────┘  (held until      └──────────────┘◀─────────────────│         │
                         operator signs)                                    └─────────┘
```

1. A trigger reaches the daemon (the `sign` op on the leader, a ceremony announce on a participant). The daemon analyses the proposal against its own key and builds the spec.
2. The webhook gate POSTs the spec JSON to `/webhook`. The approver mints a fresh 16-byte hex nonce, files the request under it and holds the connection open.
3. The operator opens the page. It lists every pending spec: ceremony id, outputs with labels and change flags, fee, fee rate and txid for a signing spec; threshold, ring and leader for a DKG spec.
4. The operator picks Approve or Reject. The page shows the exact message to sign:

   ```
   otzi-gate:<approve|reject>:<ceremonyId>:<nonce>
   ```

5. The operator signs that message with the pinned address in their wallet and pastes the base64 signature into the page.
6. The page POSTs `{ nonce, decision, signature }` to `/decide`. The approver verifies the signature against the pinned address, then resolves the held webhook response with `{ "decision": "approve" | "reject" }`. A signature that does not verify changes nothing: the request stays pending.
7. The daemon's webhook gate returns the decision. Signing proceeds or this node stays silent.

## Run the approver

```bash
# From the otzi-headless repo root (tsx is installed with the repo's dependencies)
export APPROVER_ADDRESS="bc1q…"               # the operator's Bitcoin address (REQUIRED)
export APPROVER_LISTEN="127.0.0.1:8181"       # optional, this is the default
export APPROVER_TOKEN="…"                     # optional, see below
npx tsx examples/gate-web-btc-message/approver.ts
```

| Variable | Meaning |
|---|---|
| `APPROVER_ADDRESS` | The one address whose signatures count. Mainnet or test-network address of any type the verifier accepts (below). The approver refuses to start if it is not a valid address. |
| `APPROVER_LISTEN` | `host:port` to listen on, default `127.0.0.1:8181`. IPv6 as `[::1]:8181`. A loopback host turns on the `Host` check described under Exposure. |
| `APPROVER_TOKEN` | When set, `POST /webhook` requires `Authorization: Bearer <token>`. Set it together with `bearer_token_env` in the daemon's `[gate]` table. |

## Configure the daemon

Gate parameters sit directly in the `[gate]` table, next to `strategy`:

```toml
[gate]
strategy         = "webhook"
url              = "http://approver:8181/webhook"
timeout_sec      = 86400                       # 24h, enough time for human review
bearer_token_env = "APPROVER_TOKEN"            # optional; env var on the daemon holding the token

[deadlines]
signing_ms = 86400000                          # every signer's decision must arrive within these
dkg_ms     = 86400000
```

Raise `[deadlines]` on every node to cover the slowest approver, and keep `timeout_sec` within it (see `docs/gates.md` § Operator-in-the-loop timeouts). `timeout_sec` is one deadline for the daemon's whole request. When it passes, or the daemon restarts, the daemon disconnects and the approver drops that pending entry.

A gate decides for its own node only, so run one approver per node (or point several nodes at one approver; each request is held under its own nonce). Configure a gate on every node that should refuse spends.

## Signing the message

The message binds the decision to one ceremony and one approver-issued nonce, so a signature cannot be replayed for another ceremony, for the opposite decision, or after it has been used.

The verifier accepts what `src/otzi/backend/btc-message.ts` accepts:

| Pinned address type | Signature |
|---|---|
| P2WPKH (`bc1q…` / `tb1q…`) | BIP-322 simple, or legacy / BIP-137 |
| P2TR (`bc1p…` / `tb1p…`), key path | BIP-322 simple |
| P2PKH (`1…`) and P2SH-P2WPKH (`3…`) | legacy `signmessage` / BIP-137 |

Paste the signature as base64, as wallets print it. Message signing in Bitcoin Core (`signmessage`) covers P2PKH addresses only; use a wallet that supports BIP-322 or BIP-137 for segwit and taproot addresses.

## Security properties

- **Pinned address.** The approver trusts exactly one address. A signature from any other key does not verify.
- **Nonce per request.** 16 random bytes per held webhook request, deleted when its decision lands, so a nonce works once. A wrong signature does not consume it.
- **Decision and ceremony in the message.** An approve signature does not verify as a reject, and a signature for one ceremony does not verify for another.
- **Fail closed.** A malformed spec, an unknown spec `kind`, a wrong bearer token, a full queue (100 pending) or a shutting-down approver all answer with an HTTP error, which the daemon's gate counts as a reject.
- **Exposure.** `/webhook` is only reachable with the bearer token when `APPROVER_TOKEN` is set. `GET /pending` shows the specs (addresses, amounts, labels) to anyone who can reach the listener, and a signature is all `/decide` needs. Two checks keep a web page in the operator's browser away from a loopback listener:
  - **`Host` check (loopback binds only).** Any spelling of a loopback address counts as a loopback bind (`127.0.0.0/8`, `localhost`, `::1` in long or bracketed form, IPv4-mapped forms), as does an address the OS actually bound to loopback. A request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` with the listener's port is refused with `403`. Without it, a hostile site could point its own DNS name at `127.0.0.1` ("DNS rebinding") and read `GET /pending` as if it were the page.
  - **`Origin` check (every bind).** A request that carries an `Origin` header must carry the approver's own: the `Origin` host has to equal the `Host` header. The daemon sends no `Origin`; the operator page's same-origin requests send theirs. Without it, another site could make the operator's browser POST a `text/plain` body to `/webhook` or `/decide`.

  To expose the approver to a remote operator, bind the address a reverse proxy reaches (`APPROVER_LISTEN=10.0.0.5:8181`; the `Host` check is off on non-loopback binds), set `APPROVER_TOKEN` and `bearer_token_env` so only the daemon can file requests, and let the proxy terminate TLS with the access control your site uses. The proxy must pass the original `Host` header (nginx: `proxy_set_header Host $host;`), because the browser's `Origin` is compared with it. A loopback bind behind a proxy that rewrites `Host` is refused by design.
- **Page rendering.** `index.html` writes every spec-derived string (labels come from address books) as text, never as markup, and the page is served with a restrictive `Content-Security-Policy`.

## Customizing

- **Change the UI.** Edit `index.html`. It is a plain static page: no build step, no external scripts. The approver reads it at startup.
- **Change the message format.** Edit `decision.ts`. `decisionMessage` and `verifyDecision` are the only code that knows the format; `decision.test.ts` covers them (`npx vitest run examples`). `verifyDecision` returns false unless the decision is `approve` or `reject` and the nonce is 32 lowercase hex characters, which keeps the message unambiguous; keep that if you change the format.
- **Swap the auth scheme entirely.** Fork `approver.ts`, keep the webhook contract (accept the POST, hold the response, eventually answer `{ "decision": "approve" | "reject" }`), and implement whatever auth you want: SSO, a hardware token, a Slack bot, a manual CLI. The daemon does not care how you decide.

## Files

- `approver.ts` — Node.js service: the webhook endpoint, the pending list and `/decide`. It exports `createApprover(...)`, which builds the server without listening; running the file starts it from the environment.
- `approver.test.ts` — vitest tests for the approver: held requests, signatures, replay, the browser boundary. They drive it with the real webhook gate and real message signatures.
- `decision.ts` — `decisionMessage` and `verifyDecision`, the two pure functions around the signed message.
- `decision.test.ts` — vitest test for them.
- `index.html` — the operator page the approver serves at `GET /`.

`npm run typecheck` also typechecks this directory (`tsconfig.examples.json`).
