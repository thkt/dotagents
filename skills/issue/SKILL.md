---
name: issue
description: Turn reviewed Research and Think artifacts into a readable, build-ready GitHub Issue, either by creating one or updating its complete title and body. Use for an explicit Issue publishing request.
---

# Issue

Before preparing a publication contract, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md).

Inspect the current input, preview, and publication contract with `codex-issue describe`.

## Draft

- Use one ready JSON artifact produced by think. If none exists, run the hook-bound `codex-issue stop --input <task-bound-input-path>` command; do not create a placeholder Issue input or Think artifact.
- Read the Research reports referenced by that Think artifact. Use only their verified findings and the Think decision to draft the Issue.
- Choose `create` or `update`. For `update`, read the selected Issue and revise any part of its title and prose needed by the user's request; retain existing content only while it remains useful.
- Write a concise title without a task-type prefix. Write readable prose in the configured language, using only the useful sections among Background, Verified findings, Decision, and Done state.
- Do not copy the Plan into the prose or add a `## Plan` section. Pass the complete title and prose to the controller; it appends the exact Plan from the Think artifact.

## Publication

- Treat the user's leading explicit `$issue` invocation as authorization for at most one GitHub Issue create or edit in the hook-bound repository. Do not request another publication confirmation.
- When publishing, invoke the first hook-bound `codex-issue draft` command itself with network escalation. Do not request persistent approval for that prefix because it writes to GitHub. The missing-source `codex-issue stop` command needs no network escalation. If a genuine transient access failure occurs, retry the exact same draft command with network escalation before any publication approval is consumed.
- Create the draft before any GitHub write.
- Do not retry deterministic draft errors. Retry only a GitHub access failure that can change when network or credentials become available.
- Validate the Plan while drafting, and confirm only that an update target is unchanged immediately before the GitHub write.
- Publish one JSON Plan beneath `## Plan`. The renderer may collapse it for readability, but Build does not depend on surrounding presentation markup.
- Return the Issue URL and local `repo + issue_number` Build selector.

## Escalation

An invalid or incomplete Plan returns to `think`. GitHub failures stop in `issue`.

## Report

Keep the published Plan and workflow artifacts in English. Write the Issue title, Issue prose, and final report in the configured language. Include the Issue URL, Build source, and next state in the report. For an explicit missing-source stop, report `missing_decision`, no GitHub write, and think as the next state. Do not continue into either next state.
