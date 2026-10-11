import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { catalog } from './catalog.ts';

const timestamp = z.iso.datetime({ offset: true });
const cursorSchema = z.object({ occurred_at: timestamp, recorded_at: timestamp, id: z.uuid() }).strict();
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(1024).optional(),
  source: z.string().min(1).optional(), module: z.string().min(1).optional(), action: z.string().min(1).optional(),
  actor_type: z.string().min(1).optional(), actor_id: z.string().min(1).optional(),
  subject_type: z.string().min(1).optional(), subject_id: z.string().min(1).optional(),
  outcome: z.enum(['success', 'failure']).optional(), from: timestamp.optional(), to: timestamp.optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), { message: 'from must precede to' });

export const requireAdministrator: RequestHandler = (_req, res, next) => {
  if (res.locals.scope !== 'read:admin') { res.status(403).json({ error: 'Administrator read key required' }); return; }
  next();
};

export function registerAdministratorList(app: Express, pool: Pool) {
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
    const values: unknown[] = [];
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const conditions: string[] = [];
    for (const column of ['source', 'module', 'action', 'actor_type', 'actor_id', 'subject_type', 'subject_id', 'outcome'] as const) {
      if (query[column] !== undefined) conditions.push(`${column} = ${parameter(query[column])}`);
    }
    if (query.from) conditions.push(`occurred_at >= ${parameter(query.from)}::timestamptz`);
    if (query.to) conditions.push(`occurred_at <= ${parameter(query.to)}::timestamptz`);
    if (cursor) conditions.push(`(occurred_at, recorded_at, id) < (${parameter(cursor.occurred_at)}::timestamptz, ${parameter(cursor.recorded_at)}::timestamptz, ${parameter(cursor.id)}::uuid)`);
    const result = await pool.query(`
      SELECT id, source, module, action, outcome,
        json_build_object('type', actor_type, 'id', actor_id, 'display_name', actor_display_name) AS actor,
        json_build_object('type', target_type, 'id', target_id, 'display_name', target_display_name) AS target,
        CASE WHEN subject_id IS NULL THEN NULL ELSE json_build_object('type', subject_type, 'id', subject_id, 'display_name', subject_display_name) END AS subject,
        description, customer_description, ip_address, user_agent,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
        to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
      FROM audit_events ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY audit_events.occurred_at DESC, audit_events.recorded_at DESC, audit_events.id DESC LIMIT ${parameter(query.limit + 1)}
    `, values);
    const page = result.rows.slice(0, query.limit);
    const last = page.at(-1);
    const next_cursor = result.rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ occurred_at: last.occurred_at, recorded_at: last.recorded_at, id: last.id })).toString('base64url') : null;
    res.json({ events: page, next_cursor });
  });
}
