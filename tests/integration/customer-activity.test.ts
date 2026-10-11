import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.ts';
import { createKey } from '../../src/api-keys/keys.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
const app = createApp(runtime, { rateLimitPerSecond: 1000 });
let writeKey: string;
let customerKey: string;
let adminKey: string;
const run = randomUUID();
const alice = { type: 'customer', id: `alice-${run}`, display_name: 'Alice Shopper' };
const bob = { type: 'customer', id: `bob-${run}`, display_name: 'Bob Shopper' };
const base = {
  source: 'Authentication', action: 'user.login', outcome: 'success',
  actor: alice, target: { type: 'session', id: 'session-1', display_name: 'Session' },
  subject: alice, description: 'Admin text for Alice.', customer_description: 'You signed in.',
  occurred_at: '2026-01-01T12:00:00.000Z',
};
const write = async (overrides: object) => {
  const res = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...base, ...overrides });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const read = (query: Record<string, string>, key = customerKey) =>
  request(app).get('/events/customer-activity').query(query).auth(key, { type: 'bearer' });
const aliceQuery = { subject_type: alice.type, subject_id: alice.id };

beforeAll(async () => {
  writeKey = await createKey(owner, 'write:Authentication');
  customerKey = await createKey(owner, 'read:customer');
  adminKey = await createKey(owner, 'read:admin');
});
afterAll(async () => { await Promise.all([owner.end(), runtime.end()]); });

test('a query without a Subject is refused', async () => {
  expect((await read({})).status).toBe(400);
  expect((await read({ subject_id: alice.id })).status).toBe(400);
  expect((await read({ subject_type: alice.type })).status).toBe(400);
});

test('only read:customer keys can use the Customer activity read', async () => {
  expect((await read(aliceQuery, adminKey)).status).toBe(403);
  expect((await read(aliceQuery, writeKey)).status).toBe(403);
  expect((await request(app).get('/events/customer-activity').query(aliceQuery)).status).toBe(401);
});

test('returns only the Subject\'s events that have a Customer description', async () => {
  const visible = await write({});
  await write({ customer_description: null });
  await write({ subject: bob, actor: bob, customer_description: 'Bob event.' });
  await write({ subject: null, customer_description: 'No subject.' });
  const res = await read(aliceQuery);
  expect(res.status).toBe(200);
  expect(res.body.events.map((e: { id: string }) => e.id)).toEqual([visible]);
  expect(res.body.events[0]).toMatchObject({ id: visible, customer_description: 'You signed in.', occurred_at: '2026-01-01T12:00:00.000000Z' });
  expect(res.body.next_cursor).toBeNull();
});

test('a staff-performed event shows the Customer description without staff name, IP address or admin description', async () => {
  const carol = { type: 'customer', id: `carol-${run}`, display_name: 'Carol Shopper' };
  await write({
    actor: { type: 'user', id: 'staff-1', display_name: 'Sam Staff' }, subject: carol,
    description: 'Sam Staff refunded Carol.', customer_description: 'Your order was refunded.',
    ip_address: '203.0.113.7', user_agent: 'StaffBrowser/1.0', metadata: { note: 'internal' }, request_id: 'req-1',
  });
  const res = await read({ subject_type: carol.type, subject_id: carol.id });
  expect(res.body.events).toHaveLength(1);
  expect(res.body.events[0].customer_description).toBe('Your order was refunded.');
  const raw = JSON.stringify(res.body);
  for (const secret of ['Sam Staff', 'staff-1', '203.0.113.7', 'StaffBrowser', 'refunded Carol', 'internal', 'req-1']) expect(raw).not.toContain(secret);
  expect(Object.keys(res.body.events[0]).sort()).toEqual(['action', 'customer_description', 'id', 'occurred_at', 'outcome', 'source']);
});

test('no other filter is accepted, so another Customer\'s events are unreachable', async () => {
  await write({ subject: bob, actor: bob, customer_description: 'Bob event.' });
  for (const extra of [{ actor_id: bob.id }, { q: 'Bob' }, { source: 'Authentication' }] as Record<string, string>[]) {
    expect((await read({ ...aliceQuery, ...extra })).status).toBe(400);
  }
  const repeated = await request(app).get(`/events/customer-activity?subject_type=${alice.type}&subject_id=${alice.id}&subject_id=${bob.id}`).auth(customerKey, { type: 'bearer' });
  expect(repeated.status).toBe(400);
});

test('a cursor from another Customer cannot reveal their events', async () => {
  const bobQuery = { subject_type: bob.type, subject_id: bob.id };
  for (const minute of ['10', '11']) await write({ subject: bob, actor: bob, customer_description: 'Bob event.', occurred_at: `2026-02-01T12:${minute}:00.000Z` });
  const bobPage = await read({ ...bobQuery, limit: '1' });
  expect(bobPage.body.next_cursor).not.toBeNull();
  const res = await read({ ...aliceQuery, cursor: bobPage.body.next_cursor });
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toContain('Bob event.');
});

test('pagination works within the Customer\'s own events', async () => {
  const dave = { type: 'customer', id: `dave-${run}`, display_name: 'Dave' };
  const ids: string[] = [];
  for (const minute of ['01', '02', '03', '04', '05']) ids.push(await write({ subject: dave, actor: dave, occurred_at: `2026-03-01T12:${minute}:00.000Z` }));
  await write({ subject: dave, actor: dave, customer_description: null, occurred_at: '2026-03-01T12:06:00.000Z' });
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await read({ subject_type: dave.type, subject_id: dave.id, limit: '2', ...(cursor ? { cursor } : {}) });
    expect(res.status).toBe(200);
    seen.push(...res.body.events.map((e: { id: string }) => e.id));
    cursor = res.body.next_cursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen).toEqual([...ids].reverse());
});

test('invalid limits and cursors return 400', async () => {
  expect((await read({ ...aliceQuery, limit: '0' })).status).toBe(400);
  expect((await read({ ...aliceQuery, cursor: 'garbage' })).status).toBe(400);
});
