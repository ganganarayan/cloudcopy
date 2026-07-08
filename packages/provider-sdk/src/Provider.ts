import type { Readable } from 'node:stream';
import type { CloudObject } from './CloudObject.js';
import type { ProviderCapabilities } from './Capabilities.js';
import type { AuthState, ProviderCredentials } from './Auth.js';

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface UploadMeta {
  name: string;
  parentId: string;
  size: number;
  mime?: string;
}

export interface UploadSession {
  /** Opaque provider session handle (Drive: resumable session URI). Persisted in upload_sessions. */
  sessionUri: string;
  /** Epoch ms when the session expires, if the provider documents it. */
  expiresAt?: number;
}

export type ChunkResult =
  | { done: false; committedOffset: number }
  | { done: true; file: CloudObject };

export interface UploadProbe {
  status: 'open' | 'completed' | 'expired';
  /** Bytes durably committed by the provider (valid when status==='open'). */
  committedOffset: number;
  file?: CloudObject;
}

export interface QuotaInfo {
  totalBytes: number | null;
  usedBytes: number | null;
}

export interface HealthReport {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface ChangeEvent {
  type: 'created' | 'updated' | 'deleted';
  object: CloudObject;
}

/**
 * The provider contract. Adapters translate provider APIs into this interface
 * and NOTHING above this layer knows provider names. All errors thrown must
 * be ProviderError instances.
 */
export interface CloudProvider {
  readonly id: string; // 'mega' | 'gdrive' | ...
  readonly capabilities: ProviderCapabilities;

  /** Exchange initial credentials for a persistable AuthState. */
  authenticate(creds: ProviderCredentials): Promise<AuthState>;
  /** Refresh a previously stored AuthState (OAuth refresh, session renewal). */
  refresh(state: AuthState): Promise<AuthState>;

  listFolders(parentId: string | null): Promise<CloudObject[]>;
  listFiles(parentId: string | null): Promise<CloudObject[]>;
  /**
   * Find folders anywhere in the account by name substring. Lets the UI reach
   * folders that aren't under the browsable root (e.g. Google Drive "Computers").
   */
  searchFolders?(query: string): Promise<CloudObject[]>;
  getMetadata(id: string): Promise<CloudObject>;

  /** Ranged decrypted/plain download stream. Range required when capabilities.rangeDownload. */
  downloadStream(id: string, range?: ByteRange): Promise<Readable>;

  createUpload(meta: UploadMeta): Promise<UploadSession>;
  /** Upload one chunk. Sequential offsets unless capabilities.parallelUpload. */
  uploadChunk(session: UploadSession, buf: Buffer, offset: number, totalSize: number): Promise<ChunkResult>;
  /** Probe/complete a session (restart recovery: "how much did you get?"). */
  probeUpload(session: UploadSession, totalSize: number): Promise<UploadProbe>;
  completeUpload(session: UploadSession): Promise<CloudObject>;
  abortUpload(session: UploadSession): Promise<void>;

  /** Post-upload verification data (checksum fetch etc.). */
  verify(id: string): Promise<CloudObject>;

  quota(): Promise<QuotaInfo>;
  copy(id: string, newParentId: string): Promise<CloudObject>;
  move(id: string, newParentId: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
  createFolder(parentId: string | null, name: string): Promise<CloudObject>;

  /** Optional change feed. Present only when capabilities.changeFeed. */
  watch?(folderId: string | null): AsyncIterable<ChangeEvent>;

  /** Cheap liveness/latency probe for the health dashboard. */
  health(): Promise<HealthReport>;
}
