## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (fjdvm/br-audit-logs-service) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Completing tickets

Work on a feature branch for implementation tasks. A ticket implementation is complete only after validation and code review pass, the changes are committed and pushed, and a pull request is opened against the default branch. Include `Closes #<issue-number>` in the PR body so GitHub automatically closes the connected issue when the PR merges. Use a fully qualified issue reference for issues in another repository. Report the PR link to the user. Leave merging to the user unless explicitly instructed otherwise.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Database validation

Use the existing Neon database connections in `.env` for database work and validation. Do not start Docker or provision a local Postgres database. When dedicated test URLs are unset, use `DATABASE_URL_MIGRATIONS` for the test owner connection and `DATABASE_URL` for the runtime connection. Use `DATABASE_URL_ANONYMIZE` as `TEST_DATABASE_URL_ANONYMIZE` when the owner cannot `SET ROLE`.
