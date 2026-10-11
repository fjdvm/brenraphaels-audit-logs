import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { events, keys } from './schema.ts';
import { hashKey } from './keys.ts';
import { catalog } from './catalog.ts';
import { registerAdministratorList, requireAdministrator } from './admin-events.ts';
const identity = z.object({ type: z.string().min(1), id: z.string().min(1), display_name: z.string().min(1) }).strict();
const input = z.object({
  source: z.string().min(1), module: z.string().min(1).nullish(), action: z.string().min(1),
  outcome: z.enum(['success', 'failure']), actor: identity, target: identity,
  subject: identity.nullish(), description: z.string().min(1), customer_description: z.string().min(1).nullish(),
  occurred_at: z.iso.datetime({ offset: true }),
}).strict().superRefine((event, context) => {
  const source = catalog.find(entry => entry.source === event.source);
  if (!source || !source.actions.some(action => action === event.action)) context.addIssue({ code: 'custom', path: ['action'], message: 'Unknown Source or Action' });
  if (event.module && !source?.modules.some(module => module === event.module)) context.addIssue({ code: 'custom', path: ['module'], message: 'Invalid Module for Source' });
});

export function createApp(pool: Pool) {
  const db = drizzle(pool);
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/events', async (req, res, next) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) { res.status(401).json({ error: 'API key required' }); return; }
    const [key] = await db.select().from(keys).where(and(eq(keys.hash, hashKey(token)), isNull(keys.revoked_at)));
    if (!key) { res.status(401).json({ error: 'Invalid API key' }); return; }
    res.locals.scope = key.scope;
    next();
  });
  app.post('/events', async (req, res) => {
    if (!res.locals.scope.startsWith('write:')) { res.status(403).json({ error: 'Source write key required' }); return; }
    const parsed = input.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid Audit Event', details: parsed.error.issues }); return; }
    const event = parsed.data;
    if (res.locals.scope !== `write:${event.source}`) { res.status(403).json({ error: 'Source write key required' }); return; }
    const [saved] = await db.insert(events).values({
      id: randomUUID(), source: event.source, module: event.module, action: event.action, outcome: event.outcome,
      actor_type: event.actor.type, actor_id: event.actor.id, actor_display_name: event.actor.display_name,
      target_type: event.target.type, target_id: event.target.id, target_display_name: event.target.display_name,
      subject_type: event.subject?.type, subject_id: event.subject?.id, subject_display_name: event.subject?.display_name,
      description: event.description, customer_description: event.customer_description,
      occurred_at: sql`${event.occurred_at}::timestamptz`,
    }).returning({ id: events.id });
    res.status(201).json(saved);
  });
  registerAdministratorList(app, pool);
  app.get('/events/:id', requireAdministrator, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: 'Invalid event id' }); return; }
    const [event] = await db.select().from(events).where(eq(events.id, id.data));
    if (!event) { res.status(404).json({ error: 'Audit Event not found' }); return; }
    res.json({
      id: event.id, source: event.source, module: event.module, action: event.action, outcome: event.outcome,
      actor: { type: event.actor_type, id: event.actor_id, display_name: event.actor_display_name },
      target: { type: event.target_type, id: event.target_id, display_name: event.target_display_name },
      subject: event.subject_id === null ? null : { type: event.subject_type, id: event.subject_id, display_name: event.subject_display_name },
      description: event.description, customer_description: event.customer_description,
      occurred_at: event.occurred_at.toISOString(), recorded_at: event.recorded_at.toISOString(),
    });
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request body' });
  };
  app.use(errors);
  return app;
}
