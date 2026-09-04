---
name: think
description: Turn one change request and optional Research reports into an independently reviewed Plan or focused research questions. Use for an explicit design or planning request; do not implement or publish an Issue.
---

# Think

Read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and the relevant [workflow contracts](../../workflows/README.md) to judge scope. If OUTCOME.md is missing, ask the user to create it with the project outcome and verifiable completion criteria before running Think. Put implementation constraints in the affected unit contract and planned tests instead of copying repository guidance into the Plan.

Inspect the current input and decision contract with `codex-think describe`.
Invoke the first bound workflow command itself with network escalation, requesting persistent approval for prefix `["codex-think", "run"]` in that same tool call when supported. If a genuine transient `model_unavailable` occurs, preserve the intent and retry the exact same command with network escalation.

## Decisions

- State one change and the observable state that should exist when it is done.
- Explicitly select Research reports that directly determine the Plan; the Knowledge index adds at most three related original reports as dated leads.
- Read [decision writing](references/decision-writing.md) when wording the outcome and Plan.

## Boundaries

- Route an unknown that can change the design back to research instead of planning around an assumption.
- Use the repository snapshot and explicitly selected Research as the factual basis. Verify Knowledge-selected report claims against the current snapshot; report dates alone do not establish freshness, and do not copy evidence, hashes, or repository rules into the Plan.

## Report

Keep the Plan and workflow artifacts in English. Translate only the final user-facing report into the configured language: `ready` with artifact paths, or `research_required` with focused questions. The next state is `issue` or `research`; do not continue into it.
