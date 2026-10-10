import type { Transport } from './transport';
import type { BlobStore } from './blob-store';
import type { BlobKey } from './types';
import { blobKeyToString } from './types';

export interface PullOpts {
  /** Maximum pull attempts per key before giving up. */
  maxAttempts: number;
  /** Initial backoff after a null-return, in ms. Doubled each retry up to maxDelayMs. */
  initialDelayMs: number;
  /** Cap on backoff delay between retries, in ms. */
  maxDelayMs: number;
  /** Wall-clock deadline for the entire pullAll invocation, in ms from call start. */
  deadlineMs: number;
}

/**
 * Fetches expected blobs from their producers into the BlobStore.
 *
 * Per-key worker: transport.pull → null means not-yet-produced (retry with
 * exponential backoff); non-null stores the blob. A worker short-circuits if
 * its key lands in the store by another path (e.g. local production, parallel
 * puller, push delivery).
 *
 * Resolves when every expected key is in the store. Rejects on the first
 * unrecoverable error (transport throw, attempts exhausted), when the
 * wall-clock deadline fires, or with `Error('aborted')` when `signal` aborts.
 * Once the call settles, every worker stops.
 */
export class BlobPuller {
  constructor(
    private readonly transport: Transport,
    private readonly store: BlobStore,
  ) {}

  async pullAll(expected: readonly BlobKey[], opts: PullOpts, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    // One stop signal for every worker: the deadline, the caller's signal, or
    // the call settling (so no worker outlives it).
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(DEADLINE), opts.deadlineMs);
    const onAbort = () => stop.abort(ABORTED);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.all(expected.map(key => this.pullOne(key, opts, stop.signal)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stop.abort(SETTLED);
    }
  }

  private async pullOne(key: BlobKey, opts: PullOpts, stop: AbortSignal): Promise<void> {
    const keyStr = blobKeyToString(key);
    const onStop = stoppedPromise(stop, keyStr);
    let delay = opts.initialDelayMs;

    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      if (this.store.has(key)) return;

      const blob = await Promise.race([this.transport.pull(key), onStop]);
      if (blob) {
        if (!this.store.has(key)) this.store.put(key, blob);
        return;
      }

      if (attempt < opts.maxAttempts - 1) {
        await Promise.race([sleep(delay), onStop]);
        delay = Math.min(delay * 2, opts.maxDelayMs);
      }
    }

    if (this.store.has(key)) return;
    throw new Error(`Failed to fetch ${keyStr} after ${opts.maxAttempts} attempts`);
  }
}

const DEADLINE = 'deadline';
const ABORTED = 'aborted';
const SETTLED = 'settled';

/** Rejects when `stop` aborts: `aborted` for the caller's signal, the deadline error otherwise. */
function stoppedPromise(stop: AbortSignal, keyStr: string): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(
        stop.reason === ABORTED
          ? new Error('aborted')
          : new Error(`Deadline exceeded while pulling ${keyStr}`),
      );
    if (stop.aborted) fail();
    else stop.addEventListener('abort', fail, { once: true });
  });
  // A worker that returns early never awaits this; its later rejection is expected.
  p.catch(() => {});
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
