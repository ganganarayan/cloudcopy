/**
 * Provider conformance suite — one reusable spec every adapter must pass:
 * authenticate → browse → upload → resume → rename → delete → verify → quota → health.
 *
 * Implemented in Phase 3 alongside the first real adapters. Runs against fakes
 * in CI; runnable against real accounts as a canary (CONFORMANCE_LIVE=1).
 */
export interface ConformanceTarget {
  /** Factory producing an authenticated provider instance for the suite. */
  create(): Promise<import('../Provider.js').CloudProvider>;
  /** Folder the suite may create/delete freely. */
  sandboxFolderId: string | null;
}

export function conformanceSuiteName(providerId: string): string {
  return `provider-conformance:${providerId}`;
}
