---
name: think
description: Compare implementation approaches and turn one change request into a source-backed, independently reviewed Plan or a concrete research route. Use for an explicit design or planning request; do not implement or publish an issue.
---

# Think

Inspect the current input and decision contract with `codex-think describe`.

## Decisions

- When it exists, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and cite stable rules from [workflow contracts](../../workflows/README.md) in `Plan.rules` with the source path and exact quote.
- State one change and the observable state that should exist when it is done.
- Classify it as a bug, feature, documentation change, or maintenance task.
- Include only planning research reports that bear directly on the decision.
- Read [decision writing](references/decision-writing.md) when wording the outcome and Plan.

## Boundaries

- Route an unknown that can change the design back to research instead of planning around an assumption.
- Context is supplied from authoritative artifacts; re-verify it against the repository or selected evidence, and never treat context itself as evidence.

## Report

Report readiness, the decision and rationale, JSON and Markdown artifact paths, unit count, and the declared next state. Do not continue into it.
