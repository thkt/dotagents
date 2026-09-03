---
name: research
description: Investigate one repository question into a source-checked report with independent audit and explicit unknowns. Use for an explicit research request; it does not implement changes or create a Plan.
---

# Research

Read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and inspect only the minimal relevant primary sources. If it is missing, ask the user to create it with the project outcome and verifiable completion criteria before running Research.

Inspect the current input and artifact contract with `codex-research describe`.
Invoke the first bound workflow command itself with network escalation, requesting persistent approval for prefix `["codex-research", "run"]` in that same tool call when supported. If a genuine transient `model_unavailable` occurs, preserve the intent and retry the exact same command with network escalation.

## Decisions

- State one answerable question.
- Set repository scope only when evidence outside it must be excluded.
- Enable external sources only when repository evidence cannot answer the question; prefer primary sources when enabled.

## Boundaries

- Leave unresolved claims explicit instead of completing them by assumption.
- Treat related Knowledge as a lead and cite the current repository or external source that supports each finding.

## Report

Successful Research attempts to rebuild topic-based Knowledge from persisted reports. A Knowledge write failure does not invalidate the Research report. Keep workflow artifacts in English. Translate only the final user-facing report into the configured language, including the answer, finding and unknown counts, artifact paths, and `think` as the next state. Do not continue into Think.
