---
name: build
description: Implement and verify one public GitHub Issue Plan, optionally pushing one branch and creating one draft PR. Use for an explicit end-to-end build after Issue publication.
---

# Build

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

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Keep workflow contracts and the PR body in English. Translate only the final user-facing report into the configured language, including the outcome, branch, test and review results, final commit, Ship status, and verified PR URL. Report a PR URL only after Ship verification succeeds.
