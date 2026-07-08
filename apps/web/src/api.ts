export interface Account {
  id: string;
  providerId: string;
  label: string;
  status: string;
  email: string;
  quotaTotal: number | null;
  quotaUsed: number | null;
}

export interface Entry {
  id: string;
  name: string;
  size?: number;
  isFolder: boolean;
}

export interface Job {
  id: string;
  name: string;
  state: string;
  mode: string;
  totalFiles: number;
  totalBytes: number;
  transferredBytes: number;
  completedFiles: number;
  failedFiles: number;
  skippedFiles: number;
  createdAt: string;
  error: string | null;
}

export type ConflictPolicy = 'skip' | 'skip_if_same_size' | 'overwrite' | 'rename';
export type Operation = 'copy' | 'move';

export interface TransferOptions {
  conflictPolicy: ConflictPolicy;
  operation: Operation;
  includeExtensions: string[];
  excludeExtensions: string[];
  minSizeBytes?: number;
  maxSizeBytes?: number;
  skipEmpty: boolean;
  nameIncludes: string[];
  nameExcludes: string[];
  recurse: boolean;
}

export const defaultTransferOptions: TransferOptions = {
  conflictPolicy: 'skip',
  operation: 'copy',
  includeExtensions: [],
  excludeExtensions: [],
  skipEmpty: false,
  nameIncludes: [],
  nameExcludes: [],
  recurse: true,
};

export interface JobFile {
  id: string;
  path: string;
  state: string;
  paused: boolean;
  size: number;
  committedOffset: number;
  attempt: number;
  verified: boolean | null;
  error: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const base = '/api/v1';

export const api = {
  listAccounts: () => fetch(`${base}/accounts`).then((r) => json<{ accounts: Account[] }>(r)).then((d) => d.accounts),
  addMega: (email: string, password: string, label = '') =>
    fetch(`${base}/accounts/mega`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, label }),
    }).then((r) => json<{ account: Account }>(r)),
  driveConnectUrl: () => fetch(`${base}/accounts/gdrive/connect`).then((r) => json<{ url: string }>(r)).then((d) => d.url),
  deleteAccount: (id: string) => fetch(`${base}/accounts/${id}`, { method: 'DELETE' }).then((r) => json(r)),
  browse: (accountId: string, parentId?: string) =>
    fetch(`${base}/accounts/${accountId}/browse${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`).then((r) =>
      json<{ folders: Entry[]; files: Entry[] }>(r),
    ),
  listJobs: () => fetch(`${base}/jobs`).then((r) => json<{ jobs: Job[] }>(r)).then((d) => d.jobs),
  createJob: (input: {
    name: string;
    sourceAccountId: string;
    destAccountId: string;
    sourceSelection: { nodeId: string; path: string; isFolder: boolean }[];
    destFolderId: string;
    destFolderPath?: string;
    options?: TransferOptions;
  }) =>
    fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<{ id: string }>(r)),
  jobAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    fetch(`${base}/jobs/${id}/${action}`, { method: 'POST' }).then((r) => json(r)),
  jobFiles: (id: string) =>
    fetch(`${base}/jobs/${id}/files`).then((r) => json<{ files: JobFile[] }>(r)).then((d) => d.files),
  fileAction: (jobId: string, fileId: string, action: 'pause' | 'resume' | 'cancel') =>
    fetch(`${base}/jobs/${jobId}/files/${fileId}/${action}`, { method: 'POST' }).then((r) => json(r)),
};

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Connect to the live progress WebSocket. */
export function connectWs(onEvent: (ev: Record<string, unknown>) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${base}/ws`);
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  };
  return ws;
}
