/**
 * The `timeout_sec` shared by the `exec` and `webhook` gates.
 *
 * Each gate arms one `setTimeout` of `timeout_sec * 1000` ms, and Node fires a delay
 * above 2147483647 ms (`MAX_DEADLINE_MS`) almost at once. A larger value is refused at
 * startup, the same way `[deadlines]` is (src/config/parse.ts).
 */

import { ConfigError } from '../config/parse';
import { MAX_DEADLINE_MS } from '../config/types';

/** The largest `timeout_sec`: 2147483.647 s, about 24.8 days. */
export const MAX_GATE_TIMEOUT_SEC = MAX_DEADLINE_MS / 1000;

export function parseGateTimeoutSec(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new ConfigError('gate.timeout_sec', 'must be a positive number (seconds)');
  if (value > MAX_GATE_TIMEOUT_SEC)
    throw new ConfigError(
      'gate.timeout_sec',
      `must be <= ${MAX_GATE_TIMEOUT_SEC} (the longest Node.js timer, ${MAX_DEADLINE_MS} ms; got ${value})`,
    );
  return value;
}
