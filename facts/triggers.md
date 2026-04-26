# Contracts: src/triggers/

> Global invariants and the rule of engagement live in [../INTERFACES.md](../INTERFACES.md). Update this file before changing any contract surface in this subsystem.

## src/triggers/

### `types.ts`
**Purpose:** Defines trigger abstractions (HTTP, cron) and handler contracts for ceremony invocation.

**Public surface:**
- `HttpRequest`
  - **Pre:** Caller provides raw HTTP details.
  - **Post:** Normalized into a typed structure: requestId (for logging), method, path, lowercased headers, parsed body (JSON or text or null).
  - **Invariant:** Body is either parsed JSON (if Content-Type is application/json), text (otherwise), or null (no body).

- `HttpResponse`
  - **Pre:** Handler produces this.
  - **Post:** Status code + optional body (JSON-serialized).
  - **Invariant:** No fixed schema; caller decides payload shape.

- `HttpHandler`
  - **Pre:** Receives `HttpRequest`.
  - **Post:** Returns `Promise<HttpResponse>`.
  - **Throws:** Any error propagates to HTTP server (500 response); not caught by trigger.

- `HttpTriggerConfig`
  - **Pre:** `bind` is non-empty "host:port" (no 0.0.0.0 defaults); `authTokenEnv` (if set) names an env var; handler is provided.
  - **Post:** Passed to `HttpTrigger` constructor.

- `CronTick`
  - **Pre:** Produced by scheduler when cron expression fires.
  - **Post:** Carries jobName (for disambiguation) + firedAt timestamp.

- `CronHandler`
  - **Pre:** Receives `CronTick`.
  - **Post:** Returns `Promise<void>`.
  - **Throws:** Errors are caught + logged by trigger; do NOT crash scheduler.

- `CronTriggerConfig`
  - **Pre:** `jobName` is unique per daemon; `schedule` is 5-field cron expression (croner parses it); handler provided; timezone optional.
  - **Post:** Passed to `CronTrigger` constructor.

- `TriggerSource`
  - **Pre:** Any implementation.
  - **Post:** Defines lifecycle: `start()` and `stop()` (both idempotent, may be async or sync).

**Invariants:**
- Trigger sources are stateless; they emit to handler-supplied callbacks.
- Handlers own all ceremony logic (gate, runner invocation, persistence).
- Errors in handlers are NOT propagated back to the trigger (best-effort execution).
- Trigger sources must be stopped before process exit to avoid resource leaks.

**Cross-component contracts:**
- Depends on: `Logger`.
- Used by: `Daemon` (HttpTrigger, CronTrigger instantiated from config entries).

**Notes / gotchas:**
- Chain-watching is NOT a trigger source (daemon is a signing backend, not autonomous).
- Triggers are generic; ceremony dispatch logic lives in the handler (phase 5e wires it).

---

### `http.ts`
**Purpose:** Small HTTP server (node:http, zero deps) that enforces strict host:port binding, Bearer auth, 1MB body cap, and JSON body parsing.

**Public surface:**
- `HttpTrigger` (class)
  - **Constructor(config: HttpTriggerConfig)**
    - **Pre:** `config.bind` parses to valid host:port (host non-empty, port in 0-65535).
    - **Post:** Initializes server state; does NOT bind yet.
    - **Throws:** `Error` on invalid bind format (at construction, not start).

  - **async start(): Promise<void>**
    - **Pre:** Server not already started.
    - **Post:** Binds to host:port; waits for listening event.
    - **Throws:** `Error` if bind fails (port in use, permission denied, etc.).
    - **Auth:** If `authTokenEnv` is set, env var MUST be set at start time; throws if not.
    - **Invariant:** Reentrant (returns early if already started).

  - **async stop(): Promise<void>**
    - **Pre:** Called after start (or redundantly).
    - **Post:** Closes server socket; does NOT wait for inflight requests (cuts them loose for fast shutdown).
    - **Invariant:** Reentrant (returns early if not started).

  - **address(): { host: string; port: number } | null**
    - **Pre:** Called after start.
    - **Post:** Returns the bound address; useful for tests binding to port 0.
    - **Returns:** null if server not started.

- **Request handling**
  - **Pre:** HTTP request arrives.
  - **Post:** Body read up to MAX_BODY_BYTES (1MB), parsed as JSON if Content-Type is application/json.
  - **Auth:** If `authTokenEnv` was configured, request MUST have `Authorization: Bearer <token>` header; 401 if missing/wrong.
  - **Body parsing:** 400 if JSON parse fails.
  - **Handler:** Invoked with `HttpRequest`; exceptions caught, logged, and returned as 500.
  - **Response:** Handler result is JSON-serialized and sent back.
  - **Invariant:** Headers are lowercased for normalization.

- **Constraints**
  - **Host binding:** No 0.0.0.0; must be explicit (127.0.0.1, ::1, or named interface). Load-bearing for security: localhost binding is the justification for not requiring mTLS.
  - **Body cap:** 1MB hard limit; excess triggers 400 + close.
  - **Auth:** Optional but all-or-nothing; if configured, every request is checked.

**Invariants:**
- Localhost binding (or explicit interface) is non-negotiable; should be enforced at parse time.
- Bearer token is read from env var at start time (once); changing it during runtime has no effect.
- Request ID is generated from crypto.randomUUID (or Date.now() fallback); useful for logging.
- Handler exceptions do NOT propagate; they're logged + returned as 500.
- Server closes inflight connections on stop (no graceful drain of pending requests).

**Cross-component contracts:**
- Depends on: `node:http`, NOOP_LOGGER.
- Used by: `Daemon` (via `buildTriggers`).

**Notes / gotchas:**
- No HTTPS / mTLS (operator configures reverse proxy or OS-level firewall).
- Max body is 1MB; OPNet params blobs should fit comfortably.
- Errors in the handler (e.g., ceremony failure) are user-level; HTTP itself doesn't fail (status 500 carries the error message).
- Port 0 is supported for tests; `address()` returns actual bound port.

---

### `cron.ts`
**Purpose:** Wall-clock scheduler (croner library) that fires named jobs and catches handler errors.

**Public surface:**
- `CronTrigger` (class)
  - **Constructor(config: CronTriggerConfig)**
    - **Pre:** `config.schedule` is a valid 5-field cron expression (standard format or 6-field with seconds); croner validates at construction.
    - **Post:** Initializes scheduler state; does NOT start yet.
    - **Throws:** `Error` if cron expression is invalid (at construction).

  - **start(): void** (NOT async)
    - **Pre:** Not already started.
    - **Post:** Creates Cron instance; scheduler is active.
    - **Logs:** Info message with jobName, schedule, timezone, next run time.
    - **Invariant:** Reentrant (returns early if already started).

  - **stop(): void** (NOT async)
    - **Pre:** Called after start (or redundantly).
    - **Post:** Stops Cron job; scheduler is inactive.
    - **Logs:** Info message with jobName.
    - **Invariant:** Reentrant (returns early if not started).

  - **nextRun(): Date | null**
    - **Pre:** Called at any time.
    - **Post:** Returns next scheduled fire time from croner, or null if stopped / no more runs.

- **Fire behavior**
  - **Pre:** Cron expression matches wall-clock time.
    - **Post:** Invokes handler with `CronTick`; errors are caught + logged at error level.
    - **Invariant:** Errors do NOT crash scheduler or stop subsequent ticks.

- **Timezone**
  - **Pre:** Optional; defaults to system local time.
  - **Post:** Passed to croner; fire times are computed in specified timezone.

**Invariants:**
- Cron validation happens at construction (eager); invalid expressions fail immediately.
- Handler errors are swallowed; scheduler continues ticking.
- Start/stop are NOT async (unlike HttpTrigger); they return synchronously.
- Timezone is optional; system local is the default (croner behavior).

**Cross-component contracts:**
- Depends on: `croner`, NOOP_LOGGER.
- Used by: `Daemon` (via `buildTriggers`).

**Notes / gotchas:**
- Cron expression is 5-field standard (minute, hour, dom, month, dow); croner also accepts 6-field (adds seconds).
- Handler exceptions are NOT propagated; they're logged but don't affect scheduler state.
- No way to dynamically adjust schedule after construction; create a new CronTrigger if needed.
- nextRun() returns null after stop() is called (job is stopped).

---

### `uds.ts`
**Purpose:** Small UDS server (node:net + node:http; zero deps) that listens on a Unix domain socket path and forwards HTTP-shaped requests to a caller-supplied handler. Filesystem permissions on the socket path are the auth model — no Bearer token, no host:port concept.

**Public surface:**
- `UdsTrigger` (class)
  - **Constructor(config: UdsTriggerConfig)**
    - **Pre:** `config.path` is an absolute path within an existing directory; the parent directory must exist before `start()`.
    - **Post:** Initializes server state; does NOT bind yet.
    - **Throws:** none at construction.

  - **async start(): Promise<void>**
    - **Pre:** Server not already started; `config.path` parent exists; daemon process has write permission to the parent dir.
    - **Post:** Creates the socket file at `config.path` (chmod via process umask + parent setgid). On graceful prior shutdown the file is gone; on hard exit a stale file may exist — `start()` `unlink()`s any preexisting file at the path before bind.
    - **Throws:** `Error` on bind failure (parent dir missing, permission denied, etc.).
    - **Invariant:** Reentrant (returns early if already started).

  - **async stop(): Promise<void>**
    - **Pre:** Called after start (or redundantly).
    - **Post:** Closes server, removes the socket file. Idempotent.
    - **Invariant:** Reentrant.

  - **address(): { path: string } | null**
    - **Pre:** Called any time.
    - **Post:** `{ path }` after start; `null` before/after.

- **Request handling**
  - **Pre:** UDS HTTP request arrives.
  - **Post:** Same body parsing + handler invocation rules as `HttpTrigger` (1 MB cap, JSON parse on `application/json`).
  - **Auth:** None at the application layer. Filesystem perms gate access.
  - **Handler:** Same `HttpHandler` type as HTTP trigger. Request shape is identical (`HttpRequest`); `headers.host` will be `localhost` since UDS has no concept of host.

**Invariants:**
- The socket is the auth boundary; daemon does NOT inspect peer credentials.
- A stale socket file from a previous unclean shutdown is removed by `start()`.
- Same 1 MB body cap as HTTP trigger.

**Cross-component contracts:**
- Depends on: `node:net`, `node:http` (for HTTP-shaped parsing only — UDS carries HTTP/1.1 over the socket), `node:fs/promises` for unlink, NOOP_LOGGER.
- Used by: `Daemon` (via `buildTriggers`).

**Notes / gotchas:**
- The CLI talks HTTP over UDS via Node's built-in `http.request({ socketPath })` — same wire shape as TCP HTTP, just different transport.
- File mode of the socket is determined by `umask` at `listen()` time; daemon should set `umask(0o007)` so the socket lands at 0660 with parent setgid making the group `otzi`.

---

