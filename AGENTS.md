## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (fjdvm/br-audit-logs-service) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Implementation completion

For implementation tasks, work on a feature branch, complete the required checks and code review, commit and push the changes, and open a GitHub pull request linked to the ticket. Return the PR URL in the final response. The task is complete when the PR is open; leave merging to the user unless explicitly instructed otherwise.
