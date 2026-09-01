---
name: issue
description: Turn one reviewed think artifact into a validated, build-ready GitHub issue, or attach its Plan to an existing issue. Use for an explicit issue publishing request.
---

# Issue

Before preparing a publication contract, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md).

Inspect the current input, preview, and publication contract with `codex-issue describe`.

## Decisions

- Use one ready JSON artifact produced by think. If none exists, stop at the missing decision.
- Choose a new issue or Plan attachment to one named existing issue.
- For a new issue, provide a concise title without a task-type prefix.
- Choose one priority: critical, high, medium, or low.

## Publication

- Treat the user's leading explicit `$issue` invocation as authorization for exactly one GitHub Issue create or edit in the hook-bound repository. Do not request another publication confirmation.
- Use the language configured by Codex for the issue title and human prose. Keep established identifiers and executable test names unchanged.
- Create the draft before any GitHub write.
- Validate the exact draft, body, evidence, repository state, and target issue immediately before the GitHub write.
- Publish the validated draft in the same invocation and return the issue URL, receipt, and build source.

## Escalation

Invalid or stale Plan/evidence: do not publish; return to `think`. GitHub failures stop in `issue`.

## Report

Report the published issue URL, receipt path, and build as the declared next state. Do not continue into it.
