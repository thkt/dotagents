# Test organization

Tests are grouped by the behavior owner, not by implementation file. Use the lowest level that can
observe the result.

- `shared/`: pure cross-workflow decisions and serialization.
- `think/`, `research/`, `issue/`, `knowledge/`, `build/`, `flow/`: workflow-owned component and
  contract behavior.
- `integration/`: executable, hook, package, and platform wiring.
- `*.smoke.test.ts`: one primary path through real local components with external writes replaced
  at the boundary.

`bun test --parallel=8 workflows/tests skills/tests` discovers nested `*.test.ts` files, so a domain
may add subdirectories without changing `package.json`.

## Outcome coverage

| Observable boundary                                                                | Primary tests                                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Think and Research stages share one immutable startup snapshot                     | `think/pipeline.test.ts`, `research/pipeline.test.ts`                                                       |
| Current citations and Build Plan paths are rejected when stale or out of scope     | `think/pipeline.test.ts`, `research/pipeline.test.ts`, `build/revalidate.test.ts`, `issue/pipeline.test.ts` |
| One explicit Issue invocation publishes one exact draft and returns a Build source | `issue/pipeline.test.ts`, `issue/github.test.ts`                                                            |
| Build consumes a public Issue and reaches verified Ship state                      | `flow/build-describe-smoke.test.ts`, `flow/controller.test.ts`                                              |
| Published decisions return to reusable knowledge context                           | `knowledge/context.test.ts`, `issue/pipeline.test.ts`                                                       |
| Runtime failures consume intent; input and binding failures preserve it            | `think/pipeline.test.ts`, `research/pipeline.test.ts`, `issue/pipeline.test.ts`, `flow/runner.test.ts`      |

Prefer condition-and-result test names. Parameterize independent validation cases, but keep workflow
state transitions as separate tests so a failure identifies the broken boundary.
