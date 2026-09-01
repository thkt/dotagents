# Project outcome

Enable a single request to publish high-quality Issues containing Think/Research decisions and designs grounded in primary sources.

## Verifiable boundaries

- Every Think and Research model stage reads the immutable repository snapshot captured at startup, so changes to the shared worktree during execution do not alter its results.
- Current-source citations and Build Plan dependencies are revalidated at handoff, with concrete paths reported when they are stale or out of scope.
- An Issue structures and publishes the Outcome, Decision, and implementation-ready Plan in one pass, while established contracts remain reusable from this repository's documentation.
- Build consumes only the published Issue as its contract for implementation, verification, semantic review, and commit.
- Established knowledge is returned to repository documentation so future Plans can cite it.
- A terminal model failure consumes the intent and stops; only input or binding validation failures preserve the intent for correction.

Verification uses focused regression tests, `bun test`, typecheck, lint, and format:check. `bun.lock` is the source of truth for dependencies, reproduced with `bun install --frozen-lockfile --ignore-scripts`.
