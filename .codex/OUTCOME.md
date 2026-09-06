# Project outcome

Turn Research findings into a Think Plan, publish that Plan once in a public Issue, then implement and verify the selected Issue.

## Verifiable boundaries

- Research gathers the requested repository and optional external evidence into a report, then best-effort rebuilds derived topic-based Knowledge from persisted Research.
- Think reads selected Research and related Knowledge, then returns either an implementable Plan or focused follow-up research questions.
- Issue uses Research and Think to publish readable prose plus one canonical Plan, and can update the complete title and body of a selected Issue.
- Build reads the selected Issue once as its sole implementation authority, verifies the complete result, and Ships only with explicit authorization.
- Code uses the same implementation executor as Build without creating commits, pushes, or pull requests.
- Workflow contracts and canonical JSON Plans stay in English; human-facing Issue prose, visible Plan Markdown, and final reports use the configured language.

Contract granularity follows [the common workflow policy](../workflows/README.md): establish observable requirements and necessary compatibility/safety boundaries, then delegate in-scope implementation decisions.

Verification uses `bun run check`.
