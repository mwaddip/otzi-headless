/**
 * `createGate(config)` — constructs the `ApprovalGate` for a strategy named in
 * daemon TOML. Ships `auto` + `policy` (deterministic) + `exec` + `webhook`
 * (operator-in-the-loop). `cli` / `queue` remain spec'd but not implemented.
 */

import type { GateConfig } from '../config/types';
import { ExecGate, parseExecParams } from './exec';
import { parsePolicyParams, PolicyGate } from './policy';
import type { ApprovalGate, CeremonySpec, Decision } from './types';
import { parseWebhookParams, WebhookGate } from './webhook';

export class AutoGate implements ApprovalGate {
  async approve(_spec: CeremonySpec): Promise<Decision> {
    return 'approve';
  }
}

export function createGate(config: GateConfig): ApprovalGate {
  switch (config.strategy) {
    case 'auto':
      return new AutoGate();
    case 'policy':
      return new PolicyGate(parsePolicyParams(config.params ?? {}));
    case 'exec':
      return new ExecGate(parseExecParams(config.params ?? {}));
    case 'webhook':
      return new WebhookGate(parseWebhookParams(config.params ?? {}));
    case 'cli':
    case 'queue':
      throw new Error(
        `gate.strategy='${config.strategy}' is spec'd but not implemented yet — ships 'auto' / 'policy' / 'exec' / 'webhook'`,
      );
    default: {
      const _exhaustive: never = config.strategy;
      throw new Error(`unreachable: unknown gate strategy ${_exhaustive as string}`);
    }
  }
}
