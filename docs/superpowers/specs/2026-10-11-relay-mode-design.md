# Relay mode end to end — design

Date: 2026-10-11. Status: approved in conversation. Follows the BTC pivot (`2026-10-10-btc-only-pivot-design.md`).

## 1. Goal

Relay is one of the two config-selectable transports, but it has never worked end to end:
- the .deb writes a relay-mode `daemon.toml` without `[[peers]]`, which the parser rejects;
- `otzi setup` refuses relay mode, because bootstrap identifies peers by their peer-mesh endpoint;
- nothing runs the relay server: `RelayServer` exists, but no command or unit starts it;
- a daemon that loses its relay connection never reconnects.

After this change, a federation can be installed, bootstrapped, key-generated and operated over a relay. The only extra infrastructure is the relay server, which runs on a coordinator host behind TLS.

## 2. Decisions (user-approved)

| # | Decision |
|---|---|
| R1 | A new `otzi relay --listen <host:port>` command runs the relay server. The .deb also ships `otzi-relay.service`, disabled by default, which reads its listen address from `/etc/otzi/relay.env`. |
| R2 | The relay client reconnects to the relay server after any drop, with exponential backoff from 1 s to a 30 s cap. |
| R3 | `[[peers]]` is optional and unused when `[transport] kind = "relay"`. Peer-mesh is unchanged and still requires at least one peer. |
| R4 | A pubkey-book entry's endpoint is optional. Only peer-mesh requires and checks it. The fingerprint stays pubkeys-only. |
| R5 | Bootstrap in relay mode is count-based. The leader's config has `[bootstrap] parties = N`, and the leader accepts N−1 registrations that carry no endpoint. |
| R6 | The installer's relay branch writes no `[[peers]]`, and writes `[bootstrap] parties` on the leader from a new debconf question. |
| R7 | Relay re-handshake recovery: the responder asks for a re-handshake after its handshake fails, and the initiator honours that request even while it waits for hs2, rate-limited. |

## 3. Design

### 3.1 `otzi relay` (R1)

- **Command.** `otzi relay --listen <host:port>` starts `RelayServer` and runs until SIGINT or SIGTERM. It logs through the console logger: the listen line, connects and disconnects, and errors.
  - The host is required, as today (`RelayServer` rejects a missing host).
  - The command needs no daemon config and no vault.
- **Unit.** `packaging/deb/lib/systemd/system/otzi-relay.service`:
  - runs as `User=otzi`;
  - `EnvironmentFile=/etc/otzi/relay.env`, which holds `OTZI_RELAY_LISTEN=127.0.0.1:7100`;
  - `ExecStart=/usr/bin/otzi relay --listen ${OTZI_RELAY_LISTEN}`;
  - the same hardening as `otzi.service`, with no writable paths.
- **Install.** postinst creates `relay.env` with the loopback default when it is missing (`root:root 0644`). It never enables or starts the unit.
- **TLS.** The relay serves plain WebSocket. Docs require a TLS reverse proxy in front of it (`wss://`) for anything beyond loopback or a VPN, as the server's own header already advises.

### 3.2 Relay client reconnect (R2)

- **On a drop.** When the relay WebSocket closes and `stop()` was not called:
  - every peer is marked disconnected;
  - its session and initiator state are cleared;
  - its pending pulls resolve `null`.
- **Retry.** Reconnect attempts follow 1 s, 2 s, 4 s … up to 30 s, with small jitter. A successful `hello`/ack resets the delay. The existing roster logic (ack, `peer-joined`) then starts the initiator handshakes.
- **Stop.** `stop()` cancels any pending reconnect.
- **Sends while disconnected.** Broadcasts and pulls skip a disconnected peer, as today, and pulls return `null`. Ceremony pulls already retry until their deadline, so a short relay outage only delays a ceremony.
- **Contract.** `facts/transport.md`'s "Operator restart required for relay reconnect" is replaced by this rule.

### 3.3 Config (R3, R5)

- **`[[peers]]`:**
  - `transport.kind = "relay"`: `[[peers]]` may be absent. When present, it is parsed as today but not used.
  - `transport.kind = "peer-mesh"`: unchanged; at least one peer.
- **`[bootstrap] parties`** — an integer from 2 to 255:
  - allowed only on `role = "leader"`;
  - required on the leader when the transport is relay;
  - rejected under peer-mesh (`ConfigError('bootstrap.parties', 'only used with transport.kind = "relay"; peer-mesh counts [[peers]]')`).
- The unknown-key rules stay strict.

### 3.4 Pubkey book (R4)

- `advertisedEndpoint` is optional on each entry. An entry without one is written without the key and reads back without it.
- The peer-mesh transport factory requires every non-self entry to have an endpoint, through the existing `validatePeersAgainstBook`, and a missing one is a startup error naming the party. Relay never reads endpoints.
- The fingerprint is unchanged: the first 96 bits of SHA-256 over the sorted raw pubkeys.

### 3.5 Bootstrap (R5)

- **Master, peer-mesh mode.** Unchanged: an endpoint allowlist from `[[peers]]`.
- **Master, relay mode.** It expects `parties − 1` registrations.
  - A registration must have no `advertised_endpoint`; one that has it gets 400.
  - A duplicate pubkey gets 409, and so does the master's own pubkey.
  - Once the count is reached, any further registration gets 409 with "bootstrap is full".
  - Entries are sorted by raw pubkey and assigned partyIds as today.
- **Member, relay mode.** It registers without an endpoint and checks that its own entry in the returned book has none.
- **Key ids, both modes.** Every node's completion banner now prints this node's key id and the key id of every ring entry. A key id is the first 8 hex characters of SHA-256 over the raw pubkey.
  - Fingerprint comparison proves every node holds the same book. Key ids prove the book holds only the operators' own keys.
  - In relay mode this matters more: anyone who can reach the bootstrap port during setup could register, and the fingerprint would not show it.
  - The banner and docs say: compare the fingerprint on every node, and confirm each listed key id belongs to one of your nodes. A node refused with "bootstrap is full" means someone else registered, so abort and redo setup.
- **Exposure.** Docs require the bootstrap port to be reachable only by the members during setup (VPN, firewall, or loopback through an SSH tunnel).

### 3.6 Installer (R6)

- **New template.** `otzi-headless/parties`: a string holding an integer from 2 to 255, labelled "Number of nodes in the ring (including this one)". It is asked only when the transport is relay and the role is leader.
- **Validation.** postinst validates the value; a bad value warns on stderr and omits the key, so `otzi setup` then fails with the config error naming it.
- **Relay branch.** It writes no `[[peers]]`, and writes `[bootstrap] parties` on the leader.
- **Closing message.** It explains the relay coordinator: install the package on the coordinator host, edit `/etc/otzi/relay.env`, put TLS in front, run `systemctl enable --now otzi-relay`, and set every node's `relay_url` to the `wss://` URL. The `otzi setup` steps are the same for both transports.
- **Container test.** `scripts/test-deb-container.sh` gains a relay-mode preseed variant (leader and leaf) whose rendered `daemon.toml` must parse.

### 3.7 Re-handshake recovery (R7)

- **Responder.** `completeResponderHandshake`'s catch sends the re-handshake request (the empty frame) after ending the session.
- **Initiator.**
  - `onRehandshakeRequest` restarts the handshake even in `waiting-for-hs2`. Because the responder discarded our hs1, waiting for hs2 cannot succeed.
  - Every initiator restart (request, record failure, send failure, stale check, roster change) is rate-limited to one per second per peer; a peer's first handshake is immediate. A trigger inside the window is deferred, not dropped: one per-peer timer restarts the handshake when the window ends, merging repeated requests, and is cleared on `stop()`, a relay drop and `peer-left`.
- **Stray record.** An initiator in `waiting-for-hs2` that receives a non-handshake record runs `maybeStartHandshake`, which applies the stale check instead of a silent drop.

## 4. Errors

| Condition | Behaviour |
|---|---|
| Relay unreachable at start or after a drop | Warn on each failed attempt (with backoff), keep retrying until `stop()`. Ceremonies time out by their deadline. |
| Relay-mode leader without `[bootstrap] parties` | `otzi setup` (and daemon start) fail: `config bootstrap.parties: required when transport.kind = "relay" and bootstrap.role = "leader"`. |
| Registration with an endpoint in relay mode | 400 `'advertised_endpoint' not used in relay mode`. |
| Registration after the count is reached | 409 `bootstrap is full`; the member exits non-zero with a message to abort and redo setup. |
| Peer-mesh book entry without an endpoint | Daemon start fails, naming the party. |

## 5. Non-goals

- TLS inside `otzi relay` (use a reverse proxy).
- Authentication at the relay layer. Noise-KK at the peer layer is the boundary, as today.
- Mixed transports in one ring.
- Migrating an existing peer-mesh ring to relay.

## 6. Testing

- **Config:** relay without `[[peers]]` parses; `[bootstrap] parties` rules (relay leader required, leaf rejected, peer-mesh rejected, range).
- **Pubkey book:** round trip without endpoints; peer-mesh factory refuses a book entry without an endpoint.
- **Bootstrap, relay mode:** count reached, 400 on an endpoint, 409 on a duplicate pubkey, 409 when full, member-side check. Key ids in the banner, in both modes.
- **Relay transport:**
  - reconnect after the server restarts, with backoff (fake timers) and the delay reset after a successful hello;
  - `stop()` cancels the reconnect;
  - pending pulls resolve `null` on a drop;
  - the R7 paths: a failed responder handshake leads to a request and recovery; a request in `waiting-for-hs2` restarts; the rate limit; a stray record leads to the stale check.
- **End to end:** three daemons over a real `RelayServer`: bootstrap in relay mode (in-process), DKG, a signed proposal, a relay-server restart, then another signed proposal.
- **Packaging:** `bash -n`, plus the container script's relay variant. That variant runs only where docker exists.
