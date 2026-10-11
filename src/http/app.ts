import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { events, keys } from '../db/schema.ts';
import { hashKey } from '../api-keys/keys.ts';
import { actionCatalog, sources } from '../audit-events/catalog.ts';
import { registerAdministratorList, requireAdministrator } from '../audit-events/admin-events.ts';
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

export function createApp(pool: Pool, options: { rateLimitPerSecond?: number } = {}) {
  const rateLimit = options.rateLimitPerSecond ?? Number(process.env.RATE_LIMIT_PER_SECOND ?? 100);
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1) throw new Error('RATE_LIMIT_PER_SECOND must be a positive integer');
  const windows = new Map<string, { startedAt: number; requests: number }>();
  let lastCleanup = 0;
  const db = drizzle(pool);
  const app = express();
  app.post('/events/batch', express.json({ limit: '1600kb' }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/events', async (req, res, next) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) { res.status(401).json({ error: 'API key required' }); return; }
    const [key] = await db.select().from(keys).where(and(eq(keys.hash, hashKey(token)), isNull(keys.revoked_at)));
    if (!key) { res.status(401).json({ error: 'Invalid API key' }); return; }
    const now = Date.now();
    if (now - lastCleanup >= 1000) {
      for (const [hash, window] of windows) {
        if (now - window.startedAt >= 1000) windows.delete(hash);
      }
      lastCleanup = now;
    }
    let window = windows.get(key.hash);
    if (!window || now - window.startedAt >= 1000) {
      window = { startedAt: now, requests: 0 };
      windows.set(key.hash, window);
    }
    if (window.requests >= rateLimit) {
      res.set('Retry-After', '1').status(429).json({ error: 'API key rate limit exceeded', retry_after: 1 });
      return;
    }
    window.requests++;
    res.locals.scope = key.scope;
    next();
  });
  async function saveEvent(transaction: Parameters<Parameters<typeof db.transaction>[0]>[0], event: z.infer<typeof input>) {
    let [saved] = await transaction.insert(events).values({
      id: randomUUID(), source: event.source, action: event.action, outcome: event.outcome,
      actor_type: event.actor.type, actor_id: event.actor.id, actor_display_name: event.actor.display_name,
      target_type: event.target.type, target_id: event.target.id, target_display_name: event.target.display_name,
      subject_type: event.subject?.type, subject_id: event.subject?.id, subject_display_name: event.subject?.display_name,
      description: event.description, customer_description: event.customer_description,
      occurred_at: sql`${event.occurred_at}::timestamptz`, metadata: event.metadata, module: event.module,
      ip_address: event.ip_address, user_agent: event.user_agent, request_id: event.request_id, idempotency_key: event.idempotency_key,
    }).onConflictDoNothing({ target: [events.source, events.idempotency_key] }).returning({ id: events.id });
    if (!saved && event.idempotency_key !== undefined) {
      [saved] = await transaction.select({ id: events.id }).from(events).where(and(eq(events.source, event.source), eq(events.idempotency_key, event.idempotency_key)));
    }
    if (!saved) throw new Error('Audit Event could not be recorded');
    return saved;
  }
  app.post('/events/batch', async (req, res) => {
    if (!res.locals.scope.startsWith('write:')) { res.status(403).json({ error: 'Source write key required' }); return; }
    const parsed = z.object({ events: z.array(input).min(1).max(100) }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid Audit Event batch', details: parsed.error.issues }); return; }
    const wrongSource = parsed.data.events.findIndex(event => res.locals.scope !== `write:${event.source}`);
    if (wrongSource !== -1) { res.status(403).json({ error: 'Source write key required', index: wrongSource }); return; }
    const saved = await db.transaction(async transaction => {
      const results: { id: string }[] = [];
      for (const event of parsed.data.events) results.push(await saveEvent(transaction, event));
      return results;
    });
    res.status(201).json({ events: saved });
  });
  app.post('/events', async (req, res) => {
    if (!res.locals.scope.startsWith('write:') || (typeof req.body?.source === 'string' && res.locals.scope !== `write:${req.body.source}`)) { res.status(403).json({ error: 'Source write key required' }); return; }
    const parsed = input.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid Audit Event', details: parsed.error.issues }); return; }
    const event = parsed.data;
    const saved = await db.transaction(transaction => saveEvent(transaction, event));
    res.status(201).json(saved);
  });
  registerAdministratorList(app, pool);
  app.get('/events/:id', requireAdministrator, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: 'Invalid event id' }); return; }
    const [event] = await db.select().from(events).where(eq(events.id, id.data));
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
