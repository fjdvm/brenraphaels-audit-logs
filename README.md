# audit-logs

The company's single, append-only record of who did what, where, and when across all its applications. See [`CONTEXT.md`](CONTEXT.md) for the vocabulary.

## Documentation

- **[API guide](docs/guide/index.html)**: start here. Every endpoint, key role, filter and error with a worked example each, for the authors of the portal tab, the Ecommerce activity page and each Source's integration. The running service serves it at `GET /docs` (no key needed); locally, run `npm run dev` and open `http://localhost:3000/docs`, or open the file directly in a browser.
- [API contract (Markdown)](docs/api-contract.md): the same contract as plain text, the reference the guide mirrors.
- [Setup, deployment and operations](docs/api.md)
- [Architecture decisions](docs/adr/)
