import { createHash, randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { keys } from '../db/schema.ts';
import { sources } from '../audit-events/catalog.ts';
export function validScope(scope: string) {
  return scope === 'read:admin' || scope === 'read:customer' || sources.some(source => scope === `write:${source}`);
}
export function hashKey(key: string) { return createHash('sha256').update(key).digest('hex'); }
export async function createKey(pool: Pool, scope: string) {
  if (!validScope(scope)) throw new Error('Invalid key scope');
  const key = randomBytes(32).toString('base64url');
  await drizzle(pool).insert(keys).values({ hash: hashKey(key), scope });
  return key;
}
export async function revokeKey(pool: Pool, hash: string) {
  const revoked = await drizzle(pool).update(keys).set({ revoked_at: new Date() }).where(eq(keys.hash, hash)).returning();
  if (!revoked.length) throw new Error('Unknown key hash');
}
