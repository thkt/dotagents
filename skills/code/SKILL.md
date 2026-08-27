---
name: code
description: Implement a structured coding plan through an enforced controller that alternates scoped editing actors with deterministic gates. Use for multi-unit features, TDD plans, or explicit actor/verification loops. Do not use for a small direct fix that needs no workflow.
---

# Code

This is an explicit-only workflow. Invoke it with `$code`, then drive every planned unit to a mechanically verified state through the shared executable controller.

Before preparing a manifest, read the public [workflow controller](../../workflows/references/workflow-controller.md) and [gate protocol](../../workflows/references/gate-protocol.md).

## Prepare the decisions

- Resolve the absolute Git root, ordered units, observable outcome per unit, Red/Green versus Direct strategy, allowed files, repository-native gate commands, and correction budget.
- Keep unrelated pre-existing changes outside every actor's scope.
- For Red, choose the sealed failure literal only from the captured calibration evidence; this evidence judgment is not delegated to the controller.
- Write the `codex-flow-manifest/v1` file only to the hook-supplied manifest path. Do not choose another path.

## Start and conduct

Start the controller before any workflow edit by using the exact start command supplied by the hook. Omit `--run-id`; the hook binds the current task.

Then follow the controller's typed directives through its documented `next`/`report` interface until it returns a terminal directive. Do not replace a directive or mechanical result with prose judgment.

## Completion

Treat only `done` as completion. Report the manifest hash, gate evidence, correction counts, blocker when present, and whether durable Git actions occurred. Preserve mechanical result fields exactly.
