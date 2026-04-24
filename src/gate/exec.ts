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
 * Bound by `timeout_sec`.
 *
 * TOML shape (under `[gate]`):
 *   strategy = "exec"
 *   [gate.params]
 *   command = ["/etc/otzi/approve.sh"]   # argv; command[0] is the executable
 *   timeout_sec = 86400                  # hard cap on child lifetime
 *   working_dir = "/var/otzi"            # optional cwd
 *   env = { FOO = "bar" }                # optional env merged into process.env
 */

import { spawn } from 'node:child_process';
import { ConfigError } from '../config/parse';
import type { ApprovalGate, CeremonySpec, Decision } from './types';

export interface ExecGateConfig {
  /** argv — first element is the executable, remainder are args. */
  command: readonly string[];
  /** Hard cap on child-process lifetime, in seconds. */
  timeoutSec: number;
  workingDir?: string;
  env?: Record<string, string>;
}

export class ExecGate implements ApprovalGate {
  constructor(private readonly config: ExecGateConfig) {}

  async approve(spec: CeremonySpec): Promise<Decision> {
    const { command, timeoutSec, workingDir, env } = this.config;
    return new Promise<Decision>((resolve, reject) => {
      const [executable, ...args] = command;
      if (!executable) {
        reject(new Error('ExecGate: command is empty'));
        return;
      }
      const child = spawn(executable, args, {
        cwd: workingDir,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`ExecGate: command '${executable}' timed out after ${timeoutSec}s`));
      }, timeoutSec * 1000);

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`ExecGate: failed to spawn '${executable}': ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(
            `ExecGate: '${executable}' exited with code ${code}${stderr ? `; stderr: ${stderr.slice(0, 500)}` : ''}`,
          ));
          return;
        }
        const line = stdout.trim().split('\n')[0]?.trim().toLowerCase();
        if (line === 'approve') resolve('approve');
        else if (line === 'reject') resolve('reject');
        else reject(new Error(
          `ExecGate: unexpected output '${stdout.slice(0, 200)}' — expected first line to be 'approve' or 'reject'`,
        ));
      });

      const body = serializeSpec(spec);
      child.stdin?.end(body + '\n');
    });
  }
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

  if (typeof params.timeout_sec !== 'number' || !Number.isFinite(params.timeout_sec) || params.timeout_sec <= 0)
    throw new ConfigError('gate.timeout_sec', 'must be a positive number (seconds)');
  const timeoutSec = params.timeout_sec;

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
