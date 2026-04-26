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

## Install

```bash
sudo apt install ./otzi-headless_0.0.1_amd64.deb
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
   - **Node role** (`leader` / `leaf`) — leader hosts bootstrap, leaves connect to it.
   - **Operator usernames** (space-separated) — each gets `usermod -aG otzi`.
   - **Bootstrap secret** (shared passphrase, agreed out-of-band among
     operators before install).
   - **Bitcoin network** + **OPNet RPC URL** (per-network defaults provided).
   - **Transport kind** + **listen address** (or **relay URL**).
   - **Bootstrap bind** (leader) or **leader URL** (leaf).
   - **Peer hostnames** (optional, populates `[[peers]]` stubs).
   - **Node identifier** (defaults to `hostname -s`).

2. **Log out / log back in** (or `newgrp otzi`) so your shell picks up
   the new group membership.

3. **Run `otzi setup`** on every node:
   ```
   sudo -u otzi otzi setup /etc/otzi/daemon.toml
   ```
   (Or, as a member of the `otzi` group, just `otzi setup
   /etc/otzi/daemon.toml`.) Records identity pubkeys in
   `/var/lib/otzi/pubkeys.json` and prints the 8-char SHA-256
   fingerprint. **Verify the same fingerprint on every node** out-of-band.

4. **Edit `/etc/otzi/daemon.toml`** and complete `[[peers]]` from
   `pubkeys.json`:

```toml
[[peers]]
id = "node-b"
party_id = 1
wallet_address = "0xabc..."
endpoint = "ws://node-b.example:8800"
```

5. **Run `otzi generate`** on the leader to trigger DKG. Daemon writes
   the share file; the bootstrap-secret is wiped automatically once DKG
   completes:
   ```
   sudo -u otzi otzi generate /etc/otzi/daemon.toml
   ```

6. **Enable + start the daemon:**
   ```
   sudo systemctl enable --now otzi
   ```

Logs: `journalctl -u otzi -f`.

## Operator API

Default: UDS at `/var/run/otzi/otzi.sock` (mode 660, owned otzi:otzi).
Anyone in the `otzi` group can connect via the CLI.

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
| `/etc/otzi/` | config dir (setgid; group otzi can edit) | root:otzi 2770 |
| `/etc/otzi/daemon.toml` | rendered config (preserved across upgrades) | root:otzi 640 |
| `/var/lib/otzi/` | data dir (setgid; group otzi can write) | root:otzi 2770 |
| `/var/lib/otzi/identity.json` | ECDH identity | written 660 |
| `/var/lib/otzi/pubkeys.json` | pubkey book from bootstrap | otzi:otzi 644 |
| `/var/lib/otzi/share.json` | encrypted DKG share | otzi:otzi 600 |
| `/var/lib/otzi/bootstrap-secret` | shared passphrase, wiped after DKG | root:otzi 660 |
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
- In-flight ceremonies will NOT resume. The trigger source (operator HTTP
  call, cron) re-fires them.
- Persistent state (share, identity, pubkey book) is reloaded from disk
  on startup.

### Backup + recovery

See `otzi backup` (TBD — ships in a follow-up workstream). For now, manual
backup of `/var/lib/otzi/` (share + identity + pubkey book) plus
`/etc/otzi/daemon.toml` covers everything a node needs to come back online.

## Uninstall

```bash
sudo apt remove otzi-headless    # keeps /etc/otzi/ and /var/lib/otzi/
sudo apt purge otzi-headless     # ALSO removes the share + config + user
```

> **Warning:** `purge` deletes `/var/lib/otzi/share.json`. Without backups
> across the threshold, losing more than `n − t` shares makes the federation
> unrecoverable. Back up `/var/lib/otzi/` before purging if you might
> reinstall.

## Container smoke test

`scripts/test-deb-container.sh` runs the install end-to-end inside an Ubuntu
24.04 container with pre-seeded debconf answers, and verifies the rendered
config + bundle invocation. Useful before tagging a release.
