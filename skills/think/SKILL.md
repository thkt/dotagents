---
name: think
description: Turn one change request and optional Research reports into an independently reviewed Plan or focused research questions. Use for an explicit design or planning request; do not implement or publish an Issue.
---

# Think

When present, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and the relevant [workflow contracts](../../workflows/README.md) to judge scope. Put implementation constraints in the affected unit contract and planned tests instead of copying repository guidance into the Plan.

Inspect the current input and decision contract with `codex-think describe`.
Run the bound workflow command with network access. If the sandbox blocks the nested Codex connection, retry the same command with network escalation; `model_unavailable` preserves the intent for that retry.

## Decisions

- State one change and the observable state that should exist when it is done.
- Explicitly select Research reports that directly determine the Plan; related Knowledge is added automatically as background.
- Read [decision writing](references/decision-writing.md) when wording the outcome and Plan.

## Boundaries

- Route an unknown that can change the design back to research instead of planning around an assumption.
- Use the repository snapshot and explicitly selected Research as the factual basis. Treat related Knowledge as background, and do not copy evidence, hashes, or repository rules into the Plan.

## Report

Keep the Plan and workflow artifacts in English. Translate only the final user-facing report into the configured language: `ready` with artifact paths, or `research_required` with focused questions. The next state is `issue` or `research`; do not continue into it.
