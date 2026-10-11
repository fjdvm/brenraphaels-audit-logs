# MCP server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets any agent call the Audit Event API as tools. It is a thin client over the HTTP API (see [`api-contract.md`](api-contract.md)): it holds no database access and enforces nothing itself, so key roles, validation and rate limits behave exactly as for direct calls.

## Configuration

| Variable | Required | Enables |
| --- | --- | --- |
| `AUDIT_LOGS_URL` | yes | Base URL of the service, for example `https://brenraphaels-audit-logs.vercel.app` |
| `AUDIT_LOGS_ADMIN_KEY` | one key at least | `read:admin` tools: `get_valid_values`, `search_events`, `get_event`, `event_stats`, `export_events` |
| `AUDIT_LOGS_CUSTOMER_KEY` | | `read:customer` tool: `get_customer_activity` |
| `AUDIT_LOGS_WRITE_KEY` | | `write:<Source>` tools: `write_event`, `write_events_batch` |

Only the tools whose key is set are exposed, so give an agent the narrowest key it needs. Prefer a read key for exploration; a write key lets the agent append permanent, undeletable events.

## Use it

From a checkout, with Node 24 or later and `npm ci` run:

```json
{
  "mcpServers": {
    "audit-logs": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/audit-logs",
      "env": {
        "AUDIT_LOGS_URL": "https://brenraphaels-audit-logs.vercel.app",
        "AUDIT_LOGS_ADMIN_KEY": "<read:admin key>"
      }
    }
  }
}
```

For Claude Code: `claude mcp add audit-logs -e AUDIT_LOGS_URL=<url> -e AUDIT_LOGS_ADMIN_KEY=<key> -- npm run --silent mcp --prefix /path/to/audit-logs`.

API errors come back as tool errors of the form `HTTP <status>: <body>`, so the agent sees the same messages the contract documents.
