/**
 * CLI entrypoint — dispatches to subcommands (docs/cli.md):
 *
 *   otzi daemon <config.toml>                   — run the daemon
 *   otzi setup <config.toml>                    — run bootstrap (reads [bootstrap].role from config)
 *   otzi generate [--config <path>] [...]       — run the DKG through the local daemon
 *   otzi vault [--json] [--config <path>]       — print vault metadata, checked against the daemon
 *   otzi btc balance [--unit ...]               — vault balance from Esplora
 *   otzi btc send <addr|label> <amount>[unit]|max — build, sign and broadcast a vault transfer
 *   otzi btc sign <proposal.json> [--broadcast] — sign a caller-built proposal
 *   otzi book list|add|remove|import|export     — manage this node's address book
 *   otzi backup                                 — write password-protected archive of daemon state
 *   otzi restore <path> [--password-stdin]      — recover daemon state from an archive
 *
 * The `daemon` subcommand loads config + share + identity + pubkey book and
 * starts the transport + Daemon. SIGINT/SIGTERM trigger graceful shutdown.
 * If the configured share file is missing, the daemon comes up in setup
 * mode (signing rejected; DKG works) — the operator runs `otzi generate` on
 * one node, then restarts every daemon to load its new share.
 *
 * Every other verb is short-lived: it talks to the local daemon over a Unix
 * domain socket (typically /var/run/otzi/otzi.sock), reads the chain through
 * Esplora, or works on local files. Machine output goes to stdout; banners and
 * errors go to stderr. The default config path /etc/otzi/daemon.toml matches
 * the .deb install layout.
 */

import { BroadcastFailedError } from '../cli/cmd/btc';
import type { BtcUnit } from '../cli/units';
import { loadDaemonConfig } from '../config/load';
import { loadAndValidate } from './config-merge';
import { createConsoleLogger } from './console-logger';
import { Daemon } from './daemon';
import { setupMaster, setupMember } from './setup';
import { buildTransportFromFiles } from './transport-factory';
import { displayText } from '../util/text';

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
    case 'vault':
      await runVaultCommand(rest);
      return;
    case 'btc':
      await runBtcCommand(rest);
      return;
    case 'book':
      await runBookCommand(rest);
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
    '  otzi generate [--config <path>] [--ceremony-id <id>]',
    '  otzi vault [--json] [--config <path>]',
    '  otzi btc balance [--unit sats|btc|mbtc|ubtc] [--config <path>]',
    '  otzi btc send <address|label> <amount>[unit]|max [--fee-rate <sat/vB>] [--config <path>]',
    '  otzi btc sign <proposal.json> [--broadcast] [--config <path>]',
    '  otzi book list [--config <path>]',
    '  otzi book add <label> <address> [--note <text>] [--config <path>]',
    '  otzi book remove <label|address> [--config <path>]',
    '  otzi book import <file> [--replace] [--config <path>]',
    '  otzi book export [path] [--config <path>]',
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
  // logger to config loading (stale `.pending` share warning, vault-pubkey.json
  // rewrite failures), the transport (peer-mesh allowlist warns picked up by
  // fail2ban via journald) and the Daemon (orchestrator/leader/triggers).
  // stderr only — stdout is reserved for CLI machine output. CLI subcommands
  // (vault/btc/...) deliberately keep `NOOP_LOGGER` and MUST stay that way:
  // their stdout is consumed by shell scripts, so any log line on stdout would
  // corrupt the downstream parser.
  const logger = createConsoleLogger();

  const state = await loadAndValidate(configPath, { logger });
  const bundle = await buildTransportFromFiles(state, { logger });
  await bundle.start();

  const daemon = new Daemon({
    state,
    transport: bundle.transport,
    selfPartyId: bundle.selfPartyId,
    peersById: bundle.peersById,
    rng: {
      fillBytes(dest) {
        crypto.getRandomValues(dest);
      },
    },
    // Backoff only: orchestrator and leader pull until the ceremony deadline
    // (`[deadlines]`), replacing `deadlineMs` and `maxAttempts`.
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

  const mode = state.share ? 'signing (vault loaded)' : 'setup (no vault)';
  console.error(
    `otzi daemon started — nodeId=${state.config.node.id} partyId=${bundle.selfPartyId} ringId=${bundle.ringId.slice(0, 16)}... network=${state.config.network.name} mode=${mode}`,
  );
  if (!state.share) {
    console.error(
      'otzi daemon: no vault loaded — signing requests are rejected until the DKG runs and every daemon restarts.',
    );
    console.error('  1. With every daemon in the ring running, on one node: otzi generate');
    console.error(`  2. Restart every daemon so it loads its new share from ${state.config.share.path}.`);
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
// Arguments and errors
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a verb's arguments: positionals and `--flag`s in any order.
 * `spec.values` flags take the next argument; `spec.booleans` flags take none.
 * Any other `--flag` is an error, so a typo never silently falls back to a default.
 */
export function parseVerbArgs(
  args: readonly string[],
  spec: { values?: readonly string[]; booleans?: readonly string[] },
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (spec.booleans?.includes(key)) {
      flags.set(key, '');
    } else if (spec.values?.includes(key)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`flag '--${key}' needs a value`);
      flags.set(key, value);
      i += 1;
    } else {
      throw new Error(`unknown flag '--${key}'`);
    }
  }
  return { positional, flags };
}

/**
 * Print an error the way every verb does: the message on stderr. A broadcast
 * that failed after signing also prints the signed transaction hex, so the
 * operator can post it by other means.
 */
export function reportCliError(err: unknown, write: (line: string) => void = console.error): void {
  write(err instanceof Error ? err.message : String(err));
  if (err instanceof BroadcastFailedError) {
    write(`The transaction is signed (txid ${err.txid}) but was not broadcast. Its hex follows; broadcast it by other means:`);
    write(err.signedTxHex);
  }
}

function noPositional(positional: readonly string[]): void {
  if (positional.length > 0) throw new Error(`unexpected argument '${positional[0]}'\n${usage()}`);
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi generate` — run the DKG through the local daemon
// ─────────────────────────────────────────────────────────────────────────

async function runGenerateCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseVerbArgs(args, { values: ['config', 'ceremony-id'] });
  if (positional.length > 0)
    throw new Error(
      `otzi generate takes no positional argument (got '${positional[0]}'); use --config <path> for a config other than ${DEFAULT_DAEMON_CONFIG_PATH}`,
    );
  const configPath = flags.get('config') ?? DEFAULT_DAEMON_CONFIG_PATH;
  const ceremonyId = flags.get('ceremony-id');

  const config = await loadDaemonConfig(configPath);
  console.error(
    'otzi generate: running the DKG with every node in the ring (the others must be running and hold no vault)',
  );
  const { generate } = await import('../cli/cmd/generate');
  const result = await generate({ configPath, ...(ceremonyId !== undefined ? { ceremonyId } : {}) });

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('  otzi generate: DKG complete');
  console.error(`  ceremonyId: ${result.ceremonyId}`);
  console.error(`  network:    ${result.network}`);
  console.error(`  address:    ${result.address} (fund this address)`);
  console.error(`  share file: ${config.share.path} (every node wrote its own share)`);
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('Restart every daemon to load its share before signing.');
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi vault [--json] [--config <path>]`
// ─────────────────────────────────────────────────────────────────────────

async function runVaultCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseVerbArgs(args, { values: ['config'], booleans: ['json'] });
  noPositional(positional);
  const { vault } = await import('../cli/cmd/vault');
  console.log(await vault({ configPath: flags.get('config') ?? DEFAULT_DAEMON_CONFIG_PATH, json: flags.has('json') }));
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi btc {balance|send|sign} ...`
// ─────────────────────────────────────────────────────────────────────────

const BTC_UNITS: readonly BtcUnit[] = ['sats', 'btc', 'mbtc', 'ubtc'];

/** The number behind `--fee-rate`; `btcSend` enforces the range. */
function parseFeeRate(raw: string): number {
  const rate = Number(raw);
  if (raw.trim() === '' || Number.isNaN(rate)) throw new Error(`--fee-rate must be a number of sat/vB (got '${raw}')`);
  return rate;
}

async function runBtcCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'balance') {
    const { positional, flags } = parseVerbArgs(rest, { values: ['unit', 'config'] });
    noPositional(positional);
    const unit = flags.get('unit');
    if (unit !== undefined && !(BTC_UNITS as readonly string[]).includes(unit))
      throw new Error(`--unit must be one of ${BTC_UNITS.join(', ')} (got '${unit}')`);
    const { btcBalance } = await import('../cli/cmd/btc');
    console.log(
      await btcBalance({
        configPath: flags.get('config') ?? DEFAULT_DAEMON_CONFIG_PATH,
        ...(unit !== undefined ? { unit: unit as BtcUnit } : {}),
      }),
    );
    return;
  }
  if (sub === 'send') {
    const { positional, flags } = parseVerbArgs(rest, { values: ['fee-rate', 'config'] });
    if (positional.length !== 2) throw new Error('usage: otzi btc send <address|label> <amount>[unit]|max [--fee-rate <sat/vB>]');
    const [to, amount] = positional as [string, string];
    const feeRate = flags.get('fee-rate');
    const { btcSend } = await import('../cli/cmd/btc');
    const result = await btcSend({
      configPath: flags.get('config') ?? DEFAULT_DAEMON_CONFIG_PATH,
      to,
      amount,
      ...(feeRate !== undefined ? { feeRate: parseFeeRate(feeRate) } : {}),
    });
    console.log(result.txid);
    console.log(result.explorerUrl);
    return;
  }
  if (sub === 'sign') {
    const { positional, flags } = parseVerbArgs(rest, { values: ['config'], booleans: ['broadcast'] });
    if (positional.length !== 1) throw new Error('usage: otzi btc sign <proposal.json> [--broadcast]');
    const { btcSign } = await import('../cli/cmd/btc');
    const result = await btcSign({
      configPath: flags.get('config') ?? DEFAULT_DAEMON_CONFIG_PATH,
      proposalPath: positional[0]!,
      broadcast: flags.has('broadcast'),
    });
    // The summary was already written to stderr, before the daemon was asked to sign.
    if (result.explorerUrl === undefined) console.error('not broadcast; run again with --broadcast to post it');
    console.log(result.txid);
    console.log(result.signedTxHex);
    if (result.explorerUrl !== undefined) console.log(result.explorerUrl);
    return;
  }
  throw new Error(usage());
}

// ─────────────────────────────────────────────────────────────────────────
// `otzi book {list|add|remove|import|export} ...`
// ─────────────────────────────────────────────────────────────────────────

/**
 * `bookPath` is a test seam: the verbs work on `DEFAULT_ADDRESS_BOOK_PATH`
 * (`/etc/otzi/address-book.otzi.json`) and take no flag for another file.
 */
export async function runBookCommand(args: string[], bookPath?: string): Promise<void> {
  const [verb, ...rest] = args;
  const book = (flags: Map<string, string>) => ({
    configPath: flags.get('config') ?? DEFAULT_DAEMON_CONFIG_PATH,
    ...(bookPath !== undefined ? { bookPath } : {}),
  });

  switch (verb) {
    case 'list': {
      const { positional, flags } = parseVerbArgs(rest, { values: ['config'] });
      noPositional(positional);
      const { bookList } = await import('../cli/cmd/book');
      const lines = await bookList(book(flags));
      if (lines === '') console.error('address book is empty');
      else console.log(lines);
      return;
    }
    case 'add': {
      const { positional, flags } = parseVerbArgs(rest, { values: ['config', 'note'] });
      if (positional.length !== 2) throw new Error('usage: otzi book add <label> <address> [--note <text>]');
      const [label, address] = positional as [string, string];
      const note = flags.get('note');
      const { bookAdd } = await import('../cli/cmd/book');
      await bookAdd({ ...book(flags), label, address, ...(note !== undefined ? { note } : {}) });
      console.error(`address book: saved '${label}' ${address.trim()}`);
      return;
    }
    case 'remove': {
      const { positional, flags } = parseVerbArgs(rest, { values: ['config'] });
      if (positional.length !== 1) throw new Error('usage: otzi book remove <label|address>');
      const { bookRemove } = await import('../cli/cmd/book');
      await bookRemove({ ...book(flags), key: positional[0]! });
      console.error(`address book: removed '${positional[0]}'`);
      return;
    }
    case 'import': {
      const { positional, flags } = parseVerbArgs(rest, { values: ['config'], booleans: ['replace'] });
      if (positional.length !== 1) throw new Error('usage: otzi book import <file> [--replace]');
      const { bookImport } = await import('../cli/cmd/book');
      const r = await bookImport({ ...book(flags), file: positional[0]!, replace: flags.has('replace') });
      console.log(`added ${r.added}, updated ${r.updated}, unchanged ${r.unchanged}, removed ${r.removed}`);
      return;
    }
    case 'export': {
      const { positional, flags } = parseVerbArgs(rest, { values: ['config'] });
      if (positional.length > 1) throw new Error('usage: otzi book export [path]');
      const out = positional[0];
      const { bookExport } = await import('../cli/cmd/book');
      const text = await bookExport({ ...book(flags), ...(out !== undefined ? { out } : {}) });
      if (out === undefined) console.log(text);
      else console.error(`address book: wrote ${out}`);
      return;
    }
    default:
      throw new Error(usage());
  }
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
  for (const entry of result.skippedEntries) {
    console.error(`warning: skipped archive entry ${displayText(entry)}: not part of an otzi backup`);
  }
  console.log('Restored files:');
  for (const f of result.restoredFiles) {
    const mode = `mode 0${f.mode.toString(8).padStart(3, '0')}`;
    console.log(`  ${f.path} (${mode}${f.owner ? ', owner otzi:otzi' : ''})`);
  }
  console.log('Next steps:');
  console.log('  1. Create /etc/otzi/otzi.env with the share password (the archive does not contain it):');
  console.log('       sudo install -m 600 -o root -g root /dev/null /etc/otzi/otzi.env');
  console.log("       sudoedit /etc/otzi/otzi.env   # OTZI_SHARE_PASSWORD=<this node's share password>");
  console.log('  2. sudo systemctl start otzi');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((err) => {
    reportCliError(err);
    process.exit(1);
  });
}
