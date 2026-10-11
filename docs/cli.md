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
  their positional argument instead. `otzi vault` and `otzi btc balance|send|sign`
  also use it to find the daemon they check `/var/lib/otzi/vault-pubkey.json`
  against.
- Machine output (addresses, txids, signed hex, JSON) goes to stdout. Banners and
  errors go to stderr. Errors exit with status 1.
- The CLI broadcasts only the daemon's own signed version of the transaction it asked about; a reply for a different transaction, or one missing a signature, is refused and nothing is posted.
- If a broadcast fails after signing, the CLI prints the signed transaction hex
  to stderr and exits 1, so the operator can broadcast it by other means.
- Esplora defaults to mempool.space for the configured network
  (`https://mempool.space/testnet4/api` on testnet4). `[network].esplora_url`
  overrides it. Only `otzi btc *` verbs call Esplora; run them on a host that can
  reach it.

## Verbs

### Daemon lifecycle

- `otzi daemon <config.toml>` — run the daemon (long-lived; usually started by systemd, not by hand). A node with a share loaded starts in signing mode; a node without one starts in setup mode, where `sign` returns `409` until a DKG completes and the daemon restarts.
- `otzi setup <config.toml>` — bootstrap pubkey exchange. Reads `[bootstrap].role` from the config and runs the leader or leaf flow. Prints a banner with the 96-bit fingerprint of the resulting pubkey book as `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`, this node's key id (`this node: <id>`), and one `party <partyId>: <id>` line per ring entry, with the entry's endpoint under peer-mesh. A key id is the first 8 hex characters of SHA-256 over the node's raw identity pubkey. **Before any DKG, compare the fingerprint out of band with every other operator, and confirm every key id belongs to one of your nodes.** An unknown key id means someone else registered: delete `pubkeys.json` on every node and redo setup. Re-running on a node that already has a pubkey book re-prints the banner.

  Admission depends on `[transport] kind`. Under peer-mesh the leader admits only the endpoints in its `[[peers]]`. Under relay, nodes have no endpoints, so the leader admits the first `[bootstrap] parties − 1` registrations; anyone who reaches the bootstrap port could take a slot, so keep that port reachable only by the members during setup (VPN, firewall, or a loopback bind reached through an SSH tunnel). Errors a member can see:
  - `setup: bootstrap is full — …` — someone else registered in this node's place. Abort, delete `pubkeys.json` on every node and redo setup.
  - `setup: the leader expects peer-mesh registrations … / relay registrations … — use the same transport on every node` — this node's transport differs from the leader's.
  - `register: master responded 408: master bootstrap timed out after <ms>ms: received <r> of <e> registrations` — the leader gave up waiting; it prints the same message. Under relay, check the leader's `[bootstrap] parties`.
- `otzi generate [--config <path>] [--ceremony-id <id>]` — run the run-once DKG through the local daemon (the `dkg` op). Run it on exactly one node; every other daemon in the ring must be running. The vault is n-of-n: `parties` is the ring size and `threshold = parties`. The banner prints the vault address, the network, the share path, and the instruction to **restart every daemon** so each loads its new share.

  Fails with `409` when this node already holds a vault, `403` when this node's gate rejects, `500` when the ceremony fails or times out. A DKG that fails before any node commits leaves no share at the share path on any node and can be re-run; a staged `<share path>.pending` left behind is overwritten by the next DKG.

  A DKG can also fail on one node after another node has committed the vault (for example when a node loses its connection during the last exchange). A node that had already published its confirmation therefore never deletes its staged share: it keeps `<share path>.pending`, and the error (in the `500` reply when it is this node, in the daemon log otherwise) names the file and the vault address. Run `otzi vault` on the other nodes (it shows a committed vault even before that node's daemon has been restarted, with a warning that the values are not verified). If any of them shows that address, rename the `.pending` file to the share path on this node (`sudo mv <share path>.pending <share path>`) and restart its daemon. If none does, the vault was never created: remove the `.pending` files and run `otzi generate` again.

### Vault

- `otzi vault [--json] [--config <path>]` — print the vault address, the network and `<threshold>-of-<parties>`. `--json` prints `network`, `address`, `internalKey`, `outputKey`, `threshold`, `parties` and the public `vaultKey`. Any member of the `otzi` group can rewrite `/var/lib/otzi/vault-pubkey.json`, so `otzi vault` asks the daemon (the `vault-info` op, which must answer within 10 s) for the vault it has loaded and compares the file with the answer:
  - **File and daemon agree** (or there is no file): the daemon's values are printed. With `--json`, stderr says that the per-party values of `vaultKey.verifyingShares` come from the file and are not checked against the daemon (the daemon does not send them); without a file, `--json` has no `vaultKey` and says so on stderr.
  - **They differ** (`address`, `internalKey`, `outputKey`, `threshold`, `parties`, `network`, or the file's `vaultKey` does not fit them): exit 1, nothing on stdout. The error on stderr lists each differing field as `<field>: file <x>, daemon <y>` and says the file does not match the daemon's loaded share. Do not use its address; restarting the daemon rewrites the file from its share. Find out who changed it before you do.
  - **The daemon holds no vault** (`409`) **and there is a file** (a DKG committed this node's share and the daemon has not restarted since to load it): the file's values are printed, exit 0, and stderr says `the daemon has not loaded a vault — restart it to load the share; values not verified`. This is how you read the vault of a node that committed it before you rename a `.pending` file on another node (see above). With no file, exit 1 and the error points at `otzi generate`.
  - **The daemon cannot be reached** (no socket, connection refused, socket not readable, no answer within 10 s, or `--config` cannot be read): the file's values are printed as before, and stderr gets `not verified against the daemon (<reason>)`. Fails with a pointer to `otzi generate` when the file does not exist either.
  - A file that cannot be read or validated is an error in every case.
- `otzi btc balance [--unit sats|btc|mbtc|ubtc] [--config <path>]` — confirmed and unconfirmed vault balance from Esplora, in the chosen unit (default `sats`):

  ```
  confirmed: 150000
  unconfirmed: 0
  ```

  The address it queries comes from `vault-pubkey.json`, which any member of the `otzi` group can rewrite, so it first checks the file against the daemon like `otzi vault` does. A file that differs from the daemon's loaded vault is an error (exit 1, nothing on stdout: it would show the balance of the wrong address). With no daemon to ask, or a daemon that has not loaded a vault, the balance is printed with a note on stderr (`not verified against the daemon (<reason>)`, or `the daemon has not loaded a vault — restart it to load the share; values not verified`).

- `otzi btc send <label|address> <amount[unit]|max> [--fee-rate N] [--config <path>]` — send from the vault. Prints the txid and the explorer URL.
  - `<label|address>`: a label from this node's address book (exact match) or a valid address for the configured network. A label that is itself an address but names a different address is refused, so a send to an address never pays another one; rename or remove that label.
  - `<amount[unit]>`: a number with an optional unit, `sats` (default), `btc`, `mbtc` or `ubtc` (`50000`, `0.001btc`). Fractional sats are rejected. `max` spends every confirmed UTXO with no change.
  - `--fee-rate N`: sat/vB, more than 0 and at most 10000. Default: Esplora's `normal` estimate; an Esplora estimate outside that range is refused (naming the Esplora URL) and you pass `--fee-rate` instead.

  The steps: resolve the recipient and check the amount and fee rate, check `vault-pubkey.json` against the daemon, fetch **confirmed** UTXOs, build the proposal (largest UTXOs first; change under 330 sats goes to the fee; a send below 546 sats is refused), refuse a send that needs more than 255 inputs (consolidate UTXOs first), print the summary (outputs with their address-book labels, change, fee, fee rate) to stderr, call the daemon's `sign` op, check that the reply is the transaction that was built and is signed on every input, broadcast it. The node you run it on is the ceremony leader.

  The change address and the keys come from `vault-pubkey.json`, so `send` (and `sign`) require the daemon to vouch for the file: the daemon's loaded vault must match it. If it differs, if the daemon has not loaded a vault (restart it), or if the daemon cannot be reached, the command stops with an error before Esplora is asked and before anything is built, summarised or signed; stdout stays empty.

- `otzi btc sign <proposal.json> [--broadcast] [--config <path>]` — sign a proposal someone else built. `proposal.json` holds `{ "network", "tx", "prevouts" }` (see [`api.md`](./api.md) § `op: "sign"`). The file is checked against the daemon first, as for `send`; then analysis runs locally, so a proposal this vault would not sign fails before the daemon is asked to sign. The analysis summary (outputs with their address-book labels, change, fee, fee rate) goes to stderr before the daemon is asked to sign; stdout gets the txid and the signed hex. Without `--broadcast` nothing is posted; with it, the CLI posts the transaction and prints the explorer URL as a third stdout line.

Every node in the signer set analyses the proposal against its own key and runs its own gate. If a node declines, the leader's ceremony fails and the command exits with the daemon's `500` error.

### Address book

Each node has its own address book at `/etc/otzi/address-book.otzi.json` (Ötzi's address-book file format, owner `root:otzi`, mode `0640`). It labels recipients in gate specs and CLI output, resolves `otzi btc send <label>`, and can serve as the policy recipient allowlist (`allowed_recipients = "address-book"`). Nodes do not share or sync books.

**Reading needs `otzi` group membership; writing needs root** (`sudo otzi book add …`), because the book can widen a policy allowlist and so carries the same privilege as editing `daemon.toml`. Every write validates the whole book and replaces the file atomically.

- `otzi book list` — one line per entry on stdout: label, address, note, separated by tabs. Control characters in a label or note are not shown; the stored book is not changed.
- `otzi book add <label> <address> [--note <text>]` — add an entry, or update the label and note of the entry with the same address (an update without `--note` clears the note).
- `otzi book remove <label|address>` — remove the entry whose address matches, or else the one whose label matches. Fails when nothing matches, or when a label matches more than one entry (remove it by address).
- `otzi book import <file> [--replace]` — merge an Ötzi address-book file (default) or replace the book with it. Prints `added <a>, updated <u>, unchanged <n>, removed <r>` on stdout; `removed` counts the entries `--replace` dropped (always 0 for a merge). A file for another network is refused and nothing is written.
- `otzi book export [path]` — write the book as an Ötzi address-book file (stdout without a path). A file written to `path` gets mode `0640`, like the book.

Every `book` verb takes `--config <path>` (default `/etc/otzi/daemon.toml`) and reads the network from it. Confirmations go to stderr; errors exit 1.

Entry rules: trimmed label of 1 to 64 characters, an address valid for the configured network, unique addresses, a note of at most 256 characters, at most 1000 entries. The file's network must equal the configured network. Labels are not required to be unique, but `btc send` takes the first match, so keep them unique. Export and import files move between nodes and web Ötzi unchanged.

### Backup + restore

- `sudo otzi backup` — produce a password-protected archive of the full node state at `~/otzi-backup-<ISO>.otzi-backup` (mode 0600). It holds `daemon.toml`, the share, the identity key, the pubkey book, `vault-pubkey.json` and the address book (when present), and a `meta.json`. AES-256-GCM with PBKDF2-SHA256 (600k iterations). The 32-character password is auto-generated (~190 bits of entropy) and printed once to stdout in a banner; write it down. Exit code 0 on success.

  ```bash
  sudo otzi backup
  ```

  It needs root: the share file is readable only by its owner. Under plain `sudo` the archive lands in root's home directory (`/root`, as in the banner below); copy it off the host.

  Backup refuses (exit 1, nothing written) a `daemon.toml` that `otzi restore` could not restore: the share (`[share].path`), identity (`[node].identity_key_file`) and pubkey book (`[node].pubkey_book_file`) must each be an absolute path directly inside `/etc/otzi` or `/var/lib/otzi` (not in a subdirectory such as `/var/lib/otzi/keys/`), no two of them may name the same file, and none may name `daemon.toml`, `vault-pubkey.json` or the address book. The error names the key and the path, e.g. `cannot back up: [share].path = /var/lib/otzi/keys/share.json is not a direct child of /etc/otzi or /var/lib/otzi; otzi restore would refuse the archive`. Move the file, fix the path in `daemon.toml`, restart the daemon, and back up again.

  Output:
  ```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Backup written: /root/otzi-backup-2026-10-10T12-34-56Z.otzi-backup
    Password:       a8K2zP4mQ9xR7sN3vL5jB6tH1wF0gY9c

    WRITE THIS DOWN. There is no recovery path if you lose this password.
    Store the backup file and password in physically separate locations.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ```

- `otzi restore <archive-path> [--password-stdin]` — decrypt an `otzi-backup` archive and restore files to their canonical paths with canonical modes. Without `--password-stdin`, the CLI prompts for the password on the terminal; what you type is shown (the prompt does not mask it), so prefer `--password-stdin` where others can see the screen. With `--password-stdin`, it reads the password from stdin until newline — used by debconf during fresh installs and by scripted runs.

  Restore only creates files, and when run as root (`sudo otzi restore`, or the postinst) on a host with the `otzi` system user it gives every file it places in `/var/lib/otzi` to `otzi:otzi`, so the daemon can read the share; files in `/etc/otzi` stay `root:otzi`. It looks the user up in `/etc/passwd` and `/etc/group` and, when they have no `otzi`, with `getent passwd otzi` and `getent group otzi` (a user that only LDAP or sssd knows). Without root it changes no owner. As root with no `otzi` user at all, it still restores, but prints a `WARNING` on stderr: the files in `/var/lib/otzi` stay root-owned, so the daemon (`User=otzi`) cannot read its share until you run the `chown otzi:otzi …` command the warning lists. If giving a file to `otzi` fails, restore stops with `could not give <path> to otzi (<uid>:<gid>): <reason>` and removes the files it created. It writes the vault's own files — `daemon.toml`, the address book, `vault-pubkey.json`, and the share, identity and pubkey book at the paths the archived `daemon.toml` names — and only directly inside `/etc/otzi` and `/var/lib/otzi` (not in a subdirectory of them). Any other entry in the archive is skipped with a warning. If it fails part-way, it removes the files it created; nothing that existed before is touched.

  Refuses (exit 1) if:
  - `/etc/otzi/daemon.toml` already exists. Move it aside first (`sudo mv /etc/otzi/daemon.toml /root/`).
  - `systemctl is-active otzi` returns 0. Run `sudo systemctl stop otzi` first.
  - The archive magic isn't `OTZI-BACKUP-V1`.
  - Decryption fails — wrong password or tampered archive (same error; it doesn't say which).
  - Any file it would write already exists. The error lists them; move them aside (don't delete a share — it is key material) and run restore again.
  - The archive's `daemon.toml` puts the share, identity or pubkey book anywhere but directly inside `/etc/otzi` or `/var/lib/otzi` (a subdirectory such as `/var/lib/otzi/keys/` is refused too), or the archive holds a symlink, hardlink, device, FIFO, `..` or absolute entry, a directory where a file belongs, or a file twice.

  ```bash
  sudo systemctl stop otzi
  sudo mv /etc/otzi/daemon.toml /root/
  sudo otzi restore ~/otzi-backup-2026-10-10T12-34-56Z.otzi-backup

  # Or scripted:
  echo "$BACKUP_PWD" | sudo otzi restore --password-stdin ~/otzi-backup-...otzi-backup
  ```

  On success, prints a per-file summary (mode, and `owner otzi:otzi` for the files it gave to the `otzi` user), a warning line for each skipped entry, and the next steps: create `/etc/otzi/otzi.env` with the share password (the archive does not contain it; `sudo install -m 600 -o root -g root /dev/null /etc/otzi/otzi.env`, then edit it), then `sudo systemctl start otzi`.

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
