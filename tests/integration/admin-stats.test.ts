import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { createKey } from '../../src/api-keys/keys.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
const app = createApp(runtime, { rateLimitPerSecond: 1000 });
let adminKey: string;
let authKey: string;
let crmsKey: string;
const actor = { type: 'user', id: crypto.randomUUID(), display_name: 'Stats Tester' };
const base = {
  outcome: 'success', actor, target: { type: 'session', id: 's-1', display_name: 'Session' },
  description: 'Stats fixture.', occurred_at: '2025-06-01T10:00:00Z',
};
const stats = (query: object, key = adminKey) => request(app).get('/events/stats').auth(key, { type: 'bearer' }).query({ actor_id: actor.id, ...query });

beforeAll(async () => {
  adminKey = await createKey(owner, 'read:admin');
  authKey = await createKey(owner, 'write:Authentication');
  crmsKey = await createKey(owner, 'write:CRMS');
  const fixtures = [
    { key: authKey, source: 'Authentication', action: 'user.login', outcome: 'failure', occurred_at: '2025-06-01T23:59:59Z' },
    { key: authKey, source: 'Authentication', action: 'user.login', outcome: 'failure', occurred_at: '2025-06-01T01:00:00Z' },
    { key: authKey, source: 'Authentication', action: 'user.login', outcome: 'success', occurred_at: '2025-06-02T00:00:00Z' },
    { key: authKey, source: 'Authentication', action: 'user.logout', occurred_at: '2025-06-02T12:00:00Z' },
    { key: crmsKey, source: 'CRMS', action: 'record.created', module: 'Tickets', occurred_at: '2025-06-04T12:00:00Z' },
  ];
  for (const { key, ...fixture } of fixtures) {
    expect((await request(app).post('/events').auth(key, { type: 'bearer' }).send({ ...base, ...fixture })).status).toBe(201);
  }
});
afterAll(async () => { await Promise.all([owner.end(), runtime.end()]); });

test('group_by day counts events per UTC day in ascending order, omitting empty days', async () => {
  const response = await stats({ group_by: 'day' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ group_by: 'day', buckets: [{ key: '2025-06-01', count: 2 }, { key: '2025-06-02', count: 2 }, { key: '2025-06-04', count: 1 }] });
});

test('group_by source, action and outcome count by descending total', async () => {
  expect((await stats({ group_by: 'source' })).body.buckets).toEqual([{ key: 'Authentication', count: 4 }, { key: 'CRMS', count: 1 }]);
  expect((await stats({ group_by: 'action' })).body.buckets).toEqual([{ key: 'user.login', count: 3 }, { key: 'record.created', count: 1 }, { key: 'user.logout', count: 1 }]);
  expect((await stats({ group_by: 'outcome' })).body.buckets).toEqual([{ key: 'success', count: 3 }, { key: 'failure', count: 2 }]);
});

test('limit caps the top Actions', async () => {
  expect((await stats({ group_by: 'action', limit: 1 })).body.buckets).toEqual([{ key: 'user.login', count: 3 }]);
});

test('filters apply to counts as they do to the list, including failed logins by day', async () => {
  const failedLogins = { group_by: 'day', outcome: 'failure', source: 'Authentication', action: 'user.login' };
  expect((await stats(failedLogins)).body.buckets).toEqual([{ key: '2025-06-01', count: 2 }]);
  const filters = { source: 'Authentication', from: '2025-06-02T00:00:00Z', to: '2025-06-02T12:00:00Z', q: 'stats tester' };
  const counted = await stats({ group_by: 'source', ...filters });
  const listed = await request(app).get('/events').auth(adminKey, { type: 'bearer' }).query({ actor_id: actor.id, ...filters });
  expect(counted.body.buckets).toEqual([{ key: 'Authentication', count: listed.body.events.length }]);
  expect(listed.body.events).toHaveLength(2);
  expect((await stats({ group_by: 'source', module: 'Tickets' })).body.buckets).toEqual([{ key: 'CRMS', count: 1 }]);
  expect((await stats({ group_by: 'day', actor_id: crypto.randomUUID() })).body.buckets).toEqual([]);
});

test('invalid group_by, filters and limits are rejected', async () => {
  for (const query of [{}, { group_by: 'module' }, { group_by: 'day', outcome: 'maybe' }, { group_by: 'day', unknown: 1 }, { group_by: 'day', cursor: 'x' }, { group_by: 'action', limit: 0 }, { group_by: 'day', from: '2025-02-02T00:00:00Z', to: '2025-02-01T00:00:00Z' }]) {
    expect((await stats(query)).status).toBe(400);
  }
});

test('only read:admin keys may read stats', async () => {
  const customerKey = await createKey(owner, 'read:customer');
  for (const key of [customerKey, authKey]) expect((await stats({ group_by: 'day' }, key)).status).toBe(403);
  expect((await request(app).get('/events/stats').query({ group_by: 'day' })).status).toBe(401);
});
