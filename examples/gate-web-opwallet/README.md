# gate-web-opwallet — standalone OPWallet-signed gate approver

This example is a standalone service that sits between the `otzi-headless` daemon and a human operator. It speaks the daemon's `webhook` gate interface and enforces a specific operator-auth policy: **every approve/reject decision must carry a valid ML-DSA-44 signature from the operator's pinned wallet key**.

The daemon has no knowledge of ML-DSA verification or this specific auth scheme. That separation is deliberate: the daemon exposes a generic signaling surface (`ApprovalGate.approve(spec) → decision`); the decision logic lives here, outside the daemon, and can be swapped for any other auth mechanism without touching the daemon.

## Architecture

```
           ┌──────────┐                   ┌──────────────┐                  ┌─────────┐
           │          │  POST /webhook    │              │   GET  /        │         │
  daemon ──▶ webhook  │ ─────────────────▶│              │◀────────────────│         │
           │   gate   │                   │  approver    │   GET  /pending │ browser │
           │          │◀── { decision }───│              │◀────────────────│         │
           └──────────┘  (held until      │              │   POST /decide  │ + Wallet│
                         operator signs)  └──────────────┘◀────────────────│         │
                                                                           └─────────┘
```

1. Daemon receives a trigger, builds the `CeremonySpec`, calls the webhook gate.
2. Webhook gate POSTs the spec JSON to `approver.mjs`. Approver mints a 32-byte nonce and holds the request open.
3. Operator opens the browser UI, fetches `/pending`, picks a ceremony.
4. Browser asks OPWallet to sign `salt ‖ ceremonyId ‖ decision_byte ‖ nonce` with the operator's ML-DSA-44 key.
5. Browser POSTs `{ ceremonyId, decision, nonce, signatureHex }` to `/decide`.
6. Approver verifies the signature against the pubkey pinned in config, then resolves the held webhook response with `{ decision }`.
7. Daemon's webhook gate returns the decision. Signing proceeds or is silently dropped.

## Run the approver

```bash
# From the otzi-headless repo root (the script imports @btc-vision/post-quantum from node_modules)
export APPROVER_PUBKEY_HEX="…"                # 2624 hex chars (1312-byte ML-DSA-44 pubkey)
export APPROVER_LISTEN="0.0.0.0:8181"          # optional, default 0.0.0.0:8181
node examples/gate-web-opwallet/approver.mjs
```

## Configure the daemon

```toml
[gate]
strategy = "webhook"
[gate.params]
url = "http://approver:8181/webhook"
timeout_sec = 86400                            # 24h — plenty of time for human review
```

## Security properties

- **Publicly exposable approver listener.** The approver's listener is designed to sit behind a public ingress — signature verification replaces network-level auth.
- **Nonce per ceremony.** 32 random bytes per pending webhook, single-use. Prevents replay.
- **Domain-separator salt.** The signed payload includes a fixed UTF-8 domain separator `"otzi-headless:gate-decision:v1"` so approve-signatures can't be reused for any other ML-DSA context.
- **Decision byte in payload.** Approve (`0x01`) and reject (`0x00`) are distinct — an attacker can't flip an approve into a reject.
- **Pinned pubkey.** The approver trusts exactly one pubkey; wallet can't impersonate another operator.

## Customizing

- **Swap the wallet.** Replace `window.opnet.signMLDSA(hex)` in `index.html` with any JS ML-DSA-44 signer. The signed payload is the same bytes.
- **Change the UI.** Edit `index.html`. Approver reads it from disk at startup; override path with `APPROVER_HTML_FILE`.
- **Swap the auth scheme entirely.** Fork `approver.mjs`, keep the webhook contract (accept POST, hold response, eventually respond with `{ decision }`), implement whatever auth you want (SSO, hardware token, Slack bot, manual CLI). The daemon doesn't care how you decide.

## Files

- `approver.mjs` — Node.js service implementing the webhook endpoint and verifying signed decisions.
- `index.html` — browser UI the approver serves at `GET /`.
