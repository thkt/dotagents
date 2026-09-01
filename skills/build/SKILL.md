---
name: build
description: Implement one published issue-workflow receipt as verified unit commits and, when explicitly authorized, a draft PR. Use for an explicitly requested end-to-end build after issue publication.
---

# Build

Inspect the current workflow and Plan contract with `codex-flow describe --workflow build`. Read [shell gate evidence](../../workflows/flow/references/shell-gate.md) when choosing it.

## Source

- Use the published issue receipt produced by issue. If it is unavailable, stop at the missing handoff.
- Do not reconstruct or extend its Plan from the GitHub title or body.

## Authority

- For a tested unit, any Plan file absent when the workflow starts must be included in both the Red and Green actor allowed files. Existing files may remain split between Red and Green.
- This workflow authorizes creation of the declared local branch and verified unit commits.
- Include Ship only when the user explicitly authorizes both push and draft PR creation.
- Report backlog candidates without creating them.

## Escalation

Contract-external design gaps return to `think`; missing facts or evidence return to `research`. Mechanical implementation or test failures receive local correction.

## Report

Report the terminal outcome, manifest hash, branch and base, verified units and commits, gate evidence, correction counts, Ship status, and verified PR URL when present. Report a PR URL only after Ship verification succeeds.
