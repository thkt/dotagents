---
name: code
description: Implement one direct repository change with an optional scope and test command. Use for an explicit coding request that should not commit, push, or create a pull request.
---

# Code

Inspect the current input with `codex-flow describe --workflow code`, then invoke the first hook-bound command itself with network escalation. Do not request persistent approval for the `codex-flow run` prefix because the same executable can run Build and Ship. The controller compiles the request through the same implementation executor used by Build.

## Decisions

- State one concrete change request.
- Set `scope_paths` only when the allowed repository area must be narrowed.
- Provide one repository test command when automatic inference is not appropriate.
- Keep unrelated pre-existing changes outside the requested scope.

## References

- Read [testing decisions](references/testing.md) when defining acceptance tests or gates.
- Read [source verification](references/source-verification.md) when version-dependent external APIs affect implementation.
- Read [Skill authoring](references/skill-authoring.md) when editing this package's Skills.
- Read [Workflow authoring](references/workflow-authoring.md) when editing this package's workflows or hooks.

## Escalation

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Keep workflow contracts in English. Translate only the final user-facing report into the configured language, including the outcome, changed paths, test result, correction count, and any blocker. Code never commits, pushes, or creates a pull request.
