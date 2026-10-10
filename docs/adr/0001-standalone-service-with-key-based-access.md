# Audit logs is a standalone service with its own database, reached only by server-side API key

audit-logs runs as its own Express service on its own Neon Postgres project. Every Source writes and every reader reads over HTTP; no application shares its tables or connects to its database, unlike the shared-database choice in ecommerce ADR-0007. Callers are backends, never browsers: each Source holds a `write` key limited to its own Source, and the portal and ecommerce backends hold `read:admin` or `read:customer` keys (the latter must always filter by Subject). Keys are random, stored hashed, and revocable. A shared database or browser-held credentials would let a compromised producer or user rewrite or browse history, which defeats an audit log.

## Consequences

- Users are not authenticated by this service. The portal and ecommerce backends vouch for who is asking, so a leaked `read:customer` key can read any one Customer's visible events but cannot enumerate across Customers.
- The portal's session authority (ADR-0001 there) is not duplicated here.
