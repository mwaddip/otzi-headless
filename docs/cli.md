# otzi CLI reference

Operator-facing reference for `otzi <verb>`. The CLI talks to the local daemon over a Unix domain socket (typically `/var/run/otzi/otzi.sock`); access is gated by membership in the `otzi` Unix group (set up by the .deb postinst).

The default config path is `/etc/otzi/daemon.toml` — operators can override per-invocation with `--config <path>`.

## Verbs

### Daemon lifecycle

- `otzi daemon <config.toml>` — run the daemon (long-lived; usually started by systemd, not by hand).
- `otzi setup <config.toml>` — bootstrap pubkey exchange. Reads `[bootstrap].role` from the config and runs leader or leaf flow accordingly.
- `otzi generate <config.toml> [--threshold N] [--level 44] [--ceremony-id <id>]` — trigger combined DKG against the local daemon. Banner prints the resulting BTC + OPNet vault addresses on success.

### Manifest

- `otzi install <path>` — install a `.otzi.json` manifest at `/etc/otzi/manifest.otzi.json`. Validates against `headless-manifest-v1` (see `docs/headless-manifest-schema.json`). Refuses if a manifest is already installed; run `otzi uninstall` first.
- `otzi list` — show the installed manifest as a numbered/lettered tree.
- `otzi uninstall` — remove the installed manifest (idempotent).

### Signing (manifest-driven)

- `otzi sign <contract> <method> <args...>` — encode the call, run threshold ML-DSA pre-sign + FROST broadcast through the daemon. Prints the resulting `transactionId`.
  - `<contract>`: 1-based index from `otzi list` (e.g. `1`) or contract name (e.g. `Shitcoin`).
  - `<method>`: letter (e.g. `a`) or method name (e.g. `transfer`).
  - `<args>`: positional, parsed per the resolved ABI types. Decimal for uints, `0x…` for addresses, `true`/`false` for bools, `0x…` for bytes.
  - `--fee-rate <sat/vB>` (optional): override the auto-fetched mempool fee rate.

Two ceremonies happen under the hood: ML-DSA pre-sign over `sha256(calldata)` (the OPNet construction-params API requires this) followed by FROST sign + broadcast via `protocol: 'opnet-params'`. Operators see one command.

### BTC vault

- `otzi btc send <address> <amount>[unit]` — send BTC from the vault to an external address. Units: `sats` (default), `btc`, `mbtc`, `ubtc`. Auto-fetches fee rate from mempool.space; override with `--fee-rate <sat/vB>`.
- `otzi btc balance [--unit <sats|btc|mbtc|ubtc>]` — read vault BTC balance. Read-only; no daemon round-trip.

### Reads

- `otzi vault [--json]` — print vault BTC + OPNet addresses (and the underlying pubkeys when `--json`).
- `otzi op20 balance <ticker|ID>` — read the vault's balance for an OP20/OP20S contract from the manifest. Output respects the manifest-stored `decimals`.

## Examples

```bash
# After `otzi generate` completes successfully and daemons restart…
otzi vault                                 # show the vault addresses

# Manifest-driven signing
otzi install ./shitcoin.otzi.json
otzi list
otzi sign 1 a 0x<recipient-64hex> 25000000   # transfer 25,000,000 atomic units

# Direct BTC vault transfer (no manifest needed)
otzi btc balance --unit btc
otzi btc send opt1p<destination> 0.001btc

# OP20 balance read
otzi op20 balance Shitcoin
```

## Configuration

The CLI reads:
- `/etc/otzi/daemon.toml` — daemon TOML (UDS path, network, peers, …). Override with `--config`.
- `/etc/otzi/manifest.otzi.json` — installed manifest. Override per-command path is not currently exposed; install/uninstall manage this file.
- `/var/lib/otzi/vault-pubkey.json` — vault metadata cache (read-only).

See `docs/headless-manifest-schema.json` for the manifest JSON Schema and `docs/api.md` for the daemon HTTP/UDS API.
