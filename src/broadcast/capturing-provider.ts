import { JSONRpcProvider } from 'opnet';
import type { NetworkName } from '../node/types.js';
import { getNetwork, RPC_URLS } from '../node/opnet-client.js';

/**
 * Composition-style replacement for the sendRawTransaction(Package) monkey-
 * patches in opnet-capture.ts. Subclasses `JSONRpcProvider` rather than
 * wrapping it via Proxy because the SDK's `AbstractRpcProvider.call()` emits
 * `new CallResult(result, this)` — the CallResult retains a reference to
 * the actual provider instance, so a Proxy wrapper does not intercept the
 * later `this.#provider.sendRawTransaction(Package)` call. Subclassing puts
 * our overrides on the instance the SDK ends up holding.
 *
 * Usage:
 *   const wrapped = new CapturingProvider(networkName);
 *   const contract = getContract(addr, abi, wrapped as never, ..., vaultAddr);
 *   try { await callResult.sendTransaction(...); }
 *   catch (e) { if (!isCaptureOnlyError(e)) throw e; }
 *   const txs = wrapped.capturedTxs;
 *
 * One instance per capture run; instances do NOT share state. The upstream
 * provider class is never mutated; only this subclass overrides the two
 * broadcast methods.
 */
export class CapturingProvider extends JSONRpcProvider {
  private readonly captured: string[] = [];

  constructor(networkName: NetworkName) {
    super({ url: RPC_URLS[networkName], network: getNetwork(networkName) });
  }

  override async sendRawTransaction(tx: string, _psbt: boolean): Promise<never> {
    this.captured.push(tx);
    throw new Error('__capture_only__');
  }

  override async sendRawTransactionPackage(txs: string[], _isPackage?: boolean): Promise<never> {
    this.captured.push(...txs);
    throw new Error('__capture_only__');
  }

  /**
   * Tx hex captured via `sendRawTransaction` / `sendRawTransactionPackage`,
   * in call-order. Read after the SDK call settles.
   */
  get capturedTxs(): readonly string[] {
    return this.captured;
  }
}

/** Sentinel-error matcher for callers wrapping the capture in a try/catch. */
export function isCaptureOnlyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('__capture_only__');
}
