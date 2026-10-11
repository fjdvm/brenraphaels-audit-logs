# Application queries use the Drizzle query builder, with small `sql` fragments where needed

Every query the API runs goes through Drizzle against the table definitions in `src/db/schema.ts`, including the Administrator list. A renamed column then fails at typecheck instead of at runtime, and filter columns come from typed table columns instead of a hand-kept allowlist spliced into a SQL string.

Two things stay as `sql` fragments inside the builder because the builder has no direct form for them: the keyset cursor `(occurred_at, recorded_at, id) < (...)`, and `to_char(... AT TIME ZONE 'UTC', ...)` output. Timestamps are bound as strings and cast with `::timestamptz` because a JavaScript `Date` truncates microseconds, which would break cursor pagination for events that share a millisecond.

Migrations remain hand-written `.sql` files run by `scripts/migrate.ts`; Drizzle does not generate them, so a schema change needs both the migration and the `schema.ts` edit.
