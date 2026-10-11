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
  expect((await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...event, source: 'Ecommerce' })).status).toBe(400);
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
