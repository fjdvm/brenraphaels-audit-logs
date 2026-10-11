# Audit Event API

Requires Node 24 or later. Run `npm ci`, copy `.env.example` to `.env` and fill in the connection strings. Use a dedicated Neon project (or local Postgres database). `DATABASE_URL_MIGRATIONS` is its owner, the third role alongside `audit_runtime` and `audit_anonymize`.

Run `npm run db:migrate` once on a fresh database. The migration creates the tables and the two restricted login roles. As owner, assign each role a strong password using your database provider's secure tooling, then set the runtime and anonymization URLs with those credentials. Existing databases/roles are deliberately rejected rather than silently reusing unknown grants. To upgrade a database already running migration 0001, apply `migrations/0002_write_contract.sql` once as the database owner (for example, with `psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 -1 -f migrations/0002_write_contract.sql`). Keep the owner credentials out of the deployed runtime environment.

`npm run key -- create write:Authentication` and `npm run key -- create read:admin` print a new random plaintext key once. Only its SHA-256 hash is persisted; store the plaintext securely at creation. `npm run key -- revoke <sha256-hash>` revokes it. Run operator commands with the owner connection, never the runtime role.

Start with `npm run dev`, or `npm run build` then `npm start`; these load `.env`. Authenticate with `Authorization: Bearer <key>`.

`POST /events` requires a `write:<source>` key matching the body’s Source. Example JSON:

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

Returns 201 with `{ "id": "<uuid>" }`. Subject and Customer description may be omitted or null. Outcome is `success` or `failure`. Timestamps use ISO 8601 with a timezone; the service supplies `recorded_at`. `occurred_at` may be late but cannot be more than five minutes in the future. Descriptions are stored verbatim, including whitespace.

All eight Sources and their starting Actions are defined in `src/catalog.ts`; unknown Actions or Actions belonging to another Source return 400. A key for a different Source returns 403.

Optional fields:

- `module`: nonempty string, allowed only for CRMS, HRMS, POS and IMS; omit or use null for other Sources.
- `metadata`: JSON object, at most 4096 UTF-8 bytes when JSON-serialized. Keys containing `password`, `token`, `secret`, `authorization`, `card` or `cvv` (case insensitive) anywhere, including inside arrays, return 400.
- `ip_address`: IPv4 or IPv6 address; `user_agent` and `request_id`: nonempty strings. These fields can also be null.
- `idempotency_key`: nonempty producer string. Retries with the same Source and key return 201 with the original `{ "id": "<uuid>" }`, even after write-key rotation, and never replace the original event. Different Sources have separate namespaces. Omission creates a new event on every request. Retries still undergo authentication and validation.

NUL characters and malformed Unicode in text or metadata return 400. Unknown fields, including producer-supplied `recorded_at`, return 400. The total request body limit is 16 KB.

`GET /events/:id` requires `read:admin` and returns the fields above plus `id` and `recorded_at`; absent optional fields are null. Returns 404 for an unknown event, 400 for invalid input/Action/id, 401 for missing/unknown/revoked keys, 403 for the wrong scope and 413 for bodies over 16 KB. No update or delete endpoint exists.

For tests, migrate a disposable database and set `TEST_DATABASE_URL` to its owner connection and `TEST_DATABASE_URL_RUNTIME` to its `audit_runtime` connection. Run `npm test` (or `node --env-file=.env node_modules/vitest/vitest.mjs run`). Tests call Express in-process against real Postgres and create events/keys; they do not clean or delete history. Batch writes, list/search/export, Customer reads and the anonymization job are separate work.
