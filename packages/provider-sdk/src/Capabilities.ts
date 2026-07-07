/**
 * Versioned capability declaration. The chunk scheduler and planner negotiate
 * strategy from capabilities — provider names never appear in engine code.
 */
export interface ProviderCapabilities {
  /** Capability schema version; bump when adding fields so stored plans stay explainable. */
  version: 1;
  checksum: { algorithms: Array<'sha256' | 'md5' | 'crc32c'> };
  /** Destination supports multipart (parallel part) uploads. */
  multipart: boolean;
  /** Destination upload sessions can resume after disconnect/restart. */
  resume: boolean;
  /** Destination accepts chunks of one file in parallel (false → ordered sequential writer). */
  parallelUpload: boolean;
  /** Same-provider server-side copy without data egress. */
  serverCopy: boolean;
  /** Provider exposes a change feed (watch()). */
  changeFeed: boolean;
  softDelete: boolean;
  versioning: boolean;
  /** Source supports ranged (offset/length) downloads. */
  rangeDownload: boolean;
  /** Chunk size bounds in bytes. Scheduler clamps negotiated chunk size into both sides' bounds. */
  minChunkSize: number;
  maxChunkSize: number;
  /** Upload chunk sizes must be a multiple of this (e.g. Drive: 262144). 1 = unconstrained. */
  chunkSizeMultipleOf: number;
}
