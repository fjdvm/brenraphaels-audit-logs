# Audit Event API

Requires Node 24 or later. Run `npm ci`, copy `.env.example` to `.env` and fill in the connection strings. Use a dedicated Neon project (or local Postgres database). `DATABASE_URL_MIGRATIONS` is its owner, the third role alongside `audit_runtime` and `audit_anonymize`.

Run `npm run db:migrate` once on a fresh database. The migration creates the tables and the two restricted login roles. As owner, assign each role a strong password using your database provider's secure tooling, then set the runtime and anonymization URLs with those credentials. Existing databases/roles are deliberately rejected rather than silently reusing unknown grants. To upgrade a database already running migration 0001, apply `migrations/0002_write_contract.sql` once as the database owner (for example, with `psql "$DATABASE_URL_MIGRATIONS" -v ON_ERROR_STOP=1 -1 -f migrations/0002_write_contract.sql`). Keep the owner credentials out of the deployed runtime environment.

`npm run key -- create write:Authentication` and `npm run key -- create read:admin` print a new random plaintext key once. Only its SHA-256 hash is persisted; store the plaintext securely at creation. `npm run key -- revoke <sha256-hash>` revokes it; the very next request with that key returns 401. `npm run key -- rotate <sha256-hash>` prints a replacement key with the same scope once (storing only its hash) and revokes the old key; add `--overlap` to keep the old key working until you revoke it. Revoking and rotating only change `api_keys` and never touch Audit Events. Run operator commands with the owner connection, never the runtime role.

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

All eight Sources and their starting Actions are defined in `src/audit-events/catalog.ts`; unknown Actions or Actions belonging to another Source return 400. A key for a different Source returns 403.

Optional fields:

- `module`: nonempty string, allowed only for CRMS, HRMS, POS and IMS. CRMS rejects names outside its catalog; HRMS, POS and IMS continue to accept any nonempty name; HRMS's standard Modules are listed in `GET /events/valid-values` and include `Training` and `Performance`. Omit or use null for events without a Module.
- `metadata`: JSON object, at most 4096 UTF-8 bytes when JSON-serialized. Keys containing `password`, `token`, `secret`, `authorization`, `card` or `cvv` (case insensitive) anywhere, including inside arrays, return 400.
- `ip_address`: IPv4 or IPv6 address; `user_agent` and `request_id`: nonempty strings. These fields can also be null.
- `idempotency_key`: nonempty producer string. Retries with the same Source and key return 201 with the original `{ "id": "<uuid>" }`, even after write-key rotation, and never replace the original event. Different Sources have separate namespaces. Omission creates a new event on every request. Retries still undergo authentication and validation.

NUL characters and malformed Unicode in text or metadata return 400. Unknown fields, including producer-supplied `recorded_at`, return 400. The single-write request body limit is 16 KB.

`POST /events/batch` accepts `{ "events": [<Audit Event>, ...] }` with 1–100 events and a body limit of 1600 KB. The write key must match every event’s Source. Each event uses the same validation as a single write. Invalid batches return 400 with `details` paths such as `["events", 2, "action"]`, identifying the zero-based event index. Source mismatches return 403 with an `index`. Validation completes before storage; the batch is stored in one transaction, so a failure stores none of its new events.

A successful batch returns 201 with `{ "events": [{ "id": "<uuid>" }, ...] }` in input order. Idempotency keys retain the single-write semantics, including repeated keys within a batch, full-batch retries, and retries across single and batch writes.

`RATE_LIMIT_PER_SECOND` sets the maximum authenticated requests per API key per second (default 100; must be a positive integer). All `/events` requests share the key’s allowance; a batch counts as one request. Exceeding it returns 429 with `Retry-After: 1` and `{ "error": "API key rate limit exceeded", "retry_after": 1 }`. Other keys have independent allowances. Counters use one-second windows starting with each key’s first request, live in memory per service instance, and reset on restart. Multiple instances each grant their own allowance.

`GET /events/:id` requires `read:admin` and returns the fields above plus `id` and `recorded_at`; absent optional fields are null. Returns 404 for an unknown event, 400 for invalid input/Action/id, 401 for missing/unknown/revoked keys, 403 for the wrong scope and 413 for bodies over 16 KB. No update or delete endpoint exists.

For tests, use the existing Neon connections in `.env` (see `AGENTS.md`); set `TEST_DATABASE_URL` from `DATABASE_URL_MIGRATIONS` and `TEST_DATABASE_URL_RUNTIME` from `DATABASE_URL` when dedicated test URLs are unset. Set `TEST_DATABASE_URL_ANONYMIZE` from `DATABASE_URL_ANONYMIZE` when the owner cannot `SET ROLE`. Run `npm test -- --testTimeout=120000 --hookTimeout=30000` (or `node --env-file=.env node_modules/vitest/vitest.mjs run --testTimeout=120000 --hookTimeout=30000`) with those test URLs exported; the longer timeout accommodates Neon network latency. Tests call Express in-process against real Postgres and create events/keys; they do not clean or delete history. The anonymization job (`src/jobs/anonymize-customer/`) is invoked directly, not over HTTP; its tests run it and read events back through the API.

## Deployment (Azure Container Apps + Neon)

The service runs as an Azure Container App (the Express app in `src/server.ts`, built from the `Dockerfile`) against the Neon project. See [docs/deploy/azure.md](deploy/azure.md) for the workflow. Connection strings live in GitHub repository secrets, never in the repo:

- `DATABASE_URL`: pooled `audit_runtime` URL. The only database credential the deployed API needs.
- `DATABASE_URL_MIGRATIONS`: owner URL. Use it from an operator machine for `npm run db:migrate` and `npm run key`; do not add it to the deployed app.
- `DATABASE_URL_ANONYMIZE`: `audit_anonymize` URL for the separate anonymization job; do not set it on the API deployment.

Check a deployment with `BASE_URL=https://<deployment> WRITE_KEY=<write:Authentication key> ADMIN_KEY=<read:admin key> npm run smoke`. It writes one Audit Event and reads it back with the admin key. Create the keys with `npm run key`, and revoke them afterwards.

## Administrator list and filter values

`GET /events` requires `read:admin`. Returns `{ "events": [...], "next_cursor": "..." }`; `next_cursor` is null on the last page. Each event includes the detail fields, `module`, `ip_address` and `user_agent` (null when absent). List timestamps preserve Postgres microseconds.

Events are ordered by `occurred_at DESC`, then `recorded_at DESC`, then `id DESC`. The opaque cursor preserves all three ordering fields. Pass the returned `next_cursor` as `cursor` and keep the same filters while paging. Pages are live reads, not a snapshot across concurrent insertions. `limit` defaults to 50 and accepts integers from 1 to 100.

Optional exact-match filters: `source`, `module`, `action`, `actor_type`, `actor_id`, `subject_type`, `subject_id`, `outcome` (`success` or `failure`). Identity is the `(type, id)` pair; pass both to identify a specific Actor or Subject. Filters combine with AND. `from` and `to` are inclusive ISO 8601 bounds with a timezone on `occurred_at`; either can be omitted. Unknown catalog values produce an empty result. Optional `q` is a case-insensitive substring search (1–200 characters after trimming; `%`, `_` and `\` match literally) over `description` and the Actor and Subject display names, so a portal Username finds events where that person is Actor or Subject. It combines with the filters and cursor pagination. Invalid queries, reversed date ranges, and malformed cursors return 400.

Example: `GET /events?source=CRMS&module=Tickets&outcome=failure&from=2025-01-01T00:00:00Z&limit=25`.

`GET /events/stats?group_by=<day|source|action|outcome>` requires `read:admin` and returns `{ "group_by": "...", "buckets": [{ "key": "...", "count": 12 }, ...] }` for the Administrator charts. It accepts the same filters as `GET /events` (including `q`, `from` and `to`) but no `cursor`; `group_by` is required. `day` buckets are UTC dates (`YYYY-MM-DD`) in ascending order and omit days with no events; `source`, `action` and `outcome` buckets are ordered by count descending, then key. `limit` (1–100, default 10) caps the top Actions and is ignored for the other groupings. For repeated failed logins use `group_by=day&outcome=failure&source=Authentication&action=user.login`. Invalid parameters return 400; other scopes get 403.

`GET /events/valid-values` requires `read:admin` and returns `{ "sources": [{ "source": "CRMS", "modules": [...], "actions": [...] }, ...] }` for all eight Sources, including Sources with no events. Sources without Modules return an empty array. Sources and Actions use the same catalog as write validation; Modules list the portal’s seeded names. CRMS writes accept only its listed Modules; HRMS, POS and IMS continue to accept any nonempty Module.

Write keys and `read:customer` keys receive 403 on both endpoints. No PUT, PATCH or DELETE route exists.

On a database with the write-contract migration applied, run `npm run db:migrate -- 0003_administrator_list.sql` with the owner connection to add the pagination index. On a fresh database, `npm run db:migrate` applies all three migrations. Migrations are one-time operations; record which ones have run before applying them.

## Customer activity read

`GET /events/customer-activity` requires `read:customer` (the Ecommerce backend's key); admin and write keys receive 403. `subject_type` and `subject_id` are both required: a query without a Subject returns 400. The only other parameters are `limit` (1–100, default 50) and `cursor`; any other parameter returns 400, so no filter can reach another Customer's events.

Returns `{ "events": [...], "next_cursor": "..." }` for that Subject's Audit Events that have a `customer_description`; events without one never appear. Each event has only `id`, `source`, `action`, `outcome`, `customer_description` and `occurred_at`. Actor (including staff names), IP address, user agent, Target, metadata and the admin `description` are never returned. Ordering and cursor paging match the Administrator list; a cursor only pages within the queried Subject's own events.

## Export

`GET /events/export` requires `read:admin`; `read:customer` and write keys receive 403. It streams the Audit Events matching the same filters as `GET /events` (`source`, `module`, `action`, `actor_type`, `actor_id`, `subject_type`, `subject_id`, `outcome`, `q`), newest first, as a download. There is no `limit` or `cursor`.

Required parameters, otherwise 400 with a message naming them:

- `format`: `csv` or `json`. CSV has a header row and one flat row per event (Actor, Target and Subject split into `_type`, `_id` and `_display_name` columns). JSON is `{ "events": [...] }` with the same event objects as the list.
- `from` and `to`: inclusive ISO 8601 bounds on `occurred_at`; `from` must not follow `to`.
- `requested_by_id` and `requested_by_name`: the portal Administrator asking. Keys carry no identity, so the caller supplies it and it is recorded as the Actor of the export event.

An export matching more than 50,000 events is refused with 413 and a message giving the matching count; narrow the date range or filters. Nothing is streamed and no event is written.

Every accepted export first records an `audit_log.exported` Audit Event (Source Authentication, Actor from `requested_by_*`, Target `audit_log`) whose `metadata` holds `format`, `row_count` and the `filters` used, including `from` and `to`. The export covers events recorded up to the moment the request is accepted, so the export event and anything written during the stream are not in it, and a later list may show them. If streaming fails partway the connection is aborted rather than ended cleanly, but the export event is already recorded. CSV cells that begin with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'` so spreadsheets do not run them as formulas; JSON values are verbatim.

## CREOMS vocabulary

CRMS accepts these Staff Actions. Action and Module catalogs are validated independently; these pairings are the producer contract.

| Module | Actions |
| --- | --- |
| Orders | `order.delivery_fee_quoted`, `order.confirmed`, `order.cancelled` |
| Payments | `order.marked_paid` |
| Fulfilment | `order.preparing`, `order.dispatched`, `order.delivered`, `order.delivery_photo_attached` |
| Returns | `return.approved`, `return.declined`, `return.goods_received`, `return.refunded`, `return.replaced` |
| Tickets | `ticket.opened`, `ticket.claimed`, `ticket.released`, `ticket.status_changed`, `ticket.priority_changed` |
| Customer Profiles | `walk_in_customer.created`, `walk_in_customer.updated`, `customer_profile.viewed` |
| Feedback | `feedback.analysis_run` |
| Marketing (legacy Campaigns) | `record.created`, `record.updated`, `record.deleted`, `record.viewed` |
| No Module | `crms.signed_in`, `crms.access_denied` |

The four `record.*` Actions remain accepted throughout CRMS. Existing Dashboard, Customer Profiles, Campaigns, Conversations and Tickets Module names remain valid alongside Orders, Payments, Fulfilment, Returns, Marketing and Feedback. Access events omit `module` or set it to null. Ticket Messages, navigation and Dashboard PDF exports introduce no Actions.

Before enabling CREOMS producers, deploy this catalog, then configure the gateway's `crms` Caller with an audit-logs key created with `write:CRMS` scope. Keep the plaintext key in the gateway's `CALLERS` secret only. The gateway's `auditScope` metadata should also be `write:CRMS`; authorization is enforced by the audit key itself.

## HRMS vocabulary

HRMS accepts `job_posting.created`, `job_posting.updated`, `job_posting.published`, `job_posting.closed`, `job_posting.filled`, `job_template.created`, `job_template.updated` and `job_template.deleted`, alongside the four existing `record.*` Actions. These Actions are also listed under HRMS in `GET /events/valid-values`. Unknown Actions remain rejected. Recruitment and Hiring is the standard Module for these events; HRMS continues to accept any non-empty Module.

### Training and Performance

HRMS also accepts these Actions for Training (Module `Training`): `training.created`, `training.updated`, `training.rescheduled`, `training.cancelled`, `training.employee_assigned`, `training.employee_unassigned`, `training.results_marked`, `training.feedback_recorded`, `training.reminder_sent`, `training.notice_retried`, `training_material.uploaded` and `training_material.deleted`.

And these for Performance (Module `Performance`): `kpi.activated`, `kpi.deactivated`, `weight_set.created`, `weight_set.updated`, `performance_period.opened`, `non_working_date.added`, `non_working_date.updated`, `non_working_date.removed`, `attendance.imported`, `attendance_day.excused`, `attendance_day.marked_absent`, `attendance.no_attendance_confirmed`, `rating.saved` and `development_need.flagged`.

These 26 Actions are accepted only for Source HRMS; every other Source rejects them with 400. `Training` and `Performance` are listed under HRMS Modules in `GET /events/valid-values`, and the Action catalog there includes the new Actions. The existing `record.*`, `job_posting.*` and `job_template.*` Actions remain accepted. The metadata limits above (4096 bytes, no `password`, `token`, `secret`, `authorization`, `card` or `cvv` keys) apply unchanged.

HRMS producers: `description` is stored verbatim and shown to Administrators, so never put Staff-typed free text in it. Metadata should hold ids and counts, not Staff-typed free text. One event is written per Staff action. See [the Training and Performance decision](adr/0005-hrms-training-and-performance-actions.md).

Deploy this catalog before enabling the HRMS producer changes. No database migration is needed. HRMS producers should identify Staff Actors using their Portal user id with type `user` so My logs can match them; the service continues to treat Actor ids as opaque values. See [the identity and Action decision](adr/0004-hrms-audit-identity-and-actions.md).


## IMS vocabulary

IMS accepts the workflow and access Actions below alongside `record.created`,
`record.updated`, `record.deleted`, and `record.viewed`. `GET /events/valid-values`
publishes the same Actions and current SIMS Modules, retaining the historical
`Inventory Module`, `Production and Quality`, and `Distribution` names.
Unknown IMS Actions remain rejected; IMS continues to accept any nonempty Module.

| Module | Actions |
| --- | --- |
| Orders & Procurement | `purchase_requisition.submitted/approved/rejected`, `purchase_order.created/approved/rejected` |
| Goods Receiving | `delivery.received/discrepancy_logged`, `goods_receipt.inspected`, `return_to_vendor.submitted/approved/rejected`, `stock_in.approved/rejected/put_away` |
| Inventory | `stock_in.approved/rejected/put_away`, `cycle_count.reconciled`, `loss_report.submitted/approved/rejected`, `lot.recalled` |
| Production & Quality | `production_request.submitted/approved/rejected`, `material.issued`, `production_batch.stage_changed/qa_approved/qa_rejected` |
| Stock Transfer | `stock_transfer.requested/approved/rejected/dispatched/received` |
| Resources & Suppliers | The four `record.*` Actions |
| No Module (`null`) | `ims.signed_in`, `ims.access_denied` |

Slash-separated suffixes represent separate Actions. Actors use Portal user ids with
`type: user`; subjects identify affected users when known. Existing actor ids and
historical events remain unchanged. No database migration is required.

Deploy this catalog to the test Audit Logs environment before switching a SIMS
preview to `IMS_AUDIT_LEGACY_ACTIONS=false`. Native Actions support Administrator
Action filters and charts. Earlier compatibility events keep their `record.*`
Actions; search by their description tag (for example `q=purchase_order.approved`).
Do not enable native mode against a service that still accepts only `record.*`.


### Ecommerce stock Actions

The Ecommerce Source accepts `order.stock_reserved` and `order.stock_released`
for the storefront reservation lifecycle (fjdvm/epic-crms#336 and #367). These
are Administrator-visible stock events; they do not require a Module. Producers
capture the Actor and Order Target and send a stable per-Order-line
`idempotency_key`. Replaying a stock event returns the original id without
changing its contents. The Administrator `GET /events/valid-values` catalog
includes both Actions. IMS movement events retain their existing `record.updated`
Action; this addition does not change IMS authentication or stock behavior.
