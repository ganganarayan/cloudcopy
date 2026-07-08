import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ── enums ────────────────────────────────────────────────────────────────────

export const jobStateEnum = pgEnum('job_state', [
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
]);

export const fileStateEnum = pgEnum('file_state', [
  'pending',
  'downloading',
  'uploading',
  'verifying',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const chunkStateEnum = pgEnum('chunk_state', [
  'pending',
  'fetching',
  'buffered',
  'committed',
  'failed',
]);

export const jobModeEnum = pgEnum('job_mode', ['copy', 'mirror', 'incremental', 'update_only']);

export const planActionEnum = pgEnum('plan_action', [
  'copy',
  'skip',
  'overwrite',
  'rename',
  'delete',
  'archive',
]);

export const providerKindEnum = pgEnum('provider_kind', ['mega', 'gdrive']);

export const uploadSessionStateEnum = pgEnum('upload_session_state', [
  'open',
  'completed',
  'expired',
  'aborted',
]);

export const integrityAlgorithmEnum = pgEnum('integrity_algorithm', ['sha256', 'md5', 'crc32c']);

// ── users / providers / accounts ────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleSub: text('google_sub').unique().notNull(),
  email: text('email').unique().notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  role: text('role').notNull().default('admin'), // 'admin' | 'member'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

/** Static catalog of supported providers + their versioned capabilities. */
export const providers = pgTable('providers', {
  id: text('id').primaryKey(), // 'mega', 'gdrive'
  kind: providerKindEnum('kind').notNull(),
  displayName: text('display_name').notNull(),
  capabilities: jsonb('capabilities').notNull().default({}),
});

export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    label: text('label').notNull(),
    /** AES-256-GCM sealed AuthState (session material only — never passwords). */
    authBlob: bytea('auth_blob').notNull(),
    /** Non-secret metadata: email, remote account id, scopes. */
    authMeta: jsonb('auth_meta').notNull().default({}),
    status: text('status').notNull().default('active'),
    quotaTotal: bigint('quota_total', { mode: 'number' }),
    quotaUsed: bigint('quota_used', { mode: 'number' }),
    quotaCheckedAt: timestamp('quota_checked_at', { withTimezone: true }),
    /** Rolling 24h upload counter for preemptive daily-cap throttling (Drive 750GB/day). */
    uploaded24h: bigint('uploaded_24h', { mode: 'number' }).notNull().default(0),
    uploaded24hResetAt: timestamp('uploaded_24h_reset_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_pa_user_provider_label').on(t.userId, t.providerId, t.label),
    index('idx_pa_user').on(t.userId),
  ],
);

// ── inventory (scanner output, reusable) ────────────────────────────────────

export const inventories = pgTable(
  'inventories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    rootId: text('root_id'),
    rootPath: text('root_path'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
    stats: jsonb('stats').notNull().default({}), // {files, folders, bytes, durationMs}
  },
  (t) => [index('idx_inv_account').on(t.accountId, t.scannedAt)],
);

export const inventoryEntries = pgTable(
  'inventory_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    inventoryId: uuid('inventory_id')
      .notNull()
      .references(() => inventories.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    isFolder: boolean('is_folder').notNull().default(false),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    checksumAlgorithm: text('checksum_algorithm'),
    checksumValue: text('checksum_value'),
    modified: timestamp('modified', { withTimezone: true }),
    mime: text('mime'),
    raw: jsonb('raw'),
  },
  (t) => [
    index('idx_ie_inventory_path').on(t.inventoryId, t.path),
    index('idx_ie_inventory_node').on(t.inventoryId, t.nodeId),
  ],
);

// ── jobs / plans / files / chunks / sessions ────────────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sourceAccountId: uuid('source_account_id')
      .notNull()
      .references(() => providerAccounts.id),
    destAccountId: uuid('dest_account_id')
      .notNull()
      .references(() => providerAccounts.id),
    name: text('name').notNull(),
    state: jobStateEnum('state').notNull().default('queued'),
    mode: jobModeEnum('mode').notNull().default('copy'),
    /** [{nodeId, path, isFolder}] chosen in the dual-pane UI. */
    sourceSelection: jsonb('source_selection').notNull(),
    destFolderId: text('dest_folder_id').notNull(),
    destFolderPath: text('dest_folder_path'),
    /** {verify, dedup, conflictPolicy, archiveFolder, ...} */
    options: jsonb('options').notNull().default({}),
    totalFiles: integer('total_files').notNull().default(0),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
    transferredBytes: bigint('transferred_bytes', { mode: 'number' }).notNull().default(0),
    completedFiles: integer('completed_files').notNull().default(0),
    failedFiles: integer('failed_files').notNull().default(0),
    skippedFiles: integer('skipped_files').notNull().default(0),
    retryCount: integer('retry_count').notNull().default(0),
    error: text('error'),
    clonedFromJobId: uuid('cloned_from_job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_jobs_active')
      .on(t.state)
      .where(sql`${t.state} IN ('queued','preparing','scanning','planning','running','retrying')`),
    index('idx_jobs_user_created').on(t.userId, t.createdAt),
  ],
);

/** Versioned planner output — explains why an older job behaved the way it did. */
export const executionPlans = pgTable(
  'execution_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    plannerVersion: text('planner_version').notNull(),
    options: jsonb('options').notNull().default({}),
    /** {bytesToCopy, filesToCopy, duplicatesSkipped, estDurationSec, quotaDays, ...} */
    summary: jsonb('summary').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_ep_job').on(t.jobId, t.version)],
);

export const jobPlanEntries = pgTable(
  'job_plan_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => executionPlans.id, { onDelete: 'cascade' }),
    action: planActionEnum('action').notNull(),
    /** CloudObject snapshot of the source entry. */
    source: jsonb('source').notNull(),
    destParentId: text('dest_parent_id'),
    resolvedName: text('resolved_name'),
    /** Why dedup/skip decided what it did: 'name+size' | 'checksum' | null. */
    dedupBasis: text('dedup_basis'),
  },
  (t) => [index('idx_jpe_plan').on(t.planId)],
);

export const jobFiles = pgTable(
  'job_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    planEntryId: bigint('plan_entry_id', { mode: 'number' }),
    state: fileStateEnum('state').notNull().default('pending'),
    /** Per-file (selective) pause. A paused file is not claimed even when its job runs. */
    paused: boolean('paused').notNull().default(false),
    sourceNodeId: text('source_node_id').notNull(),
    sourcePath: text('source_path').notNull(),
    destParentId: text('dest_parent_id'),
    destFileId: text('dest_file_id'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Frozen at file start; multiple of 256 KiB for Drive. */
    chunkSize: integer('chunk_size'),
    /** Bytes durably committed at the destination — THE restart checkpoint. */
    committedOffset: bigint('committed_offset', { mode: 'number' }).notNull().default(0),
    integrityAlgorithm: integrityAlgorithmEnum('integrity_algorithm').notNull().default('sha256'),
    /** Serialized incremental hash context at committed_offset. */
    integrityState: bytea('integrity_state'),
    integrityHex: text('integrity_hex'),
    /** Aux incremental MD5 (same stream pass) when dest verifies via MD5 (Drive). */
    auxMd5State: bytea('aux_md5_state'),
    auxMd5Hex: text('aux_md5_hex'),
    destChecksumHex: text('dest_checksum_hex'),
    verified: boolean('verified'),
    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    claimedBy: text('claimed_by'),
    claimHeartbeatAt: timestamp('claim_heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_jf_job_source').on(t.jobId, t.sourceNodeId),
    index('idx_jf_job_state').on(t.jobId, t.state),
    index('idx_jf_active')
      .on(t.state)
      .where(sql`${t.state} IN ('pending','downloading','uploading','verifying')`),
  ],
);

/**
 * Lazy chunk window: rows exist only ~64 chunks ahead of committed_offset and
 * are pruned once committed. committed_offset on job_files is the authoritative
 * checkpoint — a 2 TB file never holds more than ~64 live rows here.
 */
export const fileChunks = pgTable(
  'file_chunks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobFileId: uuid('job_file_id')
      .notNull()
      .references(() => jobFiles.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    byteStart: bigint('byte_start', { mode: 'number' }).notNull(),
    /** Exclusive. */
    byteEnd: bigint('byte_end', { mode: 'number' }).notNull(),
    state: chunkStateEnum('state').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_fc_file_index').on(t.jobFileId, t.chunkIndex),
    index('idx_fc_file_state').on(t.jobFileId, t.state),
  ],
);

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobFileId: uuid('job_file_id')
      .notNull()
      .references(() => jobFiles.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    sessionUri: text('session_uri').notNull(),
    state: uploadSessionStateEnum('state').notNull().default('open'),
    lastOffset: bigint('last_offset', { mode: 'number' }).notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    etag: text('etag'),
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_us_file').on(t.jobFileId),
    index('idx_us_open')
      .on(t.state)
      .where(sql`${t.state} = 'open'`),
  ],
);

// ── observability / audit ───────────────────────────────────────────────────

export const logs = pgTable(
  'logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: text('level').notNull(),
    category: text('category').notNull(), // 'engine'|'api'|'provider'|'auth'|'retry'|...
    jobId: uuid('job_id'), // no FK — logs outlive rows
    jobFileId: uuid('job_file_id'),
    message: text('message').notNull(),
    data: jsonb('data'),
  },
  (t) => [
    index('idx_logs_ts').on(t.ts),
    index('idx_logs_job')
      .on(t.jobId, t.ts)
      .where(sql`${t.jobId} IS NOT NULL`),
  ],
);

/** Append-only event store (audit log + notification source). Never updated except read_at. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    /** Set only for notification-type events when the user reads them. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_events_user_unread')
      .on(t.userId, t.createdAt)
      .where(sql`${t.readAt} IS NULL`),
    index('idx_events_type_created').on(t.type, t.createdAt),
  ],
);

// ── config ──────────────────────────────────────────────────────────────────

export const settings = pgTable('settings', {
  key: text('key').primaryKey(), // 'engine.maxConcurrentFiles', 'bandwidth.windows', ...
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id),
});

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(), // 'planner_v2', 'parallel_writer', ...
  enabled: boolean('enabled').notNull().default(false),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── templates / schedules ───────────────────────────────────────────────────

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceAccountId: uuid('source_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    destAccountId: uuid('dest_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    sourceSelection: jsonb('source_selection').notNull(),
    destFolderId: text('dest_folder_id').notNull(),
    destFolderPath: text('dest_folder_path'),
    options: jsonb('options').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_templates_user').on(t.userId)],
);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_schedules_due')
      .on(t.nextRunAt)
      .where(sql`${t.enabled} = true`),
  ],
);
