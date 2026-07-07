/**
 * Provider-neutral object metadata. Every adapter maps its native shape
 * (Drive modifiedTime, MEGA timestamp, S3 ETag, Dropbox rev) into this.
 * The scanner, planner, dedup, and verification layers operate ONLY on CloudObject.
 */
export interface CloudObject {
  /** Provider-native identifier (Drive file id, MEGA node handle, S3 key...). */
  id: string;
  /** Path relative to the browsed/scanned root, using '/' separators. */
  path: string;
  name: string;
  isFolder: boolean;
  /** Bytes. 0 for folders. */
  size: number;
  checksum?: { algorithm: 'sha256' | 'md5' | 'crc32c'; value: string };
  modified?: Date;
  created?: Date;
  mime?: string;
  /** Provider-native metadata escape hatch. Never read by the engine. */
  raw?: Record<string, unknown>;
}
