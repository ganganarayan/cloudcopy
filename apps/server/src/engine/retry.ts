import { ProviderError } from '@cloudcopy/provider-sdk';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (err: ProviderError, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

function isRetryable(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.retryable;
}

/** Full-jitter exponential backoff, honoring ProviderError.retryAfterMs. */
export function backoffDelay(attempt: number, base: number, max: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, max);
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  // Deterministic-free jitter is fine here; spread requests without needing RNG guarantees.
  return Math.floor(ceiling * (0.5 + Math.random() * 0.5));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Run an operation with exponential backoff. Retries only retryable ProviderErrors
 * (429/5xx/network/quota/auth_expired); everything else throws immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxAttempts) throw err;
      const delay = backoffDelay(attempt, base, max, err.retryAfterMs);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
}
