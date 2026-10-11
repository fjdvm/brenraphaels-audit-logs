import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { events, keys } from './schema.ts';
import { hashKey } from './keys.ts';
import { actionCatalog, sources } from './catalog.ts';
function validText(value: string): boolean { return !/[\u0000\uD800-\uDFFF]/u.test(value); }
const text = z.string().min(1).refine(validText, 'Invalid text');
const identity = z.object({ type: text, id: text, display_name: text }).strict();
function unsafeMetadata(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string' && !validText(current)) return true;
    if (current !== null && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (!validText(key) || /password|token|secret|authorization|card|cvv/i.test(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}
const metadata = z.record(z.string(), z.json()).refine(value => !unsafeMetadata(value), 'Sensitive metadata key or invalid text')
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4096, 'Metadata exceeds 4 KB');
const input = z.object({
  source: z.enum(sources), action: text,
  outcome: z.enum(['success', 'failure']), actor: identity, target: identity,
  subject: identity.nullish(), description: text, customer_description: text.nullish(),
  occurred_at: z.iso.datetime({ offset: true }).refine(value => Date.parse(value) <= Date.now() + 5 * 60 * 1000, 'Occurred at exceeds five minutes in the future'),
  idempotency_key: text.optional(),
  metadata: metadata.optional(), module: text.nullish(),
  ip_address: z.union([z.ipv4(), z.ipv6()]).nullish(), user_agent: text.nullish(), request_id: text.nullish(),
}).strict().refine(event => (actionCatalog[event.source] as readonly string[]).includes(event.action), { message: 'Unknown Action for Source', path: ['action'] }).refine(event => event.module == null || ['CRMS', 'HRMS', 'POS', 'IMS'].includes(event.source), { message: 'Module is only allowed for CRMS, HRMS, POS and IMS', path: ['module'] });

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
    if (!res.locals.scope.startsWith('write:') || (typeof req.body?.source === 'string' && res.locals.scope !== `write:${req.body.source}`)) { res.status(403).json({ error: 'Source write key required' }); return; }
    const parsed = input.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid Audit Event', details: parsed.error.issues }); return; }
    const event = parsed.data;
    let [saved] = await db.insert(events).values({
      id: randomUUID(), source: event.source, action: event.action, outcome: event.outcome,
      actor_type: event.actor.type, actor_id: event.actor.id, actor_display_name: event.actor.display_name,
      target_type: event.target.type, target_id: event.target.id, target_display_name: event.target.display_name,
      subject_type: event.subject?.type, subject_id: event.subject?.id, subject_display_name: event.subject?.display_name,
      description: event.description, customer_description: event.customer_description,
      occurred_at: new Date(event.occurred_at), metadata: event.metadata, module: event.module,
      ip_address: event.ip_address, user_agent: event.user_agent, request_id: event.request_id, idempotency_key: event.idempotency_key,
    }).onConflictDoNothing({ target: [events.source, events.idempotency_key] }).returning({ id: events.id });
    if (!saved && event.idempotency_key !== undefined) {
      [saved] = await db.select({ id: events.id }).from(events).where(and(eq(events.source, event.source), eq(events.idempotency_key, event.idempotency_key)));
    }
    if (!saved) throw new Error('Audit Event could not be recorded');
    res.status(201).json(saved);
  });
  app.get('/events/:id', async (req, res) => {
    if (res.locals.scope !== 'read:admin') { res.status(403).json({ error: 'Administrator read key required' }); return; }
    if (!z.uuid().safeParse(req.params.id).success) { res.status(400).json({ error: 'Invalid event id' }); return; }
    const [event] = await db.select().from(events).where(eq(events.id, req.params.id));
    if (!event) { res.status(404).json({ error: 'Audit Event not found' }); return; }
    res.json({
      metadata: event.metadata, module: event.module,
      ip_address: event.ip_address, user_agent: event.user_agent, request_id: event.request_id, idempotency_key: event.idempotency_key,
      id: event.id, source: event.source, action: event.action, outcome: event.outcome,
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
