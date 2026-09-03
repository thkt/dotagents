# Workflows

The project outcome is defined in [.codex/OUTCOME.md](../.codex/OUTCOME.md).

## Flow

1. Research gathers repository and optional external evidence into one report.
2. Completed Research best-effort rebuilds topic-based Knowledge summaries with links to their source findings.
3. Think reads explicitly selected reports first, adds related Knowledge, and returns one Plan or focused Research questions.
4. Issue uses Research and Think to publish readable Issue prose and one canonical Plan, either by creating an Issue or updating one completely.
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
| `issue/`     | Human-readable Issue publication and public Plan     |
| `build/`     | Issue loading, Build verification, commit, and Ship  |
| `code/`      | Direct-request compilation                           |
| `flow/`      | The implementation executor shared by Build and Code |
| `shared/`    | Workflow-independent runtime support                 |

## Boundaries

- User-authored inputs contain semantic requests and selectors, not internal execution records.
- Workflow contracts and durable artifacts use English. Human-facing Issue prose and final reports use the configured language.
- The public Issue Plan is Build authority. The surrounding title and prose explain the Research and Think decision to people.
- Optional PR screenshots are Build delivery input, not public Plan authority.
- Research reports remain the evidence record. Knowledge is a rebuildable topic summary with report and finding references; it never derives decisions from Issue artifacts.
- Build and Code use one implementation actor for the complete requested scope. A failed test or blocking semantic review returns to that actor, followed by tests and review again.
- Runtime GitHub commands are declared in `shared/github.ts`. Shell tests run without GitHub credentials.
- Issue publication and Ship require separate explicit authorization. Code never commits, pushes, or creates a pull request.
- Stable decisions belong in repository documentation rather than private workflow state.

## Verification

Run `bun run check`. Use `bun run verify:clean` when dependencies must also be reconstructed from `bun.lock` with Bun 1.4.0.
