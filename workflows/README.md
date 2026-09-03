# Workflows

The project outcome is defined in [.codex/OUTCOME.md](../.codex/OUTCOME.md).

## Flow

1. Research gathers repository and optional external evidence into one report.
2. Completed Research automatically rebuilds topic-based Knowledge summaries with links to their source findings.
3. Think reads explicitly selected reports first, adds related Knowledge, and returns one Plan or focused Research questions.
4. Issue publishes that Plan once beneath `## Plan` in a public GitHub Issue.
5. Build reads the selected Issue once, implements the whole Plan, tests and reviews the result, then creates one commit.
6. Ship pushes and creates a draft pull request only when explicitly authorized.

Code accepts a direct request and uses the same implementation executor as Build without Git actions.

## Ownership

| Directory    | Responsibility                                       |
| ------------ | ---------------------------------------------------- |
| `research/`  | Evidence collection and audited Research reports     |
| `knowledge/` | Derived Knowledge updates and relevant lookup        |
| `think/`     | Plan decisions and Research questions                |
| `plan/`      | The shared Plan contract and validation              |
| `issue/`     | Issue publication and the public Plan format         |
| `build/`     | Issue loading, Build verification, commit, and Ship  |
| `code/`      | Direct-request compilation                           |
| `flow/`      | The implementation executor shared by Build and Code |
| `shared/`    | Workflow-independent runtime support                 |

## Boundaries

- User-authored inputs contain semantic requests and selectors, not internal execution records.
- Workflow contracts and durable artifacts use English. The invoking Skill translates only its final user-facing report into the configured language.
- The public Issue Plan is Build authority. Local Issue drafts and receipts support publication recovery only.
- Research reports remain the evidence record. Knowledge is a rebuildable topic summary with report and finding references; it never derives decisions from Issue artifacts.
- Build and Code use one implementation actor for the complete requested scope. A failed test or blocking semantic review returns to that actor, followed by tests and review again.
- Runtime GitHub commands are declared in `shared/github.ts`. Shell tests run without GitHub credentials.
- Issue publication and Ship require separate explicit authorization. Code never commits, pushes, or creates a pull request.
- Stable decisions belong in repository documentation rather than private workflow state.

## Verification

Run `bun run check`. Use `bun run verify:clean` when dependencies must also be reconstructed from `bun.lock` with Bun 1.4.0.
