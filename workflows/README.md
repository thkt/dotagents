# Workflows

The project outcome is defined in [.codex/OUTCOME.md](../.codex/OUTCOME.md).

## Flow

1. Research gathers repository and optional external evidence into one report.
2. Completed Research best-effort rebuilds a topic-based Knowledge index pointing to original reports.
3. Think reads explicitly selected reports first and at most three related original reports selected through Knowledge, then returns one Plan or focused Research questions.
4. Issue uses Research and Think to publish readable Issue prose and one canonical Plan, either by creating an Issue or updating one completely.
5. Build reads the selected Issue once, runs one actor to implement and self-review the whole Plan, then tests and independently reviews the result before one commit.
6. Ship pushes and creates a draft pull request only when explicitly authorized.

Code accepts a direct request and uses the same implementation executor as Build without Git actions.

## Ownership

| Directory    | Responsibility                                                                   |
| ------------ | -------------------------------------------------------------------------------- |
| `research/`  | Evidence reports and their derived Knowledge index                               |
| `think/`     | Plan decisions and Research questions                                            |
| `plan/`      | Shared Plan contract and validation                                              |
| `issue/`     | Human-readable Issue publication and public Plan                                 |
| `build/`     | Issue loading, Build verification, commit, and Ship                              |
| `code/`      | Direct-request compilation                                                       |
| `execution/` | Implementation, verification, and recoverable execution shared by Build and Code |
| `runtime/`   | Invocation authorization, CLI I/O, storage, and host environment                 |
| `shared/`    | Reusable repository, model, schema, and text utilities                           |

## Boundaries

- User-authored inputs contain semantic requests and selectors, not internal execution records.
- Workflow contracts and durable artifacts use English. Human-facing Issue prose and final reports use the configured language.
- The public Issue JSON Plan is Build authority. The same Plan also generates visible Markdown for human review, followed by a collapsed JSON block. The surrounding title and prose explain the Research and Think decision to people.
- Optional PR screenshots are Build delivery input, not public Plan authority.
- Research reports remain the evidence record. Knowledge is a rebuildable index of original reports; it never derives decisions from Issue artifacts.
- Build and Code use one implementation actor for the complete requested scope. A failed test or blocking semantic review returns to that actor, followed by tests and review again.
- Plan units organize goals and acceptance criteria; they do not prescribe actor calls or restrict review evidence. Editing stays within the combined Plan scope.
- Model responses contain judgments and findings. The runtime binds them to the invocation and source; models do not echo controller identifiers or digests.
- One invocation record owns task, workflow, repository and external-write authorization. Inputs are workflow-specific within the task directory. The hook supplies host identity; runners validate inputs, own resume policy and report blockers.
- Runtime GitHub commands are declared in `shared/github.ts`. Shell tests run without GitHub credentials.
- `codex-build` and `codex-code` are thin public adapters over one internal implementation runner and accept only their matching workflow bindings.
- Issue publication and Ship require separate explicit authorization. Code never commits, pushes, or creates a pull request.
- Stable decisions belong in repository documentation rather than private workflow state.

## File naming

- `runner.ts` is reserved for a workflow's public CLI entrypoint.
- `manifest.ts` converts that workflow's semantic input into an internal execution manifest.
- `execution/engine.ts` owns the shared execution loop; it is not a public CLI.
- `execution/manifest.ts` constructs and validates the common implementation steps. Workflow-specific `manifest.ts` files adapt their semantic inputs.
- `execution/actor-receipt.ts` owns accepted-work receipts; `repository-isolation.ts` owns sandbox execution and recoverable publication.
- `research/knowledge.ts` owns the derived index and lookup together. `build/screenshots.ts` owns screenshot validation and delivery together.
- `runtime/storage.ts` owns runtime and artifact paths, atomic writes, and artifact naming. These source moves do not relocate saved data.
- Merge a small helper into its sole owner when it has no independent responsibility; keep public CLI entrypoints stable.
- Test file names mirror the behavior owner they exercise.

## Verification

Run `bun run check`. Use `bun run verify:clean` when dependencies must also be reconstructed from `bun.lock` with Bun 1.4.0.
