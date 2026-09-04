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
- Keep the Plan out of `prose`. Derive `plan_markdown` from the ready Think Plan in the configured language used for the Issue title and prose. Translate every outcome, unit goal, contract, and acceptance criterion faithfully, preserving their order, conditions, and scope. Keep code identifiers, file paths, and the test command verbatim. Include localized labels and `###` unit headings, but no `## Plan` heading, code fences, or HTML blocks; the controller owns the section and canonical JSON.

## Publication

- Treat the user's leading explicit `$issue` invocation as authorization for at most one GitHub Issue create or edit in the hook-bound repository. Do not request another publication confirmation.
- When publishing, invoke the first bound `codex-issue draft` command itself with network escalation, requesting persistent approval for prefix `["codex-issue", "draft"]` in that same tool call when supported. This prefix is safe to persist because the controller still requires the task- and repository-bound `$issue` approval and exposes only its closed Issue read/create/edit registry. The missing-source `codex-issue stop` command needs no network escalation. If a genuine transient access failure occurs, retry the exact same draft command with network escalation before any publication approval is consumed.
- Create the draft before any GitHub write.
- Do not retry deterministic draft errors. Retry only a GitHub access failure that can change when network or credentials become available.
- Validate the Plan while drafting, and confirm only that an update target is unchanged immediately before the GitHub write.
- Review `plan_markdown` against the source Plan before publication: include the outcome, test command, all unit goals, files, contracts, and acceptance criteria without adding, omitting, or changing requirements. The controller places that translated view under one `## Plan` heading, followed by the exact English Plan in a collapsed `Build Plan JSON` block. JSON remains the sole Build authority; translation is presentation only. Always supply `plan_markdown` for localized publication; omitted input retains the English renderer for existing callers.
- Return the Issue URL and local `repo + issue_number` Build selector.

## Escalation

An invalid or incomplete Plan returns to `think`. GitHub failures stop in `issue`.

## Report

Keep the canonical JSON Plan and machine-readable workflow artifacts in English. Write the Issue title, prose, visible Plan Markdown, and final report in the configured language. Include the Issue URL, Build source, and next state in the report. For an explicit missing-source stop, report `missing_decision`, no GitHub write, and think as the next state. Do not continue into either next state.
