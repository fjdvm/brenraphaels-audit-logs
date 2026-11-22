# audit-logs

The company's single, append-only record of who did what, where, and when across all its applications. See [`CONTEXT.md`](CONTEXT.md) for the vocabulary.

## Documentation

- **[API guide](https://<audit-logs-host>/docs)**: start here. Every endpoint, key role, filter and error with a worked example each, for the authors of the portal tab, the Ecommerce activity page and each Source's integration. Live at <https://<audit-logs-host>/docs> (no key needed). Locally, run `npm run dev` and open `http://localhost:3000/docs`, or open the file directly in a browser.
- [API contract (Markdown)](docs/api-contract.md): the same contract as plain text, the reference the guide mirrors.
- [MCP server](docs/mcp.md): the same API as tools for any agent (`npm run mcp`).
- [Setup, deployment and operations](docs/api.md)
- [Architecture decisions](docs/adr/)
