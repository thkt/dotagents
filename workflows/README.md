# Workflows

The project outcome is defined in [.codex/OUTCOME.md](../.codex/OUTCOME.md).

## Flow

1. Research gathers repository and optional external evidence into one independently audited report, or waits for one independently accepted user-owned decision.
2. Completed Research best-effort rebuilds a topic-based Knowledge index pointing to original reports.
3. Think reads explicitly selected reports first and at most three related original reports selected through Knowledge. It automatically resolves reviewed factual gaps through Research, then returns a verified ready Plan or one independently accepted waiting question.
4. Issue uses Research and Think to publish readable Issue prose and one canonical Plan, either by creating an Issue or updating one completely.
5. Build reads the selected Issue once, runs one actor to implement and self-review the whole Plan, then tests and independently reviews the result before one commit.
6. Ship pushes and creates a draft pull request only when explicitly authorized.

Code accepts a direct request and uses the same implementation executor as Build without Git actions.
Both workflows require the shared shell test and an independent semantic review before completion.

All normal implementation and read-only model calls use `gpt-6-astra` with `high` reasoning through the shared client setup. The SDK launches the installed `codex` on `PATH`; `CODEX_CLI_PATH` can explicitly select another installed executable. There is no SDK-bundled fallback. Injected clients and existing sandbox, approval, network, and web-source restrictions remain unchanged. Best-effort progress records retain the actual requested model/effort and supplied SDK input, output, and cache token counts at turn completion, including calls shorter than a heartbeat. Missing counts remain unavailable; telemetry contains no prices, model text, tool arguments, or credentials.

Actors run focused regressions for changed behavior and self-review correctness, simplicity, and acceptance coverage. The controller owns the final full check against current source after implementation and corrections. Corrections rerun affected checks and do not repeat unrelated broad suites without a new reason.

## Contract granularity

This section is the common policy for Research, Think, Issue, Build, and Code.

A contract fixes observable behavior, permitted edit scope, required external or persisted compatibility, safety conditions, and acceptance evidence. Specify exact names, types, fields, formats, or algorithms only when a stated compatibility or safety requirement depends on them. The implementation owner chooses internal types, functions, file layout within scope, and algorithms otherwise; an Issue does not need to enumerate every TypeScript schema or API name.

Research establishes facts and names unresolved factual claims. An unspecified implementation choice is not missing evidence. Think fixes the external requirements and constraints needed to delegate the work, leaving implementation choices to the owner. Route genuinely unknown facts that can change those requirements to Research. Issue publishes the same reviewed Plan faithfully; publication or translation must not add internal requirements.

New Think Plans describe completed observable requirements and retain necessary current safety and authorization conditions. They omit superseded planning and publication history. Generated PR summaries deterministically reference the selected Issue and declared unit scope; arbitrary historical Plan prose is not presented as current implementation or verification facts. The captured Plan remains unchanged and authoritative. Verification still comes from current gate reports, with advisories and screenshots preserved.

Build and Code implement and self-review within the authorized scope using this distinction. Before returning a proposed handoff, an independent read-only review checks whether it identifies a genuine contract-external design decision or missing fact. If the handoff is unnecessary, return the finding to the same implementation actor for one correction; do not add a unit stage or an unconditional review to successful actor calls. Confirmed design decisions return to Think and missing facts to Research. Ordinary implementation choices and test failures remain local work. Preserve the current test, source, review, and publication checks.

## Issue review and publication recovery

The bound `codex-issue draft --input ...` runner treats the supplied title, prose and optional localized display as its initial candidate. It validates the rendered Plan and runs an independent read-only fidelity review. Blocking presentation findings return to a separate author; corrected candidates are validated and independently reviewed again. The canonical Think Plan never changes. A required Plan change stops for Think. There are at most three corrections and two attempts per model operation; restarts preserve both budgets and the saved assignment.

Issue state uses `codex-issue-state-v1` under the existing task ownership lock. The explicit Issue approval transfers into this saved invocation before model work. Resume with the original input through the same draft command; do not arm a replacement invocation while review or publication is pending. Input, Think report, review binding, contract, snapshot and preview changes reject stale publication. Legacy preview files do not establish review or authorization, and incompatible state is retained with recovery instructions.

The runtime saves a pending write before GitHub create/edit. A saved create identity or fixed update target can be reconciled against the exact accepted title and body. If create may have succeeded but no identity was captured, the runner reports `publication_unknown` and never retries create. Retain the run record, inspect GitHub and resolve the uncertain publication explicitly before starting another task; do not delete the record or treat another approval as evidence that create failed. A conflicting update is also retained rather than overwriting another edit. Completed runs validate and return their saved publication evidence without another write or dependence on the original input file, Think Report, snapshot, or live repository.

A Build → Think proposal can be selected for an explicitly authorized Issue update. The returned `build_source` is input for a new explicitly authorized Build, which reads the revised public Plan once. The old Build keeps its captured Plan and remains stopped. Issue never starts Build or grants Ship by itself.

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
- Research optionally accepts `subquestions`, one or two distinct nonblank independent questions under the original question, scope, permissions, Knowledge, and immutable snapshot. Omission keeps one investigator without a planner call. Two read-only investigators overlap; each result is persisted independently and interrupted runs retry only unresolved assignments, at most two dispatches per assignment per correction round. All children settle before ownership is released. Deterministic integration preserves findings, qualifications, rejected claims, unknowns, and limitations; static validation and the independent whole-question audit remain mandatory. A confirmed defect restarts the batch within the existing three-correction budget; indeterminate audit failures retry only the audit. Think handoffs retain their existing single assignment containing every question: approval of individual questions does not establish their mutual independence. Only explicitly supplied `subquestions` enables decomposition.
- Research consumes the armed intent after saving task-bound state. Re-running the same runner with the exact input resumes that state without a new intent, preserving snapshot, candidate, correction context and retry counts. An active Research run prevents a new invocation; a blocked run needs a new explicit Research invocation to start a new budget. Incompatible or corrupt state is retained: use the original runtime to recover, or start in a new task. SDK threads are reconstructed from persisted context.
- Research saves publication paths and a fixed generation time before writing paired artifacts, deriving the Report from its accepted candidate. Completed retries verify exact input and reuse intact artifacts without writes or a snapshot; a missing Markdown view is repaired only with matching JSON and genuine accepted evidence; divergent output fails closed. Research rejects incompatible active state formats while retaining them for recovery. Research reports remain the evidence record. Knowledge is a rebuildable index of original reports; it never derives decisions from Issue artifacts.
- Think designers own ready Plans, internal research_required decisions, and necessary user-owned questions; reviewers return findings without rewriting them. Static validation precedes independent review. Confirmed defects return to the designer at most three times, while indeterminate model failures permit one retry per stage and candidate. Research questions must identify missing facts that materially affect requirements, not ordinary implementation choices.
- Think holds task ownership before inspecting input or intent. Durable state captures the exact input identity, resolved Research and Knowledge, startup snapshot, governing contract identity, candidate and budgets. Resume uses captured evidence without rereading live reports; input, snapshot or contract changes cannot reuse acceptance. Completed retries reuse intact paired reports without model calls or snapshots, and interrupted publication repairs the fixed destinations. Unrecognized or corrupt Think state is retained with recovery guidance. A new explicit invocation is required to reset a blocked budget. A reviewed research_required decision dispatches Research and returns its accepted evidence to a newly verified designer candidate.
- Build and Code use one implementation actor for the complete requested scope. A failed test or blocking semantic review returns to that actor, followed by tests and review again.
- Verified Think and Build handoffs derive read-only child inputs from the persisted parent, preserving the caller snapshot. Children have distinct run identities, cannot be armed or resumed through standalone CLI invocations, and receive no Issue or Ship authority. The original runner resumes the same child after process death; the whole root invocation allows at most two child dispatches, including nested returns.
- Build Research returns explicit findings and unknowns to the suspended actor under the unchanged public Plan and source. Build Think prepares a proposed Plan, then leaves the old Build blocked for authorized Issue publication and a new Build invocation. An actor's unsupported handoff remains a local correction. Unresolved children and exhausted budgets retain diagnostics without reporting completion. A pending Build handoff cannot be replaced by a new intent: resume or explicitly cancel it, or start in a new task.
- Cross-stage state is versioned independently. Think and execution state reject incompatible saved runs with recovery guidance; the versionless Research report gains optional canonical research_id while historical private reports and Think report formats retain compatibility.
- The runner owns an exclusive SQLite transaction for the task while starting, executing, resuming, or cancelling it. The lock database stays in the local runtime directory; never delete it while a runner is active. Process death releases ownership without PID-based takeover. Arming a new invocation uses the same ownership boundary.
- Execution state binds worker results to an invocation and attempt, and review results to a fresh dispatch identifier and the tested source. A discarded worker is reconstructed from persisted scope, candidate files and correction evidence; this is not SDK session resumption. Durable pending publications are reconciled before redispatch.
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

## Pending decisions

Research or Think may return exactly one stable investigator- or designer-authored question only when a necessary, materially outcome-changing preference, scope, or policy decision requires user authority. Independent audit or review must accept the complete question before it is shown. It has two or three distinct choices with descriptions and an optional recommendation naming one choice. Factual uncertainty remains an audited Research unknown; internal implementation choices remain delegated.

The host displays the identical complete prompt, choices, descriptions and recommendation using an available permitted question UI, otherwise as text. UI headers and recommendation markers are presentation only; workflow contracts contain no tool names, host modes, UI schemas or recommendation suffixes. Accept an explicit listed selection or free-text answer. Append one record containing the runtime-supplied owner binding, complete displayed question context and verbatim answer to the original hook-supplied root input, then rerun the exact original root command under the same task identity. Never re-arm or create a replacement invocation, edit a nested child input, or infer an answer from labels or concurrent instructions. Empty, cancelled, timed-out, absent, silent, inferred and prose-only responses leave the workflow waiting.

Use the root input's `clarification_answers` array. Each appended record contains `owner`, `question_id` copied from the pending `id`, unchanged `prompt`, `choices`, and `recommendation` (null if absent), plus `selection` and `answer`. Set exactly one of these last two fields to the explicit listed label or verbatim free text, and the other to null. Retain every original field and earlier record.

Waiting creates no incomplete Research or Think report, Knowledge, Plan or Issue. It preserves the original invocation, immutable startup snapshot, selected evidence, accepted history, correction and retry budgets, actor state and child ownership, including the root-wide two-child maximum. An identical unanswered rerun makes no model or child call. The runtime journals and routes a valid answer only to its exact waiting leaf, including Think → Research, Build → Research, Build → Think and Build → Think → Research. Refreshing repository evidence requires a new explicit invocation.

Think keeps `research_required` internal: it automatically runs Research and returns to design and independent review, publishing only a verified ready Plan. A proposed Plan requires separate Issue publication and a new Build. The public Issue remains Build's sole implementation authority. While waiting, Build cannot reread or edit the Issue, change the captured Plan, resume implementation, write the repository, commit or Ship. Answers inform child analysis only; they never authorize Issue publication, expand the public Plan or authorize Ship. Existing explicit-invocation and network-execution rules still apply.

## Post-merge cleanup

`$cleanup <issue>` prepares a non-mutating Git preview from a verified Build Ship receipt. Historical receipts are not inferred. `$cleanup approve <prepared digest>` binds the exact repository, task, inventory and deletion targets. `codex-cleanup describe` lists the closed `prepare`, `run` and `resume` commands; the hook supplies the input path and task identity.

Cleanup saves dirty state in an owned recovery commit, moves to the verified merged base, restores and checks files/index, then deletes the remote topic with an expected-OID lease before topic configuration and atomic local ref deletion. It preserves unrelated refs (including same-OID refs), reflogs, worktrees, configuration, and staged/unstaged/untracked/ignored state. The preview contains paths and target identities, never saved file bytes. Durable canonical records share the primary worktree’s `.codex/workflow-artifacts/cleanup` namespace; approval separately binds the active worktree. Unfinished approved cleanup excludes cooperating workflow writers across linked worktrees. Inventory checks detect external drift but cannot fence arbitrary Git/filesystem writers.

An interrupted approved operation resumes only from its original input. If a remote deletion is pending and its expected OID remains present, the controller retains local/recovery refs and requires manual resolution instead of resending an indistinguishable delete. Verified absence can reconcile that intent. Reports distinguish completed, pending and unattempted steps and identify retained recovery. No Stop hook automatically starts or resumes cleanup. Unsupported index/filesystem states, including intent-to-add, stop before approval. A conflict discovered after fetching a missing base reports `blocked` with the already captured recovery OID/ref and performs no deletion. A newly tracked base path colliding with saved untracked/ignored content is a conflict even when bytes match.

## Shared Research corpus

Standalone Research alone publishes immutable `research/records/<research_id>.json` and generated `research/reports/<research_id>.md`, independently of `CODEX_FLOW_ARTIFACT_DIR`. These unignored files are for human review and commit; Research performs no Git staging, commit, branch, reset, push or Issue publication. See the [corpus contract](../research/README.md) for canonical serialization, verification and recovery. `bun run check` includes `verify:research`.

Source validation and independent source audit precede a separate public-safety audit of every unchanged report string and rendered view. Repository citations must be tracked in the immutable snapshot. Unsafe or indeterminate evidence, secrets, personal data, private endpoints, embeds and source reproduction block publication without rewriting values. Preparation and genuine acceptance bind the fixed identity and bytes before creation-only pair publication. Identical pairs are reused; interrupted owned partial pairs resume under the original invocation. Unowned partial pairs, conflicts or missing acceptance fail closed. Incompatible retained state is preserved with original-runtime/new-task recovery guidance.

Automatic Research under Think or Build completes into protected private evidence and never changes the shared corpus. Deliberate sharing requires a new explicit standalone invocation with optional `retained_child_report` selecting the original private JSON and its retained completed child state, ownership and independent audit. Startup captures the dated original and historical answers; a fresh snapshot, reconsideration and both independent audits are required. No copy-only promotion or automatic migration occurs. Answers never grant publication or Ship authority.

Knowledge indexes canonical JSON originals by `research_id` and `generated_at`, validates their paired views, and stores no summaries. Private or legacy artifacts supply no index content. Rebuild leaves the prior index unchanged if corpus validation fails or a previously indexed latest original is missing; lookup still omits unavailable originals. Prior references only prevent fallback and supply no report content. Think resolves explicit filenames against `research/records`, captures complete selected originals before related Knowledge, excludes selected identities, and takes at most three topics with one latest original each. Invalid explicit input blocks design; invalid or unavailable optional context is omitted without older fallback. Provenance distinguishes selected, related and runtime-child evidence. Resumes retain captured evidence; new invocations verify dated claims against their fresh snapshots and resolve factual gaps through Research.

Private operational storage inside a repository must already be Git-ignored and disjoint from tracked files and the corpus, including saved destinations used on resume. This covers cleanup evidence and restoration staging, private snapshots and actor payloads, and repository-local SDK runtime roots and credential homes. Directory-only ignore rules work before storage exists; production writers never install ignore policy. Resolved destinations determine repository ownership, so an ignored symlink cannot hide unsafe storage. Cleanup keeps its fixed primary-worktree owner; snapshot contents and authorized repository restoration retain their existing boundaries. Configured external storage remains repository-scoped. Knowledge rebuilding is best-effort after Research persistence and emits content-free failure diagnostics.
