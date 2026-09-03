---
name: issue
description: Turn one reviewed think artifact into a validated, build-ready GitHub issue, or attach its Plan to an existing issue. Use for an explicit issue publishing request.
---

# Issue

Before preparing a publication contract, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md).

Inspect the current input, preview, and publication contract with `codex-issue describe`.

## Decisions

- Use one ready JSON artifact produced by think. If none exists, run the hook-bound `codex-issue stop --input <task-bound-input-path>` command; do not create a placeholder Issue input or Think artifact.
- Choose a new Issue or attach the Plan to one named existing Issue. Preserve existing prose before the Plan; replace only a Plan previously published by this workflow.
- For a new issue, provide a concise title without a task-type prefix.
- Choose one priority: critical, high, medium, or low.

## Publication

- Treat the user's leading explicit `$issue` invocation as authorization for at most one GitHub Issue create or edit and, when absent, creation of its selected supported priority label in the hook-bound repository. Do not request another publication confirmation.
- Run the controller with GitHub network access. If the execution sandbox denies `api.github.com`, retry the same hook-bound command with network escalation before any approval is consumed.
- Create the draft before any GitHub write.
- If the draft fails before a GitHub write, retry the same task-bound invocation.
- Validate the approved draft and an unchanged attach target immediately before the GitHub write.
- Publish one JSON Plan beneath `## Plan`; do not add a second encoded Plan or Plan hash.
- Return the Issue URL, optional audit receipt, and local `repo + issue_number` Build selector.

## Escalation

An invalid or incomplete Plan returns to `think`. GitHub failures stop in `issue`.

## Report

Keep the published Plan and workflow artifacts in English. Translate only the final user-facing report into the configured language, including the Issue URL, optional receipt, Build source, and next state. For an explicit missing-source stop, report `missing_decision`, no GitHub write, and think as the next state. Do not continue into either next state.
