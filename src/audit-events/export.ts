import type { Express, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { events } from '../db/schema.ts';
import { datesMessage, datesOrdered, filterConditions, filterShape, listFields, requireAdministrator, timestamp } from './admin-events.ts';

export const exportRowCap = 50_000;
const batchSize = 1000;

// The portal's Administrator is not a key, so the caller names who is asking.
const exportSchema = z.object({
  ...filterShape, from: timestamp, to: timestamp, format: z.enum(['csv', 'json']),
  requested_by_id: z.string().min(1), requested_by_name: z.string().min(1),
}).strict().refine(datesOrdered, datesMessage);

const csvColumns = ['id', 'source', 'module', 'action', 'outcome', 'actor_type', 'actor_id', 'actor_display_name', 'target_type', 'target_id', 'target_display_name',
  'subject_type', 'subject_id', 'subject_display_name', 'description', 'customer_description', 'ip_address', 'user_agent', 'occurred_at', 'recorded_at'] as const;
type Row = Awaited<ReturnType<ReturnType<typeof readBatch>>>[number];

const csvField = (value: unknown) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
function csvLine(row: Row) {
  const flat: Record<string, unknown> = {
    ...row, actor_type: row.actor.type, actor_id: row.actor.id, actor_display_name: row.actor.display_name,
    target_type: row.target.type, target_id: row.target.id, target_display_name: row.target.display_name,
    subject_type: row.subject?.type, subject_id: row.subject?.id, subject_display_name: row.subject?.display_name,
  };
  return `${csvColumns.map(column => csvField(flat[column])).join(',')}\r\n`;
}

function readBatch(db: ReturnType<typeof drizzle>, conditions: ReturnType<typeof filterConditions>) {
  return async (take: number, after?: { occurred_at: string; recorded_at: string; id: string }) => db.select(listFields).from(events)
    .where(and(...conditions, after && sql`(${events.occurred_at}, ${events.recorded_at}, ${events.id}) < (${after.occurred_at}::timestamptz, ${after.recorded_at}::timestamptz, ${after.id}::uuid)`))
    .orderBy(desc(events.occurred_at), desc(events.recorded_at), desc(events.id)).limit(take);
}

async function write(res: Response, chunk: string) {
  if (!res.write(chunk)) await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve); });
}

export function registerExport(app: Express, pool: Pool, options: { maxRows?: number } = {}) {
  const maxRows = options.maxRows ?? exportRowCap;
  const db = drizzle(pool);
  app.get('/events/export', requireAdministrator, async (req, res) => {
    const parsed = exportSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid export request: from, to, format, requested_by_id and requested_by_name are required', details: parsed.error.issues }); return; }
    const { format, requested_by_id, requested_by_name, ...filters } = parsed.data;
    const conditions = filterConditions(filters);
    const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(events).where(and(...conditions));
    const total = counted?.total ?? 0;
    if (total > maxRows) {
      res.status(413).json({ error: `Export matches ${total} events, more than ${maxRows} rows. Narrow the date range or filters.`, row_count: total, limit: maxRows });
      return;
    }
    const exportId = randomUUID();
    await db.insert(events).values({
      id: exportId, source: 'Authentication', action: 'audit_log.exported', outcome: 'success',
      actor_type: 'user', actor_id: requested_by_id, actor_display_name: requested_by_name,
      target_type: 'audit_log', target_id: 'audit-events', target_display_name: 'Audit log',
      description: `${requested_by_name} exported ${total} audit events as ${format.toUpperCase()}.`,
      occurred_at: sql`now()`, metadata: { format, row_count: total, filters },
    });
    // The export event describes this export, so it never appears inside it.
    const read = readBatch(db, [...conditions, ne(events.id, exportId)]);
    res.status(200).set({
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-events.${format}"`,
    });
    await write(res, format === 'csv' ? `${csvColumns.join(',')}\r\n` : '{"events":[');
    let sent = 0;
    let after: Parameters<typeof read>[1];
    while (sent < maxRows && !res.destroyed) {
      const rows = await read(Math.min(batchSize, maxRows - sent), after);
      for (const row of rows) await write(res, format === 'csv' ? csvLine(row) : `${sent++ ? ',' : ''}${JSON.stringify(row)}`);
      if (format === 'csv') sent += rows.length;
      const last = rows.at(-1);
      if (rows.length < batchSize || !last) break;
      after = last;
    }
    res.end(format === 'json' ? ']}' : undefined);
  });
}
