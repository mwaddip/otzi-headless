# Installing otzi-headless

## System requirements

- Linux (tested: Debian 12+, Ubuntu 24.04+).
- `nodejs` ≥ 22. On Ubuntu 24.04, the default `nodejs` package is too old —
  install [nodesource's 22.x](https://github.com/nodesource/distributions) first.
- systemd (the .deb installs a unit file at `/lib/systemd/system/otzi.service`).
- Two open ports per node: one for peer-mesh (default `8800`), one for the
  operator HTTP API (default `127.0.0.1:7080`, loopback only).

## Install

```bash
sudo apt install ./otzi-headless_0.0.1_amd64.deb
```

`apt` resolves the `nodejs` dependency; if it's missing, `apt` will refuse
the install and tell you why. (Plain `dpkg -i` will fail on unmet deps —
follow up with `sudo apt -f install` to resolve.)

## debconf prompts

The install asks the following at default priority (high) — others fall
back to defaults you can override after install by editing
`/etc/otzi/daemon.toml`.

| Prompt | Choices / default | What it does |
|---|---|---|
| **Node role for bootstrap** | `leader` / `leaf` | Picks which `otzi setup …` subcommand the install message tells you to run. Doesn't affect runtime — all nodes are peers in the threshold ceremony. |
| **Bitcoin network** | `mainnet` / `testnet` / `regtest` | Sets `[network].name` and seeds `opnet_rpc` with the per-network default. |
| **Transport kind** | `peer-mesh` / `relay` | `peer-mesh` for direct WebSocket links between nodes; `relay` if going through a coordinator. |
| **Relay WebSocket URL** | string | Only asked when transport is `relay` (e.g. `ws://relay.example:9000`). |

Lower-priority prompts (visible at `medium` priority or above):

- **OPNet RPC URL** — defaults per network: `https://api.opnet.org` (mainnet),
  `https://testnet.opnet.org` (testnet), `http://127.0.0.1:9001` (regtest).
- **Peer hostnames** — space-separated list of the other nodes (e.g.
  `node-b.example node-c.example`). Used to write commented `[[peers]]`
  stubs in `daemon.toml`. Optional — leave blank to fill in by hand.
- **Peer-mesh listen address** — default `0.0.0.0:8800`.
- **Operator HTTP API bind** — default `127.0.0.1:7080` (loopback). Edit
  the toml after install to bind to a UDS or a non-loopback address.
- **Node identifier** — defaults to `hostname -s`. Used as `[node].id` in
  the toml; must be unique across the ring.

To re-run the prompts after install:

```bash
sudo rm /etc/otzi/daemon.toml      # postinst won't clobber an existing file
sudo dpkg-reconfigure otzi-headless
```

## Post-install setup

The package intentionally does **not** auto-start the daemon — the rendered
`daemon.toml` has commented `[[peers]]` stubs that the bootstrap step
populates, and starting before bootstrap would just crash-loop.

### 1. Bootstrap pubkey exchange

On the **leader** node (run first):

```bash
sudo -u otzi otzi setup leader /etc/otzi/daemon.toml --bind 0.0.0.0:7090
```

The leader generates an ECDH identity (if missing), starts a one-shot HTTP
server, waits for every leaf to register, and prints an 8-char fingerprint.
Compare the fingerprint out-of-band to detect MITM.

On each **leaf** node:

```bash
sudo -u otzi otzi setup leaf /etc/otzi/daemon.toml --leader http://<leader-host>:7090
```

Each leaf POSTs its identity, long-polls for the full pubkey book, prints
the same fingerprint, and writes `/var/lib/otzi/pubkeys.json`.

### 2. Fill in the `[[peers]]` block

Open `/var/lib/otzi/pubkeys.json` and copy each peer's `nodeId`, `partyId`,
and `walletAddress` (= `0x` + hex(SHA256(mldsaPubKey))) into the matching
`[[peers]]` stubs in `/etc/otzi/daemon.toml`:

```toml
[[peers]]
id = "node-b"
party_id = 1
wallet_address = "0xabc..."
endpoint = "ws://node-b.example:8800"
```

### 3. Generate the threshold share

Start the daemon (it'll come up in DKG-only mode since no share exists yet):

```bash
sudo systemctl start otzi
```

From any shell on the leader node:

```bash
sudo -u otzi otzi generate /etc/otzi/daemon.toml
```

This POSTs a DKG ceremony to the local daemon's HTTP trigger, runs the
combined ML-DSA + FROST DKG across all peers, and writes an encrypted V3
share to `/var/lib/otzi/share.json` on each node.

### 4. Enable + restart for full mode

```bash
sudo systemctl enable --now otzi
sudo systemctl restart otzi      # reload to pick up the persisted share
```

Logs: `journalctl -u otzi -f`.

## File layout

| Path | Purpose | Owner / mode |
|---|---|---|
| `/usr/bin/otzi` | CLI wrapper | root:root 755 |
| `/usr/lib/otzi/entrypoint.mjs` | esbuild bundle | root:root 644 |
| `/lib/systemd/system/otzi.service` | systemd unit | root:root 644 |
| `/etc/otzi/daemon.toml` | rendered config (preserved across upgrades) | root:otzi 640 |
| `/var/lib/otzi/identity.json` | ECDH identity | otzi:otzi 600 |
| `/var/lib/otzi/pubkeys.json` | pubkey book from bootstrap | otzi:otzi 600 |
| `/var/lib/otzi/share.json` | encrypted DKG share | otzi:otzi 600 |

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
