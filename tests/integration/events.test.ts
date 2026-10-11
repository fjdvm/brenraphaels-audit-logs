import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/app.ts';
import { createKey, revokeKey } from '../../src/keys.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
const app = createApp(runtime);
let writeKey: string;
let readKey: string;
const event = {
  source: 'Authentication', action: 'user.login', outcome: 'success',
  actor: { type: 'user', id: 'user-1', display_name: 'Alice' },
  target: { type: 'session', id: 'session-1', display_name: 'Portal session' },
  subject: { type: 'user', id: 'user-1', display_name: 'Alice' },
  description: 'Alice signed in.', customer_description: 'You signed in.',
  occurred_at: '2026-01-01T12:00:00.000Z',
};
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_DATABASE_URL_RUNTIME) {
    throw new Error('Set TEST_DATABASE_URL and TEST_DATABASE_URL_RUNTIME to a disposable migrated Postgres database');
  }
  writeKey = await createKey(owner, 'write:Authentication');
  readKey = await createKey(owner, 'read:admin');
});
afterAll(async () => { await Promise.all([owner.end(), runtime.end()]); });

test('Authentication writes an Audit Event and an Administrator reads every field back', async () => {
  const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send(event);
  expect(written.status).toBe(201);
  const read = await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' });
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ ...event, id: written.body.id });
  expect(Date.parse(read.body.recorded_at)).toBeGreaterThanOrEqual(Date.parse(event.occurred_at));
});

test('missing, unknown and revoked keys cannot write or read Audit Events', async () => {
  const revoked = await createKey(owner, 'write:Authentication');
  const { hashKey } = await import('../../src/keys.ts');
  await revokeKey(owner, hashKey(revoked));
  for (const key of [undefined, 'unknown-key', revoked]) {
    const write = request(app).post('/events');
    const read = request(app).get('/events/00000000-0000-4000-8000-000000000000');
    if (key) { write.auth(key, { type: 'bearer' }); read.auth(key, { type: 'bearer' }); }
    expect((await write.send(event)).status).toBe(401);
    expect((await read).status).toBe(401);
  }
});

test('keys only authorize their own Source and read scope', async () => {
  const other = await createKey(owner, 'write:Ecommerce');
  for (const key of [other, readKey]) {
    expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send(event)).status).toBe(403);
  }
  for (const key of [writeKey, await createKey(owner, 'read:customer')]) {
    expect((await request(app).get('/events/00000000-0000-4000-8000-000000000000').auth(key, { type: 'bearer' })).status).toBe(403);
  }
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, source: 'Ecommerce', action: 'order.placed' })).status).toBe(403);
});

test('an Action outside the Authentication catalog is rejected', async () => {
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, action: 'user.typo' })).status).toBe(400);
});

test('runtime cannot UPDATE or DELETE Audit Events or alter API keys', async () => {
  for (const sql of ["UPDATE audit_events SET description = 'tampered'", 'DELETE FROM audit_events', 'UPDATE api_keys SET revoked_at = NULL', 'DELETE FROM api_keys']) {
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' });
  }
});

test('API keys are stored only as hashes', async () => {
  const { hashKey } = await import('../../src/keys.ts');
  const stored = await owner.query('SELECT hash FROM api_keys WHERE hash = $1', [hashKey(writeKey)]);
  expect(stored.rows).toEqual([{ hash: hashKey(writeKey) }]);
  expect((await owner.query('SELECT hash FROM api_keys WHERE hash = $1', [writeKey])).rowCount).toBe(0);
});

test('optional Subject and Customer description can be absent', async () => {
  const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, subject: null, customer_description: null, outcome: 'failure' });
  expect(written.status).toBe(201);
  const read = await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' });
  expect(read.body).toMatchObject({ subject: null, customer_description: null, outcome: 'failure' });
});

test('anonymization role can change only personal fields and cannot delete events', async () => {
  const client = await owner.connect();
  try {
    await client.query('SET ROLE audit_anonymize');
    await client.query("UPDATE audit_events SET actor_display_name = 'Deleted customer' WHERE false");
    await expect(client.query("UPDATE audit_events SET description = 'tampered' WHERE false")).rejects.toMatchObject({ code: '42501' });
    await expect(client.query('DELETE FROM audit_events WHERE false')).rejects.toMatchObject({ code: '42501' });
  } finally { await client.query('RESET ROLE'); client.release(); }
});

test('Administrator walks timestamp ties newest first without omissions or duplicates', async () => {
  const actor = { ...event.actor, id: `pagination-${crypto.randomUUID()}` };
  const ids: string[] = [];
  for (const occurred_at of ['2025-01-01T00:00:00.123456Z', '2025-01-02T00:00:00.123456Z', '2025-01-02T00:00:00.123456Z']) {
    const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, actor, occurred_at });
    expect(written.status).toBe(201);
    ids.push(written.body.id);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query({ actor_type: actor.type, actor_id: actor.id, limit: 1, ...(cursor ? { cursor } : {}) });
    expect(page.status).toBe(200);
    seen.push(...page.body.events.map((item: { id: string }) => item.id));
    cursor = page.body.next_cursor;
  } while (cursor);
  expect(seen).toEqual(ids.reverse());
});

test('Administrator valid values include every Source and portal Modules', async () => {
  const response = await request(app).get('/events/valid-values').auth(readKey, { type: 'bearer' });
  expect(response.status).toBe(200);
  expect(Object.keys(response.body)).toEqual(['sources']);
  expect(response.body.sources.map((source: { source: string }) => source.source)).toEqual(['CRMS', 'HRMS', 'POS', 'IMS', 'Authentication', 'File storage', 'Notifications', 'Ecommerce']);
  expect(response.body.sources[0]).toEqual({ source: 'CRMS', modules: ['Dashboard', 'Customer Profiles', 'Campaigns', 'Conversations', 'Tickets'], actions: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'] });
  expect(response.body.sources[4].modules).toEqual([]);
  expect(response.body.sources[4].actions).toContain('audit_log.exported');
});

test('Administrator filters combine across Source, Module, Action, identities, outcome and dates', async () => {
  const crmsKey = await createKey(owner, 'write:CRMS');
  const actor = { type: 'user', id: crypto.randomUUID(), display_name: 'Investigator' };
  const subject = { type: 'customer', id: crypto.randomUUID(), display_name: 'Customer' };
  const matching = { ...event, source: 'CRMS', module: 'Tickets', action: 'record.created', actor, subject, outcome: 'failure', occurred_at: '2025-03-02T12:00:00Z' };
  const first = await request(app).post('/events').auth(crmsKey, { type: 'bearer' }).send(matching);
  expect(first.status).toBe(201);
  for (const change of [{ module: 'Campaigns' }, { action: 'record.updated' }, { actor: { ...actor, type: 'process' } }, { actor: { ...actor, id: crypto.randomUUID() } }, { subject: { ...subject, type: 'user' } }, { subject: { ...subject, id: crypto.randomUUID() } }, { outcome: 'success' }, { occurred_at: '2025-03-01T12:00:00Z' }, { occurred_at: '2025-03-03T12:00:00Z' }]) {
    expect((await request(app).post('/events').auth(crmsKey, { type: 'bearer' }).send({ ...matching, ...change })).status).toBe(201);
  }
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, actor, subject, outcome: 'failure', occurred_at: matching.occurred_at })).status).toBe(201);
  const filters = { source: 'CRMS', module: 'Tickets', action: 'record.created', actor_type: actor.type, actor_id: actor.id, subject_type: subject.type, subject_id: subject.id, outcome: 'failure', from: '2025-03-02T12:00:00Z', to: '2025-03-02T12:00:00Z' };
  const page = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query(filters);
  expect(page.status).toBe(200);
  expect(page.body.events.map((item: { id: string }) => item.id)).toEqual([first.body.id]);
  for (const [field, value] of Object.entries(filters)) {
    const filtered = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query({ [field]: value });
    expect(filtered.status).toBe(200);
    expect(filtered.body.events.some((item: { id: string }) => item.id === first.body.id)).toBe(true);
    for (const item of filtered.body.events) {
      if (field === 'from') expect(Date.parse(item.occurred_at)).toBeGreaterThanOrEqual(Date.parse(value));
      else if (field === 'to') expect(Date.parse(item.occurred_at)).toBeLessThanOrEqual(Date.parse(value));
      else if (field.startsWith('actor_')) expect(item.actor[field.slice(6)]).toBe(value);
      else if (field.startsWith('subject_')) expect(item.subject[field.slice(8)]).toBe(value);
      else expect(item[field]).toBe(value);
    }
  }
});

test('list and valid values require Administrator scope and events cannot be edited or deleted', async () => {
  const customerKey = await createKey(owner, 'read:customer');
  for (const path of ['/events', '/events/valid-values']) {
    for (const key of [writeKey, customerKey]) expect((await request(app).get(path).auth(key, { type: 'bearer' })).status).toBe(403);
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).auth('unknown-key', { type: 'bearer' })).status).toBe(401);
  }
  const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send(event);
  for (const method of ['put', 'patch', 'delete'] as const) {
    expect((await request(app)[method](`/events/${written.body.id}`).auth(readKey, { type: 'bearer' }).send({ description: 'Changed' })).status).toBe(404);
  }
  expect((await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' })).body.description).toBe(event.description);
});

test('invalid cursors, dates, limits and structured filters are rejected', async () => {
  for (const query of [{ cursor: 'garbage' }, { cursor: Buffer.from(JSON.stringify({ id: 'bad', occurred_at: 'bad', recorded_at: 'bad' })).toString('base64url') }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { from: 'yesterday' }, { from: '2025-02-02T00:00:00Z', to: '2025-02-01T00:00:00Z' }, { outcome: 'unknown' }, { actor_id: ['a', 'b'] }, { unknown: 'filter' }]) {
    expect((await request(app).get('/events').auth(readKey, { type: 'bearer' }).query(query)).status).toBe(400);
  }
  const empty = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query({ actor_id: crypto.randomUUID() });
  expect(empty.body).toEqual({ events: [], next_cursor: null });
});

test('pagination preserves microseconds across concurrent writes with shared occurrence timestamps', async () => {
  const actor = { ...event.actor, id: crypto.randomUUID() };
  const written = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, actor, occurred_at: '2025-01-01T00:00:00.123456Z' })));
  expect(written.every(response => response.status === 201)).toBe(true);
  const complete = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query({ actor_id: actor.id });
  expect(complete.body.events[0].occurred_at).toBe('2025-01-01T00:00:00.123456Z');
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query({ actor_id: actor.id, limit: 2, ...(cursor ? { cursor } : {}) });
    expect(page.status).toBe(200);
    seen.push(...page.body.events.map((item: { id: string }) => item.id));
    cursor = page.body.next_cursor;
  } while (cursor);
  expect(seen).toEqual(complete.body.events.map((item: { id: string }) => item.id));
  expect(new Set(seen).size).toBe(5);
});
