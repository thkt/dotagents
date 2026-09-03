# Test organization

Tests are grouped by the behavior owner, not by implementation file. Use the lowest level that can
observe the result.

- `shared/`: pure cross-workflow decisions and serialization.
- `research/`, `think/`, `plan/`, `issue/`, `build/`, `code/`: behavior owned by each stage.
- `flow/`: behavior of the shared executor and its policy.
- `knowledge/`: automatic topic summaries and relevant Knowledge lookup.
- `integration/`: executable, hook, package, and platform wiring.
- `smoke.test.ts`: one primary path through real local components with external writes replaced
  at the boundary.

`bun run test` discovers nested `*.test.ts` files. Tests that change process state must restore it.
The suite uses `--no-isolate`, so leaked environment variables, output streams, or exit codes can
affect later files.

## Outcome coverage

| Observable boundary                                                                                            | Primary tests                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Research produces selected evidence; Think produces a reviewed Plan or focused questions                       | `research/pipeline.test.ts`, `think/pipeline.test.ts`                                    |
| Issue publishes one JSON Plan; Build reads that Issue once as its authority                                    | `issue/pipeline.test.ts`, `build/smoke.test.ts`                                          |
| Code and Build use the same actor/test executor without exposing internal steps                                | `code/compile.test.ts`, `build/compile.test.ts`, `flow/controller-policy.test.ts`        |
| The completed Build stays in Plan scope, passes tests and review, then creates one final commit                | `build/artifacts.test.ts`, `build/smoke.test.ts`                                         |
| Completed Research updates Knowledge and Think receives related summaries without duplicating selected reports | `knowledge/update-search.test.ts`, `research/pipeline.test.ts`, `think/pipeline.test.ts` |
| External write approval and hook-bound inputs remain task- and repository-scoped                               | `flow/invocation.test.ts`, `flow/controller.test.ts`                                     |

Prefer condition-and-result test names. Parameterize independent validation cases, but keep workflow
state transitions as separate tests so a failure identifies the broken boundary.
