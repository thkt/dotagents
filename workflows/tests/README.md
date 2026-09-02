# Test organization

Tests are grouped by the behavior owner, not by implementation file. Use the lowest level that can
observe the result.

- `shared/`: pure cross-workflow decisions and serialization.
- `think/`, `research/`, `issue/`, `knowledge/`, `build/`, `flow/`: workflow-owned component and
  contract behavior.
- `integration/`: executable, hook, package, and platform wiring.
- `*.smoke.test.ts`: one primary path through real local components with external writes replaced
  at the boundary.

`bun test --parallel=4 --no-isolate workflows/tests skills/tests` discovers nested `*.test.ts` files,
so a domain may add subdirectories without changing `package.json`. `--no-isolate` stays on because
bun 1.4.0's per-file isolation, when a worker moves from one file to the next, loses the exit of a
child started by `spawnSync`. The child becomes a zombie and the test blocks until its timeout. Under
isolation the suite failed in about half of the runs; without it, 0 of 6 runs failed. Test files must
therefore restore every process-level change they make (`process.env`, `process.stdout`, exit code).

## Outcome coverage

| Observable boundary                                                                                         | Primary tests                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Think and Research stages share one immutable startup snapshot                                              | `flow/isolation.test.ts`, `think/pipeline.test.ts`, `research/pipeline.test.ts`                              |
| Current citations and Build Plan paths are rejected when stale or out of scope                              | `think/pipeline.test.ts`, `research/pipeline.test.ts`, `build/revalidate.test.ts`, `issue/pipeline.test.ts`  |
| One explicit Issue invocation publishes one exact draft and returns a Build source                          | `issue/pipeline.test.ts`, `issue/github.test.ts`                                                             |
| Build binds execution to a public Plan, passes independent semantic review, and reaches verified Ship state | `build/gates.test.ts`, `flow/build-describe-smoke.test.ts`, `flow/controller.test.ts`, `flow/runner.test.ts` |
| Published decisions return to reusable knowledge context                                                    | `knowledge/context.test.ts`, `issue/pipeline.test.ts`                                                        |
| Runtime failures consume intent; input and binding failures preserve it                                     | `think/pipeline.test.ts`, `research/pipeline.test.ts`, `issue/pipeline.test.ts`                              |

Prefer condition-and-result test names. Parameterize independent validation cases, but keep workflow
state transitions as separate tests so a failure identifies the broken boundary.
