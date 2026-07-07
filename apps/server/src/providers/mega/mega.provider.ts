import type { Readable } from 'node:stream';
import { Storage, type File } from 'megajs';
import {
  NotSupportedError,
  ProviderError,
  type AuthState,
  type ByteRange,
  type ChunkResult,
  type CloudObject,
  type CloudProvider,
  type HealthReport,
  type ProviderCredentials,
  type ProviderCapabilities,
  type QuotaInfo,
  type UploadMeta,
  type UploadProbe,
  type UploadSession,
} from '@cloudcopy/provider-sdk';

export const MEGA_CAPABILITIES: ProviderCapabilities = {
  version: 1,
  checksum: { algorithms: [] },
  multipart: false,
  resume: false,
  parallelUpload: false,
  serverCopy: false,
  changeFeed: false,
  softDelete: true,
  versioning: false,
  rangeDownload: true,
  minChunkSize: 262_144,
  maxChunkSize: 1_073_741_824,
  chunkSizeMultipleOf: 1,
};

/** Session-only material we persist (sealed): sid + key, never the password. */
interface MegaSession {
  key: string;
  sid: string;
  name: string;
  user: string;
}

function mapFile(f: File, path?: string): CloudObject {
  return {
    id: f.nodeId ?? '',
    name: f.name ?? '',
    path: path ?? f.name ?? '',
    isFolder: f.directory,
    size: f.size ?? 0,
    modified: f.timestamp ? new Date(f.timestamp * 1000) : undefined,
    raw: { nodeId: f.nodeId, label: f.label },
  };
}

function toProviderError(err: unknown, context: string): ProviderError {
  const msg = (err as Error)?.message ?? String(err);
  if (/ESID|EACCESS|EBLOCKED|login|auth/i.test(msg)) return new ProviderError('auth_invalid', `MEGA ${context}: ${msg}`, { cause: err });
  if (/EOVERQUOTA|bandwidth|quota/i.test(msg)) return new ProviderError('quota_exceeded', `MEGA ${context}: ${msg}`, { cause: err });
  if (/EAGAIN|ETEMPUNAVAIL|ERATELIMIT/i.test(msg)) return new ProviderError('rate_limited', `MEGA ${context}: ${msg}`, { cause: err });
  if (/ENOENT|not found/i.test(msg)) return new ProviderError('not_found', `MEGA ${context}: ${msg}`, { cause: err });
  return new ProviderError('unknown', `MEGA ${context}: ${msg}`, { cause: err });
}

export class MegaProvider implements CloudProvider {
  readonly id = 'mega';
  readonly capabilities = MEGA_CAPABILITIES;
  private storage: Storage | null = null;

  constructor(storage?: Storage) {
    this.storage = storage ?? null;
  }

  /** Rehydrate a provider from a previously sealed session (no password needed). */
  static async fromSession(sessionJson: string): Promise<MegaProvider> {
    const s = JSON.parse(sessionJson) as MegaSession;
    const storage = Storage.fromJSON({ ...s, options: { keepalive: false } as never });
    await storage.ready;
    return new MegaProvider(storage);
  }

  private ensure(): Storage {
    if (!this.storage) throw new ProviderError('auth_invalid', 'MEGA not authenticated');
    return this.storage;
  }

  async authenticate(creds: ProviderCredentials): Promise<AuthState> {
    if (creds.kind !== 'password') throw new NotSupportedError('mega.authenticate(non-password)');
    try {
      const storage = new Storage({ email: creds.email, password: creds.password, autoload: true, autologin: true });
      await storage.ready;
      this.storage = storage;
      const full = storage.toJSON();
      // Persist session material only — strip the password from options.
      const session: MegaSession = { key: full.key, sid: full.sid, name: full.name, user: full.user };
      return {
        session: JSON.stringify(session),
        meta: { email: creds.email, name: full.name ?? '', user: full.user ?? '' },
      };
    } catch (err) {
      throw toProviderError(err, 'authenticate');
    }
  }

  async refresh(state: AuthState): Promise<AuthState> {
    // MEGA sessions are long-lived; rehydrate to validate.
    this.storage = (await MegaProvider.fromSession(state.session)).storage;
    return state;
  }

  private folder(parentId: string | null): File {
    const storage = this.ensure();
    if (!parentId) return storage.root;
    const node = storage.files[parentId];
    if (!node) throw new ProviderError('not_found', `MEGA folder ${parentId} not found`);
    return node;
  }

  async listFolders(parentId: string | null): Promise<CloudObject[]> {
    try {
      const children = this.folder(parentId).children ?? [];
      return children.filter((c) => c.directory).map((c) => mapFile(c));
    } catch (err) {
      throw toProviderError(err, 'listFolders');
    }
  }

  async listFiles(parentId: string | null): Promise<CloudObject[]> {
    try {
      const children = this.folder(parentId).children ?? [];
      return children.filter((c) => !c.directory).map((c) => mapFile(c));
    } catch (err) {
      throw toProviderError(err, 'listFiles');
    }
  }

  async getMetadata(id: string): Promise<CloudObject> {
    const node = this.ensure().files[id];
    if (!node) throw new ProviderError('not_found', `MEGA node ${id} not found`);
    return mapFile(node);
  }

  async downloadStream(id: string, range?: ByteRange): Promise<Readable> {
    const node = this.ensure().files[id];
    if (!node) throw new ProviderError('not_found', `MEGA node ${id} not found`);
    try {
      // megajs `end` is the inclusive last byte; our ByteRange.end is exclusive.
      const opts = range ? { start: range.start, end: range.end - 1 } : {};
      return node.download(opts);
    } catch (err) {
      throw toProviderError(err, 'downloadStream');
    }
  }

  // ── destination ops: MEGA is source-only in the current flow ──
  createUpload(_meta: UploadMeta): Promise<UploadSession> {
    throw new NotSupportedError('mega.createUpload');
  }
  uploadChunk(): Promise<ChunkResult> {
    throw new NotSupportedError('mega.uploadChunk');
  }
  probeUpload(): Promise<UploadProbe> {
    throw new NotSupportedError('mega.probeUpload');
  }
  completeUpload(): Promise<CloudObject> {
    throw new NotSupportedError('mega.completeUpload');
  }
  abortUpload(): Promise<void> {
    return Promise.resolve();
  }
  verify(id: string): Promise<CloudObject> {
    return this.getMetadata(id);
  }

  async quota(): Promise<QuotaInfo> {
    try {
      const info = await this.ensure().getAccountInfo();
      return { totalBytes: info.spaceTotal, usedBytes: info.spaceUsed };
    } catch (err) {
      throw toProviderError(err, 'quota');
    }
  }

  copy(): Promise<CloudObject> {
    throw new NotSupportedError('mega.copy');
  }
  async move(id: string, newParentId: string): Promise<void> {
    const node = this.ensure().files[id];
    const target = this.ensure().files[newParentId];
    if (!node || !target) throw new ProviderError('not_found', 'MEGA move: node or target missing');
    await (node as { moveTo(t: File): Promise<void> }).moveTo(target);
  }
  async rename(id: string, name: string): Promise<void> {
    const node = this.ensure().files[id];
    if (!node) throw new ProviderError('not_found', `MEGA node ${id} not found`);
    await (node as { rename(n: string): Promise<void> }).rename(name);
  }
  async delete(id: string): Promise<void> {
    const node = this.ensure().files[id];
    if (!node) return;
    await (node as { delete(permanent?: boolean): Promise<void> }).delete(false);
  }
  async createFolder(parentId: string | null, name: string): Promise<CloudObject> {
    const parent = this.folder(parentId) as unknown as { mkdir(o: { name: string }): Promise<File> };
    const created = await parent.mkdir({ name });
    return mapFile(created);
  }

  async health(): Promise<HealthReport> {
    const start = Date.now();
    try {
      await this.ensure().getAccountInfo();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }
}
