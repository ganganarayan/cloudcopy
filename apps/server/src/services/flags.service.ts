import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { featureFlags } from '../db/schema.js';

const CACHE_TTL_MS = 10_000;

/**
 * Feature flags with a short read-through cache — safe rollouts for
 * planner_v2, parallel_writer, etc. without redeploys.
 */
export class FlagsService {
  private cache = new Map<string, boolean>();
  private loadedAt = 0;

  constructor(private readonly db: Db) {}

  async isEnabled(key: string): Promise<boolean> {
    await this.reloadIfStale();
    return this.cache.get(key) ?? false;
  }

  async list(): Promise<Array<{ key: string; enabled: boolean; description: string | null }>> {
    const rows = await this.db.select().from(featureFlags);
    return rows.map((r) => ({ key: r.key, enabled: r.enabled, description: r.description }));
  }

  async set(key: string, enabled: boolean, description?: string): Promise<void> {
    await this.db
      .insert(featureFlags)
      .values({ key, enabled, description: description ?? null, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: featureFlags.key,
        set: { enabled, ...(description !== undefined ? { description } : {}), updatedAt: new Date() },
      });
    this.cache.set(key, enabled);
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(featureFlags).where(eq(featureFlags.key, key));
    this.cache.delete(key);
  }

  private async reloadIfStale(): Promise<void> {
    if (Date.now() - this.loadedAt < CACHE_TTL_MS) return;
    const rows = await this.db.select().from(featureFlags);
    this.cache = new Map(rows.map((r) => [r.key, r.enabled]));
    this.loadedAt = Date.now();
  }
}
