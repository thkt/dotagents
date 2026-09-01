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
- Create the draft before any GitHub write.
- Validate the exact draft, body, evidence, repository state, and target issue immediately before the GitHub write.
- Publish the validated draft in the same invocation and return the Issue URL, audit receipt, and portable `repository + issue_number` build source.
- Generate both the visible Plan and embedded machine contract from the same canonical Plan, then run the same exact-match validation used by Build before publication.

## Escalation

Invalid or stale Plan/evidence: do not publish; return to `think`. GitHub failures stop in `issue`.

## Report

Report the published Issue URL, optional audit receipt path, portable build source, and build as the declared next state. Do not continue into it.
