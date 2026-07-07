/**
 * Zero-config local dev bootstrap. If DATABASE_URL / CREDENTIALS_KEY aren't set,
 * spins up a persistent embedded PostgreSQL and generates a stable local key,
 * then hands off to the real server (src/index.ts). Docker not required.
 *
 * Production (Railway) sets DATABASE_URL, so this file is never used there.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEV_DIR = join(process.cwd(), '.dev');
const PG_DIR = join(DEV_DIR, 'pg');
const KEY_FILE = join(DEV_DIR, 'credentials.key');
const PG_PORT = Number(process.env.DEV_PG_PORT ?? 55432);

mkdirSync(DEV_DIR, { recursive: true });

if (!process.env.CREDENTIALS_KEY) {
  let key: string;
  if (existsSync(KEY_FILE)) {
    key = readFileSync(KEY_FILE, 'utf8').trim();
  } else {
    key = randomBytes(32).toString('base64');
    writeFileSync(KEY_FILE, key, { mode: 0o600 });
    console.log('[dev] generated local CREDENTIALS_KEY at .dev/credentials.key');
  }
  process.env.CREDENTIALS_KEY = key;
}

if (!process.env.DATABASE_URL) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const firstRun = !existsSync(join(PG_DIR, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
  });
  if (firstRun) {
    console.log('[dev] initialising embedded PostgreSQL (first run may take a minute)…');
    await pg.initialise();
  }
  await pg.start();
  if (firstRun) {
    await pg.createDatabase('cloudcopy');
  }
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/cloudcopy`;
  console.log(`[dev] embedded PostgreSQL ready on :${PG_PORT}`);

  const stop = async () => {
    try {
      await pg.stop();
    } catch {
      /* ignore */
    }
  };
  process.on('exit', () => void stop());
}

await import('./index.js');
