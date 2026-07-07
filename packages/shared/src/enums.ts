export const JOB_STATES = [
  'queued',
  'preparing',
  'scanning',
  'planning',
  'running',
  'paused',
  'retrying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const FILE_STATES = [
  'pending',
  'downloading',
  'uploading',
  'verifying',
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type FileState = (typeof FILE_STATES)[number];

export const CHUNK_STATES = ['pending', 'fetching', 'buffered', 'committed', 'failed'] as const;
export type ChunkState = (typeof CHUNK_STATES)[number];

export const JOB_MODES = ['copy', 'mirror', 'incremental', 'update_only'] as const;
export type JobMode = (typeof JOB_MODES)[number];

export const PLAN_ACTIONS = ['copy', 'skip', 'overwrite', 'rename', 'delete', 'archive'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export const PROVIDER_KINDS = ['mega', 'gdrive'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const ACCOUNT_STATUSES = ['active', 'auth_error', 'quota_exceeded', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const UPLOAD_SESSION_STATES = ['open', 'completed', 'expired', 'aborted'] as const;
export type UploadSessionState = (typeof UPLOAD_SESSION_STATES)[number];

export const INTEGRITY_ALGORITHMS = ['sha256', 'md5', 'crc32c'] as const;
export type IntegrityAlgorithm = (typeof INTEGRITY_ALGORITHMS)[number];

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Append-only audit event types (event sourcing). */
export const EVENT_TYPES = [
  'JobCreated',
  'JobScanned',
  'JobPlanned',
  'JobStarted',
  'JobPaused',
  'JobResumed',
  'JobCompleted',
  'JobFailed',
  'JobCancelled',
  'FileStarted',
  'FileCompleted',
  'FileFailed',
  'FileSkipped',
  'ChunkCompleted',
  'RetryScheduled',
  'ProviderQuotaHit',
  'AccountAuthError',
  'WorkerStarted',
  'WorkerStopped',
  'EngineRecovered',
  'DailySummary',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event types surfaced to users as notifications (bell). */
export const NOTIFICATION_EVENT_TYPES: readonly EventType[] = [
  'JobCompleted',
  'JobFailed',
  'AccountAuthError',
  'ProviderQuotaHit',
  'DailySummary',
] as const;

/** Legal job state transitions — enforced by services, tested in unit tests. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['preparing', 'cancelled'],
  preparing: ['scanning', 'failed', 'cancelled'],
  scanning: ['planning', 'failed', 'cancelled'],
  planning: ['running', 'failed', 'cancelled'],
  running: ['paused', 'retrying', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  retrying: ['running', 'paused', 'failed', 'cancelled'],
  completed: [],
  failed: ['retrying', 'queued'],
  cancelled: [],
};

export function isLegalJobTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
