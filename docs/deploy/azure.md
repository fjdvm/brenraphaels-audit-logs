# Deploy to Azure Container Apps

Tracked by [Ticket#153](https://github.com/fjdvm/brenraphaels-authentication-microservice/issues/153) (Spec#138). Supersedes the ACR-based plan in #57/#58.

Every push to `main` runs `.github/workflows/container.yml`: typecheck, tests, build the image, smoke-test it against a disposable Postgres (health, authenticated write, read), then push to GHCR and deploy Container App `audit-logs` in `rg-brenraphaels` / `cae-brenraphaels` with **min 0, max 2 replicas**. The first request after idle wakes a replica (cold start of a few seconds).

## Repository secrets and variables

| Name | Kind | Value |
| --- | --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | secret | OIDC login (Ticket#141) |
| `GHCR_PULL_TOKEN`, `GHCR_USERNAME` | secret / variable | read:packages pull token (Ticket#141) |
| `DATABASE_URL` | secret | Neon pooled `audit_runtime` connection |
| `DATABASE_URL_MIGRATIONS` | secret | Neon direct owner connection |
| `DATABASE_URL_ANONYMIZE` | secret | Neon `audit_anonymize` connection |
| `RATE_LIMIT_PER_SECOND` | variable | per-key requests per second per instance (default 100) |

The three database values become Container App secrets referenced by env vars of the same name. No data moves; the database stays on Neon, and migrations are still applied by hand with `npm run db:migrate`.

## Switching callers

The workflow prints the app's default `*.azurecontainerapps.io` address. Callers move to `audit.buildwrite.me` in Ticket#154; until then point the gateway's audit URL at the default address.
