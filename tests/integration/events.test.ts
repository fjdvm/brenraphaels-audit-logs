import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { createKey, hashKey, revokeKey, rotateKey } from '../../src/api-keys/keys.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
const app = createApp(runtime, { rateLimitPerSecond: 1000 });
const clockSkewMs = 2000;
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
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, source: 'Ecommerce' })).status).toBe(403);
});

test('Portal decline activity is accepted and readable with its reason and message', async () => {
  const declined = { ...event, action: 'account_request.declined', description: 'Declined Account request RQ-0001. Reason: Duplicate request. Message: Use RQ-0002.' };
  const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send(declined);
  expect(written.status).toBe(201);
  const read = await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' });
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject(declined);
  const options = await request(app).get('/events/valid-values').auth(readKey, { type: 'bearer' });
  expect(options.body.sources.find((source: { source: string }) => source.source === 'Authentication').actions).toContain('account_request.declined');
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
  const anonymize = process.env.TEST_DATABASE_URL_ANONYMIZE ? new Pool({ connectionString: process.env.TEST_DATABASE_URL_ANONYMIZE }) : undefined;
  const client = await (anonymize ?? owner).connect();
  try {
    if (!anonymize) await client.query('SET ROLE audit_anonymize');
    await client.query("UPDATE audit_events SET actor_display_name = 'Deleted customer' WHERE false");
    await expect(client.query("UPDATE audit_events SET description = 'tampered' WHERE false")).rejects.toMatchObject({ code: '42501' });
    await expect(client.query('DELETE FROM audit_events WHERE false')).rejects.toMatchObject({ code: '42501' });
  } finally {
    if (!anonymize) await client.query('RESET ROLE');
    client.release();
    await anonymize?.end();
  }
});

const startingActions: Record<string, string[]> = {
  CRMS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  HRMS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  POS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  IMS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  Authentication: ['user.login', 'user.login_failed', 'user.logout', 'user.created', 'user.deleted', 'user.restored', 'password.changed', 'password.forgot_requested', 'credentials.resent', 'access_grant.granted', 'access_grant.revoked', 'audit_log.exported', 'password.forgot_completed', 'user.role_changed', 'system.handoff_authorized', 'system.handoff_exchanged', 'system.handoff_denied'],
  'File storage': ['file.uploaded', 'file.downloaded', 'file.deleted', 'file.shared'],
  Notifications: ['notification.sent', 'notification.failed'],
  Ecommerce: ['customer.signed_up', 'customer.signed_in', 'customer.password_changed', 'customer.address_changed', 'order.placed', 'order.cancelled', 'payment.completed', 'support_ticket.opened', 'feedback.request_sent'],
};

test('every starting Action is writable only by its own Source', async () => {
  const sourceKeys = await Promise.all(Object.keys(startingActions).map(async source => ({ source, key: await createKey(owner, `write:${source}`) })));
  for (const [source, actions] of Object.entries(startingActions)) {
    for (const action of actions) {
      for (const credential of sourceKeys) {
        const response = await request(app).post('/events').auth(credential.key, { type: 'bearer' }).send({ ...event, source, action });
        expect(response.status, `${source}/${action} with ${credential.source} key`).toBe(credential.source === source ? 201 : 403);
      }
    }
    const key = sourceKeys.find(credential => credential.source === source)!.key;
    expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send({ ...event, source, action: 'unknown.action' })).status).toBe(400);
  }
});

test('metadata rejects sensitive-looking keys at any depth and enforces UTF-8 byte limits', async () => {
  for (const name of ['password', 'accessToken', 'client_secret', 'Authorization', 'creditCard', 'CVV']) {
    for (const metadata of [{ [name]: 'hidden' }, { nested: [{ deeper: { [name]: 'hidden' } }] }]) {
      expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, metadata })).status).toBe(400);
    }
  }
  const metadata = { note: 'é'.repeat(2042) }; // 4095 bytes including JSON punctuation
  const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, metadata });
  expect(written.status).toBe(201);
  expect((await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' })).body.metadata).toEqual(metadata);
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, metadata: { note: 'é'.repeat(2043) } })).status).toBe(400);
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, description: 'x'.repeat(16384) })).status).toBe(413);
});

test('future events and producer recorded_at are rejected while late events keep their time', async () => {
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, occurred_at: new Date(Date.now() + 301000).toISOString() })).status).toBe(400);
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, recorded_at: event.occurred_at })).status).toBe(400);
  for (const occurred_at of ['2000-01-01T00:00:00.000Z', new Date(Date.now() + 299000).toISOString()]) {
    const before = Date.now();
    const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, occurred_at });
    expect(written.status).toBe(201);
    const read = await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' });
    expect(read.body.occurred_at).toBe(occurred_at);
    // recorded_at comes from the database clock, which can drift from this machine's.
    expect(Date.parse(read.body.recorded_at)).toBeGreaterThanOrEqual(before - clockSkewMs);
    expect(Date.parse(read.body.recorded_at)).toBeLessThanOrEqual(Date.now() + clockSkewMs);
  }
});

test('Module is accepted only for the four Systems and descriptions remain as written', async () => {
  for (const [source, actions] of Object.entries(startingActions)) {
    const key = await createKey(owner, `write:${source}`);
    const payload = { ...event, source, action: actions[0], module: source === 'CRMS' ? 'Customer Profiles' : 'Customers', description: '  Alice\nchanged Café.  ', customer_description: '  Your details\nchanged.  ', ip_address: '2001:db8::1', user_agent: 'Example/1.0', request_id: 'req-17' };
    const written = await request(app).post('/events').auth(key, { type: 'bearer' }).send(payload);
    if (['CRMS', 'HRMS', 'POS', 'IMS'].includes(source)) {
      expect(written.status).toBe(201);
      const read = await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' });
      expect(read.body).toMatchObject(payload);
    } else {
      expect(written.status).toBe(400);
      expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send({ ...payload, module: null })).status).toBe(201);
    }
  }
  for (const extra of [{ module: '' }, { ip_address: 'not an IP' }, { metadata: [] }, { unknown: 'field' }]) {
    expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, ...extra })).status).toBe(400);
  }
});

test('concurrent and rotated-key retries return the original Audit Event without overwriting it', async () => {
  const { randomUUID } = await import('node:crypto');
  const idempotency_key = randomUUID();
  const payload = { ...event, idempotency_key, metadata: { attempt: 1 } };
  const results = await Promise.all(Array.from({ length: 8 }, () => request(app).post('/events').auth(writeKey, { type: 'bearer' }).send(payload)));
  for (const response of results) expect(response.status).toBe(201);
  expect(new Set(results.map(response => response.body.id)).size).toBe(1);
  const original = await request(app).get(`/events/${results[0]!.body.id}`).auth(readKey, { type: 'bearer' });
  const rotated = await createKey(owner, 'write:Authentication');
  const retry = await request(app).post('/events').auth(rotated, { type: 'bearer' }).send({ ...payload, description: 'Changed on retry', metadata: { attempt: 2 } });
  expect(retry.status).toBe(201);
  expect(retry.body).toEqual(results[0]!.body);
  expect((await request(app).get(`/events/${retry.body.id}`).auth(readKey, { type: 'bearer' })).body).toEqual(original.body);
  expect(original.body).toMatchObject(payload);
  const other = await createKey(owner, 'write:Ecommerce');
  const separate = await request(app).post('/events').auth(other, { type: 'bearer' }).send({ ...payload, source: 'Ecommerce', action: 'order.placed' });
  expect(separate.status).toBe(201);
  expect(separate.body.id).not.toBe(retry.body.id);
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, idempotency_key: '' })).status).toBe(400);
});

test('Postgres-invalid text is rejected as malformed input before storage', async () => {
  for (const invalid of ['\u0000', '\ud800']) {
    for (const fields of [
      { description: `bad${invalid}` }, { customer_description: invalid },
      { actor: { ...event.actor, display_name: invalid } },
      { request_id: invalid }, { idempotency_key: invalid },
      { metadata: { nested: [{ note: invalid }] } }, { metadata: { [invalid]: 'value' } },
    ]) {
      expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, ...fields })).status).toBe(400);
    }
  }
});


test('a batch of 100 Audit Events is readable in input order and 101 is rejected', async () => {
  const payload = Array.from({ length: 100 }, (_, index) => ({ ...event, description: `Batch event ${index}` }));
  const written = await request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send({ events: payload });
  expect(written.status).toBe(201);
  expect(written.body.events).toHaveLength(100);
  expect(new Set(written.body.events.map((saved: { id: string }) => saved.id)).size).toBe(100);
  for (const [index, saved] of written.body.events.entries()) {
    const read = await request(app).get(`/events/${saved.id}`).auth(readKey, { type: 'bearer' });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject(payload[index]!);
  }
  expect((await request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send({ events: [...payload, event] })).status).toBe(400);
});

test('invalid batches identify the event and store none of the preceding events', async () => {
  const { randomUUID } = await import('node:crypto');
  for (const invalid of [
    { action: 'user.typo' }, { metadata: { nested: [{ accessToken: 'hidden' }] } },
    { module: 'Customers' }, { recorded_at: event.occurred_at },
    { occurred_at: new Date(Date.now() + 600000).toISOString() },
    { actor: { type: 'user', id: '', display_name: 'Alice' } },
  ]) {
    const first = { ...event, idempotency_key: randomUUID(), description: 'Must not be stored' };
    const rejected = await request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send({ events: [first, { ...event, ...invalid }] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.details.some((issue: { path: unknown[] }) => issue.path[0] === 'events' && issue.path[1] === 1)).toBe(true);
    const accepted = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...first, description: 'Stored after rejection' });
    expect(accepted.status).toBe(201);
    const read = await request(app).get(`/events/${accepted.body.id}`).auth(readKey, { type: 'bearer' });
    expect(read.body.description).toBe('Stored after rejection');
  }
  for (const body of [{ events: [] }, { events: [event], unknown: true }, [event]]) {
    expect((await request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send(body)).status).toBe(400);
  }
});

test('batch writes enforce authentication and the Source scope for every event', async () => {
  expect((await request(app).post('/events/batch').send({ events: [event] })).status).toBe(401);
  expect((await request(app).post('/events/batch').auth(readKey, { type: 'bearer' }).send({ events: [event] })).status).toBe(403);
  const response = await request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send({ events: [event, { ...event, source: 'Ecommerce', action: 'order.placed' }] });
  expect(response.status).toBe(403);
  expect(response.body.index).toBe(1);
});

test('batch retries and repeated idempotency keys preserve the first event across write endpoints', async () => {
  const { randomUUID } = await import('node:crypto');
  const first = { ...event, idempotency_key: randomUUID() };
  const second = { ...event, idempotency_key: randomUUID(), description: 'Second event' };
  const payload = { events: [first, { ...first, description: 'Changed duplicate' }, second] };
  const written = await request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send(payload);
  expect(written.status).toBe(201);
  expect(written.body.events[0]).toEqual(written.body.events[1]);
  expect(written.body.events[2].id).not.toBe(written.body.events[0].id);
  const retries = await Promise.all(Array.from({ length: 3 }, () => request(app).post('/events/batch').auth(writeKey, { type: 'bearer' }).send(payload)));
  for (const retry of retries) { expect(retry.status).toBe(201); expect(retry.body).toEqual(written.body); }
  const single = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...first, description: 'Changed single retry' });
  expect(single.status).toBe(201);
  expect(single.body).toEqual(written.body.events[0]);
  const read = await request(app).get(`/events/${single.body.id}`).auth(readKey, { type: 'bearer' });
  expect(read.body).toMatchObject(first);
});

test('configured per-key limits share single and batch allowance and recover after the retry hint', async () => {
  const previous = process.env.RATE_LIMIT_PER_SECOND;
  process.env.RATE_LIMIT_PER_SECOND = '2';
  let limited: ReturnType<typeof createApp>;
  try { limited = createApp(runtime); } finally {
    if (previous === undefined) delete process.env.RATE_LIMIT_PER_SECOND;
    else process.env.RATE_LIMIT_PER_SECOND = previous;
  }
  const other = await createKey(owner, 'write:Authentication');
  const now = Date.now();
  const time = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect((await request(limited).post('/events/batch').auth(writeKey, { type: 'bearer' }).send({ events: [event, event, event] })).status).toBe(201);
    expect((await request(limited).post('/events').auth(writeKey, { type: 'bearer' }).send(event)).status).toBe(201);
    const blocked = await request(limited).post('/events/batch').auth(writeKey, { type: 'bearer' }).send({ events: [event] });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.body.retry_after).toBe(1);
    expect((await request(limited).post('/events').auth(other, { type: 'bearer' }).send(event)).status).toBe(201);
    time.mockReturnValue(now + 1000);
    expect((await request(limited).post('/events').auth(writeKey, { type: 'bearer' }).send(event)).status).toBe(201);
  } finally { time.mockRestore(); }
});

test('default rate limit permits 100 requests and rejects the next request', async () => {
  const previous = process.env.RATE_LIMIT_PER_SECOND;
  delete process.env.RATE_LIMIT_PER_SECOND;
  let limited: ReturnType<typeof createApp>;
  try { limited = createApp(runtime); } finally {
    if (previous !== undefined) process.env.RATE_LIMIT_PER_SECOND = previous;
  }
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    for (let index = 0; index < 100; index++) {
      expect((await request(limited).get('/events/00000000-0000-4000-8000-000000000000').auth(readKey, { type: 'bearer' })).status).toBe(404);
    }
    expect((await request(limited).get('/events/00000000-0000-4000-8000-000000000000').auth(readKey, { type: 'bearer' })).status).toBe(429);
  } finally { time.mockRestore(); }
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
  expect(response.body.sources[0]).toMatchObject({ source: 'CRMS', modules: expect.arrayContaining(['Dashboard', 'Customer Profiles', 'Campaigns', 'Conversations', 'Tickets', 'Feedback']), actions: expect.arrayContaining(['record.created', 'record.updated', 'record.deleted', 'record.viewed', 'feedback.analysis_run']) });
  expect(response.body.sources[4].modules).toEqual([]);
  expect(response.body.sources[4].actions).toContain('audit_log.exported');
  expect(response.body.sources[4].actions).toEqual(expect.arrayContaining(['password.forgot_completed', 'user.role_changed', 'system.handoff_authorized', 'system.handoff_exchanged', 'system.handoff_denied']));
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
    const anchor = field.startsWith('actor_') ? { subject_id: subject.id } : { actor_id: actor.id };
    const filtered = await request(app).get('/events').auth(readKey, { type: 'bearer' }).query({ ...anchor, [field]: value });
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

test('revoking a key makes its very next request fail and leaves events untouched', async () => {
  const key = await createKey(owner, 'write:Authentication');
  const written = await request(app).post('/events').auth(key, { type: 'bearer' }).send(event);
  expect(written.status).toBe(201);
  const before = await owner.query('SELECT count(*)::int AS n FROM audit_events');
  await revokeKey(owner, hashKey(key));
  expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send(event)).status).toBe(401);
  expect((await owner.query('SELECT count(*)::int AS n FROM audit_events')).rows).toEqual(before.rows);
  expect((await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' })).status).toBe(200);
});

test('rotating a key revokes the old one by default and stores only the new hash', async () => {
  const old = await createKey(owner, 'write:Authentication');
  const rotated = await rotateKey(owner, hashKey(old));
  expect(rotated).not.toBe(old);
  expect((await request(app).post('/events').auth(old, { type: 'bearer' }).send(event)).status).toBe(401);
  expect((await request(app).post('/events').auth(rotated, { type: 'bearer' }).send(event)).status).toBe(201);
  expect((await owner.query('SELECT scope FROM api_keys WHERE hash = $1', [hashKey(rotated)])).rows).toEqual([{ scope: 'write:Authentication' }]);
  expect((await owner.query('SELECT 1 FROM api_keys WHERE hash = $1', [rotated])).rowCount).toBe(0);
});

test('rotating with overlap keeps the old key working until it is revoked', async () => {
  const old = await createKey(owner, 'write:Authentication');
  const rotated = await rotateKey(owner, hashKey(old), { overlap: true });
  expect((await request(app).post('/events').auth(old, { type: 'bearer' }).send(event)).status).toBe(201);
  expect((await request(app).post('/events').auth(rotated, { type: 'bearer' }).send(event)).status).toBe(201);
  await revokeKey(owner, hashKey(old));
  expect((await request(app).post('/events').auth(old, { type: 'bearer' }).send(event)).status).toBe(401);
});

test('unknown or already revoked keys cannot be rotated', async () => {
  await expect(rotateKey(owner, hashKey('nope'))).rejects.toThrow('Unknown key hash');
  const old = await createKey(owner, 'write:Authentication');
  await revokeKey(owner, hashKey(old));
  await expect(rotateKey(owner, hashKey(old))).rejects.toThrow('Key is revoked');
});

test('Administrator free-text search matches description and Actor or Subject names, case-insensitively, with filters and paging', async () => {
  const token = `Zq${crypto.randomUUID().slice(0, 8)}`;
  const post = async (change: object) => {
    const written = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, description: 'Unrelated.', ...change });
    expect(written.status).toBe(201);
    return written.body.id as string;
  };
  const asActor = await post({ actor: { type: 'user', id: crypto.randomUUID(), display_name: `${token} Smith` }, occurred_at: '2025-05-01T00:00:00Z' });
  const asSubject = await post({ subject: { type: 'user', id: crypto.randomUUID(), display_name: `Dr ${token}` }, occurred_at: '2025-05-02T00:00:00Z' });
  const inDescription = await post({ description: `Reset password for ${token.toLowerCase()} today`, outcome: 'failure', occurred_at: '2025-05-03T00:00:00Z' });
  await post({ occurred_at: '2025-05-04T00:00:00Z' });
  const search = (query: object) => request(app).get('/events').auth(readKey, { type: 'bearer' }).query(query);
  const ids = async (query: object) => (await search(query)).body.events.map((item: { id: string }) => item.id);

  expect(await ids({ q: token.toUpperCase() })).toEqual([inDescription, asSubject, asActor]);
  expect(await ids({ q: `${token} smith` })).toEqual([asActor]);
  expect(await ids({ q: `password for ${token}` })).toEqual([inDescription]);
  expect(await ids({ q: token, outcome: 'failure' })).toEqual([inDescription]);
  expect(await ids({ q: '%' })).toEqual([]);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await search({ q: token, limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.body.events.map((item: { id: string }) => item.id));
    cursor = page.body.next_cursor;
  } while (cursor);
  expect(seen).toEqual([inDescription, asSubject, asActor]);
  expect((await search({ q: '   ' })).status).toBe(400);
});

const crmsActionsByModule: Record<string, string[]> = {
  Orders: ['order.delivery_fee_quoted', 'order.confirmed', 'order.cancelled'],
  Payments: ['order.marked_paid'],
  Fulfilment: ['order.preparing', 'order.dispatched', 'order.delivered', 'order.delivery_photo_attached'],
  Returns: ['return.approved', 'return.declined', 'return.goods_received', 'return.refunded', 'return.replaced'],
  Tickets: ['ticket.opened', 'ticket.claimed', 'ticket.released', 'ticket.status_changed', 'ticket.priority_changed'],
  'Customer Profiles': ['walk_in_customer.created', 'walk_in_customer.updated', 'customer_profile.viewed'],
  Feedback: ['feedback.analysis_run'],
};

test('CRMS accepts every Staff Action with its Module and publishes the vocabulary', async () => {
  const key = await createKey(owner, 'write:CRMS');
  const values = await request(app).get('/events/valid-values').auth(readKey, { type: 'bearer' });
  expect(values.status).toBe(200);
  const crms = values.body.sources.find((item: { source: string }) => item.source === 'CRMS');
  for (const [module, actions] of Object.entries(crmsActionsByModule)) {
    expect(crms.modules).toContain(module);
    for (const action of actions) {
      expect(crms.actions).toContain(action);
      const written = await request(app).post('/events').auth(key, { type: 'bearer' }).send({ ...event, source: 'CRMS', module, action });
      expect(written.status, `${module}/${action}`).toBe(201);
      const read = await request(app).get(`/events/${written.body.id}`).auth(readKey, { type: 'bearer' });
      expect(read.body).toMatchObject({ source: 'CRMS', module, action });
    }
  }
  for (const action of ['crms.signed_in', 'crms.access_denied']) {
    expect(crms.actions).toContain(action);
    expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send({ ...event, source: 'CRMS', action })).status).toBe(201);
  }
  for (const module of ['Campaigns', 'Marketing']) {
    expect(crms.modules).toContain(module);
    for (const action of ['record.created', 'record.updated', 'record.deleted', 'record.viewed']) {
      expect(crms.actions).toContain(action);
      expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send({ ...event, source: 'CRMS', module, action })).status).toBe(201);
    }
  }
});

test('CRMS rejects unknown Actions and Modules on single and batch writes', async () => {
  const key = await createKey(owner, 'write:CRMS');
  for (const invalid of [
    { module: 'Orders', action: 'order.typo' },
    { module: 'Unknown Module', action: 'record.created' },
    { module: 'Orders', action: 'user.login' },
  ]) {
    const payload = { ...event, source: 'CRMS', ...invalid };
    expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send(payload)).status).toBe(400);
    expect((await request(app).post('/events/batch').auth(key, { type: 'bearer' }).send({ events: [payload] })).status).toBe(400);
  }
});


const hrmsJobActions = [
  'job_posting.created', 'job_posting.updated', 'job_posting.published',
  'job_posting.closed', 'job_posting.filled',
  'job_template.created', 'job_template.updated', 'job_template.deleted',
];

test.each(hrmsJobActions)('HRMS accepts and retains %s on single and batch writes', async action => {
  const key = await createKey(owner, 'write:HRMS');
  const payload = { ...event, source: 'HRMS', module: 'Recruitment and Hiring', action };
  for (const path of ['/events', '/events/batch']) {
    const written = await request(app).post(path).auth(key, { type: 'bearer' })
      .send(path === '/events' ? payload : { events: [payload] });
    expect(written.status, path).toBe(201);
    const id = path === '/events' ? written.body.id : written.body.events[0].id;
    const read = await request(app).get(`/events/${id}`).auth(readKey, { type: 'bearer' });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject(payload);
  }
});

test('HRMS publishes its Job Actions and keeps record Actions valid', async () => {
  const values = await request(app).get('/events/valid-values').auth(readKey, { type: 'bearer' });
  expect(values.status).toBe(200);
  const hrms = values.body.sources.find((item: { source: string }) => item.source === 'HRMS');
  expect(hrms.modules).toContain('Recruitment and Hiring');
  expect(hrms.actions).toEqual(expect.arrayContaining(hrmsJobActions));
  const key = await createKey(owner, 'write:HRMS');
  for (const action of ['record.created', 'record.updated', 'record.deleted', 'record.viewed']) {
    expect(hrms.actions).toContain(action);
    const written = await request(app).post('/events').auth(key, { type: 'bearer' })
      .send({ ...event, source: 'HRMS', module: 'Custom HRMS Module', action });
    expect(written.status, action).toBe(201);
  }
});

test('HRMS rejects unknown Actions on single and batch writes', async () => {
  const key = await createKey(owner, 'write:HRMS');
  for (const action of ['job_posting.typo', 'job_template.typo', 'user.login']) {
    const payload = { ...event, source: 'HRMS', module: 'Recruitment and Hiring', action };
    expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send(payload)).status).toBe(400);
    expect((await request(app).post('/events/batch').auth(key, { type: 'bearer' }).send({ events: [payload] })).status).toBe(400);
  }
});

test.each(['order.stock_reserved', 'order.stock_released'])(
  'Ecommerce %s is accepted once, readable, and listed for Administrators', async action => {
    const key = await createKey(owner, 'write:Ecommerce');
    const stockEvent = {
      source: 'Ecommerce', action, outcome: 'success',
      actor: { type: 'system', id: 'stock-verification', display_name: 'Stock verification' },
      target: { type: 'order', id: `verify-${action}`, display_name: 'Verification Order' },
      description: 'Verified an Order stock movement.',
      occurred_at: new Date().toISOString(), idempotency_key: `stock-verification:${action}:${crypto.randomUUID()}`,
    };
    const first = await request(app).post('/events').auth(key, { type: 'bearer' }).send(stockEvent);
    expect(first.status).toBe(201);
    const replay = await request(app).post('/events').auth(key, { type: 'bearer' }).send(stockEvent);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    const read = await request(app).get(`/events/${first.body.id}`).auth(readKey, { type: 'bearer' });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ source: 'Ecommerce', action, actor: stockEvent.actor, target: stockEvent.target });
    const values = await request(app).get('/events/valid-values').auth(readKey, { type: 'bearer' });
    expect(values.body.sources.find((source: { source: string }) => source.source === 'Ecommerce').actions).toContain(action);
  },
);
