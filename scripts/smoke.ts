const { BASE_URL, WRITE_KEY, ADMIN_KEY } = process.env;
if (!BASE_URL || !WRITE_KEY || !ADMIN_KEY) throw new Error('Usage: BASE_URL=<url> WRITE_KEY=<write:Authentication key> ADMIN_KEY=<read:admin key> npm run smoke');
const call = (path: string, key: string, body?: unknown) => fetch(new URL(path, BASE_URL), {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const event = {
  source: 'Authentication', action: 'user.login', outcome: 'success',
  actor: { type: 'user', id: 'smoke', display_name: 'Smoke test' },
  target: { type: 'session', id: 'smoke-session', display_name: 'Smoke session' },
  description: 'Deployment smoke test.', customer_description: 'Deployment smoke test.',
  occurred_at: new Date().toISOString(),
};
const written = await call('/events', WRITE_KEY, event);
if (written.status !== 201) throw new Error(`write returned ${written.status}: ${await written.text()}`);
const { id } = await written.json() as { id: string };
const read = await call(`/events/${id}`, ADMIN_KEY);
if (read.status !== 200) throw new Error(`read returned ${read.status}: ${await read.text()}`);
const stored = await read.json() as { id: string; description: string };
if (stored.id !== id || stored.description !== event.description) throw new Error('read did not return the written event');
console.log(`ok: wrote and read back ${id} at ${BASE_URL}`);
