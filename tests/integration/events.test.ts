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
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, source: 'Ecommerce' })).status).toBe(403);
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

const startingActions: Record<string, string[]> = {
  CRMS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  HRMS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  POS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  IMS: ['record.created', 'record.updated', 'record.deleted', 'record.viewed'],
  Authentication: ['user.login', 'user.login_failed', 'user.logout', 'user.created', 'user.deleted', 'user.restored', 'password.changed', 'password.forgot_requested', 'credentials.resent', 'access_grant.granted', 'access_grant.revoked', 'audit_log.exported'],
  'File storage': ['file.uploaded', 'file.downloaded', 'file.deleted', 'file.shared'],
  Notifications: ['notification.sent', 'notification.failed'],
  Ecommerce: ['customer.signed_up', 'customer.signed_in', 'customer.password_changed', 'customer.address_changed', 'order.placed', 'order.cancelled', 'payment.completed', 'support_ticket.opened'],
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
    expect(Date.parse(read.body.recorded_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(read.body.recorded_at)).toBeLessThanOrEqual(Date.now());
  }
});

test('Module is accepted only for the four Systems and descriptions remain as written', async () => {
  for (const [source, actions] of Object.entries(startingActions)) {
    const key = await createKey(owner, `write:${source}`);
    const payload = { ...event, source, action: actions[0], module: 'Customers', description: '  Alice\nchanged Café.  ', customer_description: '  Your details\nchanged.  ', ip_address: '2001:db8::1', user_agent: 'Example/1.0', request_id: 'req-17' };
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
