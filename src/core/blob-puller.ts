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
 * unrecoverable error (transport throw, attempts exhausted) or when the
 * wall-clock deadline fires.
 */
export class BlobPuller {
  constructor(
    private readonly transport: Transport,
    private readonly store: BlobStore,
  ) {}

  async pullAll(expected: readonly BlobKey[], opts: PullOpts): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.deadlineMs);
    try {
      await Promise.all(expected.map(key => this.pullOne(key, opts, ac.signal)));
    } finally {
      clearTimeout(timer);
    }
  }

  private async pullOne(key: BlobKey, opts: PullOpts, signal: AbortSignal): Promise<void> {
    const keyStr = blobKeyToString(key);
    const onDeadline = abortedPromise(signal, keyStr);
    let delay = opts.initialDelayMs;

    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      if (this.store.has(key)) return;

      const blob = await Promise.race([this.transport.pull(key), onDeadline]);
      if (blob) {
        if (!this.store.has(key)) this.store.put(key, blob);
        return;
      }

      if (attempt < opts.maxAttempts - 1) {
        await Promise.race([sleep(delay), onDeadline]);
        delay = Math.min(delay * 2, opts.maxDelayMs);
      }
    }

    if (this.store.has(key)) return;
    throw new Error(`Failed to fetch ${keyStr} after ${opts.maxAttempts} attempts`);
  }
}

function abortedPromise(signal: AbortSignal, keyStr: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(`Deadline exceeded while pulling ${keyStr}`));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
