/**
 * `createGate(config)` — constructs the `ApprovalGate` for a strategy named in
 * daemon TOML. Phase 5b ships `auto` + `policy`; `webhook` / `cli` / `queue` throw
 * as not-yet-implemented.
 */

import type { GateConfig } from '../config/types';
import { parsePolicyParams, PolicyGate } from './policy';
import type { ApprovalGate, CeremonySpec, Decision } from './types';

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
    case 'webhook':
    case 'cli':
    case 'queue':
      throw new Error(
        `gate.strategy='${config.strategy}' is spec'd but not implemented yet — phase 5b ships 'auto' + 'policy' only`,
      );
    default: {
      const _exhaustive: never = config.strategy;
      throw new Error(`unreachable: unknown gate strategy ${_exhaustive as string}`);
    }
  }
}
