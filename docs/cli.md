# otzi CLI reference

Operator-facing reference for `otzi <verb>`. The CLI is the operator surface: it
talks to the local daemon over a Unix domain socket (typically
`/var/run/otzi/otzi.sock`), reads the chain through Esplora, and works on local
files. Access to the socket is gated by membership in the `otzi` Unix group (set
up by the .deb postinst).

The daemon never touches the chain. The CLI builds the transaction proposal from
Esplora data, asks the daemon to sign it, and broadcasts the signed transaction
through Esplora.

## Conventions

- Verbs that read the daemon configuration accept `--config <path>` (default
  `/etc/otzi/daemon.toml`). The CLI takes the UDS path, the network and the
  Esplora URL from it. `otzi daemon` and `otzi setup` take the config path as
  their positional argument instead. `otzi vault` reads only
  `/var/lib/otzi/vault-pubkey.json`.
- Machine output (addresses, txids, signed hex, JSON) goes to stdout. Banners and
  errors go to stderr. Errors exit with status 1.
- If a broadcast fails after signing, the CLI prints the signed transaction hex
  to stderr and exits 1, so the operator can broadcast it by other means.
- Esplora defaults to mempool.space for the configured network
  (`https://mempool.space/testnet4/api` on testnet4). `[network].esplora_url`
  overrides it. Only `otzi btc *` verbs call Esplora; run them on a host that can
  reach it.

## Verbs

### Daemon lifecycle

- `otzi daemon <config.toml>` — run the daemon (long-lived; usually started by systemd, not by hand). A node with a share loaded starts in signing mode; a node without one starts in setup mode, where `sign` returns `409` until a DKG completes and the daemon restarts.
- `otzi setup <config.toml>` — bootstrap pubkey exchange. Reads `[bootstrap].role` from the config and runs the leader or leaf flow. Prints the 96-bit fingerprint of the resulting pubkey book as `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`. **Compare it out of band with every other operator before any DKG.** Re-running on a node that already has a pubkey book re-prints the fingerprint.
- `otzi generate [--config <path>] [--ceremony-id <id>]` — run the run-once DKG through the local daemon (the `dkg` op). Run it on exactly one node; every other daemon in the ring must be running. The vault is n-of-n: `parties` is the ring size and `threshold = parties`. The banner prints the vault address, the network, the share path, and the instruction to **restart every daemon** so each loads its new share.

  Fails with `409` when this node already holds a vault, `403` when this node's gate rejects, `500` when the ceremony fails or times out. A DKG that fails before every node has confirmed leaves no share at the share path on any node and can be re-run.

### Vault

- `otzi vault [--json]` — print the vault address, the network and `<threshold>-of-<parties>`, read from `/var/lib/otzi/vault-pubkey.json`. `--json` prints the whole file: `network`, `address`, `internalKey`, `outputKey`, `threshold`, `parties` and the public `vaultKey`. Works without the daemon. Fails with a pointer to `otzi generate` when the file does not exist.
- `otzi btc balance [--unit sats|btc|mbtc|ubtc] [--config <path>]` — confirmed and unconfirmed vault balance from Esplora, in the chosen unit (default `sats`):

  ```
  confirmed: 150000
  unconfirmed: 0
  ```

- `otzi btc send <label|address> <amount[unit]|max> [--fee-rate N] [--config <path>]` — send from the vault. Prints the txid and the explorer URL.
  - `<label|address>`: a label from this node's address book (exact match) or a valid address for the configured network.
  - `<amount[unit]>`: a number with an optional unit, `sats` (default), `btc`, `mbtc` or `ubtc` (`50000`, `0.001btc`). Fractional sats are rejected. `max` spends every confirmed UTXO with no change.
  - `--fee-rate N`: sat/vB. Default: Esplora's `normal` estimate.

  The steps: resolve the recipient, fetch **confirmed** UTXOs, build the proposal (largest UTXOs first; change under 330 sats goes to the fee; a send below 546 sats is refused), refuse a send that needs more than 255 inputs (consolidate UTXOs first), call the daemon's `sign` op, broadcast the signed transaction. The node you run it on is the ceremony leader.

- `otzi btc sign <proposal.json> [--broadcast] [--config <path>]` — sign a proposal someone else built. `proposal.json` holds `{ "network", "tx", "prevouts" }` (see [`api.md`](./api.md) § `op: "sign"`). Analysis runs locally first, so a proposal this vault would not sign fails before any daemon call. The analysis summary (outputs with their address-book labels, change, fee, fee rate) goes to stderr; stdout gets the txid and the signed hex. Without `--broadcast` nothing is posted; with it, the CLI posts the transaction and prints the explorer URL as a third stdout line.

Every node in the signer set analyses the proposal against its own key and runs its own gate. If a node declines, the leader's ceremony fails and the command exits with the daemon's `500` error.

### Address book

Each node has its own address book at `/etc/otzi/address-book.otzi.json` (Ötzi's address-book file format, owner `root:otzi`, mode `0640`). It labels recipients in gate specs and CLI output, resolves `otzi btc send <label>`, and can serve as the policy recipient allowlist (`allowed_recipients = "address-book"`). Nodes do not share or sync books.

**Reading needs `otzi` group membership; writing needs root** (`sudo otzi book add …`), because the book can widen a policy allowlist and so carries the same privilege as editing `daemon.toml`. Every write validates the whole book and replaces the file atomically.

- `otzi book list` — one line per entry: label, address, note.
- `otzi book add <label> <address> [--note <text>]` — add an entry, or update the label and note of the entry with the same address.
- `otzi book remove <label|address>` — remove the entry whose label or address matches. Fails when nothing matches.
- `otzi book import <file> [--replace]` — merge an Ötzi address-book file (default) or replace the book with it. Prints how many entries were added, updated and unchanged.
- `otzi book export [path]` — write the book as an Ötzi address-book file (stdout without a path).

Entry rules: trimmed label of 1 to 64 characters, an address valid for the configured network, unique addresses, a note of at most 256 characters, at most 1000 entries. The file's network must equal the configured network. Labels are not required to be unique, but `btc send` takes the first match, so keep them unique. Export and import files move between nodes and web Ötzi unchanged.

### Backup + restore

- `otzi backup` — produce a password-protected archive of the full node state at `~/otzi-backup-<ISO>.otzi-backup` (mode 0600). It holds `daemon.toml`, the share, the identity key, the pubkey book, `vault-pubkey.json` and the address book (when present), and a `meta.json`. AES-256-GCM with PBKDF2-SHA256 (600k iterations). The 32-character password is auto-generated (~190 bits of entropy) and printed once to stdout in a banner; write it down. Exit code 0 on success.

  ```bash
  otzi backup
  ```

  Output:
  ```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Backup written: /home/operator/otzi-backup-2026-10-10T12-34-56Z.otzi-backup
    Password:       a8K2zP4mQ9xR7sN3vL5jB6tH1wF0gY9c

    WRITE THIS DOWN. There is no recovery path if you lose this password.
    Store the backup file and password in physically separate locations.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ```

- `otzi restore <archive-path> [--password-stdin]` — decrypt an `otzi-backup` archive and restore files to their canonical paths with canonical modes. Without `--password-stdin`, the CLI prompts for the password interactively (TTY-masked). With `--password-stdin`, it reads the password from stdin until newline — used by debconf during fresh installs and by scripted runs.

  Refuses (exit 1) if:
  - `/etc/otzi/daemon.toml` already exists. Run `sudo rm /etc/otzi/daemon.toml` first.
  - `systemctl is-active otzi` returns 0. Run `sudo systemctl stop otzi` first.
  - The archive magic isn't `OTZI-BACKUP-V1`.
  - Decryption fails — wrong password or tampered archive (same error; it doesn't say which).

  ```bash
  sudo systemctl stop otzi
  sudo rm /etc/otzi/daemon.toml
  sudo otzi restore ~/otzi-backup-2026-10-10T12-34-56Z.otzi-backup

  # Or scripted:
  echo "$BACKUP_PWD" | sudo otzi restore --password-stdin ~/otzi-backup-...otzi-backup
  ```

  On success, prints a per-file summary and a `Run systemctl start otzi` next step.

  **Why stdin and not a `--password=<pwd>` flag?** A CLI flag would leak the password via `/proc/<pid>/cmdline` and `ps`. Stdin is the only safe non-interactive channel.

## Examples

All addresses below are testnet4.

```bash
# One-time setup, after `otzi setup` fingerprints match on every node
otzi generate                              # on one node; then restart every daemon
sudo systemctl restart otzi                # on every node

otzi vault                                 # same address on every node
otzi btc balance --unit btc

# Send to an address, or to a label from the address book
otzi btc send tb1p…recipient 50000 --fee-rate 5
sudo otzi book add treasury tb1p…recipient --note "cold storage"
otzi btc send treasury 0.001btc
otzi btc send treasury max

# Sign a proposal built elsewhere, then broadcast it
otzi btc sign ./proposal.json
otzi btc sign ./proposal.json --broadcast

# Address-book files move between nodes and web Ötzi
otzi book export ./book.otzi.json
sudo otzi book import ./book.otzi.json
sudo otzi book import ./book.otzi.json --replace
```

## Configuration

The CLI reads:
- `/etc/otzi/daemon.toml` — daemon TOML (UDS path, network, Esplora URL, …). Override with `--config`.
- `/var/lib/otzi/vault-pubkey.json` — public vault metadata, written by the daemon (read-only for the CLI).
- `/etc/otzi/address-book.otzi.json` — this node's address book.

See [`api.md`](./api.md) for the daemon UDS API and [`config.md`](./config.md) for `daemon.toml`.
