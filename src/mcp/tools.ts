import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient, ApiResult } from './client.ts';

export type McpKeys = { admin?: string; write?: string; customer?: string };

const reply = ({ status, body }: ApiResult) => ({
  isError: status >= 400,
  content: [{ type: 'text' as const, text: status >= 400 ? `HTTP ${status}: ${body}` : body }],
});

const party = z.object({ type: z.string(), id: z.string(), display_name: z.string() });

const filters = {
  source: z.string().optional().describe('One of CRMS, HRMS, POS, IMS, Authentication, File storage, Notifications, Ecommerce'),
  module: z.string().optional(),
  action: z.string().optional().describe('Action names come from get_valid_values'),
  outcome: z.enum(['success', 'failure']).optional(),
  actor_type: z.string().optional().describe('Pass with actor_id to identify one Actor'),
  actor_id: z.string().optional(),
  subject_type: z.string().optional().describe('Pass with subject_id to identify one Subject'),
  subject_id: z.string().optional(),
  q: z.string().min(1).max(200).optional().describe('Case-insensitive substring over description and Actor/Subject display names'),
  from: z.string().optional().describe('Inclusive ISO 8601 lower bound on occurred_at, timezone required'),
  to: z.string().optional().describe('Inclusive ISO 8601 upper bound on occurred_at, timezone required'),
};

const auditEvent = {
  source: z.string().describe('Must match the Source of the write key'),
  action: z.string().describe('Must belong to the Source; see get_valid_values'),
  outcome: z.enum(['success', 'failure']),
  actor: party,
  target: party,
  subject: party.nullable().optional().describe('Decides whose history the event appears in'),
  description: z.string().describe('Plain-language sentence for Administrators'),
  customer_description: z.string().optional().describe('Sentence for the Subject Customer; without it the event is Administrator-only'),
  occurred_at: z.string().describe('ISO 8601 with timezone, at most five minutes in the future'),
  module: z.string().optional().describe('Only for CRMS, HRMS, POS and IMS'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('At most 4096 bytes; keys such as password, token, secret, authorization, card, cvv are rejected'),
  ip_address: z.string().optional(),
  user_agent: z.string().optional(),
  request_id: z.string().optional(),
  idempotency_key: z.string().optional().describe('Retries with the same Source and key return the original id'),
};

export const registerTools = (server: McpServer, api: ApiClient, keys: McpKeys) => {
  const { admin, write, customer } = keys;
  if (admin) {
    server.registerTool('get_valid_values', {
      description: 'List every Source with its Modules and the Actions it may write. Call this first to learn valid filter and write values.',
    }, async () => reply(await api.get('/events/valid-values', admin)));

    server.registerTool('search_events', {
      description: 'Administrator list and search of Audit Events, newest first. Filters combine with AND. Page with next_cursor while keeping the same filters.',
      inputSchema: { ...filters, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
    }, async (args) => reply(await api.get('/events', admin, args)));

    server.registerTool('get_event', {
      description: 'Fetch one Audit Event by its UUID, with every written field plus recorded_at.',
      inputSchema: { id: z.string().describe('Audit Event UUID') },
    }, async ({ id }) => reply(await api.get(`/events/${encodeURIComponent(id)}`, admin)));

    server.registerTool('event_stats', {
      description: 'Count Audit Events grouped by day, source, action or outcome, for charts. Accepts the same filters as search_events.',
      inputSchema: { group_by: z.enum(['day', 'source', 'action', 'outcome']), ...filters, limit: z.number().int().min(1).max(100).optional().describe('Caps buckets for group_by=action only') },
    }, async (args) => reply(await api.get('/events/stats', admin, args)));

    server.registerTool('export_events', {
      description: 'Export matching Audit Events as CSV or JSON text (at most 50,000 rows). Records an audit_log.exported event attributed to requested_by_*, so only call this on behalf of a real Administrator.',
      inputSchema: {
        format: z.enum(['csv', 'json']),
        from: z.string().describe('Inclusive ISO 8601 lower bound on occurred_at'),
        to: z.string().describe('Inclusive ISO 8601 upper bound on occurred_at'),
        requested_by_id: z.string().describe('Id of the Administrator asking'),
        requested_by_name: z.string().describe('Display name of the Administrator asking'),
        ...Object.fromEntries(Object.entries(filters).filter(([name]) => name !== 'from' && name !== 'to')),
      },
    }, async (args) => reply(await api.get('/events/export', admin, args)));
  }

  if (customer) {
    server.registerTool('get_customer_activity', {
      description: 'A Customer\'s own activity feed (customer-facing descriptions only), newest first. subject_id must come from the Customer\'s authenticated session, never from user input.',
      inputSchema: { subject_type: z.string(), subject_id: z.string(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
    }, async (args) => reply(await api.get('/events/customer-activity', customer, args)));
  }

  if (write) {
    server.registerTool('write_event', {
      description: 'Record one Audit Event. Append-only: events can never be edited or deleted, so check values with get_valid_values first.',
      inputSchema: auditEvent,
    }, async (event) => reply(await api.post('/events', write, event)));

    server.registerTool('write_events_batch', {
      description: 'Record 1 to 100 Audit Events atomically (all or none). Every event must belong to the write key\'s Source.',
      inputSchema: { events: z.array(z.object(auditEvent)).min(1).max(100) },
    }, async (body) => reply(await api.post('/events/batch', write, body)));
  }
};
