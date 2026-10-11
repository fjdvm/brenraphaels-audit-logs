## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (fjdvm/br-audit-logs-service) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Completing tickets

After implementing a ticket, complete validation and code review, commit and push the changes, then open a pull request against the default branch. Include `Closes #<issue-number>` in the PR body so GitHub automatically closes the connected issue when the PR merges. Use a fully qualified issue reference for issues in another repository. Report the PR link to the user.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
