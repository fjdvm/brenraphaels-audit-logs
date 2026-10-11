import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { events } from '../db/schema.ts';
import { catalog } from './catalog.ts';

export const utc = (column: PgColumn) => sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type Identity = { type: string; id: string; display_name: string };

export const timestamp = z.iso.datetime({ offset: true });
export const cursorSchema = z.object({ occurred_at: timestamp, recorded_at: timestamp, id: z.uuid() }).strict();
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(1024).optional(),
  source: z.string().min(1).optional(), module: z.string().min(1).optional(), action: z.string().min(1).optional(),
  actor_type: z.string().min(1).optional(), actor_id: z.string().min(1).optional(),
  subject_type: z.string().min(1).optional(), subject_id: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  outcome: z.enum(['success', 'failure']).optional(), from: timestamp.optional(), to: timestamp.optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), { message: 'from must precede to' });

export const requireAdministrator: RequestHandler = (_req, res, next) => {
  if (res.locals.scope !== 'read:admin') { res.status(403).json({ error: 'Administrator read key required' }); return; }
  next();
};

export function registerAdministratorList(app: Express, pool: Pool) {
  const db = drizzle(pool);
  app.get('/events/valid-values', requireAdministrator, (_req, res) => { res.json({ sources: catalog }); });
  app.get('/events', requireAdministrator, async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid filters', details: parsed.error.issues }); return; }
    const query = parsed.data;
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
      catch { res.status(400).json({ error: 'Invalid cursor' }); return; }
    }
    const conditions: SQL[] = [];
    for (const column of ['source', 'module', 'action', 'actor_type', 'actor_id', 'subject_type', 'subject_id', 'outcome'] as const) {
      if (query[column] !== undefined) conditions.push(eq(events[column], query[column]));
    }
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(or(ilike(events.description, pattern), ilike(events.actor_display_name, pattern), ilike(events.subject_display_name, pattern))!);
    }
    // Bound strings cast to timestamptz keep the microseconds a JavaScript Date would truncate.
    if (query.from) conditions.push(sql`${events.occurred_at} >= ${query.from}::timestamptz`);
    if (query.to) conditions.push(sql`${events.occurred_at} <= ${query.to}::timestamptz`);
    if (cursor) conditions.push(sql`(${events.occurred_at}, ${events.recorded_at}, ${events.id}) < (${cursor.occurred_at}::timestamptz, ${cursor.recorded_at}::timestamptz, ${cursor.id}::uuid)`);
    const identity = (type: PgColumn, id: PgColumn, displayName: PgColumn) => sql<Identity>`json_build_object('type', ${type}, 'id', ${id}, 'display_name', ${displayName})`;
    const rows = await db.select({
      id: events.id, source: events.source, module: events.module, action: events.action, outcome: events.outcome,
      actor: identity(events.actor_type, events.actor_id, events.actor_display_name),
      target: identity(events.target_type, events.target_id, events.target_display_name),
      subject: sql<Identity | null>`CASE WHEN ${events.subject_id} IS NULL THEN NULL ELSE ${identity(events.subject_type, events.subject_id, events.subject_display_name)} END`,
      description: events.description, customer_description: events.customer_description,
      ip_address: events.ip_address, user_agent: events.user_agent,
      occurred_at: utc(events.occurred_at), recorded_at: utc(events.recorded_at),
    }).from(events).where(and(...conditions))
      .orderBy(desc(events.occurred_at), desc(events.recorded_at), desc(events.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const next_cursor = rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ occurred_at: last.occurred_at, recorded_at: last.recorded_at, id: last.id })).toString('base64url') : null;
    res.json({ events: page, next_cursor });
  });
}
