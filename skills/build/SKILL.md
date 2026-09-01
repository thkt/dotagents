---
name: build
description: Implement one published issue-workflow receipt as verified unit commits and a draft PR. Use for an explicitly requested end-to-end build after issue publication.
---

# Build

Inspect the current workflow and Plan contract with `codex-flow describe --workflow build`. Read [shell gate evidence](../../workflows/flow/references/shell-gate.md) when choosing it.

## Source

- Use the published issue receipt produced by issue. If it is unavailable, stop at the missing handoff.
- Do not reconstruct or extend its Plan from the GitHub title or body.

## Authority

- For a tested unit, any Plan file absent when the workflow starts must be included in both the Red and Green actor allowed files. Existing files may remain split between Red and Green.
- Treat the user's leading explicit invocation as authorization for the declared local branch, verified unit commits, exactly one push, and exactly one draft PR creation in the hook-bound repository. Do not request another Ship confirmation.
- Include Ship unless the user explicitly excludes push or draft PR creation in the same request.
- Report backlog candidates without creating them.

## Escalation

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Report the terminal outcome, manifest hash, branch and base, verified units and commits, gate evidence, correction counts, Ship status, and verified PR URL when present. Report a PR URL only after Ship verification succeeds.
