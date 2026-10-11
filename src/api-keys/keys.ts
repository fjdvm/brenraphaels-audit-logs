import { createHash, randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { keys } from '../db/schema.ts';
import { sources } from '../audit-events/catalog.ts';
export function validScope(scope: string) {
  return scope === 'read:admin' || scope === 'read:customer' || sources.some(source => scope === `write:${source}`);
}
export function hashKey(key: string) { return createHash('sha256').update(key).digest('hex'); }
async function insertKey(db: Pick<ReturnType<typeof drizzle>, 'insert'>, scope: string) {
  const key = randomBytes(32).toString('base64url');
  await db.insert(keys).values({ hash: hashKey(key), scope });
  return key;
}
export async function createKey(pool: Pool, scope: string) {
  if (!validScope(scope)) throw new Error('Invalid key scope');
  return insertKey(drizzle(pool), scope);
}
export async function revokeKey(pool: Pool, hash: string) {
  const revoked = await drizzle(pool).update(keys).set({ revoked_at: new Date() }).where(and(eq(keys.hash, hash), isNull(keys.revoked_at))).returning();
  if (!revoked.length) throw new Error('Unknown or already revoked key hash');
}
export async function rotateKey(pool: Pool, hash: string, options: { overlap?: boolean } = {}) {
  return drizzle(pool).transaction(async tx => {
    const [old] = await tx.select().from(keys).where(eq(keys.hash, hash)).for('update');
    if (!old) throw new Error('Unknown key hash');
    if (old.revoked_at) throw new Error('Key is revoked');
    const key = await insertKey(tx, old.scope);
    if (!options.overlap) await tx.update(keys).set({ revoked_at: new Date() }).where(eq(keys.hash, hash));
    return key;
  });
}
