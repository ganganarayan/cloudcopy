import { ProviderError, type ProviderErrorCode } from '@cloudcopy/provider-sdk';

/** Map an HTTP status to our canonical provider error taxonomy. */
export function classifyHttpStatus(status: number, retryAfterMs?: number): ProviderErrorCode {
  if (status === 401) return 'auth_expired';
  if (status === 403) return 'quota_exceeded'; // Drive returns 403 for rate/quota; refined by body reason
  if (status === 404 || status === 410) return 'session_expired';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

export async function driveError(res: Response, context: string): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const retryAfter = res.headers.get('retry-after');
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
  let code = classifyHttpStatus(res.status, retryAfterMs);
  // Refine 403: distinguish hard quota (daily cap) from transient rate limiting.
  if (res.status === 403) {
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(body)) code = 'rate_limited';
    else if (/quotaExceeded|storageQuotaExceeded|dailyLimitExceeded/i.test(body)) code = 'quota_exceeded';
    else code = 'auth_invalid';
  }
  return new ProviderError(code, `Drive ${context} failed: ${res.status} ${body.slice(0, 300)}`, {
    retryAfterMs,
  });
}

/** Parse a Drive resumable `Range: bytes=0-N` header into the next committed offset (N+1). */
export function parseCommittedOffset(rangeHeader: string | null): number {
  if (!rangeHeader) return 0;
  const m = /bytes=0-(\d+)/.exec(rangeHeader);
  if (!m) return 0;
  return Number(m[1]) + 1;
}
