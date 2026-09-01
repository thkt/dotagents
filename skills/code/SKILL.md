---
name: code
description: Implement multi-unit or TDD coding plans as scoped actor/gate units. Use when a request explicitly calls for structured editing and verification; do not use for a small direct fix.
---

# Code

Inspect the current workflow contract with `codex-flow describe --workflow code`. Read [shell gate evidence](../../workflows/flow/references/shell-gate.md) when choosing it.

## Decisions

- Define the ordered units and an observable outcome for each.
- Choose unit boundaries, Red/Green or Direct, and repository-native evidence.
- Keep unrelated pre-existing changes outside every unit's file scope.

## References

- Read [testing decisions](references/testing.md) when defining acceptance tests or gates.
- Read [source verification](references/source-verification.md) when version-dependent external APIs affect implementation.
- Read [Skill authoring](references/skill-authoring.md) when editing this package's Skills.
- Read [Workflow authoring](references/workflow-authoring.md) when editing this package's workflows or hooks.

## Escalation

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Report the terminal outcome, manifest hash, gate evidence, correction counts, and any blocker.
