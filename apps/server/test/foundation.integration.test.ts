import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedProviders } from '../src/db/seed.js';
import { LogService } from '../src/services/log.service.js';
import { EventService } from '../src/services/event.service.js';
import { FlagsService } from '../src/services/flags.service.js';
import { ProviderAccountService } from '../src/services/provider-account.service.js';
import { ensureDefaultUser } from '../src/services/bootstrap-user.js';
import { createMetrics } from '../src/observability/metrics.js';
import { ProgressBus } from '../src/realtime/bus.js';
import { TransferEngine } from '../src/engine/engine.js';
import { buildServer } from '../src/api/server.js';

const PORT = 54329;
let pg: EmbeddedPostgres;
let dataDir: string;
let handle: DbHandle;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cloudcopy-pg-'));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('cloudcopy_test');
  handle = createDb(`postgres://postgres:postgres@localhost:${PORT}/cloudcopy_test`);
  await runMigrations(handle.db);
  await seedProviders(handle.db);
});

afterAll(async () => {
  await handle?.pool.end();
  await pg?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('migrations + seed', () => {
  it('created all 17 tables', async () => {
    const res = await handle.db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = res.rows.map((r) => r.table_name as string).sort();
    for (const expected of [
      'users', 'providers', 'provider_accounts', 'inventories', 'inventory_entries',
      'jobs', 'execution_plans', 'job_plan_entries', 'job_files', 'file_chunks',
      'upload_sessions', 'logs', 'events', 'settings', 'feature_flags', 'templates', 'schedules',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('seeded the provider catalog with capabilities', async () => {
    const res = await handle.db.execute(sql`SELECT id, capabilities FROM providers ORDER BY id`);
    const ids = res.rows.map((r) => r.id);
    expect(ids).toEqual(['gdrive', 'mega']);
    const gdrive = res.rows[0]!.capabilities as Record<string, unknown>;
    expect(gdrive.resume).toBe(true);
    expect(gdrive.chunkSizeMultipleOf).toBe(262144);
  });

  it('is idempotent (re-running migrate + seed is safe)', async () => {
    await runMigrations(handle.db);
    await seedProviders(handle.db);
  });
});

describe('log service', () => {
  it('batches rows into the logs table', async () => {
    const log = new LogService(handle.db, { level: 'silent' });
    log.info('system', 'phase 1 boot test', { foo: 'bar' });
    log.error('engine', 'retry scheduled', { attempt: 2 }, { jobId: '00000000-0000-0000-0000-000000000001' });
    await log.close();
    const res = await handle.db.execute(sql`SELECT level, category, message, data FROM logs ORDER BY id`);
    expect(res.rows.length).toBe(2);
    expect(res.rows[0]).toMatchObject({ level: 'info', category: 'system', message: 'phase 1 boot test' });
    expect((res.rows[1]!.data as Record<string, unknown>).attempt).toBe(2);
  });
});

describe('event store', () => {
  it('appends events and notifies listeners', async () => {
    const eventsSvc = new EventService(handle.db);
    const seen: string[] = [];
    const unsub = eventsSvc.onEvent((e) => seen.push(e.type));
    const stored = await eventsSvc.append('JobCreated', { jobId: 'x', name: 'test job' });
    unsub();
    expect(stored.id).toBeGreaterThan(0);
    expect(seen).toEqual(['JobCreated']);
    expect(EventService.isNotification('JobCompleted')).toBe(true);
    expect(EventService.isNotification('ChunkCompleted')).toBe(false);
  });
});

describe('feature flags', () => {
  it('sets, reads, and deletes flags', async () => {
    const flags = new FlagsService(handle.db);
    expect(await flags.isEnabled('planner_v2')).toBe(false);
    await flags.set('planner_v2', true, 'second-gen planner');
    expect(await flags.isEnabled('planner_v2')).toBe(true);
    const all = await flags.list();
    expect(all.find((f) => f.key === 'planner_v2')?.enabled).toBe(true);
    await flags.delete('planner_v2');
  });
});

describe('http server', () => {
  it('serves /healthz and /metrics', async () => {
    const config = loadConfig({
      DATABASE_URL: `postgres://postgres:postgres@localhost:${PORT}/cloudcopy_test`,
      CREDENTIALS_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const log = new LogService(handle.db, { level: 'silent' });
    const events = new EventService(handle.db);
    const bus = new ProgressBus();
    const metrics = createMetrics();
    const engine = new TransferEngine(config, handle.db, log, events, bus, metrics);
    const defaultUserId = await ensureDefaultUser(handle.db);
    const app = await buildServer({
      config,
      db: handle.db,
      log,
      events,
      flags: new FlagsService(handle.db),
      metrics,
      accounts: new ProviderAccountService(config, handle.db),
      engine,
      bus,
      defaultUserId,
    });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', version: '0.1.0' });

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain('cloudcopy_queue_depth');

    const docs = await app.inject({ method: 'GET', url: '/api/docs' });
    expect([200, 302]).toContain(docs.statusCode);

    await app.close();
    await log.close();
  });
});
