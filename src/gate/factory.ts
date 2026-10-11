import { ConfigError } from '../config/parse';
import type { GateConfig } from '../config/types';
import type { Logger } from '../orchestrator/types';
import { ExecGate, parseExecParams } from './exec';
import { parsePolicyParams, PolicyGate } from './policy';
import type { ApprovalGate, CeremonySpec, Decision } from './types';
import { parseWebhookParams, WebhookGate } from './webhook';

export class AutoGate implements ApprovalGate {
  async approve(_spec: CeremonySpec): Promise<Decision> {
    return 'approve';
  }
}

/**
 * `deps.loadAddressBook` returns this node's address book addresses for
 * `allowed_recipients = "address-book"` (rejecting when there is no usable
 * book); `deps.logger` receives the policy gate's warnings; `deps.secretEnv`
 * names variables an `exec` command must not inherit (the share password's and
 * the HTTP trigger tokens').
 */
export function createGate(
  config: GateConfig,
  deps: { loadAddressBook?: () => Promise<string[]>; logger?: Logger; secretEnv?: readonly string[] } = {},
): ApprovalGate {
  switch (config.strategy) {
    case 'auto': {
      const [key] = Object.keys(config.params ?? {});
      // A leftover rule under "auto" would read as enforced while nothing checks it.
      if (key !== undefined) throw new ConfigError(`gate.${key}`, 'not used by strategy auto');
      return new AutoGate();
    }
    case 'policy':
      return new PolicyGate(parsePolicyParams(config.params ?? {}), {
        loadAddressBook: deps.loadAddressBook,
        logger: deps.logger,
      });
    case 'exec':
      return new ExecGate({ ...parseExecParams(config.params ?? {}), omitEnv: deps.secretEnv });
    case 'webhook':
      return new WebhookGate(parseWebhookParams(config.params ?? {}));
    default: {
      const _exhaustive: never = config.strategy;
      throw new Error(`unreachable: unknown gate strategy ${_exhaustive as string}`);
    }
  }
}
