/**
 * `ExecGate` — operator-in-the-loop strategy backed by a spawned process.
 *
 * Daemon serializes the `CeremonySpec` as JSON (bigint → decimal string) and
 * writes it on the command's stdin. The command is expected to return a single
 * line on stdout — `approve` or `reject` — and exit 0. Anything else (non-zero
 * exit, unexpected output) is treated as a thrown error by the gate; the
 * orchestrator converts gate-throw into `reject` at the participant (silent
 * drop) and the leader dispatcher surfaces it as `GateRejection`.
 *
 * The Promise resolves only when the command exits — for human-in-the-loop
 * setups the operator's script is expected to block (inotifywait on a
 * decision file, poll an approval queue, etc.) until the operator responds.
 * Bound by `timeout_sec`: the call fails at once, the command gets SIGTERM,
 * and SIGKILL after a grace period if it is still running.
 *
 * The command never takes the daemon down: a command that exits without
 * reading its stdin (a large spec fills the pipe) only causes a stdin error
 * that is ignored, and its stdout / stderr are read up to 64 KiB each. It does
 * not inherit the secrets the daemon names in `omitEnv`: the share password
 * variable and the HTTP triggers' token variables.
 *
 * TOML shape (under `[gate]`, parameters sit directly next to `strategy`):
 *   strategy = "exec"
 *   command = ["/etc/otzi/approve.sh"]   # argv; command[0] is the executable
 *   timeout_sec = 86400                  # hard cap on child lifetime
 *   working_dir = "/var/otzi"            # optional cwd
 *   env = { FOO = "bar" }                # optional env merged into the inherited one
 */

import { spawn } from 'node:child_process';
import { ConfigError } from '../config/parse';
import { parseGateTimeoutSec } from './timeout';
import type { ApprovalGate, CeremonySpec, Decision } from './types';

export interface ExecGateConfig {
  /** argv — first element is the executable, remainder are args. */
  command: readonly string[];
  /** Hard cap on child-process lifetime, in seconds. */
  timeoutSec: number;
  workingDir?: string;
  env?: Record<string, string>;
  /** Variables removed from the inherited environment (the share password's, the HTTP trigger tokens'); `env` applies after. */
  omitEnv?: readonly string[];
  /** Time between the timeout's SIGTERM and SIGKILL, in ms. Default 5000. */
  killGraceMs?: number;
}

/** stdout and stderr are kept up to this many bytes each; the rest is ignored. */
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

export class ExecGate implements ApprovalGate {
  constructor(private readonly config: ExecGateConfig) {}

  async approve(spec: CeremonySpec): Promise<Decision> {
    const { command, timeoutSec, workingDir, env, omitEnv, killGraceMs = DEFAULT_KILL_GRACE_MS } = this.config;
    return new Promise<Decision>((resolve, reject) => {
      const [executable, ...args] = command;
      if (!executable) {
        reject(new Error('ExecGate: command is empty'));
        return;
      }
      const inherited: NodeJS.ProcessEnv = { ...process.env };
      for (const name of omitEnv ?? []) delete inherited[name];
      const child = spawn(executable, args, {
        cwd: workingDir,
        env: { ...inherited, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        // A command that ignores SIGTERM must not outlive its decision window.
        killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
        reject(new Error(`ExecGate: command '${executable}' timed out after ${timeoutSec}s`));
      }, timeoutSec * 1000);

      const stdout = cappedCollector();
      const stderr = cappedCollector();
      child.stdout?.on('data', stdout.add);
      child.stderr?.on('data', stderr.add);
      // Read errors on the output pipes end in 'close' like everything else.
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      // A command may exit without reading its stdin; writing the rest of a large spec
      // then fails (EPIPE, ERR_STREAM_DESTROYED). The exit status and stdout decide.
      child.stdin?.on('error', () => {});

      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(new Error(`ExecGate: failed to spawn '${executable}': ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        const stdoutText = stdout.text();
        const stderrText = stderr.text();
        if (code !== 0) {
          reject(new Error(
            `ExecGate: '${executable}' exited with code ${code}${stderrText ? `; stderr: ${stderrText.slice(0, 500)}` : ''}`,
          ));
          return;
        }
        const line = stdoutText.trim().split('\n')[0]?.trim().toLowerCase();
        if (line === 'approve') resolve('approve');
        else if (line === 'reject') resolve('reject');
        else reject(new Error(
          `ExecGate: unexpected output '${stdoutText.slice(0, 200)}' — expected first line to be 'approve' or 'reject'`,
        ));
      });

      const body = serializeSpec(spec);
      child.stdin?.end(body + '\n');
    });
  }
}

/** Keeps the first `MAX_OUTPUT_BYTES` of a stream; later chunks are dropped. */
function cappedCollector(): { add: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    add: (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const part = chunk.subarray(0, MAX_OUTPUT_BYTES - size);
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Serialize `CeremonySpec` to JSON, converting bigints to decimal strings. */
export function serializeSpec(spec: CeremonySpec): string {
  return JSON.stringify(spec, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

const KNOWN_KEYS = new Set(['command', 'timeout_sec', 'working_dir', 'env']);

export function parseExecParams(params: Record<string, unknown>): ExecGateConfig {
  for (const key of Object.keys(params)) {
    if (!KNOWN_KEYS.has(key))
      throw new ConfigError(`gate.${key}`, `unknown exec field (expected one of ${[...KNOWN_KEYS].join(', ')})`);
  }

  if (!Array.isArray(params.command) || params.command.length === 0)
    throw new ConfigError('gate.command', 'must be a non-empty array of strings');
  const command: string[] = params.command.map((item, i) => {
    if (typeof item !== 'string')
      throw new ConfigError(`gate.command[${i}]`, 'must be a string');
    return item;
  });

  const timeoutSec = parseGateTimeoutSec(params.timeout_sec);

  const out: ExecGateConfig = { command, timeoutSec };

  if (params.working_dir !== undefined) {
    if (typeof params.working_dir !== 'string')
      throw new ConfigError('gate.working_dir', 'must be a string');
    out.workingDir = params.working_dir;
  }
  if (params.env !== undefined) {
    if (!params.env || typeof params.env !== 'object' || Array.isArray(params.env))
      throw new ConfigError('gate.env', 'must be a table of string→string');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(params.env as Record<string, unknown>)) {
      if (typeof v !== 'string')
        throw new ConfigError(`gate.env.${k}`, 'must be a string');
      env[k] = v;
    }
    out.env = env;
  }

  return out;
}
