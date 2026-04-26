/**
 * Console-style `Logger` that writes one line per call to **stderr**, with the
 * `extra` field rendered as compact JSON. Designed for the daemon entrypoint:
 * systemd captures stderr into journald, which is where the fail2ban
 * `otzi.conf` filter looks for `peer-allowlist: dropped connection from
 * non-peer source` warnings (see `examples/fail2ban/otzi.conf`).
 *
 * Format (single line):
 *
 *   <LEVEL> <msg>                                        — when no extra
 *   <LEVEL> <msg> {"key":"value",...}                    — when extra is set
 *
 * The JSON-extras tail matches the regex shipped in `examples/fail2ban/otzi.conf`:
 *
 *   ^.*peer-allowlist: dropped connection from non-peer source\s*[\{].*?ip["']?\s*[:=]\s*["']?<HOST>["']?.*$
 *
 * Stdout is reserved for CLI output (`otzi list`, `otzi sign` → tx id, ...).
 * Daemon-mode logging MUST go to stderr so it doesn't pollute machine-readable
 * stdout of operator subcommands.
 *
 * `console.error` is synchronous on Node, so log lines flush even on crash.
 * No file handles, no async resources — nothing to clean up on `Daemon.stop()`.
 */

import type { Logger } from '../orchestrator/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface ConsoleLoggerOpts {
  /**
   * Minimum level to emit. Lower-ranked calls are dropped. Defaults to `'info'`
   * — `debug` is silenced by default to keep journald readable.
   */
  minLevel?: LogLevel;
  /**
   * Sink for the rendered line. Defaults to `process.stderr.write`. Tests
   * inject a capturing function.
   */
  write?: (line: string) => void;
}

export function createConsoleLogger(opts: ConsoleLoggerOpts = {}): Logger {
  const minRank = LEVEL_RANK[opts.minLevel ?? 'info'];
  const write = opts.write ?? ((line: string) => {
    process.stderr.write(line);
  });

  function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < minRank) return;
    const tail = extra && Object.keys(extra).length > 0 ? ` ${stringifyExtra(extra)}` : '';
    write(`${level.toUpperCase()} ${msg}${tail}\n`);
  }

  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}

/**
 * Render `extra` as compact JSON. `JSON.stringify` already strips functions,
 * undefined fields, and symbols. BigInt is the only common value JSON refuses
 * to serialize — coerce it to its decimal-string form so log emission never
 * throws on a value that bubbled up from a wire decode.
 */
function stringifyExtra(extra: Record<string, unknown>): string {
  return JSON.stringify(extra, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
