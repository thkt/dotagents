---
name: issue
description: Turn one reviewed think artifact into a validated, build-ready GitHub issue, or attach its Plan to an existing issue. Use for an explicit issue publishing request.
---

# Issue

Before preparing a publication contract, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md).

Inspect the current input, preview, and publication contract with `codex-issue describe`.

## Decisions

- Use one ready JSON artifact produced by think. If none exists, run the hook-bound `codex-issue stop --input <task-bound-input-path>` command; do not create a placeholder Issue input or Think artifact.
- Choose a new issue or Plan attachment to one named existing issue.
- For a new issue, provide a concise title without a task-type prefix.
- Choose one priority: critical, high, medium, or low.

## Publication

- Treat the user's leading explicit `$issue` invocation as authorization for at most one GitHub Issue create or edit and, when absent, creation of its selected supported priority label in the hook-bound repository. Do not request another publication confirmation.
- Run the controller with GitHub network access. If the execution sandbox denies `api.github.com`, retry the same hook-bound command with network escalation before any approval is consumed.
- Create the draft before any GitHub write.
- Validate the exact draft, body, evidence, repository state, and target issue immediately before the GitHub write.
- Publish the validated draft in the same invocation and return the Issue URL, audit receipt, and portable `repository + issue_number` build source.
- Generate both the visible Plan and embedded machine contract from the same canonical Plan, then run the same exact-match validation used by Build before publication.

## Escalation

Invalid or stale Plan/evidence: do not publish; return to `think`. GitHub failures stop in `issue`.

## Report

Report the published Issue URL, optional audit receipt path, portable build source, and build as the declared next state. For an explicit missing-source stop, report `missing_decision`, no GitHub write, and think as the next state. Do not continue into either next state.
