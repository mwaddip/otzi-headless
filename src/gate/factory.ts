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
    default: {
      const _exhaustive: never = config.strategy;
      throw new Error(`unreachable: unknown gate strategy ${_exhaustive as string}`);
    }
  }
}
