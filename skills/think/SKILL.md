---
name: think
description: Turn one change request and optional Research reports into an independently reviewed Plan or focused research questions. Use for an explicit design or planning request; do not implement or publish an Issue.
---

# Think

Follow the common [contract granularity](../../workflows/README.md) when deciding what this stage must establish.

Read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and the relevant [workflow contracts](../../workflows/README.md) to judge scope. If OUTCOME.md is missing, ask the user to create it with the project outcome and verifiable completion criteria before running Think. State the required behavior and justified constraints in the affected unit contract and acceptance tests without copying repository guidance.

Inspect the current input and decision contract with `codex-think describe`.
Invoke the first bound workflow command itself with network escalation, requesting persistent approval for prefix `["codex-think", "run"]` in that same tool call when supported. If a genuine transient `model_unavailable` occurs, preserve the intent and retry the exact same command with network escalation.

## Decisions

- State one change and the observable state that should exist when it is done.
- Explicitly select Research reports that directly determine the Plan; the Knowledge index adds at most three related original reports as dated leads.
- Read [decision writing](references/decision-writing.md) when wording the outcome and Plan.

## Boundaries

- Route unresolved facts that can change the requirements to Research. Leave in-scope implementation choices to the owner; their absence does not make a Plan incomplete.
- Use the repository snapshot and explicitly selected Research as the factual basis. Verify Knowledge-selected report claims against the current snapshot; report dates alone do not establish freshness, and do not copy investigation evidence or repository rules into the Plan.

## Report

Keep the Plan and workflow artifacts in English. Translate only the final user-facing report into the configured language: `ready` with artifact paths, or `research_required` with focused questions. The next state is `issue` or `research`; do not continue into it.
