import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../server.js';
import { jobFiles, jobs } from '../../db/schema.js';
import { transferOptionsSchema } from '../../engine/options.js';

const selectionEntry = z.object({
  nodeId: z.string(),
  path: z.string(),
  isFolder: z.boolean(),
});

const createJobBody = z.object({
  name: z.string().min(1),
  sourceAccountId: z.string().uuid(),
  destAccountId: z.string().uuid(),
  sourceSelection: z.array(selectionEntry).min(1),
  destFolderId: z.string().min(1),
  destFolderPath: z.string().optional(),
  mode: z.enum(['copy', 'mirror', 'incremental', 'update_only']).optional(),
  options: transferOptionsSchema.optional(),
});

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/jobs', async (req, reply) => {
    const body = createJobBody.parse(req.body);
    const id = await ctx.engine.createJob({ userId: ctx.defaultUserId, ...body });
    return reply.status(201).send({ id });
  });

  app.get('/jobs', async () => {
    const rows = await ctx.db
      .select()
      .from(jobs)
      .where(eq(jobs.userId, ctx.defaultUserId))
      .orderBy(desc(jobs.createdAt))
      .limit(100);
    return { jobs: rows.map(jobSummary) };
  });

  app.get('/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await ctx.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!rows[0]) return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'job not found' });
    return { job: jobSummary(rows[0]) };
  });

  app.get('/jobs/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const rows = await ctx.db
      .select()
      .from(jobFiles)
      .where(eq(jobFiles.jobId, id))
      .orderBy(jobFiles.sourcePath)
      .limit(2000);
    return {
      files: rows.map((f) => ({
        id: f.id,
        path: f.sourcePath,
        state: f.state,
        size: f.sizeBytes,
        committedOffset: f.committedOffset,
        attempt: f.attempt,
        verified: f.verified,
        error: f.error,
      })),
    };
  });

  for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) {
    app.post(`/jobs/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      await ctx.engine[action](id);
      return { ok: true };
    });
  }
}

function jobSummary(j: typeof jobs.$inferSelect) {
  return {
    id: j.id,
    name: j.name,
    state: j.state,
    mode: j.mode,
    totalFiles: j.totalFiles,
    totalBytes: j.totalBytes,
    transferredBytes: j.transferredBytes,
    completedFiles: j.completedFiles,
    failedFiles: j.failedFiles,
    skippedFiles: j.skippedFiles,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
  };
}
