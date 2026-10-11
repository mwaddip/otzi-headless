# Relay Mode End to End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A federation can be installed, bootstrapped, key-generated and operated over a relay, with the relay server run by `otzi relay` / `otzi-relay.service` and daemons that reconnect on their own.

**Architecture:** The changes run bottom-up:
1. Config and pubkey book accept relay mode: no `[[peers]]`, no endpoints, and `[bootstrap] parties`.
2. Bootstrap gains count-based admission and key ids.
3. The relay client reconnects and recovers failed handshakes.
4. A CLI verb and a systemd unit run the server, and the installer renders relay configs.
5. An end-to-end ring over a real relay proves it.

**Tech Stack:** Node.js + TypeScript, `ws`, vitest, debconf/shell for packaging.

**Spec:** `docs/superpowers/specs/2026-10-11-relay-mode-design.md`. Read it first; section references (§) below point there.

## Global Constraints

- Never edit `src/otzi/**`. No new dependencies.
- Per CLAUDE.md, read the relevant `facts/*.md` first, update the contract before changing behaviour across it, and cite the contracts in the commit message.
- Conventional commits. Every commit message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015VMqRJLLSTNoNWZpLE5yPp`
- Peer-mesh behaviour is unchanged. Every existing peer-mesh test passes unmodified, except where a signature in this plan changes (master admission).
- `[bootstrap] parties` is an integer, 2 ≤ parties ≤ 255.
- Reconnect backoff: 1000 ms initial, doubling, 30000 ms cap, up to +10 % random jitter; reset after a successful `hello` ack.
- Re-handshake rate limit: at most one initiator restart per peer per 1000 ms.
- Key id: the first 8 lowercase hex characters of SHA-256 over the raw 65-byte pubkey.
- Relay listen default `127.0.0.1:7100`, in `/etc/otzi/relay.env` as `OTZI_RELAY_LISTEN=127.0.0.1:7100` (`root:root 0644`).
- Run before each commit: `npm run typecheck && npm test`. Run `bash -n` on each shell file touched, one file at a time.

## Review Focus

1. **Relay drops mid-ceremony.** Pulls during the outage return `null`, the puller retries, and the ceremony completes after the reconnect, within its deadline. Pinned in Task 4.
2. **Mismatched transports at setup.** A relay-mode member registering with a peer-mesh leader gets a member error that names the mismatch, not only "advertised_endpoint missing". Pinned in Task 3.
3. **Wrong `parties` on the leader.**
   - Too many: the leader's timeout error says how many registrations it received out of how many expected.
   - Too few: members beyond the count get "bootstrap is full".
   - Pinned in Task 3.
4. **Relay unreachable when the daemon starts.** The daemon still starts, logs a warning and keeps retrying; it does not crash-loop under systemd. Pinned in Task 4.
5. **A relay-made book (no endpoints) used with a peer-mesh config.** Startup fails, naming the party with no endpoint, instead of a confusing endpoint-set mismatch. Pinned in Task 2.

---

### Task 1: Config — `[[peers]]` optional under relay; `[bootstrap] parties`

**Files:**
- Modify: `src/config/types.ts` (`BootstrapConfig`), `src/config/parse.ts` (`parsePeers`, `parseBootstrap`, `parseDaemonConfig` ~:364-380)
- Test: `src/config/parse.test.ts`
- Docs: `facts/config.md`, `docs/config.md`

**Interfaces:**
- Produces: `BootstrapConfig.parties?: number`, set only for `role = "leader"` under relay. `DaemonConfig.peers: PeerEntry[]`, which may be `[]` under relay.

- [ ] **Step 1: Write the failing tests** in `parse.test.ts`:

```ts
it('relay config without [[peers]] parses with peers = []', ...);           // transport kind "relay", url set, no peers key
it('relay config with [[peers]] still parses them', ...);
it('peer-mesh still requires at least one peer', ...);                       // existing messages unchanged
it('relay leader requires bootstrap.parties', ...);                          // ConfigError path 'bootstrap.parties', message 'required when transport.kind = "relay" and bootstrap.role = "leader"'
it('bootstrap.parties must be an integer from 2 to 255', ...);               // 1, 256, 2.5, "3" → ConfigError 'bootstrap.parties'
it('bootstrap.parties is rejected under peer-mesh', ...);                    // message 'only used with transport.kind = "relay"; peer-mesh counts [[peers]]'
it('bootstrap.parties is rejected on a leaf', ...);                          // unknown-key rule: 'bootstrap.parties'
```

- [ ] **Step 2: Run** `npx vitest run src/config/parse.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Parse `transport` before `peers` and `bootstrap`, and pass its `kind` in: `parsePeers(raw, kind)` and `parseBootstrap(raw, kind)`.
  - Under relay, an absent `[[peers]]` gives `[]`.
  - `parties` is allowed only on a leader. Use the existing `asObject` / `rejectUnknownKeys` / `ConfigError` helpers.
- [ ] **Step 4: Run** `npx vitest run src/config`. Expected: PASS.
- [ ] **Step 5: Update docs and commit.**
  - In `facts/config.md`, change the peers rule ("at least one entry" now applies to peer-mesh only) and add `bootstrap.parties`.
  - In `docs/config.md`, update the `[[peers]]` heading note and the `[bootstrap]` table.
  - Commit `feat(config): relay configs need no [[peers]]; [bootstrap] parties for relay setup (facts/config.md)`.

### Task 2: Pubkey book — optional endpoints, key ids, peer-mesh requirement

**Files:**
- Modify: `src/bootstrap/pubkey-book.ts` (~:17-134), `src/daemon/transport-factory.ts` (peer-mesh branch ~:143-177, `validatePeersAgainstBook` ~:259-287), `src/transport/peer-mesh/*` wherever `advertisedEndpoint` is read as a string
- Test: `src/bootstrap/bootstrap.test.ts`, `src/daemon/transport-factory.test.ts`
- Docs: `facts/bootstrap.md`, `facts/daemon.md` (transport-factory)

**Interfaces:**
- Produces:
  - `PubkeyBookEntry.advertisedEndpoint?: string`.
  - `keyId(publicKeyHex: string): string`, exported from `pubkey-book.ts`: the first 8 hex characters of SHA-256 over the raw pubkey bytes. Use `@noble/hashes` (already a dependency) or `node:crypto`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('round-trips a book whose entries have no advertisedEndpoint', ...);   // serializeBook omits the key; parseBook returns entries without it
it('rejects an empty-string advertisedEndpoint', ...);                    // present-but-empty is still an error
it('keyId is the first 8 hex chars of sha256(raw pubkey)', ...);          // check against a fixed vector computed in the test with node:crypto
it('fingerprint ignores endpoints', ...);                                 // same pubkeys with and without endpoints → same fingerprint
// transport-factory.test.ts
it('peer-mesh refuses a book entry without an endpoint, naming the party', ...);   // /party 1 has no advertisedEndpoint/
it('relay accepts a book without endpoints', ...);
```

- [ ] **Step 2: Run** `npx vitest run src/bootstrap src/daemon/transport-factory.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `validateEntry` checks the endpoint only when it is present.
  - The peer-mesh factory throws `transport-factory: pubkey book entry for party <id> has no advertisedEndpoint; peer-mesh needs one for every peer` before `validatePeersAgainstBook`.
  - Fix every compile error the optional type surfaces, without changing peer-mesh behaviour.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run src/bootstrap src/daemon src/transport`. Expected: PASS.
- [ ] **Step 5: Update facts and commit** `feat(bootstrap): pubkey book endpoints optional; key ids (facts/bootstrap.md, facts/daemon.md)`.

### Task 3: Bootstrap — count-based admission in relay mode; key ids in the banner

**Files:**
- Modify: `src/bootstrap/master.ts` (`MasterBootstrapInputs` ~:33-49, `runMasterBootstrap` ~:97-140, `handleRequest` ~:220-275), `src/bootstrap/register.ts` (`MemberRegisterInputs` ~:19-30, `runMemberRegister`), `src/daemon/setup.ts` (`setupMaster` ~:34-71, `setupMember` ~:73-110, `announceComplete` ~:173-186)
- Test: `src/bootstrap/bootstrap.test.ts`, setup tests (find them: `grep -rln setupMaster src`)
- Docs: `facts/bootstrap.md`, `docs/install.md` (setup section), `docs/cli.md` (`otzi setup`)

**Interfaces:**
- Consumes: `keyId` and the optional `advertisedEndpoint` from Task 2; `BootstrapConfig.parties` from Task 1.
- Produces:

```ts
export type MasterAdmission =
  | { kind: 'endpoints'; selfEndpoint: string; expectedPeers: ReadonlyArray<{ advertisedEndpoint: string }> }
  | { kind: 'count'; parties: number };
export interface MasterBootstrapInputs { self: { identity: IdentityKeyPair }; admission: MasterAdmission; bind: string; timeoutMs?: number; logger?: Logger }
export interface MemberRegisterInputs { self: { identity: IdentityKeyPair; advertisedEndpoint?: string }; masterUrl: string; timeoutMs?: number }
```

- [ ] **Step 1: Write the failing tests** in `bootstrap.test.ts` (in-process master and members, as the existing tests do):

```ts
it('count admission: completes after parties − 1 registrations without endpoints', ...);   // 3 parties → book of 3, partyIds by sorted pubkey, no endpoints
it('count admission: a registration with an endpoint gets 400', ...);                     // body error "'advertised_endpoint' not used in relay mode"
it('count admission: a duplicate pubkey or the master's own pubkey gets 409', ...);
it('count admission: a registration after the count is reached gets 409 bootstrap is full', ...);
it('member in relay mode refuses a book whose own entry has an endpoint', ...);
it('a relay-mode member registering with an endpoints-mode master gets an error naming the transport mismatch', ...);   // Review Focus 2: member error contains 'transport' and 'relay'
it('leader timeout names received vs expected registrations', ...);                       // Review Focus 3: /received 1 of 2/
it('endpoints admission unchanged', ...);                                                 // existing tests, ported to `admission`
// setup tests
it('setup banner lists this node's key id and every ring key id', ...);                   // both transports
```

- [ ] **Step 2: Run** `npx vitest run src/bootstrap src/daemon/setup*`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **Master, `count` admission:** track registrations by pubkey and complete at `parties` total, self included.
  - **Member:** when `advertisedEndpoint` is absent, send no `advertised_endpoint`. Map a 400 "'advertised_endpoint' missing" reply into the mismatch error:
    `setup: the leader expects peer-mesh registrations (an advertised endpoint); this node is configured for relay — use the same transport on every node`.
  - **Member, full:** a 409 "bootstrap is full" becomes
    `setup: bootstrap is full — another party registered in this node's place; abort, delete pubkeys.json on every node and redo setup with the bootstrap port reachable only by the members`.
  - **`setupMaster` / `setupMember`:** pick the admission from `config.transport.kind`. Remove the "requires peer-mesh" throws.
  - **`announceComplete`:** after the fingerprint, print:
    - `this node: <keyId>`;
    - one line per entry: `party <id>: <keyId>` plus `  <endpoint>` when present;
    - the instruction `Confirm every key id above belongs to one of your nodes; an unknown id means someone else registered — delete pubkeys.json on every node and redo setup.`
- [ ] **Step 4: Run** `npx vitest run src/bootstrap src/daemon`. Expected: PASS.
- [ ] **Step 5: Update docs and commit.**
  - In `facts/bootstrap.md`: admission modes, error codes and the key-id rule.
  - In `docs/install.md` and `docs/cli.md`: relay setup, key-id check and port exposure (spec §3.5).
  - Commit `feat(bootstrap): count-based relay admission and key ids in the setup banner (facts/bootstrap.md)`.

### Task 4: Relay client reconnect

**Files:**
- Modify: `src/transport/relay/relay-transport.ts` (`RelayTransportOptions` ~:64-73, `start` ~:164-195, `stop` ~:197, `handleRelayClose` ~:654-664)
- Test: `src/transport/relay/relay.test.ts`
- Docs: `facts/transport.md` (~:420 "Operator restart required for relay reconnect", relay-transport section)

**Interfaces:**
- Produces: `RelayTransportOptions.reconnect?: { initialMs?: number; maxMs?: number }`, defaulting to 1000 / 30000, so tests can shorten it. `start()` resolves after its first connection attempt whether or not it succeeded.

- [ ] **Step 1: Write the failing tests** (real `RelayServer` on an ephemeral port; small reconnect values such as 50 / 400 ms):

```ts
it('reconnects after the relay server restarts and re-handshakes with peers', ...);    // stop server, start a new one on the same port, broadcast delivers again
it('start() succeeds when the relay is down and connects once it comes up', ...);    // Review Focus 4
it('backoff doubles to the cap and resets after a successful hello', ...);           // inspect attempt delays via an injected clock/logger or the reconnect option; no wall-clock asserts tighter than 3×
it('stop() cancels a pending reconnect', ...);                                       // no connection attempt after stop
it('pulls during an outage return null and succeed after the reconnect', ...);      // Review Focus 1
```

- [ ] **Step 2: Run** `npx vitest run src/transport/relay`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - On close or error, run the existing `handleRelayClose` cleanup, then schedule `connect()` after `min(maxMs, initialMs·2^attempt)` with up to +10 % jitter.
  - A `hello` ack resets `attempt`.
  - Log each failed attempt at warn, with the next delay.
  - `stop()` clears the timer and closes the socket.
- [ ] **Step 4: Run** `npx vitest run src/transport`. Expected: PASS, with no open handles.
- [ ] **Step 5: Update facts and commit** `feat(transport): relay client reconnects with backoff (facts/transport.md)`.

### Task 5: Relay re-handshake recovery (spec §3.7)

**Files:**
- Modify: `src/transport/relay/relay-transport.ts` (`completeResponderHandshake` catch ~:507-512, `onRehandshakeRequest` ~:427-433, the `dispatchIncoming` record-while-waiting branch ~:399-405)
- Test: `src/transport/relay/relay.test.ts`
- Docs: `facts/transport.md`

**Interfaces:** internal only. Constant `REHANDSHAKE_MIN_INTERVAL_MS = 1000`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('a failed responder handshake asks the initiator to restart, and the pair recovers', ...);   // inject a malformed hs1 (65 bytes, 0x04 prefix, not a point); then a broadcast from the RESPONDER reaches the initiator within 2 s without initiator traffic
it('a re-handshake request in waiting-for-hs2 restarts the handshake', ...);
it('restarts are limited to one per peer per second', ...);                                   // two requests 100 ms apart → one restart
it('a stray record while waiting for hs2 triggers the stale check, not a silent drop', ...);
```

- [ ] **Step 2: Run** `npx vitest run src/transport/relay`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - In the responder's catch, call `requestRehandshake(peer)` after `endSession`.
  - In `onRehandshakeRequest`, restart from any status when `now − lastRestartAt ≥ REHANDSHAKE_MIN_INTERVAL_MS`; otherwise log at debug and ignore.
  - When the initiator in `waiting-for-hs2` receives a non-handshake record, call `maybeStartHandshake(peer)`.
- [ ] **Step 4: Run** `npx vitest run src/transport`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(transport): relay pairs recover from a failed responder handshake (facts/transport.md)`.

### Task 6: `otzi relay` verb

**Files:**
- Modify: `src/daemon/entrypoint.ts` (verb switch ~:43-66, usage text, new `runRelayCommand(args: string[]): Promise<void>` beside `runDaemonCommand` ~:96)
- Test: `src/daemon/entrypoint.test.ts`
- Docs: `facts/daemon.md` (verb table), `docs/cli.md`, `CLAUDE.md` § Transport (relay: "run `otzi relay` on the coordinator, behind TLS"), `README.md` if it lists verbs

**Interfaces:**
- Consumes: `RelayServer` (`src/transport/relay/server.ts`, `{ listen, logger }`).
- Produces: `otzi relay --listen <host:port>`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('otzi relay --listen 127.0.0.1:0 starts a relay that accepts a hello and stops on SIGTERM', ...);   // spawn or call runRelayCommand with an abort hook; assert listen line on stderr
it('otzi relay without --listen fails with usage', ...);
it('otzi relay rejects an unknown flag', ...);
```

- [ ] **Step 2: Run** `npx vitest run src/daemon/entrypoint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `parseVerbArgs(args, { values: ['listen'] })`.
  - Construct `RelayServer` with the console logger and start it.
  - SIGINT and SIGTERM stop it, then exit 0.
  - Nothing goes to stdout.
- [ ] **Step 4: Run** `npx vitest run src/daemon`. Expected: PASS.
- [ ] **Step 5: Update docs and commit** `feat(cli): otzi relay runs the relay server (facts/daemon.md)`.

### Task 7: Packaging — relay unit, debconf parties, relay branch

**Files:**
- Create: `packaging/deb/lib/systemd/system/otzi-relay.service`
- Modify:
  - `packaging/deb/DEBIAN/templates` (new `otzi-headless/parties`);
  - `packaging/deb/DEBIAN/config` (ask `parties` when transport is relay and role is leader, ~:49-63);
  - `packaging/deb/DEBIAN/postinst` (relay branch ~:197-248: no `[[peers]]`, `[bootstrap] parties`; create `/etc/otzi/relay.env` when missing; closing message);
  - `scripts/build-deb.sh` (ship the unit if units are listed explicitly);
  - `scripts/test-deb-container.sh` (relay preseed variant).
- Docs: `docs/install.md` (relay coordinator section)

**Interfaces:**
- Consumes: Task 1 config keys, Task 6 verb.

- [ ] **Step 1: Write the unit.**
  - Directives: `User=otzi`, `Group=otzi`, `EnvironmentFile=/etc/otzi/relay.env`, `ExecStart=/usr/bin/otzi relay --listen ${OTZI_RELAY_LISTEN}`, `Restart=on-failure`.
  - Copy the sandbox directives from `otzi.service`, without `ReadWritePaths` and without `RuntimeDirectory`.
  - Verify with `systemd-analyze verify` on a scratch copy whose `ExecStart` is `/bin/true`. Expected: no output.
- [ ] **Step 2: Add the debconf template, config prompt and postinst rendering.**
  - **Template `otzi-headless/parties`:** `Type: string`, description "Number of nodes in the ring (including this one)", asked at high priority only for relay leaders.
  - **postinst validation:** accept only an integer from 2 to 255. Otherwise warn on stderr and omit the key.
  - **postinst relay branch:** render no `[[peers]]`.
  - **`relay.env`:** create it with `OTZI_RELAY_LISTEN=127.0.0.1:7100`, `root:root 0644`, only when missing. Never enable `otzi-relay`.
  - **Closing message (relay):** spec §3.6.
- [ ] **Step 3: Add the container variant.**
  - In `scripts/test-deb-container.sh`, preseed a relay leader (`parties` 3) and a relay leaf, and assert each rendered `daemon.toml` parses (`otzi vault --config`, or the parse check the script already uses).
  - Assert `/etc/otzi/relay.env` exists, `otzi-relay.service` is installed, and the service is disabled.
  - Verify with `bash -n` on each touched shell file, plus a stub debconf harness run of postinst for relay leader, relay leaf and peer-mesh. Expected: every rendered `daemon.toml` parses with `parseDaemonConfigToml`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Update docs and commit.**
  - In `docs/install.md`: relay coordinator setup (TLS proxy, `wss://` URL, enabling the unit) and the `parties` prompt.
  - Commit `feat(packaging): relay unit, parties prompt and a parseable relay config (docs/install.md)`.

### Task 8: End-to-end ring over a real relay

**Files:**
- Create: `src/daemon/relay-integration.test.ts`
- Consumes: everything above; follow the patterns in `src/daemon/daemon-integration.test.ts` (real configs, `loadAndValidate`, `Daemon`) and `buildTransportFromFiles`.

- [ ] **Step 1: Write the test.**

```ts
it('three daemons over a real relay: relay-mode setup, DKG, signing, relay restart, signing again', async () => {
  // 1. RelayServer on 127.0.0.1:0.
  // 2. Three temp node dirs with relay-mode daemon.toml (leader with parties = 3).
  //    setupMaster + two setupMember in-process → identical fingerprints, books without endpoints.
  // 3. Start three Daemons (buildTransportFromFiles); DKG via the leader's API → all three commit the same address.
  // 4. Restart the daemons to load shares (as operators do); sign a makeProposal(...) → signed tx verifies.
  // 5. Stop the RelayServer; start a new one on the same port; sign another proposal → succeeds after reconnect.
}, 120_000);
```

- [ ] **Step 2: Run** `npx vitest run src/daemon/relay-integration.test.ts` five times in a row. Expected: PASS 5/5, with no open handles.
- [ ] **Step 3: Run** `npm run typecheck && npm test && bash scripts/check-otzi-drift.sh /home/user/mwaddip/otzi`. Expected: all green, drift `OK: 21 files`.
- [ ] **Step 4: Commit** `test(relay): end-to-end ring over a real relay with a relay restart`.
