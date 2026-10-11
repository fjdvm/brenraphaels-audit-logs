import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './client.ts';
import { registerTools } from './tools.ts';

const { AUDIT_LOGS_URL, AUDIT_LOGS_ADMIN_KEY, AUDIT_LOGS_WRITE_KEY, AUDIT_LOGS_CUSTOMER_KEY } = process.env;
if (!AUDIT_LOGS_URL) throw new Error('AUDIT_LOGS_URL is required');
if (!AUDIT_LOGS_ADMIN_KEY && !AUDIT_LOGS_WRITE_KEY && !AUDIT_LOGS_CUSTOMER_KEY) {
  throw new Error('Set at least one of AUDIT_LOGS_ADMIN_KEY, AUDIT_LOGS_WRITE_KEY, AUDIT_LOGS_CUSTOMER_KEY');
}

const server = new McpServer({ name: 'audit-logs', version: '1.0.0' });
registerTools(server, createApiClient(AUDIT_LOGS_URL), {
  admin: AUDIT_LOGS_ADMIN_KEY, write: AUDIT_LOGS_WRITE_KEY, customer: AUDIT_LOGS_CUSTOMER_KEY,
});
await server.connect(new StdioServerTransport());
