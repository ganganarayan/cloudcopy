import 'dotenv/config';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { seedProviders } from './seed.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, pool } = createDb(url);
try {
  await runMigrations(db);
  await seedProviders(db);
  console.log('Migrations applied and provider catalog seeded.');
} finally {
  await pool.end();
}
