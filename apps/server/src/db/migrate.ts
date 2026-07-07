import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

/**
 * Apply committed SQL migrations at boot, before recovery and the engine start.
 * tsup bundles src into dist/index.js, so resolve the folder relative to cwd in
 * production (Docker copies migrations alongside dist) with a src fallback for dev.
 */
export async function runMigrations(db: Db): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'), // dev: src/db/migrations
    join(process.cwd(), 'migrations'), // prod image: /app/migrations
    join(process.cwd(), 'src', 'db', 'migrations'),
  ];
  const { existsSync } = await import('node:fs');
  const migrationsFolder = candidates.find((p) => existsSync(p));
  if (!migrationsFolder) {
    throw new Error(`No migrations folder found. Looked in: ${candidates.join(', ')}`);
  }
  await migrate(db, { migrationsFolder });
}
