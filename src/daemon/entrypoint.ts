/**
 * CLI entrypoint — dispatches to subcommands:
 *
 *   otzi daemon <config.toml>                   — run the daemon
 *   otzi setup <config.toml>                    — run bootstrap (reads [bootstrap].role from config)
 *   otzi generate <config.toml> [flags]         — trigger DKG against local daemon
 *
 * The `daemon` subcommand loads config + share + identity + pubkey book and
 * starts the transport + Daemon. SIGINT/SIGTERM trigger graceful shutdown.
 * If the configured share file is missing, the daemon comes up in DKG-only
 * mode (signing rejected; DKG works) — operator runs `otzi generate` against
 * it from another shell, then restarts to load the persisted share.
 *
 * (Phase 9b/9c add: install / list / sign / uninstall / vault / btc / op20 / sync.)
 *
 * Explicitly does NOT call `initEccLib` — phase-4d trap: double-init would
 * silently misroute the FROST legacy-sig monkey-patch when BTC broadcast
 * modules also import `@btc-vision/transaction`.
 */

import { loadDaemonConfig } from '../config/load';
import { loadAndValidate } from './config-merge';
import { Daemon } from './daemon';
import { setupMaster, setupMember } from './setup';
import { buildTransportFromFiles } from './transport-factory';

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
    default:
      throw new Error(usage());
  }
}

function usage(): string {
  return [
    'usage:',
    '  otzi daemon <path/to/daemon.toml>',
    '  otzi setup <path/to/daemon.toml>',
    '  otzi generate <path/to/daemon.toml> [--threshold N] [--level 44] [--ceremony-id <id>]',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi daemon`
// ─────────────────────────────────────────────────────────────────────────

async function runDaemonCommand(args: string[]): Promise<void> {
  const configPath = args[0];
  if (!configPath) throw new Error(usage());

  const state = await loadAndValidate(configPath);
  const bundle = await buildTransportFromFiles(state);
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

  const parties = config.peers.length + 1;
  const threshold = flags.has('threshold')
    ? Number(flags.get('threshold'))
    : Math.ceil((parties * 2) / 3);
  const level = flags.has('level') ? Number(flags.get('level')) : 44;
  const ceremonyId = flags.get('ceremony-id') ?? `dkg-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  if (!Number.isInteger(threshold) || threshold < 1 || threshold > parties)
    throw new Error(`otzi generate: --threshold must be an integer in [1, ${parties}]`);

  console.error(
    `otzi generate: triggering combined DKG (parties=${parties}, threshold=${threshold}, level=${level}, ceremonyId=${ceremonyId}) → POST ${url}`,
  );

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ op: 'dkg-combined', ceremonyId, threshold, parties, level }),
  });
  const bodyText = await res.text();
  if (res.status !== 200)
    throw new Error(`otzi generate: HTTP ${res.status}: ${bodyText}`);

  const result = JSON.parse(bodyText) as {
    ceremonyId: string;
    status: string;
    mldsaPublicKeyHex: string;
    frostVerifyingKeyHex: string;
  };

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`  otzi generate: DKG complete (status=${result.status})`);
  console.error(`  ceremonyId:        ${result.ceremonyId}`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
