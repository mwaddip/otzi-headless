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
   - **Node role** (`leader` / `leaf`) — leader hosts bootstrap, leaves connect to it.
   - **Operator usernames** (space-separated) — each gets `usermod -aG otzi`.
   - **Bootstrap secret** (shared passphrase, agreed out-of-band among
     operators before install).
   - **Bitcoin network** + **OPNet RPC URL** (per-network defaults provided).
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

3. **Run `otzi setup`** on every node:
   ```
   sudo -u otzi otzi setup /etc/otzi/daemon.toml
   ```
   (Or, as a member of the `otzi` group, just `otzi setup
   /etc/otzi/daemon.toml`.) Records identity pubkeys + each peer's
   reachable address in `/var/lib/otzi/pubkeys.json` and prints the
   8-char SHA-256 fingerprint. **Verify the same fingerprint on every
   node** out-of-band. partyIds are assigned deterministically by
   sorted-pubkey-bytes order — every node observes the same mapping.

4. **Enable + start the daemon:**
   ```
   sudo systemctl enable --now otzi
   ```

5. **Run `otzi generate`** on the leader to trigger DKG. Daemon writes
   the share file; the bootstrap-secret is wiped automatically once DKG
   completes:
   ```
   sudo -u otzi otzi generate /etc/otzi/daemon.toml
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

#### Backup

Run `otzi backup` after every config change, every peer change, and after
initial DKG completes. Beyond that, cadence is per-operator risk tolerance.

```
otzi backup
```

Output: a single password-protected archive in your home directory:

```
~/otzi-backup-2026-04-26T12-34-56Z.otzi-backup    # mode 0600
```

The archive contains:

- `etc/otzi/daemon.toml` — daemon config.
- `etc/otzi/share.json` — encrypted DKG share.
- `etc/otzi/pubkey-book.json` — peer pubkey book from bootstrap.
- `var/lib/otzi/identity.json` — Noise-KK identity keypair.
- `etc/otzi/manifest.otzi.json` — installed manifest (if any).
- `var/lib/otzi/vault-pubkey.json` — derived addresses cache (if present).
- `var/lib/otzi/bootstrap-secret` — shared passphrase (only pre-DKG; wiped after).
- `meta.json` — `{ version, createdAt, hostname, partyId }`.

The password is auto-generated (32 chars from `[A-Za-z0-9]`, ~190 bits
entropy) and printed once to stdout:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Backup written: /home/operator/otzi-backup-2026-04-26T12-34-56Z.otzi-backup
  Password:       a8K2zP4mQ9xR7sN3vL5jB6tH1wF0gY9c

  WRITE THIS DOWN. There is no recovery path if you lose this password.
  Store the backup file and password in physically separate locations.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Write down the password.** Loss of the password is loss of the backup —
there is no recovery path. Store the archive and the password in physically
separate locations: e.g., archive in cloud storage, password in a password
manager OR a sealed envelope in a different room. An attacker who gets both
can sign as your slot in the federation.

#### Recovery

Two paths.

**1. Fresh-install via debconf (preferred).**

When installing the .deb on a new host, answer `Yes` to "Restore from a
backup?". debconf prompts for the archive path and password; postinst
pipes the password via stdin to `otzi restore --password-stdin`. If
restore succeeds, the rest of the install prompts (network, role,
peers, bootstrap-secret, etc.) are skipped — config came from the
backup.

If restore fails (wrong password, corrupted archive, missing file),
dpkg flags the package as half-installed. Retry via:

```
sudo dpkg-reconfigure otzi-headless
```

Decline restore this time, OR provide a valid backup + password.

**2. Manual via `otzi restore`.**

If you've already done a fresh install (or the daemon is in a
half-state), stop the daemon, remove the existing config, then run
restore manually:

```
sudo systemctl stop otzi
sudo rm /etc/otzi/daemon.toml
sudo otzi restore ~/otzi-backup-2026-04-26T12-34-56Z.otzi-backup
```

The CLI prompts for the password interactively. Use
`--password-stdin` for scripted runs.

**Restore refuses if:**

- `/etc/otzi/daemon.toml` already exists — operator must remove it first
  (loud failure beats silent overwrite).
- `systemctl is-active otzi` returns 0 — operator must `systemctl stop
  otzi` first.
- Archive magic doesn't match `OTZI-BACKUP-V1`.
- Decryption fails — wrong password OR tampered archive (same error
  message; the daemon doesn't leak which one).

#### What the archive does NOT contain

- Other federation members' shares — you can only sign for your own slot.
- The federation's threshold-key public material — recoverable from any
  peer via re-bootstrap.
- Blockchain state — vault funds live on-chain, not in the backup.
- The `.deb` package itself — download from releases for the install.

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
