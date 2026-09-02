# Workflow contracts

The project outcome is defined in [.codex/OUTCOME.md](../.codex/OUTCOME.md).
This document is the primary source for the stable handoff boundaries:

- Think and Research model stages use the same-run immutable repository snapshot.
- Build selects a public GitHub Issue contract by `repository + issue_number`; it does not depend on a publisher-local receipt or scan for the latest artifact.
- A hook-created task directory owns ephemeral intent, approval, input, and controller records. Repository-local `.codex/workflow-artifacts/` is ignored handoff/audit cache, not Build authority. Paths stay stable; exact schema validation rejects incompatible task-local state, while cache remains rebuildable.
- Protocol identifiers name one outcome-bearing contract, not a harness release, so every identifier is versionless. Parsers accept only the current exact schema. When a durable Issue, Plan, manifest, or task-local record is stale, recreate it with the current workflow instead of guessing or maintaining version branches.
- A public Issue is durable cross-harness authority, not a task-local record. Publications use the stable `codex-public-build-contract` envelope and separately hashed publication identity. Build rejects stale envelopes and requires the Issue to be republished by the current Issue workflow.
- Build derives actor goals, contracts, and verification commands from the loaded public Plan. After final tests, an independent read-only Codex SDK review checks the complete diff before Ship can begin.
- External branch, commit, push, and draft-PR actions are reconciled from their observable postconditions when an interrupted controller resumes.
- A terminal model failure consumes intent; input or binding validation failures preserve it.
- A pending Issue with no ready Think artifact terminates only through the task-bound `codex-issue stop`; it revokes publication authority without requiring a placeholder input or GitHub access.
- Issue generates the visible body and machine contract from one canonical Plan, then revalidates current source and exact identity before publishing once. Build revalidates that public Issue at startup, before semantic review, and before Ship.
- An active controller can be cancelled only through task-bound `codex-flow cancel`, which revokes Ship authorization and records terminal `cancelled` state.

Think Plans should cite this document and quote the applicable rule instead of restating it.

## GitHub CLI access

Every runtime `gh` call is declared in `shared/github.ts`; workflow modules use its literal argv builders instead of constructing GitHub commands themselves.

| Operations                                                                      | Access    | Required authority                                                                                            |
| ------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `repo view`, `issue view`, publication-id Issue search, `label list`, `pr view` | Read-only | None; the exact command may still require sandbox network escalation                                          |
| `label create`, `issue create`, `issue edit`                                    | Write     | A consumed, repository-bound `issue-publication` approval created by the leading explicit `$issue` invocation |
| `pr create`                                                                     | Write     | A task- and repository-bound `build-ship` approval created by the leading explicit `$build` invocation        |

The pending-Build hook permits only the exact source-bound `gh issue view` command. Issue-authored shell gates cannot invoke `gh`; all shell-gate subprocesses also run without GitHub tokens and with an isolated `GH_CONFIG_DIR`. Git push is a separate `build-ship` action and is not delegated to Issue-authored commands.

GitHub network, authentication, or keyring access failure before branch creation leaves a cursor-zero Build retryable only while the manifest, `HEAD`, and worktree snapshot remain unchanged. A missing Issue, malformed GitHub response, or invalid Issue contract stays blocked and is not retryable as a network failure. A GitHub write failure never widens or restores a consumed write approval.

Ship recovery treats only GitHub's explicit “no pull request found” result as absence. An inaccessible, malformed, or mismatched existing PR blocks recovery instead of repeating `gh pr create`.

# Verification

依存関係を `bun.lock` どおりに再現して検証する標準経路は `bun run verify:clean` です。これは `bun install --frozen-lockfile --ignore-scripts` でこの repository の `node_modules` を構築した後、`check`（lint、format、typecheck、tests、skills validation）を実行します。`node_modules` の symlink や別 repository の依存関係を使わないでください。Bun 1.4.0 を使用します。
