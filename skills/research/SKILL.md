---
name: research
description: Investigate one project or technical question into a source-checked artifact with independent audit and explicit unknowns. Use for an explicit research request; it does not implement changes or generate the Plan itself.
---

# Research

When present, read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and inspect only the minimal relevant primary sources.

Inspect the current input and artifact contract with `codex-research describe`.

## Decisions

- State one answerable question and whether the result supports understanding, planning, or diagnosis.
- Set repository scope only when evidence outside it must be excluded.
- Choose whether external sources are disabled, limited to primary sources, or broadly allowed.

## Boundaries

- Leave unresolved claims explicit instead of completing them by assumption.
- Context is supplied from authoritative artifacts; re-verify it against the repository or selected evidence, and never treat context itself as evidence.

## Report

Report the answer, verified finding and unknown counts, JSON and Markdown artifact paths, and the declared next state. Do not continue into it.
