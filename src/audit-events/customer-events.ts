import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { events } from '../db/schema.ts';
import { cursorSchema, utc } from './admin-events.ts';

// The only filters are the required Subject and paging: nothing else can widen the result beyond that Customer.
const querySchema = z.object({
  subject_type: z.string().min(1), subject_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(1024).optional(),
}).strict();

const requireCustomerRead: RequestHandler = (_req, res, next) => {
  if (res.locals.scope !== 'read:customer') { res.status(403).json({ error: 'Customer read key required' }); return; }
  next();
};

export function registerCustomerActivity(app: Express, pool: Pool) {
  const db = drizzle(pool);
  app.get('/events/customer-activity', requireCustomerRead, async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid query', details: parsed.error.issues }); return; }
    const query = parsed.data;
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
      catch { res.status(400).json({ error: 'Invalid cursor' }); return; }
    }
    const rows = await db.select({
      id: events.id, source: events.source, action: events.action, outcome: events.outcome,
      customer_description: events.customer_description,
      occurred_at: utc(events.occurred_at), recorded_at: utc(events.recorded_at),
    }).from(events).where(and(
      eq(events.subject_type, query.subject_type), eq(events.subject_id, query.subject_id), isNotNull(events.customer_description),
      cursor && sql`(${events.occurred_at}, ${events.recorded_at}, ${events.id}) < (${cursor.occurred_at}::timestamptz, ${cursor.recorded_at}::timestamptz, ${cursor.id}::uuid)`,
    )).orderBy(desc(events.occurred_at), desc(events.recorded_at), desc(events.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const next_cursor = rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ occurred_at: last.occurred_at, recorded_at: last.recorded_at, id: last.id })).toString('base64url') : null;
    res.json({ events: page.map(({ recorded_at: _recorded, ...event }) => event), next_cursor });
  });
}
