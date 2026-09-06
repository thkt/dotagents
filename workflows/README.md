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
Both workflows require the shared shell test and an independent semantic review before completion.

## Contract granularity

This section is the common policy for Research, Think, Issue, Build, and Code.

A contract fixes observable behavior, permitted edit scope, required external or persisted compatibility, safety conditions, and acceptance evidence. Specify exact names, types, fields, formats, or algorithms only when a stated compatibility or safety requirement depends on them. The implementation owner chooses internal types, functions, file layout within scope, and algorithms otherwise; an Issue does not need to enumerate every TypeScript schema or API name.

Research establishes facts and names unresolved factual claims. An unspecified implementation choice is not missing evidence. Think fixes the external requirements and constraints needed to delegate the work, leaving implementation choices to the owner. Route genuinely unknown facts that can change those requirements to Research. Issue publishes the same reviewed Plan faithfully; publication or translation must not add internal requirements.

Build and Code implement and self-review within the authorized scope using this distinction. Before returning a proposed handoff, an independent read-only review checks whether it identifies a genuine contract-external design decision or missing fact. If the handoff is unnecessary, return the finding to the same implementation actor for one correction; do not add a unit stage or an unconditional review to successful actor calls. Confirmed design decisions return to Think and missing facts to Research. Ordinary implementation choices and test failures remain local work. Preserve the current test, source, review, and publication checks.

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
- Workflow contracts and machine-readable artifacts use English. Human-facing Issue prose, visible Plan Markdown, and final reports use the configured language.
- The public Issue JSON Plan is Build authority. Issue authors derive a faithful `plan_markdown` translation from the ready Think Plan in the configured language used for the title and prose, preserving every requirement, identifier, file path, and command. The controller adds the Plan heading and unchanged canonical JSON block. Existing callers that omit the translated view retain English rendering.
- Optional PR screenshots are Build delivery input, not public Plan authority.
- Research owns a durable startup snapshot and investigator-authored candidate. Static evidence validation precedes independent audit; confirmed defects return to the investigator at most three times. Invalid model responses and infrastructure failures allow one retry per stage and candidate, then stop as indeterminate without spending correction budget.
- Research consumes the armed intent after saving task-bound state. Re-running the same runner with the exact input resumes that state without a new intent, preserving snapshot, candidate, correction context and retry counts. An active Research run prevents a new invocation; a blocked run needs a new explicit Research invocation to start a new budget. Incompatible or corrupt state is retained: use the original runtime to recover, or start in a new task. SDK threads are reconstructed from persisted context.
- Research saves publication paths before writing paired artifacts; completed retries reuse those paths without model calls. Research reports remain the evidence record. Knowledge is a rebuildable index of original reports; it never derives decisions from Issue artifacts.
- Build and Code use one implementation actor for the complete requested scope. A failed test or blocking semantic review returns to that actor, followed by tests and review again.
- The runner owns an exclusive SQLite transaction for the task while starting, executing, resuming, or cancelling it. The lock database stays in the local runtime directory; never delete it while a runner is active. Process death releases ownership without PID-based takeover. Arming a new invocation uses the same ownership boundary.
- Execution state revision 1 binds worker results to an invocation and attempt, and review results to a fresh dispatch identifier and the tested source. A discarded worker is reconstructed from persisted scope, candidate files and correction evidence; this is not SDK session resumption. Durable pending publications are reconciled before redispatch.
- Incompatible older execution records are retained and rejected before side effects. Finish or cancel them using their original runtime before starting a new invocation. Re-running an exhausted or completed invocation does not reset its correction budget.
- Code uses the same internal review gate as Build. Build and Code supply outcome, test command, and scoped review units through the same criteria input; only Build includes public Issue metadata. Code does not fetch or publish an Issue, and supports repositories without commits.
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
