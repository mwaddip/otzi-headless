/**
 * `otzi generate` — run the run-once DKG through the local daemon
 * (facts/daemon.md, `generate.ts`).
 */

import type { NetworkName } from '../../config/types';
import { DaemonClient } from '../daemon-client';
import type { CliDeps } from './btc';

export async function generate(
  opts: { configPath: string; ceremonyId?: string },
  deps: CliDeps = {},
): Promise<{ ceremonyId: string; address: string; network: NetworkName }> {
  const client = deps.client ?? (await DaemonClient.fromConfig(opts.configPath));
  const reply = await client.request<{ ceremonyId?: unknown; address?: unknown; network?: unknown }>({
    op: 'dkg',
    ...(opts.ceremonyId !== undefined ? { ceremonyId: opts.ceremonyId } : {}),
  });
  if (typeof reply?.ceremonyId !== 'string' || typeof reply.address !== 'string' || typeof reply.network !== 'string') {
    throw new Error("daemon reply to 'dkg' has no vault (ceremonyId, address, network)");
  }
  return { ceremonyId: reply.ceremonyId, address: reply.address, network: reply.network as NetworkName };
}
