---
name: build
description: Implement and verify one public GitHub Issue Plan, optionally pushing one branch and creating one draft PR. Use for an explicit end-to-end build after Issue publication.
---

# Build

Follow the common [contract granularity](../../workflows/README.md) when deciding what this stage must establish.

Run the prepared Build input with `codex-build run --input <task-input-json>`. The controller derives every execution step from the selected public Plan.

## Source

- Accept an Issue shorthand such as `#123` in the explicit invocation and select it from the current worktree's `origin` GitHub repository. The hook prepares the small Build input; do not author execution steps.
- Invoke the first bound controller command itself with network escalation, requesting persistent approval for prefix `["codex-build", "run"]` in that same tool call when supported. This prefix is safe to persist because the Build-only command still requires the task- and repository-bound `$build` approval and exposes only Build run and cancel operations. If a genuine transient access failure occurs, retry the exact same controller command with network escalation. Do not run a separate `gh ... view` preparation command or substitute browser content as the contract.
- Read the selected Issue once at Build start. The JSON Plan in its unique `## Plan` section is the sole implementation authority; surrounding presentation markup, a publisher-local receipt, second rendering, or body hash is not required.
- The controller derives actor goals, combined file scope, and the test command from that Plan. Build input is not an alternate source of implementation intent.
- Run one actor to implement and self-review the whole Plan, then run tests and one independent read-only SDK review of contract compliance and quality. Return concrete failures to the implementation actor and repeat verification.

## Authority

- Treat the user's leading explicit invocation as authorization for the local branch, one final verified commit, and, when Ship is enabled, one push and one draft PR creation in the hook-bound repository. Do not request another Ship confirmation.
- Include Ship unless the user explicitly excludes push or draft PR creation in the same request.
- On resume, reconcile branch, commit, push, and draft PR postconditions before repeating an external action.
- When the user explicitly requests PR screenshots, add their safe image names and alt text to the prepared Build input. Render the completed UI and capture every requested image at the controller-provided path. Ship only with the exact controller-sealed image bytes; a changed image or unresolved attachment blocks completion instead of creating another PR.
- Report backlog candidates without creating them.
- If the user cancels an active Build, run the hook-bound `codex-build cancel` operation. Do not implement, commit, push, or create a draft PR after cancellation.

## Escalation

Apply the common handoff review policy before returning a design question to `think` or a factual gap to `research`. Unspecified internal implementation choices remain with the implementation owner.

## Report

Research or Think may return exactly one stable investigator- or designer-authored question only when a necessary, materially outcome-changing preference, scope, or policy decision requires user authority. Independent audit or review must accept the complete question before it is shown. It has two or three distinct choices with descriptions and an optional recommendation naming one choice. Factual uncertainty remains an audited Research unknown; internal implementation choices remain delegated.

The host displays the identical complete prompt, choices, descriptions and recommendation using an available permitted question UI, otherwise as text. UI headers and recommendation markers are presentation only; workflow contracts contain no tool names, host modes, UI schemas or recommendation suffixes. Accept an explicit listed selection or free-text answer. Append one record containing the runtime-supplied owner binding, complete displayed question context and verbatim answer to the original hook-supplied root input, then rerun the exact original root command under the same task identity. Never re-arm or create a replacement invocation, edit a nested child input, or infer an answer from labels or concurrent instructions. Empty, cancelled, timed-out, absent, silent, inferred and prose-only responses leave the workflow waiting.

Use the root input's `clarification_answers` array. Each appended record contains `owner`, `question_id` copied from the pending `id`, unchanged `prompt`, `choices`, and `recommendation` (null if absent), plus `selection` and `answer`. Set exactly one of these last two fields to the explicit listed label or verbatim free text, and the other to null. Retain every original field and earlier record.

Waiting creates no incomplete Research or Think report, Knowledge, Plan or Issue. It preserves the original invocation, immutable startup snapshot, selected evidence, accepted history, correction and retry budgets, actor state and child ownership, including the root-wide two-child maximum. An identical unanswered rerun makes no model or child call. The runtime journals and routes a valid answer only to its exact waiting leaf, including Think → Research, Build → Research, Build → Think and Build → Think → Research. Refreshing repository evidence requires a new explicit invocation.

Think keeps `research_required` internal: it automatically runs Research and returns to design and independent review, publishing only a verified ready Plan. A proposed Plan requires separate Issue publication and a new Build. The public Issue remains Build's sole implementation authority. While waiting, Build cannot reread or edit the Issue, change the captured Plan, resume implementation, write the repository, commit or Ship. Answers inform child analysis only; they never authorize Issue publication, expand the public Plan or authorize Ship. Existing explicit-invocation and network-execution rules still apply.

Keep workflow contracts and the PR body in English. Translate only the final user-facing report into the configured language, including the outcome, branch, test and review results, final commit, Ship status, and verified PR URL. Report a PR URL only after Ship verification succeeds.
