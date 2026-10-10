/**
 * Console-style `Logger` that writes one line per call to **stderr**, with the
 * `extra` field rendered as compact JSON (facts/daemon.md, `console-logger.ts`).
 * Designed for the daemon entrypoint: systemd captures stderr into journald,
 * which is where the fail2ban `otzi.conf` filter looks for `peer-allowlist:
 * dropped connection from non-peer source` warnings (see
 * `examples/fail2ban/otzi.conf`).
 *
 * Format (single line):
 *
 *   <LEVEL> <msg>                                        — when no extra
 *   <LEVEL> <msg> {"key":"value",...}                    — when extra is set
 *
 * One call is always one line. Messages carry peer-controlled text (a
 * `signoff-aborted` reason, for one), so every control character in `msg` and
 * in `extra` is escaped: `\n`, `\r`, `\t`, otherwise `\u00XX` (C0, DEL, C1) and
 * `\u2028` / `\u2029`. A forged line can therefore only sit in the middle of a
 * real one, and the fail2ban filter is anchored to the start of the line:
 *
 *   ^(?:\S+\s+)?(?:\S+\[\d+\]:\s+)?WARN peer-allowlist: dropped connection from non-peer source \{"ip":"<HOST>"
 *
 * (the optional prefix is the `<host> <ident>[<pid>]: ` journald adds).
 *
 * Stdout is reserved for CLI output (`otzi vault`, `otzi btc send|sign`,
 * `otzi book list|export`, ...). Daemon-mode logging MUST go to stderr so it
 * doesn't pollute machine-readable stdout of operator subcommands.
 *
 * `process.stderr.write` is synchronous for files and pipes on Node, so log
 * lines flush even on crash. No file handles, no async resources — nothing to
 * clean up on `Daemon.stop()`.
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
    write(`${level.toUpperCase()} ${escapeControls(String(msg))}${tail}\n`);
  }

  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}

/** C0, DEL, C1 and the Unicode line / paragraph separators. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Every control character as a visible escape, so the text stays on one line. */
export function escapeControls(text: string): string {
  return text.replace(CONTROL, c => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Render `extra` as compact JSON. `JSON.stringify` already strips functions,
 * undefined fields, and symbols, and escapes C0 characters inside strings.
 * BigInt is the only common value JSON refuses to serialize — coerce it to its
 * decimal-string form so log emission never throws on a value that bubbled up
 * from a wire decode. The control characters JSON leaves as they are (DEL, C1,
 * U+2028 / U+2029) can only occur inside JSON strings, where `\uXXXX` is the
 * same character, so they are escaped in the output.
 */
function stringifyExtra(extra: Record<string, unknown>): string {
  return escapeControls(
    JSON.stringify(extra, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
}
