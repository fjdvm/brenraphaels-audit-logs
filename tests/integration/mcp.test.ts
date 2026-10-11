import { afterAll, beforeAll, expect, test } from 'vitest';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../src/http/app.ts';
import { createKey } from '../../src/api-keys/keys.ts';

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL_RUNTIME });
let server: Server;
let url: URL;
let writeKey: string;
let adminKey: string;

const connect = async (key: string) => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
};

beforeAll(async () => {
  server = createServer(createApp(runtime, { rateLimitPerSecond: 1000 })).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  writeKey = await createKey(owner, 'write:Authentication');
  adminKey = await createKey(owner, 'read:admin');
});
afterAll(async () => {
  server.close();
  await Promise.all([owner.end(), runtime.end()]);
});

test('refuses a call without a valid key', async () => {
  const call = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });
  expect((await call({})).status).toBe(401);
  expect((await call({ authorization: 'Bearer nope' })).status).toBe(401);
  expect((await fetch(url)).status).toBe(405);
});

test('the key role decides which tools are offered', async () => {
  const names = async (key: string) => (await (await connect(key)).listTools()).tools.map(tool => tool.name).sort();
  expect(await names(adminKey)).toEqual(['event_stats', 'export_events', 'get_event', 'get_valid_values', 'search_events']);
  expect(await names(writeKey)).toEqual(['write_event', 'write_events_batch']);
});

test('a write tool stores an event that an admin tool reads back', async () => {
  const party = { type: 'user', id: 'mcp-test', display_name: 'MCP test' };
  const written = await (await connect(writeKey)).callTool({ name: 'write_event', arguments: {
    source: 'Authentication', action: 'user.login', outcome: 'success', actor: party,
    target: { type: 'session', id: 's-1', display_name: 'Session' },
    description: 'Written through MCP.', occurred_at: new Date().toISOString(),
  } });
  expect(written.isError).toBe(false);
  const { id } = JSON.parse((written.content as { text: string }[])[0]!.text) as { id: string };
  const read = await (await connect(adminKey)).callTool({ name: 'get_event', arguments: { id } });
  expect(JSON.parse((read.content as { text: string }[])[0]!.text)).toMatchObject({ id, description: 'Written through MCP.' });
});
