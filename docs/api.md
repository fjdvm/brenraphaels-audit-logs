# Walking skeleton

Requires Node 24 or later. Run `npm ci`, copy `.env.example` to `.env` and fill in the connection strings. Use a dedicated Neon project (or local Postgres database). `DATABASE_URL_MIGRATIONS` is its owner, the third role alongside `audit_runtime` and `audit_anonymize`.

Run `npm run db:migrate` once on a fresh database. The migration creates the tables and the two restricted login roles. As owner, assign each role a strong password using your database provider's secure tooling, then set the runtime and anonymization URLs with those credentials. Existing databases/roles are deliberately rejected rather than silently reusing unknown grants. Keep the owner credentials out of the deployed runtime environment.

`npm run key -- create write:Authentication` and `npm run key -- create read:admin` print a new random plaintext key once. Only its SHA-256 hash is persisted; store the plaintext securely at creation. `npm run key -- revoke <sha256-hash>` revokes it. Run operator commands with the owner connection, never the runtime role.

Start with `npm run dev`, or `npm run build` then `npm start`; these load `.env`. Authenticate with `Authorization: Bearer <key>`.

`POST /events` requires `write:Authentication`. Example JSON:

```json
{
  "source": "Authentication",
  "action": "user.login",
  "outcome": "success",
  "actor": {"type": "user", "id": "user-1", "display_name": "Alice"},
  "target": {"type": "session", "id": "session-1", "display_name": "Portal session"},
  "subject": {"type": "user", "id": "user-1", "display_name": "Alice"},
  "description": "Alice signed in.",
  "customer_description": "You signed in.",
  "occurred_at": "2026-01-01T12:00:00.000Z"
}
```

Returns 201 with `{ "id": "<uuid>" }`. Subject and Customer description may be omitted or null. Outcome is `success` or `failure`. Timestamps use ISO 8601 with a timezone; the service supplies `recorded_at`. Authentication has no Module. Allowed Actions are in `src/catalog.ts`.

`GET /events/:id` requires `read:admin` and returns the fields above plus `id` and `recorded_at`; absent optional fields are null. Returns 404 for an unknown event, 400 for invalid input/Action/id, 401 for missing/unknown/revoked keys, 403 for the wrong scope and 413 for bodies over 16 KB. No update or delete endpoint exists.

For tests, migrate a disposable database and set `TEST_DATABASE_URL` to its owner connection and `TEST_DATABASE_URL_RUNTIME` to its `audit_runtime` connection. Run `npm test` (or `node --env-file=.env node_modules/vitest/vitest.mjs run`). Tests call Express in-process against real Postgres and create events/keys; they do not clean or delete history. This skeleton does not yet implement batch writes, idempotency, metadata, list/search/export, Customer reads or the anonymization job.
