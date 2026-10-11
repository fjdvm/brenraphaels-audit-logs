# MCP server

The service is a remote [Model Context Protocol](https://modelcontextprotocol.io) server at `POST /mcp` (Streamable HTTP, stateless). Any MCP client adds it with a URL and an API key, with nothing to install. The same instructions are in the `/docs` guide.

Each tool calls the HTTP API with the caller's own key ([`api-contract.md`](api-contract.md)), so key roles, validation and rate limits behave exactly as for direct calls. API errors come back as tool errors, `HTTP <status>: <body>`. A missing or revoked key gets 401.

## Tools by key role

The key's role decides which tools the agent sees.

| Key role | Tools |
| --- | --- |
| `read:admin` | `get_valid_values`, `search_events`, `get_event`, `event_stats`, `export_events` |
| `read:customer` | `get_customer_activity` |
| `write:<Source>` | `write_event`, `write_events_batch` |

Give an agent a read key for exploration: a write key lets it append permanent, undeletable events.

## Add it to a client

Put your key in `AUDIT_LOGS_KEY` first so it stays out of config files. The examples use the production URL.

```sh
# Claude Code
claude mcp add --transport http audit-logs https://brenraphaels-audit-logs.vercel.app/mcp \
  --header "Authorization: Bearer $AUDIT_LOGS_KEY"

# Codex
codex mcp add audit-logs --url https://brenraphaels-audit-logs.vercel.app/mcp --bearer-token-env-var AUDIT_LOGS_KEY
```

Cursor, `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "audit-logs": {
  "url": "https://brenraphaels-audit-logs.vercel.app/mcp",
  "headers": { "Authorization": "Bearer ${env:AUDIT_LOGS_KEY}" } } } }
```

Kiro, `~/.kiro/settings/mcp.json`:

```json
{ "mcpServers": { "audit-logs": {
  "url": "https://brenraphaels-audit-logs.vercel.app/mcp",
  "headers": { "Authorization": "Bearer ${AUDIT_LOGS_KEY}" } } } }
```

Any other client that supports a remote (Streamable HTTP) MCP server with custom headers takes the same URL and `Authorization: Bearer <key>` header.

## Local stdio fallback

For a client without remote support, run the server from a checkout (Node 24 or later, `npm ci`) with `npm run --silent mcp`. It reads `AUDIT_LOGS_URL` plus any of `AUDIT_LOGS_ADMIN_KEY`, `AUDIT_LOGS_CUSTOMER_KEY` and `AUDIT_LOGS_WRITE_KEY`, and exposes the tools for the keys that are set.
