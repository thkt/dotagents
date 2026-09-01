# Workflow contracts

The project outcome is defined in [.codex/OUTCOME.md](../.codex/OUTCOME.md).
This document is the primary source for the stable handoff boundaries:

- Think and Research model stages use the same-run immutable repository snapshot.
- Build selects a public GitHub Issue contract by `repository + issue_number`; it does not depend on a publisher-local receipt or scan for the latest artifact.
- Semantic review and audit are independent checks.
- A terminal model failure consumes intent; input or binding validation failures preserve it.
- Issue generates the visible body and machine contract from one canonical Plan, then revalidates current source and exact identity before publishing once. Build revalidates that public Issue at startup and before Ship.
- An active controller can be cancelled only through task-bound `codex-flow cancel`, which revokes Ship authorization and records terminal `cancelled` state.

Think Plans should cite this document and quote the applicable rule instead of restating it.

# Verification

依存関係を `bun.lock` どおりに再現して検証する標準経路は `bun run verify:clean` です。これは `bun install --frozen-lockfile --ignore-scripts` でこの repository の `node_modules` を構築した後、`check`（lint、format、typecheck、tests、skills validation）を実行します。`node_modules` の symlink や別 repository の依存関係を使わないでください。Bun 1.4.0 を使用します。
