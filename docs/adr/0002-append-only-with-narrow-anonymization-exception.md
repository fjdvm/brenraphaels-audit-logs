# Audit Events are append-only, except a narrow anonymization job

The API offers no update or delete, and the application's database role holds only `INSERT` and `SELECT` on Audit Events. The one deliberate exception is erasure: when a Customer account is deleted, a separate admin-only job overwrites personal fields (display names, IP address, user agent) with "Deleted customer" while keeping the rows. That job needs a narrow `UPDATE` grant limited to those columns, which is why it runs under its own database role and never through the normal API. We chose anonymization over deleting rows so the history of what happened stays intact. We chose it over keeping personal data forever so privacy erasure requests can still be honoured.

A hash chain was deferred: v1 relies on database permissions alone, and the schema leaves room to add a `prev_hash` column later. Anonymization would have to be reconciled with any future hash chain, because it rewrites rows the chain covers.

Events are kept for 2 years (a config value); no automatic deletion exists yet.
