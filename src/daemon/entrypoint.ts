/**
 * CLI entrypoint — dispatches to subcommands:
 *
 *   otzi daemon <config.toml>                   — run the daemon
 *   otzi setup <config.toml>                    — run bootstrap (reads [bootstrap].role from config)
 *   otzi generate <config.toml> [flags]         — trigger DKG against local daemon
 *   otzi install <path>                         — install a manifest
 *   otzi sync <path>                            — distribute a manifest to all peers (bootstrap-window-only)
 *   otzi list                                   — show the installed manifest
 *   otzi uninstall                              — remove the installed manifest
 *   otzi sign <contract> <method> <args...>     — sign + broadcast OPNet contract call
 *   otzi vault [--json]                         — print vault metadata
 *   otzi btc send <addr> <amount>[unit]         — send BTC from the vault
 *   otzi btc balance [--unit ...]               — read vault BTC balance
 *   otzi op20 balance <ticker|ID>               — read vault OP20 balance
 *   otzi backup                                 — write password-protected archive of daemon state
 *   otzi restore <path> [--password-stdin]      — recover daemon state from an archive
 *
 * The `daemon` subcommand loads config + share + identity + pubkey book and
 * starts the transport + Daemon. SIGINT/SIGTERM trigger graceful shutdown.
 * If the configured share file is missing, the daemon comes up in DKG-only
 * mode (signing rejected; DKG works) — operator runs `otzi generate` against
 * it from another shell, then restarts to load the persisted share.
 *
 * Operator-facing commands (install/list/sign/...) talk to the local daemon
 * over a Unix domain socket (typically /var/run/otzi/otzi.sock). The default
 * config path /etc/otzi/daemon.toml matches the .deb install layout.
 *
 * Explicitly does NOT call `initEccLib` — phase-4d trap: double-init would
 * silently misroute the FROST legacy-sig monkey-patch when BTC broadcast
 * modules also import `@btc-vision/transaction`.
 */

import { loadDaemonConfig } from '../config/load';
import { loadAndValidate } from './config-merge';
import { createConsoleLogger } from './console-logger';
import { Daemon } from './daemon';
import { setupMaster, setupMember } from './setup';
import { buildTransportFromFiles } from './transport-factory';

const DEFAULT_DAEMON_CONFIG_PATH = '/etc/otzi/daemon.toml';

export async function main(argv: readonly string[]): Promise<void> {
  const [, , cmd, ...rest] = argv;
  switch (cmd) {
    case 'daemon':
      await runDaemonCommand(rest);
      return;
    case 'setup':
      await runSetupCommand(rest);
      return;
    case 'generate':
      await runGenerateCommand(rest);
      return;
    case 'install':
      await runInstallCommand(rest);
      return;
    case 'sync':
      await runSyncCommand(rest);
      return;
    case 'list':
      await runListCommand(rest);
      return;
    case 'uninstall':
      await runUninstallCommand(rest);
      return;
    case 'sign':
      await runSignCommand(rest);
      return;
    case 'vault':
      await runVaultCommand(rest);
      return;
    case 'btc':
      await runBtcCommand(rest);
      return;
    case 'op20':
      await runOp20Command(rest);
      return;
    case 'backup':
      await runBackupCommand(rest);
      return;
    case 'restore':
      await runRestoreCommand(rest);
      return;
    default:
      throw new Error(usage());
  }
}

function usage(): string {
  return [
    'usage:',
    '  otzi daemon <path/to/daemon.toml>',
    '  otzi setup <path/to/daemon.toml>',
    '  otzi generate <path/to/daemon.toml> [--ceremony-id <id>]',
    '  otzi install <path>',
    '  otzi sync <path>',
    '  otzi list',
    '  otzi uninstall',
    '  otzi sign <contract> <method> [args...] [--config <path>] [--fee-rate <sat/vB>]',
    '  otzi vault [--json]',
    '  otzi btc send <address> <amount>[unit] [--config <path>] [--fee-rate <sat/vB>]',
    '  otzi btc balance [--unit sats|btc|mbtc|ubtc]',
    '  otzi op20 balance <ticker|ID>',
    '  otzi backup',
    '  otzi restore <archive-path> [--password-stdin]',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi daemon`
// ─────────────────────────────────────────────────────────────────────────

async function runDaemonCommand(args: string[]): Promise<void> {
  const configPath = args[0];
  if (!configPath) throw new Error(usage());

  // The daemon path is the only entrypoint that needs a real Logger — all other
  // verbs are short-lived CLI commands talking to the daemon over UDS. Ship the
  // logger to both the transport (for peer-mesh allowlist warns picked up by
  // fail2ban via journald) and to the Daemon (for orchestrator/leader/triggers
  // info+error context). stderr only — stdout is reserved for CLI machine output.
  // CLI subcommands (sign/vault/btc/op20/...) deliberately keep `NOOP_LOGGER`
  // and MUST stay that way: their stdout is consumed by shell scripts piping tx
  // IDs, vault metadata, balances into `xargs`/`opnet broadcast`/etc., so any
  // log line on stdout would corrupt the downstream parser. Wire log output to
  // stderr if a future CLI verb genuinely needs it; never to stdout.
  const logger = createConsoleLogger();

  const state = await loadAndValidate(configPath);
  const bundle = await buildTransportFromFiles(state, { logger });
  await bundle.start();

  const daemon = new Daemon({
    state,
    transport: bundle.transport,
    rng: {
      fillBytes(dest) {
        crypto.getRandomValues(dest);
      },
    },
    pullOpts: {
      maxAttempts: 200,
      initialDelayMs: 100,
      maxDelayMs: 2_000,
      deadlineMs: 120_000,
    },
    logger,
  });

  await daemon.start();

  const shutdown = async (signal: string) => {
    console.error(`received ${signal}, shutting down`);
    try {
      await daemon.stop();
      await bundle.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const mode = state.share ? 'signing+DKG' : 'DKG-only (no share file present)';
  console.error(
    `otzi daemon started — nodeId=${state.config.node.id} partyId=${state.config.node.partyId} ringId=${bundle.ringId.slice(0, 16)}... mode=${mode}`,
  );
  if (!state.share) {
    console.error(
      `otzi daemon: signing requests will be rejected until DKG runs. From another shell on the leader node:`,
    );
    console.error(`  otzi generate ${state.config.share.path === '/dev/null' ? '<config.toml>' : '<your config.toml>'}`);
    console.error('Then SIGINT this daemon and restart to load the persisted share.');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi setup …`
// ─────────────────────────────────────────────────────────────────────────

async function runSetupCommand(args: string[]): Promise<void> {
  const configPath = args[0];
  if (!configPath) throw new Error(usage());
  const config = await loadDaemonConfig(configPath);
  if (!config.bootstrap)
    throw new Error(
      'otzi setup: [bootstrap] section missing in daemon.toml — set role + bind/leader_url and re-run.',
    );
  const { role } = config.bootstrap;
  if (role === 'leader') {
    if (!config.bootstrap.bind)
      throw new Error('otzi setup: bootstrap.bind missing for role=leader');
    await setupMaster(configPath, config.bootstrap.bind);
    return;
  }
  if (!config.bootstrap.leaderUrl)
    throw new Error('otzi setup: bootstrap.leader_url missing for role=leaf');
  await setupMember(configPath, config.bootstrap.leaderUrl);
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi generate` — trigger combined DKG against the local daemon
// ─────────────────────────────────────────────────────────────────────────

async function runGenerateCommand(args: string[]): Promise<void> {
  const configPath = args[0];
  if (!configPath) throw new Error(usage());
  const flags = parseFlags(args.slice(1));

  const config = await loadDaemonConfig(configPath);

  // Find the HTTP trigger to POST to. Generate operates against the local
  // daemon over its operator-API HTTP trigger — same surface the daemon
  // already exposes for ceremony triggers.
  const httpTrigger = config.triggers.find((t) => t.kind === 'http');
  if (!httpTrigger)
    throw new Error(
      'otzi generate: no [[triggers]] entry of kind="http" in config — required to deliver the DKG request to the local daemon',
    );
  const bind = httpTrigger.params?.bind;
  if (typeof bind !== 'string')
    throw new Error('otzi generate: triggers.http.bind missing in config');

  const url = `http://${bind}/`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const authTokenEnv = httpTrigger.params?.auth_token_env;
  if (typeof authTokenEnv === 'string') {
    const token = process.env[authTokenEnv];
    if (!token)
      throw new Error(
        `otzi generate: env var '${authTokenEnv}' not set (required for HTTP trigger Bearer auth)`,
      );
    headers['authorization'] = `Bearer ${token}`;
  }

  const ceremonyId = flags.get('ceremony-id') ?? `dkg-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // Daemon derives parties (= configured peers + 1) and threshold (= parties,
  // n-of-n by v0.1 design); we just kick the ceremony.
  console.error(
    `otzi generate: triggering combined DKG (ceremonyId=${ceremonyId}) → POST ${url}`,
  );

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ op: 'dkg-combined', ceremonyId }),
  });
  const bodyText = await res.text();
  if (res.status !== 200)
    throw new Error(`otzi generate: HTTP ${res.status}: ${bodyText}`);

  const result = JSON.parse(bodyText) as {
    ceremonyId: string;
    status: string;
    mldsaPublicKeyHex: string;
    frostVerifyingKeyHex: string;
    btcAddress?: string;
    opnetAddress?: string;
    network?: string;
  };

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`  otzi generate: DKG complete (status=${result.status})`);
  console.error(`  ceremonyId:        ${result.ceremonyId}`);
  if (result.btcAddress) {
    console.error(`  vault BTC:         ${result.btcAddress} (fund here for BTC)`);
  }
  if (result.opnetAddress) {
    console.error(`  vault OPNet:       ${result.opnetAddress} (send OP20/contract calls here)`);
  }
  console.error(`  mldsaPublicKey:    ${result.mldsaPublicKeyHex}`);
  console.error(`  frostVerifyingKey: ${result.frostVerifyingKeyHex}`);
  console.error(`  share file:        ${config.share.path} (each peer also persisted its own copy)`);
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('Restart all daemons to load the persisted share and enable signing.');
}

function parseFlags(args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--'))
      throw new Error(`unexpected positional argument '${arg}'`);
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`flag --${key} is missing a value`);
    out.set(key, value);
    i += 1;
  }
  return out;
}

/**
 * Parse mixed positional + --flag args. Boolean flags (`--json` with no
 * following value) are also allowed and surface in the flags map with an
 * empty string value.
 */
function parsePositionalAndFlags(args: string[]): {
  positional: string[];
  flags: Map<string, string>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, '');
      continue;
    }
    flags.set(key, next);
    i += 1;
  }
  return { positional, flags };
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi install <path>`
// ─────────────────────────────────────────────────────────────────────────

async function runInstallCommand(args: string[]): Promise<void> {
  const source = args[0];
  if (!source || source.startsWith('--')) throw new Error('usage: otzi install <path>');
  const { install } = await import('../cli/cmd/install');
  await install({ source });
  console.error(`otzi: installed manifest from ${source}`);
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi sync <path>` — distribute a manifest to all peers
// ─────────────────────────────────────────────────────────────────────────

async function runSyncCommand(args: string[]): Promise<void> {
  const { positional, flags } = parsePositionalAndFlags(args);
  const source = positional[0];
  if (!source) throw new Error('usage: otzi sync <path>');
  const configPath = flags.get('config') || DEFAULT_DAEMON_CONFIG_PATH;
  const { sync } = await import('../cli/cmd/sync');
  const result = await sync({ configPath, source });
  console.error(
    `otzi sync: manifest installed locally + broadcast to ${result.peersNotified} peer(s) (ceremonyId=${result.ceremonyId})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi list`
// ─────────────────────────────────────────────────────────────────────────

async function runListCommand(_args: string[]): Promise<void> {
  const { list } = await import('../cli/cmd/list');
  const out = await list();
  console.log(out);
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi uninstall`
// ─────────────────────────────────────────────────────────────────────────

async function runUninstallCommand(_args: string[]): Promise<void> {
  const { uninstall } = await import('../cli/cmd/uninstall');
  const result = await uninstall();
  console.error(result.removed ? 'otzi: manifest removed' : 'otzi: no manifest installed');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi sign <contract> <method> <args...>`
// ─────────────────────────────────────────────────────────────────────────

async function runSignCommand(args: string[]): Promise<void> {
  const { positional, flags } = parsePositionalAndFlags(args);
  if (positional.length < 2)
    throw new Error('usage: otzi sign <contract> <method> [args...]');
  const [contractIdent, methodIdent, ...rest] = positional;
  const { sign } = await import('../cli/cmd/sign');
  const configPath = flags.get('config') || DEFAULT_DAEMON_CONFIG_PATH;
  const result = await sign({
    configPath,
    contractIdent: contractIdent!,
    methodIdent: methodIdent!,
    args: rest,
    ...(flags.has('fee-rate') ? { feeRate: Number(flags.get('fee-rate')) } : {}),
  });
  console.log(result.transactionId);
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi vault [--json]`
// ─────────────────────────────────────────────────────────────────────────

async function runVaultCommand(args: string[]): Promise<void> {
  const { flags } = parsePositionalAndFlags(args);
  const { vault } = await import('../cli/cmd/vault');
  const out = await vault({ json: flags.has('json') });
  console.log(out);
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi btc {send|balance} ...`
// ─────────────────────────────────────────────────────────────────────────

async function runBtcCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'send') {
    const { positional, flags } = parsePositionalAndFlags(args.slice(1));
    if (positional.length !== 2)
      throw new Error('usage: otzi btc send <address> <amount>[unit]');
    const [toAddress, amount] = positional;
    const { btcSend } = await import('../cli/cmd/btc');
    const result = await btcSend({
      configPath: flags.get('config') || DEFAULT_DAEMON_CONFIG_PATH,
      toAddress: toAddress!,
      amount: amount!,
      ...(flags.has('fee-rate') ? { feeRate: Number(flags.get('fee-rate')) } : {}),
    });
    console.log(result.transactionId);
    return;
  }
  if (sub === 'balance') {
    const { flags } = parsePositionalAndFlags(args.slice(1));
    const { btcBalance } = await import('../cli/cmd/btc');
    const out = await btcBalance({
      ...(flags.has('unit')
        ? { unit: flags.get('unit') as 'sats' | 'btc' | 'mbtc' | 'ubtc' }
        : {}),
    });
    console.log(out);
    return;
  }
  throw new Error('usage: otzi btc {send <address> <amount>[unit] | balance [--unit ...]}');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi op20 balance <ticker|ID>`
// ─────────────────────────────────────────────────────────────────────────

async function runOp20Command(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'balance') {
    const identifier = args[1];
    if (!identifier || identifier.startsWith('--'))
      throw new Error('usage: otzi op20 balance <ticker|ID>');
    const { op20Balance } = await import('../cli/cmd/op20');
    const out = await op20Balance({ identifier });
    console.log(out);
    return;
  }
  throw new Error('usage: otzi op20 balance <ticker|ID>');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi backup`
// ─────────────────────────────────────────────────────────────────────────

async function runBackupCommand(_args: string[]): Promise<void> {
  const { runBackup } = await import('../cli/cmd/backup');
  const result = await runBackup();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Backup written: ${result.path}`);
  console.log(`  Password:       ${result.password}`);
  console.log('');
  console.log('  WRITE THIS DOWN. There is no recovery path if you lose this password.');
  console.log('  Store the backup file and password in physically separate locations.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi restore <archive-path> [--password-stdin]`
// ─────────────────────────────────────────────────────────────────────────

async function runRestoreCommand(args: string[]): Promise<void> {
  // `--password-stdin` is a boolean toggle; the generic parsePositionalAndFlags
  // treats every `--flag` as flag-with-value and would consume the path as the
  // flag's value. Parse manually for this verb.
  let archivePath: string | undefined;
  let passwordStdin = false;
  for (const arg of args) {
    if (arg === '--password-stdin') {
      passwordStdin = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (archivePath !== undefined) {
      throw new Error('usage: otzi restore <archive-path> [--password-stdin]');
    }
    archivePath = arg;
  }
  if (!archivePath)
    throw new Error('usage: otzi restore <archive-path> [--password-stdin]');
  const { runRestore } = await import('../cli/cmd/restore');
  const result = await runRestore({
    archivePath,
    ...(passwordStdin ? { passwordStdin: true } : {}),
  });
  console.log('Restored files:');
  for (const f of result.restoredFiles) {
    console.log(`  ${f.path} (mode 0${f.mode.toString(8).padStart(3, '0')})`);
  }
  console.log('Run `systemctl start otzi` to bring up the daemon.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
