# fail2ban — ban repeat-offender IPs at the firewall layer

This example ships a fail2ban filter + jail that watches the daemon's
`peer-allowlist:` warn lines (emitted when a non-peer source tries to open a
WebSocket to the daemon's listen port) and bans the source IP at the
iptables/nftables layer after a few attempts.

## How it fits in

The peer-mesh transport already has two layers of defense before fail2ban
enters the picture:

1. **Network-layer pre-filter** (in-process, daemon-internal). The WS upgrade
   handler drops connections from any source IP not on the resolved peer
   endpoint allowlist. The drop is silent (socket destroyed before the
   handshake completes), and warn-logged with the `peer-allowlist:` prefix.
2. **Cryptographic mutual auth.** Allowlisted sources still must complete a
   Noise-KK handshake authenticated by the pubkey book. A wrong key cannot
   reach any ceremony state.

fail2ban is **opt-in escalation on top of these**. It pushes the rejection
out one more layer — to the kernel firewall — so a flood of failed connection
attempts from a single bad source costs nothing past the first few packets.

## Install (Ubuntu 24.04 with `apt install fail2ban`)

```bash
sudo cp examples/fail2ban/otzi.conf  /etc/fail2ban/filter.d/otzi.conf
sudo cp examples/fail2ban/otzi.local /etc/fail2ban/jail.d/otzi.local
sudo systemctl reload fail2ban
```

Verify the jail is up:

```bash
sudo fail2ban-client status otzi
```

You should see `Currently failed: 0` and `Currently banned: 0`. The numbers
move once a non-peer source actually starts hitting the daemon's listen port.

## Adjust to your deployment

Edit `/etc/fail2ban/jail.d/otzi.local`:

- **`port`** — must match your daemon's `transport.listen` in
  `/etc/otzi/daemon.toml`. The .deb's debconf default is `8800`. If the daemon
  binds a non-default port, update the jail.
- **`maxretry` / `findtime` / `bantime`** — starting points for a small
  federation. Production deployments with stable peers should consider
  `bantime = -1` (permanent) — legitimate peers never trip the allowlist
  in steady state, so a permanent ban on offenders is rarely a footgun.
- **`backend`** — the default `systemd` reads from journald. If you have
  redirected the daemon's stderr to a file, comment out the systemd lines and
  uncomment `backend = polling` + `logpath = /var/log/otzi/daemon.log`.

## Sanity check: are warn lines reaching journald?

The .deb-installed daemon ships with a stderr `Logger` wired into
`runDaemonCommand` (see `src/daemon/console-logger.ts`), so warn lines from
the peer-mesh allowlist land in journald automatically under the `otzi.service`
unit. Confirm with:

```bash
sudo journalctl -u otzi.service --since '1 hour ago' | grep -F 'peer-allowlist:'
```

If you see lines, the filter will work. If you see nothing despite known
non-peer connection attempts, you're either running a custom-launched daemon
that didn't construct a `createConsoleLogger()` (only the `daemon` subcommand
does), or no scanners have hit the listen port yet.

## Test the filter against real journal entries

`fail2ban-regex` can dry-run the filter against the journal — useful both for
confirming the regex matches the daemon's actual output and for spot-checking
after upgrades:

```bash
sudo fail2ban-regex \
    --journalmatch '_SYSTEMD_UNIT=otzi.service' \
    systemd-journal \
    /etc/fail2ban/filter.d/otzi.conf
```

The output reports `Lines: <n>, matched: <m>` — `m > 0` confirms the regex is
matching real drop events. Zero-matched-from-zero-lines means the daemon
isn't emitting drops in the queried window (normal when no scanners are
hitting the listen port); zero-matched-from-non-zero-lines means the regex
is wrong against the deployed daemon's logger format — file an issue.

## Files

- `otzi.conf` — fail2ban filter (the regex that captures the offending IP).
- `otzi.local` — fail2ban jail (which port + how aggressively to ban).
