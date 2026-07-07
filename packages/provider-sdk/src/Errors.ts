/**
 * Canonical provider error taxonomy. Adapters translate every native error
 * into one of these so the retry/backoff layer can classify without knowing providers.
 */
export type ProviderErrorCode =
  | 'auth_expired' // refreshable — trigger refresh() then retry
  | 'auth_invalid' // NOT retryable — account needs re-authentication
  | 'rate_limited' // retryable with backoff (respect retryAfterMs)
  | 'quota_exceeded' // long pause (daily caps, transfer quotas)
  | 'not_found'
  | 'conflict'
  | 'session_expired' // upload session gone — open a new one, restart file
  | 'network' // retryable
  | 'server' // provider 5xx — retryable
  | 'not_supported' // capability not implemented by this provider
  | 'unknown';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'auth_expired',
  'rate_limited',
  'quota_exceeded',
  'network',
  'server',
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** Provider-suggested wait (from Retry-After etc.), if any. */
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(code: ProviderErrorCode, message: string, opts?: { retryAfterMs?: number; cause?: unknown }) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryAfterMs = opts?.retryAfterMs;
    this.cause = opts?.cause;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export class NotSupportedError extends ProviderError {
  constructor(operation: string) {
    super('not_supported', `Operation not supported by this provider: ${operation}`);
    this.name = 'NotSupportedError';
  }
}
