/**
 * Composition-style wrapper around an OPNet provider that intercepts
 * `sendRawTransaction` and `sendRawTransactionPackage` to record the
 * finalized template tx hex and abort broadcast (via the `__capture_only__`
 * sentinel) — replacement for the monkey-patches that previously mutated
 * the upstream provider object directly.
 *
 * Usage:
 *   const wrapped = new CapturingProvider(realProvider);
 *   const contract = getContract(addr, abi, wrapped.proxy as never, ...);
 *   try { await callResult.sendTransaction(...); }
 *   catch (e) { if (!isCaptureOnlyError(e)) throw e; }
 *   const txs = wrapped.capturedTxs;
 *
 * The wrapper is per-capture; instances do NOT share state. The inner
 * provider is never mutated; the caller can hold the same provider across
 * multiple captures (each one creates its own `CapturingProvider`).
 */
export class CapturingProvider {
  private readonly captured: string[] = [];
  readonly proxy: object;

  constructor(inner: object) {
    this.proxy = new Proxy(inner, {
      get: (target, prop, receiver) => {
        if (prop === 'sendRawTransaction') {
          return async (tx: string, _psbt: boolean): Promise<never> => {
            this.captured.push(tx);
            throw new Error('__capture_only__');
          };
        }
        if (prop === 'sendRawTransactionPackage') {
          return async (txs: string[], _isPackage?: boolean): Promise<never> => {
            this.captured.push(...txs);
            throw new Error('__capture_only__');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    });
  }

  /**
   * Tx hex captured via `sendRawTransaction` / `sendRawTransactionPackage`,
   * in call-order. Read after the SDK call settles. Persists for the
   * wrapper's lifetime — instantiate a fresh wrapper per capture.
   */
  get capturedTxs(): readonly string[] {
    return this.captured;
  }
}

/** Sentinel-error matcher for callers wrapping the capture in a try/catch. */
export function isCaptureOnlyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('__capture_only__');
}
