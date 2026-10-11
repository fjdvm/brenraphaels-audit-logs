import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { createKey } from '../../src/api-keys/keys.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
const app = createApp(runtime, { rateLimitPerSecond: 1000, exportMaxRows: 3 });
let adminKey: string;
let customerKey: string;
let authKey: string;
const actor = { type: 'user', id: crypto.randomUUID(), display_name: 'Export, "Tester"' };
const requester = { requested_by_id: 'admin-7', requested_by_name: 'Ada Admin' };
const base = {
  source: 'Authentication', action: 'user.login', outcome: 'success', actor,
  target: { type: 'session', id: 's-1', display_name: 'Session' }, description: 'Line one,\nline "two".',
};
const range = { from: '2025-07-01T00:00:00Z', to: '2025-07-31T23:59:59Z' };
const exportAs = (query: object, key = adminKey) => request(app).get('/events/export').auth(key, { type: 'bearer' }).query({ actor_id: actor.id, ...requester, ...query });
const exportText = async (query: object) => {
  const response = await exportAs(query).buffer(true).parse((res, callback) => { res.setEncoding('utf8'); let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => callback(null, text)); });
  return { status: response.status, headers: response.headers, text: response.body as string };
};

beforeAll(async () => {
  adminKey = await createKey(owner, 'read:admin');
  customerKey = await createKey(owner, 'read:customer');
  authKey = await createKey(owner, 'write:Authentication');
  for (const [index, outcome] of ['success', 'failure', 'success', 'success'].entries()) {
    const day = String(index + 1).padStart(2, '0');
    expect((await request(app).post('/events').auth(authKey, { type: 'bearer' }).send({ ...base, outcome, occurred_at: `2025-07-${day}T10:00:00Z` })).status).toBe(201);
  }
});
afterAll(async () => { await Promise.all([owner.end(), runtime.end()]); });

test('JSON export contains exactly the events the list returns for the same filters', async () => {
  const filters = { ...range, outcome: 'success' };
  const listed = await request(app).get('/events').auth(adminKey, { type: 'bearer' }).query({ actor_id: actor.id, ...filters });
  const exported = await exportText({ ...filters, format: 'json' });
  expect(exported.status).toBe(200);
  expect(exported.headers['content-type']).toMatch(/application\/json/);
  expect(exported.headers['content-disposition']).toMatch(/attachment; filename="audit-events.*\.json"/);
  expect(JSON.parse(exported.text)).toEqual({ events: listed.body.events });
  expect(listed.body.events).toHaveLength(3);
});

test('CSV export has a header and one correctly quoted row per listed event, newest first', async () => {
  const listed = await request(app).get('/events').auth(adminKey, { type: 'bearer' }).query({ actor_id: actor.id, ...range, outcome: 'success' });
  const exported = await exportText({ ...range, outcome: 'success', format: 'csv' });
  expect(exported.status).toBe(200);
  expect(exported.headers['content-type']).toMatch(/text\/csv/);
  const [header = [] as string[], ...rows] = parseCsv(exported.text);
  expect(header).toEqual(['id', 'source', 'module', 'action', 'outcome', 'actor_type', 'actor_id', 'actor_display_name', 'target_type', 'target_id', 'target_display_name',
    'subject_type', 'subject_id', 'subject_display_name', 'description', 'customer_description', 'ip_address', 'user_agent', 'occurred_at', 'recorded_at']);
  expect(rows.map(row => row[0])).toEqual(listed.body.events.map((item: { id: string }) => item.id));
  expect(rows[0]![header.indexOf('actor_display_name')]).toBe(actor.display_name);
  expect(rows[0]![header.indexOf('description')]).toBe(base.description);
});

test('an export without a full date range is refused with a clear message', async () => {
  for (const query of [{ format: 'csv' }, { format: 'csv', from: range.from }, { format: 'json', to: range.to }]) {
    const response = await exportAs(query);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.details)).toMatch(/from|to/);
  }
  expect((await exportAs({ ...range })).status).toBe(400);
  expect((await exportAs({ ...range, format: 'xml' })).status).toBe(400);
  expect((await exportAs({ from: range.to, to: range.from, format: 'csv' })).status).toBe(400);
});

test('an export over the row cap is refused, names the cap and records no export event', async () => {
  const before = await exportedEvents();
  const response = await exportAs({ ...range, format: 'csv' });
  expect(response.status).toBe(413);
  expect(response.body.error).toMatch(/more than 3 rows/);
  expect(await exportedEvents()).toHaveLength(before.length);
});

test('every successful export records an audit_log.exported event with the filters and who asked', async () => {
  const before = (await exportedEvents()).length;
  const filters = { ...range, outcome: 'failure' };
  expect((await exportText({ ...filters, format: 'json' })).status).toBe(200);
  const after = await exportedEvents();
  expect(after).toHaveLength(before + 1);
  const recorded = after[0]!;
  expect(recorded).toMatchObject({
    source: 'Authentication', action: 'audit_log.exported', outcome: 'success',
    actor: { type: 'user', id: 'admin-7', display_name: 'Ada Admin' },
  });
  const details = (await request(app).get(`/events/${recorded.id}`).auth(adminKey, { type: 'bearer' })).body;
  expect(details.metadata).toEqual({ format: 'json', row_count: 1, filters: { actor_id: actor.id, ...filters } });
});

test('a read:customer key, a write key and a missing requester are refused', async () => {
  expect((await exportAs({ ...range, format: 'csv' }, customerKey)).status).toBe(403);
  expect((await exportAs({ ...range, format: 'csv' }, authKey)).status).toBe(403);
  const anonymous = await request(app).get('/events/export').auth(adminKey, { type: 'bearer' }).query({ actor_id: actor.id, ...range, format: 'csv' });
  expect(anonymous.status).toBe(400);
});

async function exportedEvents() {
  const response = await request(app).get('/events').auth(adminKey, { type: 'bearer' }).query({ action: 'audit_log.exported', actor_id: 'admin-7', limit: 100 });
  return response.body.events as Array<{ id: string; [key: string]: unknown }>;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
