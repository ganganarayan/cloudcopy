import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  NotSupportedError,
  ProviderError,
  type AuthState,
  type ByteRange,
  type ChunkResult,
  type CloudObject,
  type CloudProvider,
  type HealthReport,
  type ProviderCapabilities,
  type QuotaInfo,
  type UploadMeta,
  type UploadProbe,
  type UploadSession,
} from '@cloudcopy/provider-sdk';
import type { AccountRow, IProviderRegistry } from '../src/providers/registry.js';

/** Deterministic pseudo-random bytes so source reads are reproducible. */
export function genBytes(size: number, seed = 7): Buffer {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) b[i] = (i * 131 + seed) & 0xff;
  return b;
}

const NOOP_CAPS: ProviderCapabilities = {
  version: 1,
  checksum: { algorithms: ['md5'] },
  multipart: false,
  resume: true,
  parallelUpload: false,
  serverCopy: false,
  changeFeed: false,
  softDelete: false,
  versioning: false,
  rangeDownload: true,
  minChunkSize: 1,
  maxChunkSize: 1 << 30,
  chunkSizeMultipleOf: 1,
};

export class FakeSourceProvider implements CloudProvider {
  readonly id = 'mega';
  readonly capabilities = NOOP_CAPS;
  private files = new Map<string, { size: number; seed: number }>();

  addFile(id: string, size: number, seed = 7): void {
    this.files.set(id, { size, seed });
  }
  bytes(id: string): Buffer {
    const f = this.files.get(id)!;
    return genBytes(f.size, f.seed);
  }

  authenticate(): Promise<AuthState> {
    return Promise.resolve({ session: '{}', meta: {} });
  }
  refresh(s: AuthState): Promise<AuthState> {
    return Promise.resolve(s);
  }
  listFolders(): Promise<CloudObject[]> {
    return Promise.resolve([]);
  }
  listFiles(): Promise<CloudObject[]> {
    return Promise.resolve(
      [...this.files].map(([id, f]) => ({ id, name: `${id}.bin`, path: `${id}.bin`, isFolder: false, size: f.size })),
    );
  }
  getMetadata(id: string): Promise<CloudObject> {
    const f = this.files.get(id);
    if (!f) return Promise.reject(new ProviderError('not_found', id));
    return Promise.resolve({ id, name: `${id}.bin`, path: `${id}.bin`, isFolder: false, size: f.size });
  }
  downloadStream(id: string, range?: ByteRange): Promise<Readable> {
    const full = this.bytes(id);
    const start = range?.start ?? 0;
    const end = range?.end ?? full.length;
    const slice = full.subarray(start, end);
    // Emit in small pieces to exercise chunk reassembly + backpressure.
    async function* gen() {
      for (let i = 0; i < slice.length; i += 64 * 1024) yield slice.subarray(i, i + 64 * 1024);
    }
    return Promise.resolve(Readable.from(gen()));
  }
  createUpload(): Promise<UploadSession> {
    throw new NotSupportedError('fakeSource.createUpload');
  }
  uploadChunk(): Promise<ChunkResult> {
    throw new NotSupportedError('fakeSource.uploadChunk');
  }
  probeUpload(): Promise<UploadProbe> {
    throw new NotSupportedError('fakeSource.probeUpload');
  }
  completeUpload(): Promise<CloudObject> {
    throw new NotSupportedError('fakeSource.completeUpload');
  }
  abortUpload(): Promise<void> {
    return Promise.resolve();
  }
  verify(id: string): Promise<CloudObject> {
    return this.getMetadata(id);
  }
  quota(): Promise<QuotaInfo> {
    return Promise.resolve({ totalBytes: null, usedBytes: null });
  }
  copy(): Promise<CloudObject> {
    throw new NotSupportedError('copy');
  }
  move(): Promise<void> {
    return Promise.resolve();
  }
  rename(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  createFolder(): Promise<CloudObject> {
    throw new NotSupportedError('createFolder');
  }
  health(): Promise<HealthReport> {
    return Promise.resolve({ ok: true, latencyMs: 0 });
  }
}

interface FakeUpload {
  id: string;
  name: string;
  size: number;
  received: Buffer;
  done: boolean;
}

/**
 * Destination with real resumable semantics: strictly sequential offsets,
 * 308-style partial acks, completion md5. Optional one-shot failure at an offset.
 */
export class FakeDestProvider implements CloudProvider {
  readonly id = 'gdrive';
  readonly capabilities = NOOP_CAPS;
  uploads = new Map<string, FakeUpload>();
  private seq = 0;
  failAtOffset: number | null = null; // throws once when a chunk lands at this offset

  authenticate(): Promise<AuthState> {
    return Promise.resolve({ session: '{}', meta: {} });
  }
  refresh(s: AuthState): Promise<AuthState> {
    return Promise.resolve(s);
  }
  listFolders(): Promise<CloudObject[]> {
    return Promise.resolve([]);
  }
  listFiles(): Promise<CloudObject[]> {
    return Promise.resolve([]);
  }
  getMetadata(id: string): Promise<CloudObject> {
    const u = [...this.uploads.values()].find((x) => x.id === id);
    if (!u) return Promise.reject(new ProviderError('not_found', id));
    return Promise.resolve(this.toObject(u));
  }
  downloadStream(): Promise<Readable> {
    throw new NotSupportedError('fakeDest.downloadStream');
  }
  createUpload(meta: UploadMeta): Promise<UploadSession> {
    const uri = `mem://${++this.seq}`;
    this.uploads.set(uri, { id: `drive-${this.seq}`, name: meta.name, size: meta.size, received: Buffer.alloc(0), done: false });
    return Promise.resolve({ sessionUri: uri });
  }
  uploadChunk(session: UploadSession, buf: Buffer, offset: number, totalSize: number): Promise<ChunkResult> {
    const u = this.uploads.get(session.sessionUri);
    if (!u) return Promise.reject(new ProviderError('session_expired', 'no session'));
    if (offset !== u.received.length) {
      return Promise.reject(new ProviderError('server', `non-sequential: got ${offset}, expected ${u.received.length}`));
    }
    if (this.failAtOffset !== null && offset === this.failAtOffset) {
      this.failAtOffset = null; // fail once, then succeed on retry
      return Promise.reject(new ProviderError('rate_limited', 'injected 429', { retryAfterMs: 1 }));
    }
    u.received = Buffer.concat([u.received, buf]);
    if (u.received.length >= totalSize) {
      u.done = true;
      return Promise.resolve({ done: true, file: this.toObject(u) });
    }
    return Promise.resolve({ done: false, committedOffset: u.received.length });
  }
  probeUpload(session: UploadSession, _total: number): Promise<UploadProbe> {
    const u = this.uploads.get(session.sessionUri);
    if (!u) return Promise.resolve({ status: 'expired', committedOffset: 0 });
    if (u.done) return Promise.resolve({ status: 'completed', committedOffset: u.size, file: this.toObject(u) });
    return Promise.resolve({ status: 'open', committedOffset: u.received.length });
  }
  completeUpload(session: UploadSession): Promise<CloudObject> {
    const u = this.uploads.get(session.sessionUri)!;
    return Promise.resolve(this.toObject(u));
  }
  abortUpload(): Promise<void> {
    return Promise.resolve();
  }
  verify(id: string): Promise<CloudObject> {
    return this.getMetadata(id);
  }
  quota(): Promise<QuotaInfo> {
    return Promise.resolve({ totalBytes: 1 << 30, usedBytes: 0 });
  }
  copy(): Promise<CloudObject> {
    throw new NotSupportedError('copy');
  }
  move(): Promise<void> {
    return Promise.resolve();
  }
  rename(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  createFolder(): Promise<CloudObject> {
    throw new NotSupportedError('createFolder');
  }
  health(): Promise<HealthReport> {
    return Promise.resolve({ ok: true, latencyMs: 0 });
  }

  private toObject(u: FakeUpload): CloudObject {
    return {
      id: u.id,
      name: u.name,
      path: u.name,
      isFolder: false,
      size: u.received.length,
      checksum: { algorithm: 'md5', value: createHash('md5').update(u.received).digest('hex') },
    };
  }
}

export class FakeRegistry implements IProviderRegistry {
  constructor(private readonly byAccount: Map<string, CloudProvider>) {}
  connect(account: AccountRow): Promise<CloudProvider> {
    const p = this.byAccount.get(account.id);
    if (!p) return Promise.reject(new Error(`no fake provider for account ${account.id}`));
    return Promise.resolve(p);
  }
  invalidate(): void {
    /* no-op */
  }
}
