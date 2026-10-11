import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.ts';
import { createKey } from '../../src/api-keys/keys.ts';
import { anonymizeCustomer } from '../../src/jobs/anonymize-customer/anonymize-customer.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
// Same fallback as the role test in events.test.ts: owners that can SET ROLE stand in for the real login.
const anonymize = process.env.TEST_DATABASE_URL_ANONYMIZE
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL_ANONYMIZE })
  : new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }).on('connect', client => { client.query('SET ROLE audit_anonymize').catch(error => { throw new Error(`Cannot SET ROLE audit_anonymize; set TEST_DATABASE_URL_ANONYMIZE: ${error.message}`); }); });
const app = createApp(runtime, { rateLimitPerSecond: 1000 });
let writeKey: string;
let adminKey: string;
let customerKey: string;
const run = randomUUID();
const alice = { type: 'customer', id: `alice-${run}`, display_name: 'Alice Shopper' };
const bob = { type: 'customer', id: `bob-${run}`, display_name: 'Bob Shopper' };
const staff = { type: 'user', id: `staff-${run}`, display_name: 'Sam Staff' };
const base = {
  source: 'Authentication', action: 'user.login', outcome: 'success',
  actor: alice, target: { type: 'session', id: 'session-1', display_name: 'Session' },
  subject: alice, description: 'Alice signed in.', customer_description: 'You signed in.',
  occurred_at: '2026-01-01T12:00:00.000Z', ip_address: '203.0.113.7', user_agent: 'AliceBrowser/1.0',
};
const write = async (overrides: object) => {
  const res = await request(app).post('/events').auth(writeKey, { type: 'bearer' }).send({ ...base, ...overrides });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const detail = async (id: string) => (await request(app).get(`/events/${id}`).auth(adminKey, { type: 'bearer' })).body;

beforeAll(async () => {
  writeKey = await createKey(owner, 'write:Authentication');
  adminKey = await createKey(owner, 'read:admin');
  customerKey = await createKey(owner, 'read:customer');
});
afterAll(async () => { await Promise.all([owner.end(), runtime.end(), anonymize.end()]); });

test('keeps the events but overwrites the Customer\'s personal fields as Actor and Subject', async () => {
  const own = await write({});
  const byStaff = await write({
    actor: staff, subject: alice, action: 'access_grant.revoked', description: 'Sam refunded Alice.',
    ip_address: '198.51.100.9', user_agent: 'StaffBrowser/1.0',
  });
  const asTarget = await write({ actor: staff, subject: null, target: { type: 'customer', id: alice.id, display_name: 'Alice Shopper' }, customer_description: null, ip_address: null, user_agent: null });
  const before = await detail(own);

  expect(await anonymizeCustomer(anonymize, { type: alice.type, id: alice.id })).toBe(3);

  const after = await detail(own);
  expect(after).toMatchObject({
    id: own, source: before.source, action: before.action, outcome: before.outcome, occurred_at: before.occurred_at,
    actor: { id: alice.id, display_name: 'Deleted customer' }, subject: { id: alice.id, display_name: 'Deleted customer' },
  });
  expect(after.ip_address ?? 'Deleted customer').toBe('Deleted customer');
  expect(after.user_agent ?? 'Deleted customer').toBe('Deleted customer');

  const staffEvent = await detail(byStaff);
  expect(staffEvent).toMatchObject({ actor: staff, subject: { id: alice.id, display_name: 'Deleted customer' }, ip_address: '198.51.100.9', user_agent: 'StaffBrowser/1.0' });
  expect((await detail(asTarget)).target).toMatchObject({ id: alice.id, display_name: 'Deleted customer' });

  const list = await request(app).get('/events').query({ actor_id: alice.id }).auth(adminKey, { type: 'bearer' });
  expect(list.body.events.map((e: { id: string }) => e.id)).toContain(own);
  const customerView = await request(app).get('/events/customer-activity').query({ subject_type: alice.type, subject_id: alice.id }).auth(customerKey, { type: 'bearer' });
  expect(customerView.body.events.map((e: { id: string }) => e.id).sort()).toEqual([own, byStaff].sort());
});

test('leaves other Customers\' events untouched', async () => {
  const bobEvent = await write({ actor: bob, subject: bob, ip_address: '192.0.2.5', user_agent: 'BobBrowser/1.0' });
  const before = await detail(bobEvent);
  await write({});
  await anonymizeCustomer(anonymize, { type: alice.type, id: alice.id });
  expect(await detail(bobEvent)).toEqual(before);
});

test('running it again is harmless', async () => {
  const id = await write({});
  await anonymizeCustomer(anonymize, { type: alice.type, id: alice.id });
  const once = await detail(id);
  await anonymizeCustomer(anonymize, { type: alice.type, id: alice.id });
  expect(await detail(id)).toEqual(once);
});

test('the anonymization role can update exactly the personal columns and nothing else', async () => {
  const personal = ['actor_display_name', 'target_display_name', 'subject_display_name', 'ip_address', 'user_agent'];
  for (const column of personal) await anonymize.query(`UPDATE audit_events SET ${column} = ${column} WHERE false`);
  const columns = (await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_events'")).rows.map(r => r.column_name as string);
  for (const column of columns.filter(c => !personal.includes(c))) {
    await expect(anonymize.query(`UPDATE audit_events SET ${column} = ${column} WHERE false`), column).rejects.toMatchObject({ code: '42501' });
  }
  await expect(anonymize.query('DELETE FROM audit_events WHERE false')).rejects.toMatchObject({ code: '42501' });
  await expect(anonymize.query('UPDATE api_keys SET revoked_at = NULL WHERE false')).rejects.toMatchObject({ code: '42501' });
});
