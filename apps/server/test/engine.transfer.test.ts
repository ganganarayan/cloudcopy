import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { eq } from 'drizzle-orm';
import type { CloudProvider } from '@cloudcopy/provider-sdk';
import { loadConfig } from '../src/config.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedProviders } from '../src/db/seed.js';
import { jobFiles, jobs, providerAccounts, uploadSessions, users } from '../src/db/schema.js';
import { LogService } from '../src/services/log.service.js';
import { EventService } from '../src/services/event.service.js';
import { createMetrics } from '../src/observability/metrics.js';
import { ProgressBus } from '../src/realtime/bus.js';
import { TransferEngine } from '../src/engine/engine.js';
import { FakeDestProvider, FakeRegistry, FakeSourceProvider, genBytes } from './fakes.js';

const PORT = 54330;
let pg: EmbeddedPostgres;
let dataDir: string;
let handle: DbHandle;
let userId: string;
let sourceAccountId: string;
let destAccountId: string;

const config = loadConfig({
  DATABASE_URL: `postgres://postgres:postgres@localhost:${PORT}/cloudcopy_test`,
  CREDENTIALS_KEY: randomBytes(32).toString('base64'),
  LOG_LEVEL: 'silent',
  ENGINE_CHUNK_SIZE: '262144', // 256 KiB so 1 MB files span multiple chunks
} as NodeJS.ProcessEnv);

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const jobState = (id: string) =>
  handle.db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id)).limit(1).then((r) => r[0]?.state);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cloudcopy-eng-'));
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('cloudcopy_test');
  handle = createDb(config.DATABASE_URL);
  await runMigrations(handle.db);
  await seedProviders(handle.db);

  const [u] = await handle.db.insert(users).values({ googleSub: 'test', email: 'test@t.co', role: 'admin' }).returning({ id: users.id });
  userId = u!.id;
  const [src] = await handle.db
    .insert(providerAccounts)
    .values({ userId, providerId: 'mega', label: 'src', authBlob: Buffer.from('x'), authMeta: {} })
    .returning({ id: providerAccounts.id });
  const [dst] = await handle.db
    .insert(providerAccounts)
    .values({ userId, providerId: 'gdrive', label: 'dst', authBlob: Buffer.from('x'), authMeta: {} })
    .returning({ id: providerAccounts.id });
  sourceAccountId = src!.id;
  destAccountId = dst!.id;
});

afterAll(async () => {
  await handle?.pool.end();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeEngine(source: FakeSourceProvider, dest: FakeDestProvider): TransferEngine {
  const registry = new FakeRegistry(
    new Map<string, CloudProvider>([
      [sourceAccountId, source],
      [destAccountId, dest],
    ]),
  );
  return new TransferEngine(config, handle.db, new LogService(handle.db, { level: 'silent' }), new EventService(handle.db), new ProgressBus(), createMetrics(), registry);
}

describe('transfer engine (fake providers)', () => {
  it('streams a multi-chunk file MEGA→Drive and verifies md5', async () => {
    const source = new FakeSourceProvider();
    const dest = new FakeDestProvider();
    const size = 1_000_000;
    source.addFile('f1', size, 11);
    const engine = makeEngine(source, dest);
    await engine.start();
    try {
      const jobId = await engine.createJob({
        userId,
        name: 'straight',
        sourceAccountId,
        destAccountId,
        sourceSelection: [{ nodeId: 'f1', path: 'f1.bin', isFolder: false }],
        destFolderId: 'dest-root',
      });
      await poll(() => jobState(jobId), (s) => s === 'completed' || s === 'failed');
      expect(await jobState(jobId)).toBe('completed');

      const [file] = await handle.db.select().from(jobFiles).where(eq(jobFiles.jobId, jobId));
      expect(file?.state).toBe('completed');
      expect(file?.verified).toBe(true);

      const upload = [...dest.uploads.values()][0]!;
      expect(upload.received.length).toBe(size);
      expect(createHash('md5').update(upload.received).digest('hex')).toBe(
        createHash('md5').update(genBytes(size, 11)).digest('hex'),
      );
    } finally {
      await engine.stop();
    }
  });

  it('resumes from committed_offset without re-uploading committed bytes', async () => {
    const source = new FakeSourceProvider();
    const dest = new FakeDestProvider();
    const size = 800_000;
    const committed = 300_000;
    source.addFile('f2', size, 22);

    // Simulate a mid-transfer restart: session already has the first `committed` bytes.
    const session = await dest.createUpload({ name: 'f2.bin', parentId: 'dest-root', size });
    dest.uploads.get(session.sessionUri)!.received = genBytes(size, 22).subarray(0, committed);

    const [job] = await handle.db
      .insert(jobs)
      .values({
        userId,
        name: 'resume',
        sourceAccountId,
        destAccountId,
        sourceSelection: [],
        destFolderId: 'dest-root',
        state: 'running',
        totalFiles: 1,
        totalBytes: size,
        startedAt: new Date(),
      })
      .returning({ id: jobs.id });
    const [file] = await handle.db
      .insert(jobFiles)
      .values({
        jobId: job!.id,
        state: 'pending',
        sourceNodeId: 'f2',
        sourcePath: 'f2.bin',
        destParentId: 'dest-root',
        sizeBytes: size,
        chunkSize: config.engine.chunkSize,
        committedOffset: committed,
      })
      .returning({ id: jobFiles.id });
    await handle.db.insert(uploadSessions).values({
      jobFileId: file!.id,
      providerId: 'gdrive',
      sessionUri: session.sessionUri,
      state: 'open',
      lastOffset: committed,
    });

    const engine = makeEngine(source, dest);
    await engine.start();
    try {
      await poll(() => jobState(job!.id), (s) => s === 'completed' || s === 'failed');
      expect(await jobState(job!.id)).toBe('completed');
      const upload = dest.uploads.get(session.sessionUri)!;
      expect(upload.received.length).toBe(size);
      // Full content matches — proves resumed bytes were correct and none were duplicated.
      expect(createHash('md5').update(upload.received).digest('hex')).toBe(
        createHash('md5').update(genBytes(size, 22)).digest('hex'),
      );
    } finally {
      await engine.stop();
    }
  });

  it('retries a transient 429 and still completes', async () => {
    const source = new FakeSourceProvider();
    const dest = new FakeDestProvider();
    const size = 600_000;
    source.addFile('f3', size, 33);
    dest.failAtOffset = 262_144; // fail once on the 2nd chunk

    const engine = makeEngine(source, dest);
    await engine.start();
    try {
      const jobId = await engine.createJob({
        userId,
        name: 'retry',
        sourceAccountId,
        destAccountId,
        sourceSelection: [{ nodeId: 'f3', path: 'f3.bin', isFolder: false }],
        destFolderId: 'dest-root',
      });
      await poll(() => jobState(jobId), (s) => s === 'completed' || s === 'failed');
      expect(await jobState(jobId)).toBe('completed');
      const upload = [...dest.uploads.values()][0]!;
      expect(createHash('md5').update(upload.received).digest('hex')).toBe(
        createHash('md5').update(genBytes(size, 33)).digest('hex'),
      );
    } finally {
      await engine.stop();
    }
  });
});
