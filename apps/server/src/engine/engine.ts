import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { ProviderError, type CloudProvider } from '@cloudcopy/provider-sdk';
import type { JobMode, JobState } from '@cloudcopy/shared';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { jobFiles, jobs, providerAccounts, uploadSessions } from '../db/schema.js';
import type { LogService } from '../services/log.service.js';
import type { EventService } from '../services/event.service.js';
import type { Metrics } from '../observability/metrics.js';
import { ProviderRegistry, type AccountRow, type IProviderRegistry } from '../providers/registry.js';
import type { ProgressBus } from '../realtime/bus.js';
import { withRetry } from './retry.js';
import { scanSelection, type ScannedFile, type SelectionEntry } from './scan.js';
import { parseTransferOptions, type ConflictPolicy } from './options.js';
import { basename, filterReason, uniqueName } from './filter.js';

const MAX_FILE_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;

export interface CreateJobInput {
  userId: string;
  name: string;
  sourceAccountId: string;
  destAccountId: string;
  sourceSelection: SelectionEntry[];
  destFolderId: string;
  destFolderPath?: string;
  mode?: JobMode;
  options?: Record<string, unknown>;
}

/** Split a Readable into fixed-size chunks (last chunk may be smaller). */
async function* chunkStream(stream: Readable, chunkSize: number): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  let len = 0;
  for await (const piece of stream as AsyncIterable<Buffer>) {
    parts.push(piece);
    len += piece.length;
    while (len >= chunkSize) {
      const whole = Buffer.concat(parts, len);
      yield whole.subarray(0, chunkSize);
      const rest = whole.subarray(chunkSize);
      parts = rest.length ? [rest] : [];
      len = rest.length;
    }
  }
  if (len > 0) yield Buffer.concat(parts, len);
}

/**
 * In-process transfer engine backed by a Postgres SKIP LOCKED queue.
 * Streams MEGA→Drive in bounded chunks with per-chunk checkpoints, so a restart
 * resumes from committed_offset instead of re-uploading. Single-process for now;
 * Redis Streams + multi-worker slot in later without schema changes.
 */
export class TransferEngine {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly registry: IProviderRegistry;
  private running = false;
  private poll: NodeJS.Timeout | null = null;
  private active = new Map<string, AbortController>();
  private pausedJobs = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly log: LogService,
    private readonly events: EventService,
    private readonly bus: ProgressBus,
    private readonly metrics: Metrics,
    registry?: IProviderRegistry,
  ) {
    this.registry = registry ?? new ProviderRegistry(config);
    this.limit = pLimit(config.engine.maxFiles);
  }

  getRegistry(): IProviderRegistry {
    return this.registry;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.recover();
    this.poll = setInterval(() => void this.pump(), POLL_INTERVAL_MS);
    this.poll.unref();
    void this.pump();
    this.log.info('engine', 'engine started', { workerId: this.workerId, maxFiles: this.config.engine.maxFiles });
    await this.events.append('WorkerStarted', { workerId: this.workerId });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.poll) clearInterval(this.poll);
    for (const ac of this.active.values()) ac.abort();
    // Give in-flight chunk writes a moment to checkpoint.
    await new Promise((r) => setTimeout(r, 500));
    await this.events.append('WorkerStopped', { workerId: this.workerId });
  }

  /** On boot, release stale claims so files become re-claimable and resume. */
  private async recover(): Promise<void> {
    const reset = await this.db
      .update(jobFiles)
      .set({ claimedBy: null, state: 'pending', updatedAt: new Date() })
      .where(inArray(jobFiles.state, ['downloading', 'uploading']))
      .returning({ id: jobFiles.id });
    if (reset.length > 0) {
      this.log.warn('engine', 'recovered in-flight files after restart', { count: reset.length });
      await this.events.append('EngineRecovered', { files: reset.length });
    }
    // Resume jobs that were mid-flight.
    await this.db
      .update(jobs)
      .set({ state: 'running', updatedAt: new Date() })
      .where(inArray(jobs.state, ['retrying']));
  }

  // ── job lifecycle ──────────────────────────────────────────────────────────

  async createJob(input: CreateJobInput): Promise<string> {
    const [job] = await this.db
      .insert(jobs)
      .values({
        userId: input.userId,
        name: input.name,
        sourceAccountId: input.sourceAccountId,
        destAccountId: input.destAccountId,
        sourceSelection: input.sourceSelection,
        destFolderId: input.destFolderId,
        destFolderPath: input.destFolderPath,
        mode: input.mode ?? 'copy',
        options: input.options ?? {},
        state: 'queued',
      })
      .returning({ id: jobs.id });
    if (!job) throw new Error('job insert failed');
    await this.events.append('JobCreated', { jobId: job.id, name: input.name }, input.userId);
    void this.prepareJob(job.id).catch((err) => {
      this.log.error('engine', 'prepareJob failed', { err: (err as Error).message }, { jobId: job.id });
      void this.failJob(job.id, (err as Error).message);
    });
    return job.id;
  }

  private async prepareJob(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) return;
    const opts = parseTransferOptions(job.options);
    await this.setJobState(jobId, 'preparing');
    await this.setJobState(jobId, 'scanning');
    this.publishJobState(jobId, 'scanning');

    const source = await this.connectAccount(job.sourceAccountId);
    const scanned = await scanSelection(source, job.sourceSelection as SelectionEntry[], opts.recurse);

    await this.setJobState(jobId, 'planning');

    // 1) selective-transfer filters (type / size / name / date)
    const toTransfer: ScannedFile[] = [];
    const skipped: { f: ScannedFile; reason: string }[] = [];
    for (const f of scanned) {
      const reason = filterReason(f, opts);
      if (reason) skipped.push({ f, reason });
      else toTransfer.push(f);
    }

    // 2) conflict policy for files already present in the destination folder
    const survivors: ScannedFile[] = [];
    if (opts.conflictPolicy === 'skip' || opts.conflictPolicy === 'skip_if_same_size') {
      const dest = await this.connectAccount(job.destAccountId);
      const existing = await dest.listFiles(job.destFolderId).catch(() => []);
      const sizeByName = new Map(existing.map((e) => [e.name.toLowerCase(), e.size]));
      for (const f of toTransfer) {
        const name = basename(f.sourcePath).toLowerCase();
        if (sizeByName.has(name)) {
          if (opts.conflictPolicy === 'skip') {
            skipped.push({ f, reason: 'already exists' });
            continue;
          }
          if (sizeByName.get(name) === f.sizeBytes) {
            skipped.push({ f, reason: 'already exists (same size)' });
            continue;
          }
        }
        survivors.push(f);
      }
    } else {
      // overwrite / rename: resolved per-file at transfer time
      survivors.push(...toTransfer);
    }

    if (survivors.length > 0) {
      await this.db.insert(jobFiles).values(
        survivors.map((f) => ({
          jobId,
          state: 'pending' as const,
          sourceNodeId: f.sourceNodeId,
          sourcePath: f.sourcePath,
          destParentId: job.destFolderId,
          sizeBytes: f.sizeBytes,
          chunkSize: this.config.engine.chunkSize,
        })),
      );
    }
    if (skipped.length > 0) {
      await this.db.insert(jobFiles).values(
        skipped.map(({ f, reason }) => ({
          jobId,
          state: 'skipped' as const,
          sourceNodeId: f.sourceNodeId,
          sourcePath: f.sourcePath,
          destParentId: job.destFolderId,
          sizeBytes: f.sizeBytes,
          error: reason,
          finishedAt: new Date(),
        })),
      );
    }

    const totalBytes = survivors.reduce((a, f) => a + f.sizeBytes, 0);
    await this.db
      .update(jobs)
      .set({
        totalFiles: survivors.length,
        totalBytes,
        skippedFiles: skipped.length,
        state: 'running',
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
    await this.events.append('JobPlanned', { jobId, files: survivors.length, skipped: skipped.length, totalBytes }, job.userId);
    await this.events.append('JobStarted', { jobId }, job.userId);
    this.publishJobState(jobId, 'running');
    if (survivors.length === 0) {
      // Nothing to transfer (all filtered/skipped) — close the job out immediately.
      await this.maybeFinishJob(jobId, job.userId);
    } else {
      void this.pump();
    }
  }

  async pause(jobId: string): Promise<void> {
    this.pausedJobs.add(jobId);
    await this.setJobState(jobId, 'paused');
    this.publishJobState(jobId, 'paused');
    await this.events.append('JobPaused', { jobId });
  }

  async resume(jobId: string): Promise<void> {
    this.pausedJobs.delete(jobId);
    await this.setJobState(jobId, 'running');
    this.publishJobState(jobId, 'running');
    await this.events.append('JobResumed', { jobId });
    void this.pump();
  }

  async cancel(jobId: string): Promise<void> {
    await this.setJobState(jobId, 'cancelled');
    await this.db
      .update(jobFiles)
      .set({ state: 'cancelled', updatedAt: new Date() })
      .where(and(eq(jobFiles.jobId, jobId), inArray(jobFiles.state, ['pending', 'downloading', 'uploading'])));
    this.publishJobState(jobId, 'cancelled');
    await this.events.append('JobCancelled', { jobId });
  }

  async retry(jobId: string): Promise<void> {
    await this.db
      .update(jobFiles)
      .set({ state: 'pending', attempt: 0, error: null, updatedAt: new Date() })
      .where(and(eq(jobFiles.jobId, jobId), eq(jobFiles.state, 'failed')));
    await this.db
      .update(jobs)
      .set({ state: 'running', failedFiles: 0, error: null, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
    this.publishJobState(jobId, 'running');
    void this.pump();
  }

  // ── worker pump ──────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (!this.running) return;
    while (this.running && this.active.size < this.config.engine.maxFiles) {
      const file = await this.claimNextFile();
      if (!file) break;
      const ac = new AbortController();
      this.active.set(file.id, ac);
      void this.limit(() => this.transferFile(file, ac.signal))
        .catch((err) => this.log.error('engine', 'transferFile crashed', { err: (err as Error).message }, { jobFileId: file.id }))
        .finally(() => {
          this.active.delete(file.id);
          void this.pump();
        });
    }
  }

  private async claimNextFile(): Promise<ClaimedFile | null> {
    const res = await this.db.execute(sql`
      UPDATE job_files SET
        state = 'downloading', claimed_by = ${this.workerId}, claim_heartbeat_at = now(),
        attempt = attempt + 1, started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = (
        SELECT jf.id FROM job_files jf
        JOIN jobs j ON j.id = jf.job_id AND j.state = 'running'
        WHERE jf.state = 'pending'
        ORDER BY j.created_at, jf.source_path
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, job_id, source_node_id, source_path, dest_parent_id, size_bytes,
                chunk_size, committed_offset, attempt
    `);
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      sourceNodeId: String(row.source_node_id),
      sourcePath: String(row.source_path),
      destParentId: row.dest_parent_id ? String(row.dest_parent_id) : null,
      sizeBytes: Number(row.size_bytes),
      chunkSize: Number(row.chunk_size ?? this.config.engine.chunkSize),
      committedOffset: Number(row.committed_offset),
      attempt: Number(row.attempt),
    };
  }

  private async transferFile(file: ClaimedFile, signal: AbortSignal): Promise<void> {
    const job = await this.getJob(file.jobId);
    if (!job || this.pausedJobs.has(file.jobId)) {
      await this.db.update(jobFiles).set({ state: 'pending', claimedBy: null }).where(eq(jobFiles.id, file.id));
      return;
    }
    await this.events.append('FileStarted', { fileId: file.id, path: file.sourcePath }, job.userId);
    try {
      const [source, dest] = await Promise.all([
        this.connectAccount(job.sourceAccountId),
        this.connectAccount(job.destAccountId),
      ]);

      const { session, committedOffset, doneFile } = await this.ensureSession(file, dest, parseTransferOptions(job.options).conflictPolicy);
      if (doneFile) {
        await this.completeFile(file, job.userId, doneFile.id, doneFile.checksum?.value, true);
        return;
      }

      await this.db.update(jobFiles).set({ state: 'uploading', updatedAt: new Date() }).where(eq(jobFiles.id, file.id));

      const md5 = committedOffset === 0 ? createHash('md5') : null; // resume ⇒ size-only verify
      let offset = committedOffset;
      let destFileId: string | undefined;
      let destMd5: string | undefined;
      let lastEmit = 0;
      const startedAt = Date.now();

      const stream = await source.downloadStream(file.sourceNodeId, { start: offset, end: file.sizeBytes });

      for await (const chunk of chunkStream(stream, file.chunkSize)) {
        if (signal.aborted || this.pausedJobs.has(file.jobId)) {
          throw new ProviderError('network', 'aborted/paused mid-file');
        }
        md5?.update(chunk);
        const result = await withRetry(() => dest.uploadChunk(session, chunk, offset, file.sizeBytes), {
          signal,
          onRetry: (err, attempt, delay) => {
            this.metrics.retriesTotal.inc({ provider: dest.id, code: err.code });
            this.log.warn('retry', 'chunk upload retry', { code: err.code, attempt, delay }, { jobFileId: file.id });
          },
        });
        offset += chunk.length;
        this.metrics.transferBytesTotal.inc({ provider: dest.id }, chunk.length);

        if (result.done) {
          destFileId = result.file.id;
          destMd5 = result.file.checksum?.value;
        } else {
          await this.checkpoint(file.id, session.sessionUri, offset, job.id, chunk.length);
        }

        const now = Date.now();
        if (now - lastEmit > 500 || result.done) {
          lastEmit = now;
          const bps = offset > committedOffset ? Math.round(((offset - committedOffset) / (now - startedAt)) * 1000) : 0;
          this.bus.publish({
            t: 'file.progress',
            jobId: file.jobId,
            fileId: file.id,
            committedOffset: offset,
            sizeBytes: file.sizeBytes,
            bps,
            etaSec: bps > 0 ? Math.round((file.sizeBytes - offset) / bps) : null,
            currentChunk: Math.floor(offset / file.chunkSize),
          });
        }
      }

      if (!destFileId) {
        // Zero-byte file or provider finalized without a body — finalize explicitly.
        const finalized = await dest.completeUpload(session);
        destFileId = finalized.id;
        destMd5 = finalized.checksum?.value;
      }

      const localMd5 = md5?.digest('hex');
      const verified = localMd5 && destMd5 ? localMd5 === destMd5 : true; // size already enforced by Drive
      await this.completeFile(file, job.userId, destFileId, localMd5 ?? destMd5, verified);
    } catch (err) {
      await this.handleFileError(file, job.userId, err);
    }
  }

  /** Find/probe an existing open session or create a new one. */
  private async ensureSession(
    file: ClaimedFile,
    dest: CloudProvider,
    conflictPolicy: ConflictPolicy = 'skip',
  ): Promise<{ session: { sessionUri: string }; committedOffset: number; doneFile?: { id: string; checksum?: { value: string } } }> {
    const existing = await this.db
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.jobFileId, file.id), eq(uploadSessions.state, 'open')))
      .limit(1);

    if (existing[0]) {
      const session = { sessionUri: existing[0].sessionUri };
      const probe = await dest.probeUpload(session, file.sizeBytes).catch(() => null);
      if (probe?.status === 'open') {
        if (probe.committedOffset !== file.committedOffset) {
          await this.db.update(jobFiles).set({ committedOffset: probe.committedOffset }).where(eq(jobFiles.id, file.id));
        }
        return { session, committedOffset: probe.committedOffset };
      }
      if (probe?.status === 'completed' && probe.file) {
        await this.db.update(uploadSessions).set({ state: 'completed' }).where(eq(uploadSessions.id, existing[0].id));
        return { session, committedOffset: file.sizeBytes, doneFile: probe.file };
      }
      // expired
      await this.db.update(uploadSessions).set({ state: 'expired' }).where(eq(uploadSessions.id, existing[0].id));
    }

    let name = basename(file.sourcePath);
    const parentId = file.destParentId ?? 'root';
    // Resolve the destination name per the conflict policy at upload time.
    if (conflictPolicy === 'overwrite' || conflictPolicy === 'rename') {
      const existing = await dest.listFiles(parentId).catch(() => []);
      if (conflictPolicy === 'overwrite') {
        for (const e of existing) {
          if (e.name.toLowerCase() === name.toLowerCase()) await dest.delete(e.id).catch(() => {});
        }
      } else {
        name = uniqueName(name, new Set(existing.map((e) => e.name.toLowerCase())));
      }
    }
    const session = await dest.createUpload({ name, parentId, size: file.sizeBytes });
    await this.db.insert(uploadSessions).values({
      jobFileId: file.id,
      providerId: dest.id,
      sessionUri: session.sessionUri,
      state: 'open',
      lastOffset: 0,
      expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
    });
    await this.db.update(jobFiles).set({ committedOffset: 0 }).where(eq(jobFiles.id, file.id));
    return { session, committedOffset: 0 };
  }

  private async checkpoint(fileId: string, sessionUri: string, offset: number, jobId: string, delta: number): Promise<void> {
    await this.db
      .update(jobFiles)
      .set({ committedOffset: offset, claimHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(jobFiles.id, fileId));
    await this.db.update(uploadSessions).set({ lastOffset: offset, updatedAt: new Date() }).where(eq(uploadSessions.sessionUri, sessionUri));
    await this.db
      .update(jobs)
      .set({ transferredBytes: sql`${jobs.transferredBytes} + ${delta}`, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
  }

  private async completeFile(file: ClaimedFile, userId: string, destFileId?: string, md5?: string, verified?: boolean): Promise<void> {
    await this.db
      .update(jobFiles)
      .set({
        state: 'completed',
        destFileId: destFileId ?? null,
        auxMd5Hex: md5 ?? null,
        verified: verified ?? null,
        committedOffset: file.sizeBytes,
        claimedBy: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobFiles.id, file.id));
    await this.db
      .update(jobs)
      .set({ completedFiles: sql`${jobs.completedFiles} + 1`, updatedAt: new Date() })
      .where(eq(jobs.id, file.jobId));
    await this.db.update(uploadSessions).set({ state: 'completed' }).where(eq(uploadSessions.jobFileId, file.id));
    this.bus.publish({ t: 'file.state', jobId: file.jobId, fileId: file.id, state: 'completed', attempt: file.attempt });
    await this.events.append('FileCompleted', { fileId: file.id, path: file.sourcePath, verified }, userId);
    await this.maybeFinishJob(file.jobId, userId);
  }

  private async handleFileError(file: ClaimedFile, userId: string, err: unknown): Promise<void> {
    const pe = err instanceof ProviderError ? err : null;
    const message = (err as Error)?.message ?? String(err);
    if (pe) this.metrics.providerErrorsTotal.inc({ provider: 'engine', code: pe.code });

    // Session expired mid-stream → restart this file from scratch.
    if (pe?.code === 'session_expired') {
      await this.db.update(uploadSessions).set({ state: 'expired' }).where(eq(uploadSessions.jobFileId, file.id));
      await this.db.update(jobFiles).set({ state: 'pending', committedOffset: 0, claimedBy: null, error: message }).where(eq(jobFiles.id, file.id));
      return;
    }

    const retryable = pe?.retryable ?? false;
    if (retryable && file.attempt < MAX_FILE_ATTEMPTS) {
      await this.db.update(jobFiles).set({ state: 'pending', claimedBy: null, error: message, updatedAt: new Date() }).where(eq(jobFiles.id, file.id));
      await this.events.append('RetryScheduled', { fileId: file.id, attempt: file.attempt, code: pe?.code }, userId);
      this.log.warn('engine', 'file will retry', { attempt: file.attempt, code: pe?.code, err: message }, { jobFileId: file.id });
      return;
    }

    await this.db.update(jobFiles).set({ state: 'failed', claimedBy: null, error: message, finishedAt: new Date() }).where(eq(jobFiles.id, file.id));
    await this.db.update(jobs).set({ failedFiles: sql`${jobs.failedFiles} + 1`, updatedAt: new Date() }).where(eq(jobs.id, file.jobId));
    this.bus.publish({ t: 'file.state', jobId: file.jobId, fileId: file.id, state: 'failed', attempt: file.attempt, error: message });
    await this.events.append('FileFailed', { fileId: file.id, path: file.sourcePath, error: message }, userId);
    this.log.error('engine', 'file failed', { err: message, code: pe?.code }, { jobFileId: file.id });
    await this.maybeFinishJob(file.jobId, userId);
  }

  private async maybeFinishJob(jobId: string, userId: string): Promise<void> {
    const remaining = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobFiles)
      .where(and(eq(jobFiles.jobId, jobId), inArray(jobFiles.state, ['pending', 'downloading', 'uploading', 'verifying'])));
    if ((remaining[0]?.n ?? 0) > 0) return;

    const failed = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobFiles)
      .where(and(eq(jobFiles.jobId, jobId), eq(jobFiles.state, 'failed')));
    const finalState = (failed[0]?.n ?? 0) > 0 ? 'failed' : 'completed';
    await this.db.update(jobs).set({ state: finalState, finishedAt: new Date(), updatedAt: new Date() }).where(eq(jobs.id, jobId));
    this.publishJobState(jobId, finalState);
    await this.events.append(finalState === 'completed' ? 'JobCompleted' : 'JobFailed', { jobId }, userId);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async connectAccount(accountId: string): Promise<CloudProvider> {
    const rows = await this.db
      .select({ id: providerAccounts.id, providerId: providerAccounts.providerId, authBlob: providerAccounts.authBlob })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = rows[0];
    if (!account) throw new Error(`account ${accountId} not found`);
    return this.registry.connect(account as AccountRow);
  }

  private async getJob(jobId: string) {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    return rows[0] ?? null;
  }

  private async setJobState(jobId: string, state: (typeof jobs.state.enumValues)[number]): Promise<void> {
    await this.db.update(jobs).set({ state, updatedAt: new Date() }).where(eq(jobs.id, jobId));
  }

  private async failJob(jobId: string, error: string): Promise<void> {
    await this.db.update(jobs).set({ state: 'failed', error, finishedAt: new Date(), updatedAt: new Date() }).where(eq(jobs.id, jobId));
    this.publishJobState(jobId, 'failed', error);
  }

  private publishJobState(jobId: string, state: JobState, error?: string): void {
    this.bus.publish({ t: 'job.state', jobId, state, error });
  }
}

interface ClaimedFile {
  id: string;
  jobId: string;
  sourceNodeId: string;
  sourcePath: string;
  destParentId: string | null;
  sizeBytes: number;
  chunkSize: number;
  committedOffset: number;
  attempt: number;
}
