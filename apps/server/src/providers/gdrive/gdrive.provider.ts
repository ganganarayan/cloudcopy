import type { Readable } from 'node:stream';
import { OAuth2Client } from 'google-auth-library';
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
import { driveError, parseCommittedOffset } from './http.js';
import { createOAuthClient, exchangeCode, type GoogleOAuthConfig } from './oauth.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents';

export const GDRIVE_CAPABILITIES: ProviderCapabilities = {
  version: 1,
  checksum: { algorithms: ['md5'] },
  multipart: false,
  resume: true,
  parallelUpload: false,
  serverCopy: true,
  changeFeed: true,
  softDelete: true,
  versioning: true,
  rangeDownload: true,
  minChunkSize: 262_144,
  maxChunkSize: 1_073_741_824,
  chunkSizeMultipleOf: 262_144,
};

/** Session material we persist (sealed). Never includes the client secret. */
interface DriveSession {
  refreshToken: string;
  sub: string;
  email: string;
}

function mapFile(f: Record<string, unknown>): CloudObject {
  const isFolder = f.mimeType === FOLDER_MIME;
  const size = f.size ? Number(f.size) : 0;
  return {
    id: String(f.id),
    name: String(f.name ?? ''),
    path: String(f.name ?? ''),
    isFolder,
    size,
    checksum: f.md5Checksum ? { algorithm: 'md5', value: String(f.md5Checksum) } : undefined,
    modified: f.modifiedTime ? new Date(String(f.modifiedTime)) : undefined,
    created: f.createdTime ? new Date(String(f.createdTime)) : undefined,
    mime: f.mimeType ? String(f.mimeType) : undefined,
    raw: f,
  };
}

export class GDriveProvider implements CloudProvider {
  readonly id = 'gdrive';
  readonly capabilities = GDRIVE_CAPABILITIES;
  private client: OAuth2Client;

  constructor(
    private readonly cfg: GoogleOAuthConfig,
    private session?: DriveSession,
  ) {
    this.client = createOAuthClient(cfg);
    if (session) this.client.setCredentials({ refresh_token: session.refreshToken });
  }

  async authenticate(creds: ProviderCredentials): Promise<AuthState> {
    if (creds.kind !== 'oauth_code') throw new NotSupportedError('gdrive.authenticate(non-oauth)');
    const identity = await exchangeCode(this.cfg, creds.code);
    this.session = { refreshToken: identity.refreshToken, sub: identity.sub, email: identity.email };
    this.client.setCredentials({ refresh_token: identity.refreshToken });
    return {
      session: JSON.stringify(this.session),
      meta: { email: identity.email, sub: identity.sub, name: identity.name ?? '' },
      expiresAt: identity.expiryDate,
    };
  }

  async refresh(state: AuthState): Promise<AuthState> {
    // OAuth2Client refreshes access tokens on demand; the refresh token is the durable secret.
    return state;
  }

  private async token(): Promise<string> {
    try {
      const { token } = await this.client.getAccessToken();
      if (!token) throw new ProviderError('auth_invalid', 'Drive: no access token from refresh');
      return token;
    } catch (err) {
      throw new ProviderError('auth_expired', `Drive token refresh failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(path.startsWith('http') ? path : `${DRIVE}${path}`, { ...init, headers });
    return res;
  }

  private async listChildren(parentId: string | null, onlyFolders: boolean): Promise<CloudObject[]> {
    const parent = parentId ?? 'root';
    const q = `'${parent}' in parents and trashed = false${onlyFolders ? ` and mimeType = '${FOLDER_MIME}'` : ''}`;
    const out: CloudObject[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.api(`/files?${params}`);
      if (!res.ok) throw await driveError(res, 'list');
      const data = (await res.json()) as { files?: Record<string, unknown>[]; nextPageToken?: string };
      for (const f of data.files ?? []) out.push(mapFile(f));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  listFolders(parentId: string | null): Promise<CloudObject[]> {
    return this.listChildren(parentId, true);
  }

  listFiles(parentId: string | null): Promise<CloudObject[]> {
    return this.listChildren(parentId, false);
  }

  async getMetadata(id: string): Promise<CloudObject> {
    const res = await this.api(`/files/${id}?fields=${FIELDS}&supportsAllDrives=true`);
    if (!res.ok) throw await driveError(res, 'getMetadata');
    return mapFile((await res.json()) as Record<string, unknown>);
  }

  /** Search folders across the whole account (My Drive AND Computers) by name. */
  async searchFolders(query: string): Promise<CloudObject[]> {
    const safe = query.replace(/['\\]/g, '\\$&');
    const q = `mimeType = '${FOLDER_MIME}' and trashed = false and name contains '${safe}'`;
    const params = new URLSearchParams({
      q,
      fields: `files(${FIELDS})`,
      pageSize: '50',
      corpora: 'user',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const res = await this.api(`/files?${params}`);
    if (!res.ok) throw await driveError(res, 'search');
    const data = (await res.json()) as { files?: Record<string, unknown>[] };
    return (data.files ?? []).map(mapFile);
  }

  downloadStream(_id: string, _range?: ByteRange): Promise<Readable> {
    // Drive is the destination in the MEGA→Drive flow; downloads not needed yet.
    throw new NotSupportedError('gdrive.downloadStream');
  }

  async createUpload(meta: UploadMeta): Promise<UploadSession> {
    const token = await this.token();
    const res = await fetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(meta.size),
        'x-upload-content-type': meta.mime ?? 'application/octet-stream',
      },
      body: JSON.stringify({ name: meta.name, parents: [meta.parentId] }),
    });
    if (!res.ok) throw await driveError(res, 'createUpload');
    const location = res.headers.get('location');
    if (!location) throw new ProviderError('server', 'Drive createUpload: no session Location header');
    return { sessionUri: location };
  }

  async uploadChunk(
    session: UploadSession,
    buf: Buffer,
    offset: number,
    totalSize: number,
  ): Promise<ChunkResult> {
    const end = offset + buf.length - 1;
    const res = await fetch(session.sessionUri, {
      method: 'PUT',
      headers: {
        'content-length': String(buf.length),
        'content-range': `bytes ${offset}-${end}/${totalSize}`,
      },
      body: buf,
    });
    if (res.status === 308) {
      const committed = parseCommittedOffset(res.headers.get('range')) || offset + buf.length;
      return { done: false, committedOffset: committed };
    }
    if (res.status === 200 || res.status === 201) {
      const meta = await this.getMetadata(String(((await res.json()) as { id: string }).id));
      return { done: true, file: meta };
    }
    throw await driveError(res, 'uploadChunk');
  }

  async probeUpload(session: UploadSession, totalSize: number): Promise<UploadProbe> {
    const res = await fetch(session.sessionUri, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${totalSize}` },
    });
    if (res.status === 308) {
      return { status: 'open', committedOffset: parseCommittedOffset(res.headers.get('range')) };
    }
    if (res.status === 200 || res.status === 201) {
      const file = mapFile((await res.json()) as Record<string, unknown>);
      return { status: 'completed', committedOffset: file.size, file };
    }
    if (res.status === 404 || res.status === 410) return { status: 'expired', committedOffset: 0 };
    throw await driveError(res, 'probeUpload');
  }

  async completeUpload(session: UploadSession): Promise<CloudObject> {
    // With Drive, completion is signalled by the final uploadChunk (200/201). If we only
    // have the session, probe returns the completed file.
    const probe = await this.probeUpload(session, 0).catch(() => null);
    if (probe?.file) return probe.file;
    throw new ProviderError('server', 'Drive completeUpload: session not finalized');
  }

  async abortUpload(session: UploadSession): Promise<void> {
    await fetch(session.sessionUri, { method: 'DELETE' }).catch(() => {});
  }

  verify(id: string): Promise<CloudObject> {
    return this.getMetadata(id);
  }

  async quota(): Promise<QuotaInfo> {
    const res = await this.api('/about?fields=storageQuota');
    if (!res.ok) throw await driveError(res, 'quota');
    const data = (await res.json()) as { storageQuota?: { limit?: string; usage?: string } };
    return {
      totalBytes: data.storageQuota?.limit ? Number(data.storageQuota.limit) : null,
      usedBytes: data.storageQuota?.usage ? Number(data.storageQuota.usage) : null,
    };
  }

  async copy(id: string, newParentId: string): Promise<CloudObject> {
    const res = await this.api(`/files/${id}/copy?fields=${FIELDS}&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parents: [newParentId] }),
    });
    if (!res.ok) throw await driveError(res, 'copy');
    return mapFile((await res.json()) as Record<string, unknown>);
  }

  async move(id: string, newParentId: string): Promise<void> {
    const cur = await this.getMetadata(id);
    const prev = (cur.raw?.parents as string[] | undefined)?.join(',') ?? '';
    const params = new URLSearchParams({ addParents: newParentId, removeParents: prev, supportsAllDrives: 'true' });
    const res = await this.api(`/files/${id}?${params}`, { method: 'PATCH' });
    if (!res.ok) throw await driveError(res, 'move');
  }

  async rename(id: string, name: string): Promise<void> {
    const res = await this.api(`/files/${id}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await driveError(res, 'rename');
  }

  async delete(id: string): Promise<void> {
    const res = await this.api(`/files/${id}?supportsAllDrives=true`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await driveError(res, 'delete');
  }

  async createFolder(parentId: string | null, name: string): Promise<CloudObject> {
    const res = await this.api(`/files?fields=${FIELDS}&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId ?? 'root'] }),
    });
    if (!res.ok) throw await driveError(res, 'createFolder');
    return mapFile((await res.json()) as Record<string, unknown>);
  }

  async health(): Promise<HealthReport> {
    const start = Date.now();
    try {
      await this.token();
      const res = await this.api('/about?fields=user');
      return { ok: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `status ${res.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }
}
