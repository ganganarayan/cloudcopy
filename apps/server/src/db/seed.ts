import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { providers } from './schema.js';

/**
 * Upsert the static provider catalog. Capabilities here mirror what the
 * adapters declare in code; adapters are the source of truth and re-sync on boot.
 */
export async function seedProviders(db: Db): Promise<void> {
  await db
    .insert(providers)
    .values([
      {
        id: 'mega',
        kind: 'mega',
        displayName: 'MEGA',
        capabilities: {
          version: 1,
          checksum: { algorithms: [] },
          multipart: false,
          resume: false,
          parallelUpload: false,
          serverCopy: false,
          changeFeed: false,
          softDelete: true,
          versioning: false,
          rangeDownload: true,
          minChunkSize: 262144,
          maxChunkSize: 1073741824,
          chunkSizeMultipleOf: 1,
        },
      },
      {
        id: 'gdrive',
        kind: 'gdrive',
        displayName: 'Google Drive',
        capabilities: {
          version: 1,
          checksum: { algorithms: ['md5'] },
          multipart: false,
          resume: true,
          parallelUpload: false,
          serverCopy: true,
          changeFeed: true,
          softDelete: true,
          versioning: true,
          rangeDownload: true,
          minChunkSize: 262144,
          maxChunkSize: 1073741824,
          chunkSizeMultipleOf: 262144,
        },
      },
    ])
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        displayName: sql`excluded.display_name`,
        capabilities: sql`excluded.capabilities`,
      },
    });
}
