# Installing otzi-headless

## System requirements

- Linux (tested: Debian 12+, Ubuntu 24.04+).
- `nodejs` ≥ 22. On Ubuntu 24.04, the default `nodejs` package is too old —
  install [nodesource's 22.x](https://github.com/nodesource/distributions) first.
- systemd (the .deb installs the unit files `/lib/systemd/system/otzi.service` and
  `otzi-relay.service`; the second is installed disabled and is needed only for the
  relay transport, see [Relay coordinator](#relay-coordinator)).
- One open port per node for peer-mesh (default `8800`); leader nodes also
  open the bootstrap-server port temporarily (default `7090`) during initial
  pubkey exchange, reachable only by the members (see step 3 of the walkthrough). The operator API is local-only over a UDS at
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
     - For `relay`: **Relay URL** (`ws://` or `wss://`; the same on every node, see
       [Relay coordinator](#relay-coordinator)). A relay config has no
       `[[peers]]`, so no peer list is asked.
   - **Bootstrap bind** (leader) or **leader URL** (leaf).
   - **Number of nodes in the ring (including this one)** — asked only on a
     leader under `relay`. An integer from 2 to 255; it becomes `[bootstrap]
     parties`, which tells the leader how many registrations to admit
     (`parties − 1`). Anything else is left out of `daemon.toml` with a warning
     on stderr, and `otzi setup` (and the daemon) then refuse the config with
     `config bootstrap.parties: required when transport.kind = "relay" and
     bootstrap.role = "leader"` until you add the key under `[bootstrap]`.
     Peer-mesh counts `[[peers]]` instead, and a leaf never takes the key.
   - **Node identifier** (defaults to `hostname -s`; local logging label only).

2. **Log out / log back in** (or `newgrp otzi`) so your shell picks up
   the new group membership.

3. **Run `otzi setup`** on every node, leader first:
   ```
   sudo -u otzi otzi setup /etc/otzi/daemon.toml
   ```
   (Or, as a member of the `otzi` group, just `otzi setup
   /etc/otzi/daemon.toml`.) Records identity pubkeys (and, under peer-mesh, each
   peer's reachable address) in `/var/lib/otzi/pubkeys.json` and prints a banner
   like this one:
   ```
     otzi: setup complete — node-a
     fingerprint: 3f2a-9c41-07be-d5e0-6a18-b2c7
     this node: 1c9e04ab
     party 0: 1c9e04ab  node-a.example:8800
     party 1: 7d20f3c5  node-b.example:8800
     party 2: e4b1a960  node-c.example:8800
   ```
   A key id is the first 8 hex characters of SHA-256 over a node's identity
   pubkey. A relay book has no endpoints, so its `party` lines end after the key id.
   Before going further:
   - **Compare the fingerprint on every node out of band.** A mismatch means
     someone tampered with the exchange: delete `/var/lib/otzi/pubkeys.json` on
     every node and redo setup.
   - **Confirm every key id belongs to one of your nodes.** Note each node's
     `this node:` id; every `party` line must show one of them. An unknown id means
     someone else registered: delete `/var/lib/otzi/pubkeys.json` on every node and
     redo setup. The fingerprint cannot catch this, because the extra key is in
     every node's book.

   partyIds are assigned deterministically by sorted-pubkey-bytes order — every
   node observes the same mapping.

   **Admission depends on the transport.** Every node must use the same one.
   - **Peer-mesh:** the leader admits only the endpoints in its `[[peers]]`.
   - **Relay:** nodes have no endpoints, so the leader admits the first
     `parties − 1` registrations, where `[bootstrap] parties` on the leader is the
     ring size including itself (see [config.md](config.md#bootstrap)).
   - A member whose transport differs from the leader's fails with
     `setup: the leader expects … registrations …; this node is configured for … — use the same transport on every node`.
   - A member that fails with `setup: bootstrap is full` was beaten to its slot by
     someone else. Likewise, if the leader finishes before all your members have
     registered, someone else filled a slot; a member that arrives after that
     fails with `register: POST failed: … (ECONNREFUSED); the leader is not
     accepting registrations — …`. That message also appears when the leader has
     not started yet, so first check whether the leader has finished, then compare
     key ids. Either way, an unknown key id means: abort, delete
     `/var/lib/otzi/pubkeys.json` on every node and redo setup.
   - If the leader times out with `received 1 of 2 registrations` (or similar),
     fewer members registered than it expected: check that every member ran
     setup and, under relay, the leader's `parties`.

   **Bootstrap port exposure.** While setup runs, the leader's bootstrap port
   (default `7090`) must be reachable only by the members. This matters most
   under relay, where admission is by count. Use one of:
   - a VPN;
   - a firewall rule that admits only the members' addresses;
   - a loopback bind reached through SSH tunnels: `bind = "127.0.0.1:7090"` on the
     leader, and on each member `ssh -N -L 7090:127.0.0.1:7090 <leader-host>` with
     `leader_url = "http://127.0.0.1:7090"`.

   The leader stops listening once every member has registered. Remove any
   firewall opening you made for setup.

4. **Enable + start the daemon** on every node (under `relay`, with the relay
   server already running: see [Relay coordinator](#relay-coordinator)):
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

## Relay coordinator

Under `[transport] kind = "relay"` the daemons do not dial each other: every node
connects to one relay server, which routes opaque encrypted frames between them.
Run that server on a **coordinator host**, once for the whole ring. The host can
be one of the ring nodes or a separate machine. The `.deb` ships the server as
`otzi-relay.service`, installed **disabled**: nothing starts it until you do.

1. **Install the package on the coordinator host.** On a ring node it is already
   there. On a separate host the debconf prompts can take any answer: the relay
   reads nothing from `daemon.toml`, and `otzi.service` stays disabled and, with
   no share password file, does not start.

2. **Check the listen address** in `/etc/otzi/relay.env` (`root:root`, mode `0644`,
   no secret). The postinst creates it when it is missing, and no later install,
   upgrade or reconfigure overwrites it:
   ```
   OTZI_RELAY_LISTEN=127.0.0.1:7100
   ```
   The unit runs `otzi relay --listen ${OTZI_RELAY_LISTEN}`. The host part is
   required: the relay has no built-in default, so it never binds every interface
   by accident (an IPv6 host goes in brackets, `[::1]:7100`). The loopback default
   suits a TLS reverse proxy on the same host. Edit the file as root and restart
   the unit to change it. A port below 1024 needs a drop-in granting
   `AmbientCapabilities=CAP_NET_BIND_SERVICE` (`sudo systemctl edit otzi-relay`).

3. **Put TLS in front of it.** The relay speaks plain WebSocket and has no login
   of its own: the Noise-KK layer between the daemons authenticates and encrypts
   everything the relay carries, so the relay sees only opaque frames and cannot
   read or forge them. It can still be disrupted: any host that can reach the port
   can claim a party slot in a ring until the squatter disconnects. So keep the
   relay on loopback behind a TLS reverse proxy, or on a VPN, and use the proxy's
   or the firewall's own allowlist when you can. The proxy must pass WebSocket
   upgrades and keep an idle connection open for longer than the 20 s keepalive
   ping that both the relay and the daemons send. With nginx:
   ```nginx
   server {
       listen 443 ssl;
       server_name relay.example;
       ssl_certificate     /etc/letsencrypt/live/relay.example/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/relay.example/privkey.pem;

       location / {
           proxy_pass http://127.0.0.1:7100;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_read_timeout 3600s;
           proxy_send_timeout 3600s;
       }
   }
   ```
   (Caddy needs only `relay.example { reverse_proxy 127.0.0.1:7100 }`.)

4. **Start the relay** on the coordinator host:
   ```
   sudo systemctl enable --now otzi-relay
   journalctl -u otzi-relay -f
   ```
   It logs `RelayServer: listening {"host":"127.0.0.1","port":7100}` at start, then
   one line per connect and disconnect. It restarts itself after a crash
   (`Restart=on-failure`). Daemons that lose the relay redial it with a backoff of
   1 s up to 30 s and re-handshake with their peers, so a relay restart only
   delays a ceremony in flight; it does not need a daemon restart.

5. **Point every node at it.** `[transport] url` in `/etc/otzi/daemon.toml` is the
   `wss://` URL of the proxy, the same on all nodes (`url = "wss://relay.example"`;
   plain `ws://` is for loopback or a VPN). The installer's **Relay URL** prompt
   writes it. Change the file by hand if the URL changes, then restart the daemon.

The `otzi setup`, `otzi generate` and `otzi vault` steps are the same for both
transports. Two differences matter during setup:

- The bootstrap exchange runs over the leader's HTTP bootstrap port, not through
  the relay, and under relay the leader admits members **by count**. Keep that
  port reachable only by the members until setup ends (see step 3 of the
  walkthrough).
- The daemons connect to the relay when they start, so start the relay before
  step 4 of the walkthrough.

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
| `/lib/systemd/system/otzi-relay.service` | systemd unit of the relay server (installed disabled; see [Relay coordinator](#relay-coordinator)) | root:root 644 |
| `/etc/otzi/` | config dir (setgid; only root writes, group otzi reads) | root:otzi 2750 |
| `/etc/otzi/daemon.toml` | rendered config (preserved across upgrades; owner and mode re-applied on every configure) | root:otzi 640 |
| `/etc/otzi/otzi.env` | share password for the unit (`OTZI_SHARE_PASSWORD=…`) | root:root 600 |
| `/etc/otzi/relay.env` | listen address of `otzi-relay.service` (`OTZI_RELAY_LISTEN=127.0.0.1:7100`); created when missing, never overwritten | root:root 644 |
| `/etc/otzi/address-book.otzi.json` | this node's address book (optional; owner and mode re-applied on every configure) | root:otzi 640 |
| `/var/lib/otzi/` | data dir (setgid; group otzi can write) | root:otzi 2770 |
| `/var/lib/otzi/identity.json` | ECDH identity | otzi:otzi 660 |
| `/var/lib/otzi/pubkeys.json` | pubkey book from bootstrap | otzi:otzi 644 |
| `/var/lib/otzi/share.json` | encrypted Ötzi v4 share | otzi:otzi 600 |
| `/var/lib/otzi/share.json.pending` | DKG staging file; exists while a DKG runs, or after a DKG that failed once this node had confirmed | otzi:otzi 600 |
| `/var/lib/otzi/vault-pubkey.json` | public vault metadata | otzi:otzi 644 |
| `/var/run/otzi/` | runtime dir for the socket (setgid and sticky: a group member cannot unlink or rename the daemon's socket and bind a look-alike; the unit's `RuntimeDirectory=` creates it with the same mode) | root:otzi 3770 (postinst, tmpfiles) before the service starts; otzi:otzi 3770 while it runs (the unit's `RuntimeDirectory=` hands it to `User=otzi`) |
| `/var/run/otzi/otzi.sock` | UDS socket for operator CLI | otzi:otzi 660 |

## Operations

### Logs

The daemon writes structured info / warn / error lines to stderr; systemd
captures them in journald. There is no daemon-level log file to manage.

```
journalctl -u otzi -f             # live tail
journalctl -u otzi --since today  # windowed
journalctl -u otzi -p warning     # filter by priority
journalctl -u otzi-relay -f       # the relay server, on the coordinator host
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

`otzi-relay.service` carries the same restrictions, except that it has no
`ReadWritePaths=` and no `RuntimeDirectory=`: the relay holds no key, reads no vault
file and writes nothing, so its whole file system is read-only.

`exec` gate commands therefore see no `/dev` beyond the basics and have no setuid
helper to call; see [`gates.md`](./gates.md) § `exec`. To loosen any of this for
one host, add a drop-in with `sudo systemctl edit otzi` (or `otzi-relay`) rather than
editing the packaged unit, which an upgrade replaces. `systemd-analyze security
otzi.service` shows the unit's exposure.

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

The package does not stop or disable a unit you enabled yourself, so run `sudo systemctl
disable --now otzi` (and, on the coordinator host, `otzi-relay`) first. `purge` also
removes `/etc/otzi/relay.env` with the rest of `/etc/otzi`.

> **Warning:** `purge` deletes `/var/lib/otzi/share.json`. The vault is n-of-n:
> losing any one share without a backup makes the funds unspendable. Run
> `sudo otzi backup` on every node before purging if you might reinstall.

## Container smoke test

`scripts/test-deb-container.sh` runs the install end-to-end inside an Ubuntu
24.04 container with pre-seeded debconf answers, and verifies the rendered
config + bundle invocation. Besides the peer-mesh install and the backup/restore
round-trip it runs relay variants: a relay leader (`parties` 3) and a relay leaf,
each of which must render a `daemon.toml` without `[[peers]]` that parses, and a
leader with a bad ring size, which must be warned about and left out. It also
checks that `otzi-relay.service` is installed with its sandbox directives, not
enabled, and that `/etc/otzi/relay.env` exists with the loopback default and
survives a reconfigure. It needs docker. Useful before tagging a release.
