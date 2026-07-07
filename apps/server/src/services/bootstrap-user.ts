import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';

const DEFAULT_EMAIL = 'owner@cloudcopy.local';
const DEFAULT_SUB = 'local-owner';

/**
 * Single-user mode: ensure one owner user exists and return its id. Every request
 * acts as this user until real multi-user Google login lands.
 */
export async function ensureDefaultUser(db: Db): Promise<string> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.googleSub, DEFAULT_SUB)).limit(1);
  if (existing[0]) return existing[0].id;
  const [row] = await db
    .insert(users)
    .values({ googleSub: DEFAULT_SUB, email: DEFAULT_EMAIL, displayName: 'Owner', role: 'admin' })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (row) return row.id;
  const again = await db.select({ id: users.id }).from(users).where(eq(users.googleSub, DEFAULT_SUB)).limit(1);
  return again[0]!.id;
}
