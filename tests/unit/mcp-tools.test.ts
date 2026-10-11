import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/mcp/client.ts';
import { registerTools, type McpKeys } from '../../src/mcp/tools.ts';

const connect = async (keys: McpKeys, respond: (url: URL, init: RequestInit) => Response) => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => { calls.push({ url, init }); return respond(url, init); }) as typeof fetch;
  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(server, createApiClient('https://audit.example', fetchImpl), keys);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls };
};

describe('audit-logs MCP tools', () => {
  it('exposes only the tools the configured keys allow', async () => {
    const { client } = await connect({ customer: 'c' }, () => new Response('{}'));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['get_customer_activity']);
  });

  it('sends filters as query parameters with the admin key', async () => {
    const { client, calls } = await connect({ admin: 'adm' }, () => new Response('{"events":[],"next_cursor":null}'));
    const result = await client.callTool({ name: 'search_events', arguments: { source: 'CRMS', q: 'alice', limit: 5 } });
    expect(result.isError).toBe(false);
    expect(calls[0]?.url.href).toBe('https://audit.example/events?source=CRMS&q=alice&limit=5');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer adm');
  });

  it('posts a write with the write key and reports API errors', async () => {
    const { client, calls } = await connect({ write: 'w' }, () => new Response('{"error":"Source write key required"}', { status: 403 }));
    const party = { type: 'user', id: '1', display_name: 'A' };
    const result = await client.callTool({ name: 'write_event', arguments: {
      source: 'CRMS', action: 'record.created', outcome: 'success', actor: party, target: party,
      description: 'd', occurred_at: '2026-01-01T00:00:00Z',
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('HTTP 403');
    expect(calls[0]?.init.method).toBe('POST');
  });
});
