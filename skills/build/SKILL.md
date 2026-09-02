---
name: build
description: Implement one public GitHub Issue contract as verified unit commits and a draft PR. Use for an explicitly requested end-to-end build after issue publication.
---

# Build

Run the prepared Build input with `codex-flow run --input <task-input-json>`. The controller derives every execution step from the selected public Plan.

## Source

- Accept an Issue shorthand such as `#123` in the explicit invocation and select it from the current worktree's `origin` GitHub repository. The hook prepares the small Build input; do not author execution steps.
- Run the controller with GitHub network access; it performs the bound Issue reads itself. If the execution sandbox denies `api.github.com`, retry the same controller command with network escalation. Do not run a separate `gh ... view` preparation command or substitute browser content as the contract.
- Select the public contract by exact GitHub `repository` and `issue_number`; a publisher's local receipt is never required.
- Read the canonical machine Plan embedded by the issue workflow and require it to match the human-readable Plan and body digest exactly.
- The controller binds every unit outcome, file scope, actor mode, and test command to that published Plan; Build input is not an alternate source of implementation intent.
- Re-fetch the Issue at Build start, immediately before semantic review, and immediately before Ship. Treat any title, body, digest, or Plan change after `load:plan` as stale.
- After final tests, require an independent read-only SDK review of the complete diff against the published goals and contracts.

## Authority

- For a tested unit, the controller gives both Red and Green actors the exact Plan file set.
- Treat the user's leading explicit invocation as authorization for the declared local branch, verified unit commits, exactly one push, and exactly one draft PR creation in the hook-bound repository. Do not request another Ship confirmation.
- Include Ship unless the user explicitly excludes push or draft PR creation in the same request.
- On resume, reconcile branch, commit, push, and draft PR postconditions before repeating an external action.
- When the published Plan declares screenshots, render the completed UI and capture every declared image at the controller-provided path. Ship only with the exact controller-sealed image bytes; a changed image or unresolved attachment blocks completion instead of creating another PR.
- Report backlog candidates without creating them.
- If the user cancels an active Build, run the hook-bound `codex-flow cancel` operation. Do not implement, commit, push, or create a draft PR after cancellation.

## Escalation

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Report the terminal outcome, execution hash, branch and base, verified units and commits, gate evidence, correction counts, Ship status, and verified PR URL when present. Report a PR URL only after Ship verification succeeds.
