---
name: build
description: Implement one public GitHub Issue contract as verified unit commits and a draft PR. Use for an explicitly requested end-to-end build after issue publication.
---

# Build

Inspect the current workflow and Plan contract with `codex-flow describe --workflow build`. Read [shell gate evidence](../../workflows/flow/references/shell-gate.md) when choosing it.

## Source

- Accept an Issue shorthand such as `#123` in the explicit invocation and select it from the current worktree's `origin` GitHub repository. Use the prepared source directly; do not search for the Issue or reconstruct the source.
- Select the public contract by exact GitHub `repository` and `issue_number`; a publisher's local receipt is never required.
- Read the canonical machine Plan embedded by the issue workflow and require it to match the human-readable Plan and body digest exactly.
- Bind every unit outcome and test command to that published Plan; manifest text is not an alternate source of implementation intent.
- Re-fetch the Issue at Build start, immediately before semantic review, and immediately before Ship. Treat any title, body, digest, or Plan change after `load:plan` as stale.
- After final tests, require an independent read-only SDK review of the complete diff against the published goals and contracts.

## Authority

- For a tested unit, any Plan file absent when the workflow starts must be included in both the Red and Green actor allowed files. Existing files may remain split between Red and Green.
- Treat the user's leading explicit invocation as authorization for the declared local branch, verified unit commits, exactly one push, and exactly one draft PR creation in the hook-bound repository. Do not request another Ship confirmation.
- Include Ship unless the user explicitly excludes push or draft PR creation in the same request.
- On resume, reconcile branch, commit, push, and draft PR postconditions before repeating an external action.
- Report backlog candidates without creating them.
- If the user cancels an active Build, run the hook-bound `codex-flow cancel` operation. Do not implement, commit, push, or create a draft PR after cancellation.

## Escalation

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Report the terminal outcome, manifest hash, branch and base, verified units and commits, gate evidence, correction counts, Ship status, and verified PR URL when present. Report a PR URL only after Ship verification succeeds.
