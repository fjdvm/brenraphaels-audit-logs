import type { Express } from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/node-postgres';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hashKey } from '../api-keys/keys.ts';
import { keys } from '../db/schema.ts';
import { createApiClient } from './client.ts';
import { registerTools, type McpKeys } from './tools.ts';

const keysFor = (scope: string, token: string): McpKeys =>
  scope === 'read:admin' ? { admin: token } : scope === 'read:customer' ? { customer: token } : { write: token };

// Remote MCP endpoint: the caller's own API key picks the tools, and each tool calls this same app over loopback with that key,
// so roles, validation and rate limits are exactly those of direct API calls. The loopback address is fixed, never taken from the request.
export function registerMcp(app: Express, db: ReturnType<typeof drizzle>) {
  let loopback: Promise<string> | undefined;
  const loopbackUrl = () => loopback ??= new Promise(resolve => {
    const server = createServer(app).listen(0, '127.0.0.1', () => {
      server.unref();
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });

  app.post('/mcp', async (req, res) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'API key required' }); return; }
    const [key] = await db.select().from(keys).where(and(eq(keys.hash, hashKey(token)), isNull(keys.revoked_at)));
    if (!key) { res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Invalid API key' }); return; }
    const server = new McpServer({ name: 'audit-logs', version: '1.0.0' });
    registerTools(server, createApiClient(await loopbackUrl()), keysFor(key.scope, token));
    // Stateless: one server and transport per request, so any instance can serve any call.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }); });
}
