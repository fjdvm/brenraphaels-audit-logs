# API contract

For the authors of the portal tab, the Ecommerce activity page and each Source's integration. Terms follow [`CONTEXT.md`](../CONTEXT.md). Setup, deployment and operator notes live in [`api.md`](api.md). A browsable version of this page is [`guide/index.html`](guide/index.html), served by the running service at `GET /docs` (no key needed).

## Conventions

- Every `/events` route needs `Authorization: Bearer <key>`. `GET /health` needs no key and returns `{ "status": "ok" }`.
- JSON in, JSON out, except the export. Errors are `{ "error": "<message>" }`, plus `details` (validation issues) where noted.
- Timestamps are ISO 8601 with a timezone. Responses use UTC with microseconds, for example `2026-01-01T12:00:00.000000Z`.
- No route updates or deletes an Audit Event.

### Key roles

| Key role | Held by | May call |
| --- | --- | --- |
| `write:<Source>` (for example `write:CRMS`) | That Source's integration | `POST /events`, `POST /events/batch` for events whose Source matches |
| `read:admin` | The portal tab (Administrators) | `GET /events`, `/events/:id`, `/events/stats`, `/events/valid-values`, `/events/export` |
| `read:customer` | The Ecommerce backend | `GET /events/customer-activity` |

A key used on a route outside its role gets 403.

### Errors common to every `/events` route

| Status | When | Body |
| --- | --- | --- |
| 401 | No `Authorization: Bearer` header | `{ "error": "API key required" }` |
| 401 | Unknown or revoked key | `{ "error": "Invalid API key" }` |
| 403 | Key role not allowed on this route | `{ "error": "<role> key required" }` |
| 429 | More than `RATE_LIMIT_PER_SECOND` requests (default 100) from one key in a second. A batch counts as one. | `{ "error": "API key rate limit exceeded", "retry_after": 1 }` with `Retry-After: 1` |
| 400 | Malformed JSON body | `{ "error": "Invalid request body" }` |
| 413 | JSON body over 16 KB (1600 KB for batch) | `{ "error": "Invalid request body" }` |
| 500 | Unexpected failure | `{ "error": "Internal server error" }` |

---

## Write an Audit Event

`POST /events`, key `write:<Source>` matching the body's `source`.

### Body

| Field | Required | Notes |
| --- | --- | --- |
| `source` | yes | One of the eight Sources: `CRMS`, `HRMS`, `POS`, `IMS`, `Authentication`, `File storage`, `Notifications`, `Ecommerce` |
| `action` | yes | Must belong to that Source (see [Valid values](#valid-values)) |
| `outcome` | yes | `success` or `failure` |
| `actor` | yes | `{ type, id, display_name }`, all nonempty strings |
| `target` | yes | `{ type, id, display_name }` |
| `subject` | no | `{ type, id, display_name }` or null. Decides whose history the event appears in |
| `description` | yes | Plain-language sentence for Administrators, stored verbatim |
| `customer_description` | no | Sentence for the Subject Customer. Without it the event is Administrator-only |
| `occurred_at` | yes | ISO 8601 with timezone. May be late, at most five minutes in the future |
| `module` | no | Only for CRMS, HRMS, POS and IMS |
| `metadata` | no | JSON object, at most 4096 UTF-8 bytes. Keys containing `password`, `token`, `secret`, `authorization`, `card` or `cvv` (any case, at any depth) are rejected |
| `ip_address` | no | IPv4 or IPv6 |
| `user_agent`, `request_id` | no | Nonempty strings |
| `idempotency_key` | no | Retries with the same Source and key return the original id and never replace the event. Each Source has its own namespace |

Unknown fields, including `recorded_at`, return 400. NUL characters and malformed Unicode return 400.

### Responses

| Status | Body |
| --- | --- |
| 201 | `{ "id": "<uuid>" }` |
| 400 | `{ "error": "Invalid Audit Event", "details": [{ "path": ["action"], "message": "Unknown Action for Source", ... }] }` |
| 403 | `{ "error": "Source write key required" }`: not a write key, or its Source differs from the body's |

### Example

```sh
curl -X POST "$BASE_URL/events" \
  -H "Authorization: Bearer $WRITE_KEY" -H "Content-Type: application/json" \
  -d '{
    "source": "Ecommerce",
    "action": "order.placed",
    "outcome": "success",
    "actor":   {"type": "customer", "id": "cust-42", "display_name": "Maria Santos"},
    "target":  {"type": "order", "id": "order-1001", "display_name": "Order #1001"},
    "subject": {"type": "customer", "id": "cust-42", "display_name": "Maria Santos"},
    "description": "Maria Santos placed order #1001.",
    "customer_description": "You placed order #1001.",
    "occurred_at": "2026-01-01T12:00:00.000Z",
    "idempotency_key": "order-1001-placed"
  }'
# 201 {"id":"6f0c9a52-3d1e-4c8e-9a53-0f4b8b1d2c77"}
```

## Write a batch

`POST /events/batch`, key `write:<Source>` matching **every** event's Source.

Body: `{ "events": [<Audit Event>, ...] }` with 1 to 100 events, each validated exactly as a single write. The batch is stored in one transaction, so a failure stores none of it. Idempotency keys behave as for single writes.

| Status | Body |
| --- | --- |
| 201 | `{ "events": [{ "id": "<uuid>" }, ...] }` in input order |
| 400 | `{ "error": "Invalid Audit Event batch", "details": [...] }` where `path` starts `["events", <zero-based index>, ...]` |
| 403 | `{ "error": "Source write key required" }`, plus `"index"` of the first event with a different Source |

```sh
curl -X POST "$BASE_URL/events/batch" \
  -H "Authorization: Bearer $WRITE_KEY" -H "Content-Type: application/json" \
  -d '{"events": [
    {"source":"Notifications","action":"notification.sent","outcome":"success",
     "actor":{"type":"process","id":"mailer","display_name":"Mailer"},
     "target":{"type":"email","id":"m-1","display_name":"Welcome email"},
     "description":"Welcome email sent.","occurred_at":"2026-01-01T12:00:00Z"},
    {"source":"Notifications","action":"notification.failed","outcome":"failure",
     "actor":{"type":"process","id":"mailer","display_name":"Mailer"},
     "target":{"type":"email","id":"m-2","display_name":"Receipt email"},
     "description":"Receipt email bounced.","occurred_at":"2026-01-01T12:00:05Z"}
  ]}'
# 201 {"events":[{"id":"..."},{"id":"..."}]}
```

## Get one Audit Event

`GET /events/:id`, key `read:admin`.

Returns every written field plus `id` and `recorded_at` (set by the service). Absent optional fields are null.

| Status | When |
| --- | --- |
| 200 | The event |
| 400 | `{ "error": "Invalid event id" }`: `:id` is not a UUID |
| 404 | `{ "error": "Audit Event not found" }` |
| 403 | Not a `read:admin` key |

```sh
curl "$BASE_URL/events/6f0c9a52-3d1e-4c8e-9a53-0f4b8b1d2c77" -H "Authorization: Bearer $ADMIN_KEY"
```

```json
{
  "id": "6f0c9a52-3d1e-4c8e-9a53-0f4b8b1d2c77",
  "source": "Ecommerce", "action": "order.placed", "outcome": "success",
  "actor":   {"type": "customer", "id": "cust-42", "display_name": "Maria Santos"},
  "target":  {"type": "order", "id": "order-1001", "display_name": "Order #1001"},
  "subject": {"type": "customer", "id": "cust-42", "display_name": "Maria Santos"},
  "description": "Maria Santos placed order #1001.",
  "customer_description": "You placed order #1001.",
  "occurred_at": "2026-01-01T12:00:00.000Z", "recorded_at": "2026-01-01T12:00:01.204Z",
  "module": null, "metadata": null, "ip_address": null, "user_agent": null, "request_id": null,
  "idempotency_key": "order-1001-placed"
}
```

## Administrator list and search

`GET /events`, key `read:admin`. Newest first by `occurred_at`, then `recorded_at`, then `id`.

### Query parameters

| Parameter | Meaning |
| --- | --- |
| `source`, `module`, `action`, `outcome`, `actor_type`, `actor_id`, `subject_type`, `subject_id` | Exact match. Pass both `*_type` and `*_id` to identify one Actor or Subject. Filters combine with AND. An unknown value gives an empty list |
| `from`, `to` | Inclusive ISO 8601 bounds on `occurred_at` (timezone required). Either may be omitted; `from` must not follow `to` |
| `q` | Case-insensitive substring over `description` and the Actor and Subject display names. 1 to 200 characters after trimming. `%`, `_` and `\` match literally |
| `limit` | 1 to 100, default 50 |
| `cursor` | The previous page's `next_cursor`. Keep the same filters while paging. Pages are live, not a snapshot |

Unknown parameters return 400.

| Status | Body |
| --- | --- |
| 200 | `{ "events": [...], "next_cursor": "<opaque>" \| null }`. Each event has `id`, `source`, `module`, `action`, `outcome`, `actor`, `target`, `subject`, `description`, `customer_description`, `ip_address`, `user_agent`, `occurred_at`, `recorded_at` |
| 400 | `{ "error": "Invalid filters", "details": [...] }`, or `{ "error": "Invalid cursor" }` |

```sh
curl -G "$BASE_URL/events" -H "Authorization: Bearer $ADMIN_KEY" \
  --data-urlencode "source=CRMS" --data-urlencode "module=Tickets" \
  --data-urlencode "outcome=failure" --data-urlencode "q=alice" \
  --data-urlencode "from=2026-01-01T00:00:00Z" --data-urlencode "limit=25"
# 200 {"events":[{...}],"next_cursor":"eyJvY2N1cnJlZF9hdCI6..."}
```

## Stats for charts

`GET /events/stats?group_by=...`, key `read:admin`.

`group_by` is required: `day`, `source`, `action` or `outcome`. It accepts the same filters as the list (including `q`, `from`, `to`) but no `cursor`. `limit` (1 to 100, default 10) caps the buckets for `action` only.

- `day`: UTC dates `YYYY-MM-DD`, ascending, days without events omitted.
- `source`, `action`, `outcome`: highest count first, then key.

| Status | Body |
| --- | --- |
| 200 | `{ "group_by": "day", "buckets": [{ "key": "2026-01-01", "count": 12 }, ...] }` |
| 400 | `{ "error": "Invalid filters", "details": [...] }` |

```sh
curl -G "$BASE_URL/events/stats" -H "Authorization: Bearer $ADMIN_KEY" \
  --data-urlencode "group_by=day" --data-urlencode "source=Authentication" \
  --data-urlencode "action=user.login_failed" --data-urlencode "outcome=failure"
# 200 {"group_by":"day","buckets":[{"key":"2026-01-01","count":4},{"key":"2026-01-02","count":9}]}
```

## Valid values

`GET /events/valid-values`, key `read:admin`. Takes no parameters. Use it to fill the portal's filter dropdowns and to learn which Actions a Source may write.

```sh
curl "$BASE_URL/events/valid-values" -H "Authorization: Bearer $ADMIN_KEY"
# 200 {"sources":[{"source":"CRMS","modules":["Dashboard","Customer Profiles","Campaigns","Conversations","Tickets","Orders","Payments","Fulfilment","Returns","Marketing","Feedback"],
#                  "actions":["record.created","record.updated","record.deleted","record.viewed","order.delivery_fee_quoted","order.confirmed","order.cancelled","order.marked_paid","order.preparing","order.dispatched","order.delivered","order.delivery_photo_attached","return.approved","return.declined","return.goods_received","return.refunded","return.replaced","ticket.opened","ticket.claimed","ticket.released","ticket.status_changed","ticket.priority_changed","walk_in_customer.created","walk_in_customer.updated","customer_profile.viewed","feedback.analysis_run","crms.signed_in","crms.access_denied"]}, ... all eight Sources]}
```

Sources without Modules return `"modules": []`. CRMS writes reject Modules outside its listed catalog. HRMS, POS and IMS writes continue to accept any nonempty `module`. See [CREOMS vocabulary](api.md#creoms-vocabulary) for the CRMS producer contract.

## Export

`GET /events/export`, key `read:admin`. Streams matching events as a download, newest first. No `limit` or `cursor`.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `format` | yes | `csv` (header row, flat `actor_*`, `target_*`, `subject_*` columns) or `json` (`{ "events": [...] }`) |
| `from`, `to` | yes | Inclusive ISO 8601 bounds on `occurred_at` |
| `requested_by_id`, `requested_by_name` | yes | The portal Administrator asking. Keys carry no identity, so you supply it. It becomes the Actor of the export's own Audit Event |
| `source`, `module`, `action`, `outcome`, `actor_type`, `actor_id`, `subject_type`, `subject_id`, `q` | no | Same filters as the list |

| Status | When |
| --- | --- |
| 200 | Streamed file. `Content-Disposition: attachment; filename="audit-events.csv"` (or `.json`) |
| 400 | Missing or invalid parameters. The message names what is required |
| 413 | More than 50,000 matches: `{ "error": "...", "row_count": 73120, "limit": 50000 }`. Nothing is streamed or recorded |

Every accepted export first records an `audit_log.exported` Audit Event (Source Authentication) with `metadata` holding `format`, `row_count` and `filters`. The file covers events recorded up to the moment the request was accepted, so it never contains its own export event. If streaming fails partway the connection is aborted rather than ended cleanly. CSV cells starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'`.

```sh
curl -G "$BASE_URL/events/export" -H "Authorization: Bearer $ADMIN_KEY" -o audit-events.csv \
  --data-urlencode "format=csv" --data-urlencode "from=2026-01-01T00:00:00Z" --data-urlencode "to=2026-01-31T23:59:59Z" \
  --data-urlencode "requested_by_id=user-7" --data-urlencode "requested_by_name=Alice Admin"
```

## Customer activity

`GET /events/customer-activity`, key `read:customer` (the Ecommerce backend). Admin and write keys get 403.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `subject_type`, `subject_id` | yes | The Customer. Without both, 400 |
| `limit` | no | 1 to 100, default 50 |
| `cursor` | no | The previous `next_cursor`. Only pages within the same Subject |

Any other parameter returns 400, so no filter can reach another Customer's events. Only events that have a `customer_description` for that Subject are returned, newest first. Each event has only `id`, `source`, `action`, `outcome`, `customer_description` and `occurred_at`: never the Actor, Target, IP address, user agent, metadata or the Administrator `description`.

The Ecommerce backend must derive `subject_id` from its own logged-in session, never from the browser.

| Status | Body |
| --- | --- |
| 200 | `{ "events": [...], "next_cursor": "<opaque>" \| null }` |
| 400 | `{ "error": "Invalid query", "details": [...] }`, or `{ "error": "Invalid cursor" }` |

```sh
curl -G "$BASE_URL/events/customer-activity" -H "Authorization: Bearer $CUSTOMER_KEY" \
  --data-urlencode "subject_type=customer" --data-urlencode "subject_id=cust-42" --data-urlencode "limit=20"
```

```json
{
  "events": [
    { "id": "6f0c9a52-3d1e-4c8e-9a53-0f4b8b1d2c77", "source": "Ecommerce", "action": "order.placed",
      "outcome": "success", "customer_description": "You placed order #1001.",
      "occurred_at": "2026-01-01T12:00:00.000000Z" }
  ],
  "next_cursor": null
}
```

## Customer erasure

Not an HTTP endpoint. Run `npm run anonymize-customer -- <customer id>` with the `audit_anonymize` connection (see [`api.md`](api.md) and ADR-0002); it replaces the Customer's display names with `Deleted customer` and clears their IP address and user agent where they were the Actor. Events themselves stay.
