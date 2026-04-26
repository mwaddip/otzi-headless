# otzi-headless — Extraction & Daemon Plan

Status: extraction complete, design open. `tsc --noEmit` passes clean.

Goal: fit the spec in `CLAUDE.md` (pull-based threshold-signing daemon over OPNet) around the byte-compatible primitives lifted from `~/projects/otzi/`.

---

## 1. What was extracted (present in this repo)

All extracted files are **verbatim copies** from Ötzi. No edits. Byte-compat with Ötzi is the explicit contract for the wire layer (see CLAUDE.md § "What to Share With Ötzi").

### `src/wire/` — wire-format byte layer (from `~/projects/otzi/src/lib/`)

| File | Purpose |
|---|---|
| `dkg.ts` | DKG + FROST blob envelope encoding (v=2), Phase 1/2/3/4 ML-DSA DKG + FROST R1/R2 DKG + FROST-sign R1/R2 codecs. Integrity checksums on Phase 3+4. |
| `threshold.ts` | ML-DSA threshold signing protocol (round1→round2→round3→combine) with session state + blob add/decode. |
| `frost-sign.ts` | FROST signing blob codec (frost-sign-r1 commitments, frost-sign-r2 shares) for N sighashes. |
| `serialize.ts` | Binary (de)serialization of `ThresholdKeyShare`, `FrostKeyPackage`, V3 combined format. 23-bit polynomial packing. |
| `hex.ts` | `toHex` / `fromHex` / `uint8ToBase64`. |
| `crypto.ts` | Share-file AES-256-GCM + PBKDF2(600k) via Web Crypto. |
| `share-crypto.ts` | Share-file parse + decrypt + V2/V3 deserialization. |
| `relay-crypto.ts` | ECDH-P256 + HKDF + AES-256-GCM for relay E2E; session fingerprint. |
| `manifest.ts` | Project manifest validation, ABI shorthand resolution, condition evaluation, param resolution. |
| `manifest-types.ts` | Manifest TypeScript types. |
| `op20-methods.ts` | OP-20 method metadata tables (used by `manifest.ts`). |
| `vault-types.ts` | `VaultConfig` + `WalletPublic` + `PermafrostConfig` (frontend-shape; drops `mnemonic`). |

### `src/node/` — Node-side crypto & signer adapters (from `~/projects/otzi/backend/src/lib/`)

| File | Purpose |
|---|---|
| `frost-psbt-signer.ts` | PSBT signer using the SDK's wallet-path (`multiSignPsbt`). `createCapture` — extract sighashes with dummy sigs; `createReplay` — apply precomputed FROST sigs matched by sighash. |
| `threshold-signer.ts` | `QuantumBIP32Interface` adapter returning a precomputed ML-DSA threshold signature (for SDK integration). |
| `frost-link.ts` | Key-link hash (`node:crypto` + `BinaryWriter`) + `withFrostLegacySig` which monkey-patches the OPNet SDK's `signSchnorr` and `TweakedSigner.tweakSigner` during broadcast. |
| `encryption.ts` | Vault-config AES-256-GCM + PBKDF2(600k) via `node:crypto`. |
| `opnet-client.ts` | `getNetwork` / `getProvider` (JSONRpcProvider) / `generateWallet` / `generateMnemonic`. |
| `types.ts` | Backend-shape `VaultConfig` + `defaultConfig` + `sanitizeConfig`. Includes `mnemonic` field (unlike frontend `vault-types.ts`). |

### `vendor/post-quantum/`

Full vendored copy of `@btc-vision/post-quantum` (ML-DSA, Threshold ML-DSA, ML-KEM, SLH-DSA, hybrid). Matches Ötzi.

### `docs/`

- `signing-flows.md` — documented ceremony flows (reference).

### Scaffold

- `package.json` — deps match Ötzi's backend + `ws` + `@btc-vision/bip32` (direct dep, used by `threshold-signer.ts`).
- `tsconfig.json` — `Bundler` moduleResolution, `Preserve` module, `DOM` lib. See **§3 runtime** below.
- `.gitignore` — node_modules, dist, logs, env.

---

## 2. What was deliberately NOT extracted

| Source | Why not |
|---|---|
| `otzi/src/lib/relay.ts` | Uses browser `WebSocket` + `sessionStorage`. Needs a Node port (swap to `ws` package + in-memory token map). Protocol itself is fine — wrapper is browser-shaped. |
| `otzi/src/lib/keygen.ts` | Mixes pure `encryptShareV2`/`V3` with browser-only `downloadShareFile` (`document`, `Blob`, `URL`). Needs split before lift. |
| `otzi/src/lib/manifest-state.ts` | React hook (`useState`, `useEffect`). Rewrite as daemon watcher/poller. |
| `otzi/src/lib/api.ts`, `theme.ts` | UI HTTP client + theme. Irrelevant. |
| `otzi/backend/src/routes/btc.ts` | Express-wrapped. CLAUDE.md marks **adapt**: extract pure PSBT-build + broadcast pipeline, drop `req`/`res`. |
| `otzi/backend/src/routes/tx.ts` | Express-wrapped. CLAUDE.md marks **adapt**: extract OPNet contract sighash-capture + broadcast pipeline + ABI resolution. |
| `otzi/backend/src/routes/auth.ts`, `users.ts`, `config.ts`, `hosting.ts`, `balances.ts`, `wallet.ts` | UI-oriented HTTP routes. Irrelevant to a daemon with no interactive operator. |
| `otzi/backend/src/lib/auth.ts`, `users.ts`, `config-store.ts` | Password/user management for interactive operators. Daemon auth model is peer-allowlist + ML-DSA mutual auth (CLAUDE.md § "Ring of Trust"). Rewrite. |
| React components (`DKGWizard.tsx`, `ThresholdSign.tsx`, `FrostSign.tsx`, `SigningPage.tsx`) | Explicitly banned by CLAUDE.md. Read for protocol reference only. |

---

## 3. Build & runtime

The extracted `src/wire/` files use **extensionless relative imports** (`./hex`, `./dkg`, `./manifest-types`) — Ötzi's frontend Vite resolves these. Our tsconfig uses `moduleResolution: "Bundler"` + `module: "Preserve"`, so `tsc --noEmit` accepts them verbatim.

Runtime strategy:
- **Dev:** `tsx` (already in `devDependencies`) — handles extensionless resolution natively.
- **Prod:** `tsup` / `esbuild` bundle — single runnable artifact, extensions become irrelevant, fits Docker/systemd/.deb targets.

Source stays byte-identical to Ötzi. No rewrites, no runtime compromise.

---

## 4. Proposed daemon architecture

Implements CLAUDE.md § "Core Architecture: Pull-Based Blob Exchange" and § "Transport" on top of the extracted primitives.

```
┌─ triggers (new) ──────────────┐
│  HTTP/IPC API                 │
│  Cron                         │
└──────────────┬────────────────┘
               │ ceremony spec
               ▼
┌─ ceremony core (new) ─────────┐       ┌─ src/wire/ (as-is) ──────────┐
│  CeremonyRunner               │──────▶│ dkg.ts / threshold.ts /      │
│  BlobStore                    │       │ frost-sign.ts / serialize.ts │
│  BlobPuller (retry+deadline)  │       └──────────────────────────────┘
└──────────────┬────────────────┘
               │ encoded blobs
               ▼
┌─ transport (new, pluggable) ──┐       ┌─ src/wire/relay-crypto.ts ───┐
│  PeerMeshTransport (ws)       │──────▶│ (as-is, E2E encrypt)         │
│  RelayTransport               │       └──────────────────────────────┘
└───────────────────────────────┘

┌─ broadcast (adapt) ───────────┐       ┌─ src/node/ (as-is) ──────────┐
│  BTC prepare+broadcast        │──────▶│ frost-psbt-signer.ts         │
│  OPNet sighash+broadcast      │       │ threshold-signer.ts          │
│  (extracted from btc.ts/tx.ts)│       │ frost-link.ts (SDK patch)    │
└───────────────────────────────┘       │ opnet-client.ts              │
                                        └──────────────────────────────┘
```

### Layers

**Ceremony core (new, ~pull-based):**
- `BlobStore` — in-memory keyed by `(ceremonyId, round, from, to?)`.
- `BlobPuller` — for round N, asks producers for missing blobs; per-request retry count + ceremony-wide deadline.
- `CeremonyRunner` — drives DKG or FROST-sign ceremonies. Uses `src/wire/` codecs directly. No leader, no COMPLETE, no heartbeat.

**Transport (new, config-selectable):**
- `PeerMeshTransport` — direct `ws` WebSocket between daemons. IP-pinned, mutual ML-DSA auth at handshake.
- `RelayTransport` — wraps a Node port of `src/lib/relay.ts` using `ws`; reuses `src/wire/relay-crypto.ts` unchanged.

**Broadcast (adapt from `backend/src/routes/btc.ts` + `tx.ts`):**
- Reduce the two route files to pure pipeline functions: `buildBtcPsbt(...)`, `captureBtcSighashes(psbt) → sighash[]`, `broadcastBtcTx(signedPsbt)`, and the equivalents for OPNet contract calls (with ABI resolution from `src/wire/manifest.ts`).

**Triggers (new):**
- HTTP/IPC API — authorized POST endpoints that queue ceremonies.
- Cron scheduler — config-driven.

(Chain watching is intentionally NOT a daemon responsibility — the daemon is a signing backend; operator infrastructure that needs event-driven flows watches the chain itself and POSTs `/sign`.)

---

## 5. Resolved design decisions

All open questions from the bootstrap session are now decided. Protocol-level decisions are reflected in CLAUDE.md.

1. **Abort/timeout** — retries: exp. backoff 1s→30s, max 5. Deadline: `auto`/`policy` = 5 min signing / 15 min DKG; `webhook`/`cli`/`queue` = unbounded default, operator cap. See CLAUDE.md § Core Architecture.
2. **Config format** — TOML for `DaemonConfig`; JSON for Ötzi share files. See CLAUDE.md § Stack.
3. **`frost-link.ts` variants** — web-crypto variant deleted. Only `src/node/frost-link.ts` remains; exported `computeKeyLinkHash` serves DKG callers, `withFrostLegacySig` serves broadcast.
4. **`VaultConfig` pruning** — hybrid: share file stays Ötzi-compatible JSON; daemon-specific settings live in a new `DaemonConfig` type. Startup merges.
5. **Transport priority** — PeerMesh first (phase 3). Relay port is phase 3+ follow-up.
6. **Build & runtime** — `tsx` dev, bundle for prod. No source rewrites. See § 3.

Approval-gate design (added during bootstrap review) is specified in CLAUDE.md § Security Model.

---

## 6. Implementation phases (proposed)

| Phase | Scope | Primary files |
|---|---|---|
| 1 — done | Extraction + scaffold + plan | this commit |
| 2 | Ceremony core — `BlobStore`, `BlobPuller`, `CeremonyRunner` | `src/wire/dkg.ts`, `threshold.ts`, `frost-sign.ts`, `serialize.ts` |
| 3 | Transport — PeerMesh (primary); relay port as follow-up | `ws`, `src/wire/relay-crypto.ts` |
| 4 | Broadcast adapters — extract from `btc.ts`, `tx.ts` | `src/node/frost-psbt-signer.ts`, `threshold-signer.ts`, `frost-link.ts`, `opnet-client.ts` |
| 5 | Triggers + daemon entrypoint — HTTP/IPC API, cron | new |
| 6 | Packaging — Docker, systemd, .deb | new |

Each phase ends with `tsc --noEmit` green + any new unit tests green before the next begins (OVERRIDES.md Rule 4 & 6).
