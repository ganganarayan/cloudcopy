import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedProviders } from './db/seed.js';
import { LogService } from './services/log.service.js';
import { EventService } from './services/event.service.js';
import { FlagsService } from './services/flags.service.js';
import { createMetrics } from './observability/metrics.js';
import { buildServer } from './api/server.js';

// Boot order (frozen design): config → migrate → seed → [recover: Phase 5] →
// listen → [start workers: Phase 4B]. Graceful SIGTERM keeps checkpoints clean.
const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const log = new LogService(db, { level: config.LOG_LEVEL });

try {
  await runMigrations(db);
  await seedProviders(db);
  log.info('system', 'migrations applied, provider catalog seeded');

  if (config.engine.clamped) {
    log.warn('system', 'ENGINE_CHUNKS_PER_FILE clamped to fit memory budget', {
      chunksPerFile: config.engine.chunksPerFile,
      budgetMb: config.engine.memoryBudgetMb,
    });
  }

  const events = new EventService(db);
  const flags = new FlagsService(db);
  const metrics = createMetrics();

  const app = await buildServer({ config, db, log, events, flags, metrics });
  await app.listen({ host: config.HOST, port: config.PORT });
  log.info('system', 'server listening', { host: config.HOST, port: config.PORT });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('system', 'shutting down', { signal });
    try {
      await app.close();
      await log.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error('shutdown error', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
} catch (err) {
  log.pino.fatal({ err }, 'boot failed');
  await log.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
}
