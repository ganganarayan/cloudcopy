import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedProviders } from './db/seed.js';
import { LogService } from './services/log.service.js';
import { EventService } from './services/event.service.js';
import { FlagsService } from './services/flags.service.js';
import { ProviderAccountService } from './services/provider-account.service.js';
import { ensureDefaultUser } from './services/bootstrap-user.js';
import { createMetrics } from './observability/metrics.js';
import { ProviderRegistry } from './providers/registry.js';
import { ProgressBus } from './realtime/bus.js';
import { TransferEngine } from './engine/engine.js';
import { buildServer } from './api/server.js';

// Boot order: config → migrate → seed → recover(engine.start) → listen → pump.
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
  const bus = new ProgressBus();
  const registry = new ProviderRegistry(config);
  const accounts = new ProviderAccountService(config, db);
  const engine = new TransferEngine(config, db, log, events, bus, metrics, registry);

  const defaultUserId = await ensureDefaultUser(db);

  // Mirror engine events into the notification stream for the bell.
  events.onEvent((e) => {
    if (EventService.isNotification(e.type as never)) {
      bus.publish({ t: 'notification', eventId: String(e.id), type: e.type, payload: e.payload, createdAt: e.createdAt.toISOString() });
    }
  });

  const app = await buildServer({ config, db, log, events, flags, metrics, accounts, engine, bus, defaultUserId });
  await engine.start();
  await app.listen({ host: config.HOST, port: config.PORT });
  log.info('system', 'server listening', { host: config.HOST, port: config.PORT });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('system', 'shutting down', { signal });
    try {
      await engine.stop();
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
