# Installing otzi-headless

## System requirements

- Linux (tested: Debian 12+, Ubuntu 24.04+).
- `nodejs` ≥ 22. On Ubuntu 24.04, the default `nodejs` package is too old —
  install [nodesource's 22.x](https://github.com/nodesource/distributions) first.
- systemd (the .deb installs a unit file at `/lib/systemd/system/otzi.service`).
- One open port per node for peer-mesh (default `8800`); leader nodes also
  open the bootstrap-server port temporarily (default `7090`) during initial
  pubkey exchange. The operator API is local-only over a UDS at
  `/var/run/otzi/otzi.sock` — no operator-facing port is exposed.
- Outbound HTTPS from the host where you run `otzi btc *` to the Esplora API
  (mempool.space for the configured network, or your `esplora_url`). The daemon
  itself makes no chain requests.

## Install

```bash
sudo apt install ./otzi-headless_<version>_amd64.deb
```

`apt` resolves the `nodejs` dependency; if it's missing, `apt` will refuse
the install and tell you why. (Plain `dpkg -i` will fail on unmet deps —
follow up with `sudo apt -f install` to resolve.)

## Install walkthrough

1. **Install the .deb.**
   ```
   sudo apt install ./otzi-headless_<version>_<arch>.deb
   ```
   debconf will prompt for:
   - **Restore from a backup?** — `Yes` skips every other prompt and restores the
     node from an archive (see § Backup + recovery). Asked only while
     `/etc/otzi/daemon.toml` does not exist, so not on an upgrade.
   - **Node role** (`leader` / `leaf`) — leader hosts bootstrap, leaves connect to it.
   - **Operator usernames** (space-separated) — each gets `usermod -aG otzi`.
   - **Bitcoin network** — `mainnet`, `testnet4` or `signet`. Every node in the
     ring must use the same network.
   - **Esplora URL** (optional) — the chain API the `otzi btc *` verbs use. It must
     start with `http://` or `https://`; a value without the scheme is ignored with a
     warning. Leave it blank for the mempool.space default of the network.
   - **Transport kind**:
     - For `peer-mesh`: **This node's reachable address** (canonical
       `host[:port]`, wildcards rejected) and **Other peers** (comma-
       separated `host[:port]` list of every other node — on a leaf,
       the leader is auto-derived from the bootstrap leader URL, so
       you only list peers *other than* the leader).
     - For `relay`: **Relay URL**.
   - **Bootstrap bind** (leader) or **leader URL** (leaf).
   - **Node identifier** (defaults to `hostname -s`; local logging label only).

2. **Log out / log back in** (or `newgrp otzi`) so your shell picks up
   the new group membership.

3. **Run `otzi setup`** on every node, leader first:
   ```
   sudo -u otzi otzi setup /etc/otzi/daemon.toml
   ```
   (Or, as a member of the `otzi` group, just `otzi setup
   /etc/otzi/daemon.toml`.) Records identity pubkeys + each peer's
   reachable address in `/var/lib/otzi/pubkeys.json` and prints the
   96-bit SHA-256 fingerprint of the pubkey book, formatted
   `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`. **Compare the fingerprint on every node
   out of band before going further.** A mismatch means someone tampered with the
   exchange: delete `/var/lib/otzi/pubkeys.json` on every node and redo setup.
   partyIds are assigned deterministically by sorted-pubkey-bytes order — every
   node observes the same mapping.

4. **Enable + start the daemon** on every node:
   ```
   sudo systemctl enable --now otzi
   ```
   The daemon reads the share password from the environment variable named by
   `[share].password_env` (default `OTZI_SHARE_PASSWORD`) and refuses to start
   without it, even before a vault exists. The unit loads it from
   `/etc/otzi/otzi.env`, so create that file **before the first start**: owner
   `root:root`, mode `0600`, one line:
   ```
   sudo install -m 600 -o root -g root /dev/null /etc/otzi/otzi.env
   sudoedit /etc/otzi/otzi.env      # one line: OTZI_SHARE_PASSWORD=<a strong password>
   ```
   (systemd reads the file as root, before it drops to the `otzi` user.)
   systemd interprets quotes and backslashes in this file and strips spaces
   around the value, so pick a password without `"`, `'`, `\` or
   leading/trailing spaces — `openssl rand -base64 32` gives one — or write it
   in double quotes with `\"` and `\\` escaped. The
   password encrypts this node's share file; each node picks its own, and web Ötzi
   asks for it when it opens the share.

   A node with no share starts in **setup mode**: it joins ceremonies and runs the
   DKG, but `sign` returns `409`.

5. **Run `otzi generate`** on one node to run the DKG. Every other daemon must be
   running and hold no vault. Each node writes its share (mode 0600) to
   `/var/lib/otzi/share.json` and the public vault metadata to
   `/var/lib/otzi/vault-pubkey.json`:
   ```
   otzi generate
   ```
   The banner prints the vault address, the network, the share path, and the
   reminder to restart every daemon. The vault is n-of-n: `threshold` equals the
   number of nodes.

6. **Restart every daemon** so each loads its new share:
   ```
   sudo systemctl restart otzi
   ```
   Until then `sign` returns `409` with a restart hint.

7. **Check the vault** on every node:
   ```
   otzi vault
   ```
   The address and `<threshold>-of-<parties>` must be identical on all nodes.
   `otzi vault` asks the running daemon for the vault it loaded and compares
   `vault-pubkey.json` with the answer; a file that differs is refused (see
   [`cli.md`](./cli.md)).
   Fund the address, then `otzi btc balance` and `otzi btc send` (see
   [`cli.md`](./cli.md)).

Logs: `journalctl -u otzi -f`.

## Operator API

Default: UDS at `/var/run/otzi/otzi.sock` (mode 660, owned otzi:otzi).
Anyone in the `otzi` group can connect via the CLI.
The directory is sticky, so a group member cannot remove the daemon's socket. `otzi vault`
and `otzi btc` trust what the daemon behind that socket says about the vault.

To add a new operator after install:
```
sudo usermod -aG otzi <user>
```
(They'll need to log out / back in to pick up the group.)

To re-run the install prompts:
```
sudo rm /etc/otzi/daemon.toml      # postinst won't clobber an existing file
sudo dpkg-reconfigure otzi-headless
```

## File layout

| Path | Purpose | Owner / mode |
|---|---|---|
| `/usr/bin/otzi` | CLI wrapper | root:root 755 |
| `/usr/lib/otzi/entrypoint.mjs` | esbuild bundle | root:root 644 |
| `/lib/systemd/system/otzi.service` | systemd unit | root:root 644 |
| `/etc/otzi/` | config dir (setgid; only root writes, group otzi reads) | root:otzi 2750 |
| `/etc/otzi/daemon.toml` | rendered config (preserved across upgrades; owner and mode re-applied on every configure) | root:otzi 640 |
| `/etc/otzi/otzi.env` | share password for the unit (`OTZI_SHARE_PASSWORD=…`) | root:root 600 |
| `/etc/otzi/address-book.otzi.json` | this node's address book (optional; owner and mode re-applied on every configure) | root:otzi 640 |
| `/var/lib/otzi/` | data dir (setgid; group otzi can write) | root:otzi 2770 |
| `/var/lib/otzi/identity.json` | ECDH identity | otzi:otzi 660 |
| `/var/lib/otzi/pubkeys.json` | pubkey book from bootstrap | otzi:otzi 644 |
| `/var/lib/otzi/share.json` | encrypted Ötzi v4 share | otzi:otzi 600 |
| `/var/lib/otzi/share.json.pending` | DKG staging file; exists while a DKG runs, or after a DKG that failed once this node had confirmed | otzi:otzi 600 |
| `/var/lib/otzi/vault-pubkey.json` | public vault metadata | otzi:otzi 644 |
| `/var/run/otzi/` | runtime dir for the socket (setgid and sticky: a group member cannot unlink or rename the daemon's socket and bind a look-alike; the unit's `RuntimeDirectory=` creates it with the same mode) | root:otzi 3770 |
| `/var/run/otzi/otzi.sock` | UDS socket for operator CLI | otzi:otzi 660 |

## Operations

### Logs

The daemon writes structured info / warn / error lines to stderr; systemd
captures them in journald. There is no daemon-level log file to manage.

```
journalctl -u otzi -f             # live tail
journalctl -u otzi --since today  # windowed
journalctl -u otzi -p warning     # filter by priority
```

### Disk + retention

Logs are subject to journald's defaults (typically a 4 GB rolling cap;
persistence is configurable). For long-term retention, either raise the
cap in `/etc/systemd/journald.conf`:

```
SystemMaxUse=20G
```

or ship logs to an external collector (rsyslog, Loki, Vector, etc.).

### Restart

`systemctl restart otzi` is safe to run at any time:

- Orchestrator state is in-memory; restart drops it cleanly.
- In-flight ceremonies will NOT resume. The trigger source (operator API
  call, cron) re-fires them with a new `ceremonyId`.
- Persistent state (share, identity, pubkey book, address book) is reloaded from
  disk on startup. A restart is also how a daemon picks up a share created by
  `otzi generate`.
- Policy-gate rate windows (`max_sats_per_24h`, `max_ceremonies_per_hour`) are
  in memory and start empty.

A leftover `/var/lib/otzi/share.json.pending` from an interrupted DKG is logged
at warn level on startup and never loaded. It may be this node's share of a
vault the other nodes committed: if `otzi vault` on another node shows the
address the warning names, `sudo mv /var/lib/otzi/share.json.pending
/var/lib/otzi/share.json` and restart the daemon. Otherwise the next DKG
overwrites it. If the file is the loaded share itself (a second name left by a
failed removal after the commit), the daemon removes it at startup and logs at
info level.

### Service sandbox

The unit (`/lib/systemd/system/otzi.service`) runs the daemon as the `otzi` user
with these restrictions, which also bind everything the daemon starts, such as an
`exec` gate command:

| Setting | Effect |
|---|---|
| `ProtectSystem=strict`, `ReadWritePaths=/var/lib/otzi` | The file system is read-only except `/var/lib/otzi` (and the unit's `/run/otzi`). |
| `ProtectHome=true`, `PrivateTmp=true` | No `/home`, `/root` or `/run/user`; a private `/tmp`. |
| `PrivateDevices=true` | A private `/dev` with only `null`, `zero`, `full`, `random`, `urandom`, `tty` and the pty devices: no block devices, USB or serial ports. |
| `NoNewPrivileges=true`, `RestrictSUIDSGID=true` | No gaining privilege through setuid or setgid programs (`sudo`, `su`), and no creating setuid or setgid files. |
| `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectKernelLogs=true`, `ProtectControlGroups=true` | `/proc/sys`, `/sys` and the cgroup file system are read-only; no loading kernel modules; no kernel log. |
| `ProtectClock=true`, `ProtectHostname=true` | The system clock, the hardware clock and the hostname cannot be changed. |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK` | TCP/UDP, the operator socket and nothing else. Netlink is what glibc's name resolution (`getaddrinfo` with `AI_ADDRCONFIG`) uses to learn the host's address families. |
| `RestrictNamespaces=true`, `RestrictRealtime=true`, `LockPersonality=true`, `SystemCallArchitectures=native` | No new namespaces, no realtime scheduling, no personality change, no non-native system calls. |

Deliberately not set:

- `MemoryDenyWriteExecute`: Node's V8 JIT needs writable and executable memory.
- `SystemCallFilter`: an `exec` gate command runs inside this sandbox, and so does
  whatever it starts. Its system calls are the operator's to choose.
- An empty `CapabilityBoundingSet`: the daemon runs with no capabilities already;
  the setting would only stop a drop-in from granting one, such as
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` to listen on a port below 1024.

`exec` gate commands therefore see no `/dev` beyond the basics and have no setuid
helper to call; see [`gates.md`](./gates.md) § `exec`. To loosen any of this for
one host, add a drop-in with `sudo systemctl edit otzi` rather than editing the
packaged unit, which an upgrade replaces. `systemd-analyze security otzi.service`
shows the unit's exposure.

### Address book

Each node keeps its own address book at `/etc/otzi/address-book.otzi.json`. It
labels recipients and can serve as the policy recipient allowlist
(`allowed_recipients = "address-book"`). Reading needs `otzi` group membership;
writing needs root, because the book can widen a policy allowlist:

```
sudo otzi book add treasury tb1p… --note "cold storage"
otzi book list
otzi book export ./book.otzi.json     # copy to the other nodes
sudo otzi book import ./book.otzi.json
```

The daemon reads the book at each use, so edits take effect without a restart.
The book's network must equal `[network].name`. See [`cli.md`](./cli.md) § Address
book.

### Backup + recovery

#### Backup

Run `sudo otzi backup` after every config change, after `otzi generate` completes,
and after address-book changes. Beyond that, cadence is per-operator risk
tolerance. **Back up every node:** the vault is n-of-n, so every share is
required to sign, and losing one share without a backup makes the funds
unspendable.

```
sudo otzi backup
```

It runs as root because the share file is readable only by its owner. Output:
a single password-protected archive in your home directory (`/root` under
plain `sudo`):

```
~/otzi-backup-2026-10-10T12-34-56Z.otzi-backup    # mode 0600
```

The archive contains:

- `/etc/otzi/daemon.toml` — daemon config.
- The share file (`[share].path`) — encrypted Ötzi v4 share.
- The identity key file (`[node].identity_key_file`) — Noise-KK identity keypair.
- The pubkey book file (`[node].pubkey_book_file`) — peer pubkey book from bootstrap.
- `/var/lib/otzi/vault-pubkey.json` — public vault metadata (if present).
- `/etc/otzi/address-book.otzi.json` — the address book (if present).
- `meta.json` — `{ version, createdAt, hostname, partyId }`.

(Inside the archive, paths are stored without the leading slash.)

The share, identity and pubkey book must sit directly inside `/etc/otzi` or
`/var/lib/otzi`, as the `.deb` configures them: `otzi backup` refuses a
`daemon.toml` that puts one in a subdirectory or elsewhere, or names one file
twice, because `otzi restore` would refuse that archive (see
[`cli.md`](./cli.md) § Backup + restore).

The password is auto-generated (32 chars from `[A-Za-z0-9]`, ~190 bits
entropy) and printed once to stdout:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Backup written: /root/otzi-backup-2026-10-10T12-34-56Z.otzi-backup
  Password:       a8K2zP4mQ9xR7sN3vL5jB6tH1wF0gY9c

  WRITE THIS DOWN. There is no recovery path if you lose this password.
  Store the backup file and password in physically separate locations.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Write down the password.** Loss of the password is loss of the backup —
there is no recovery path. Store the archive and the password in physically
separate locations: e.g., archive in cloud storage, password in a password
manager OR a sealed envelope in a different room. An attacker who gets both
(and the share password) can sign as your slot in the federation.

#### Recovery

Two paths.

**1. Fresh-install via debconf (preferred).**

When installing the .deb on a new host, answer `Yes` to "Restore from a
backup?". debconf prompts for the archive path and password; postinst
pipes the password via stdin to `otzi restore --password-stdin`. If
restore succeeds, the rest of the install prompts (network, role,
peers, etc.) are skipped — config came from the backup — and postinst sets
the answer back to `No` and wipes the stored path and password, so later
upgrades of the package leave the restored node alone.

The question, and the restore, only happen while `/etc/otzi/daemon.toml` does
not exist (a fresh install, or one where you moved it aside). On an installed
node neither an upgrade nor `dpkg-reconfigure` asks it, and if the stored
answer is still `Yes` (an earlier release left it so), postinst prints a
warning on stderr, `skipping the restore from backup`, resets the answer and carries on with the
normal upgrade. To restore onto an installed node, move `daemon.toml` and the
other files restore lists aside first (see 2. below), then run
`dpkg-reconfigure otzi-headless` or `otzi restore`.

If restore fails (wrong password, corrupted archive, missing file),
dpkg flags the package as half-installed. Retry via:

```
sudo dpkg-reconfigure otzi-headless
```

Decline restore this time, OR provide a valid backup + password.

**2. Manual via `otzi restore`.**

If you've already done a fresh install (or the daemon is in a
half-state), stop the daemon, move the existing node files aside, then
run restore manually. Restore never overwrites anything: it refuses
while `/etc/otzi/daemon.toml` exists, and it refuses (listing them) if
any file it would write — the share, identity, pubkey book,
`vault-pubkey.json` or the address book — already exists. Move them,
don't delete them: a share file is key material.

```
sudo systemctl stop otzi
sudo mkdir -p /root/otzi-aside
sudo mv /etc/otzi/daemon.toml /root/otzi-aside/
# and every file `otzi restore` lists as existing, e.g.:
# sudo mv /var/lib/otzi/share.json /root/otzi-aside/
sudo otzi restore ~/otzi-backup-2026-10-10T12-34-56Z.otzi-backup
```

Restore writes only the vault's own files, directly inside `/etc/otzi` and
`/var/lib/otzi`. It refuses an archive whose daemon.toml points the
share, identity or pubkey book anywhere else (a subdirectory such as
`/var/lib/otzi/keys/` included, so keep those three files directly in
those two directories), and an archive with a
symlink, hardlink, device, `..` or absolute entry; any other unknown
entry is skipped with a warning. If it fails part-way, it removes the
files it created and leaves everything else as it was.

The CLI prompts for the password interactively. Use
`--password-stdin` for scripted runs.

Restore places each file at its canonical path with these modes and owners:

| Path | Mode | Owner |
|---|---|---|
| `/etc/otzi/daemon.toml` | 0640 | root:otzi |
| `/etc/otzi/address-book.otzi.json` | 0640 | root:otzi |
| share file (`[share].path`) | 0600 | otzi:otzi |
| identity file | 0660 | otzi:otzi |
| pubkey-book file | 0644 | otzi:otzi |
| `/var/lib/otzi/vault-pubkey.json` | 0644 | otzi:otzi |

The owners are what restore sets when it runs as root (the debconf restore and
`sudo otzi restore` both do) on a host with the `otzi` system user: it gives
every file it places in `/var/lib/otzi` to `otzi:otzi`, because the daemon runs
as `otzi` and could not read a root-owned `0600` share. Files in `/etc/otzi`
keep the owner they are created with, `root:otzi` through the setgid
directory. Run as another user, or on a host with no `otzi` user, restore
changes no owner.

The archive does not contain `/etc/otzi/otzi.env`. Recreate it with the share
password, then start the daemon; it loads the restored share:

```
sudo install -m 600 -o root -g root /dev/null /etc/otzi/otzi.env
sudoedit /etc/otzi/otzi.env      # one line: OTZI_SHARE_PASSWORD=<the share password>
sudo systemctl start otzi
```

**Restore refuses if:**

- `/etc/otzi/daemon.toml` already exists — operator must move it aside
  first (loud failure beats silent overwrite).
- `systemctl is-active otzi` returns 0 — operator must `systemctl stop
  otzi` first.
- Archive magic doesn't match `OTZI-BACKUP-V1`.
- Decryption fails — wrong password OR tampered archive (same error
  message; the daemon doesn't leak which one).
- Any file it would write already exists (all of them are listed) —
  move them aside and run restore again.
- The archive's `daemon.toml` puts the share, identity or pubkey book
  anywhere but directly inside `/etc/otzi` or `/var/lib/otzi`, or the archive holds a
  symlink, hardlink, device, FIFO, `..` or absolute entry.

#### What the archive does NOT contain

- Other federation members' shares — you can only sign for your own slot.
- The share password file `/etc/otzi/otzi.env` — keep the password in your own
  password manager.
- Blockchain state — vault funds live on-chain, not in the backup.
- The `.deb` package itself — download from releases for the install.

## Uninstall

```bash
sudo apt remove otzi-headless    # keeps /etc/otzi/ and /var/lib/otzi/
sudo apt purge otzi-headless     # ALSO removes the share + config + user
```

> **Warning:** `purge` deletes `/var/lib/otzi/share.json`. The vault is n-of-n:
> losing any one share without a backup makes the funds unspendable. Run
> `sudo otzi backup` on every node before purging if you might reinstall.

## Container smoke test

`scripts/test-deb-container.sh` runs the install end-to-end inside an Ubuntu
24.04 container with pre-seeded debconf answers, and verifies the rendered
config + bundle invocation. Useful before tagging a release.
