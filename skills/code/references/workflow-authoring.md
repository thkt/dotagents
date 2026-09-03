# Workflow Authoring

Read this reference when the requested code change edits this package's workflow controller, agents, gates, hooks, or workflow artifacts.

## Ownership

- Group modules by the outcome they maintain. Put feature-independent code in `workflows/shared/`, shared execution in `workflows/execution/`, and workflow-specific code in its named directory.
- Keep workflow tests with the owning workflow. Use integration tests only for cross-workflow or installation boundaries.
- Keep the Bun 1.4.0 toolchain and dependency installation at the package root.

## Runtime boundary

- Parse every caller, persisted, command, and model boundary into a closed type before using it.
- Put repeatable validation, permissions, state transitions, retries, and stopping conditions in TypeScript.
- Keep prompts to judgments that code cannot derive. Pass untrusted text in clearly delimited data blocks.
- Run model work with the narrowest read, write, network, and external-action authority that reaches the outcome.
- Preserve a stable failure classification and enough evidence for the declared correction owner.

## Readability

- Start every maintained TypeScript file with one `@file Outcome` comment.
- Use names and types for intent. Add JSDoc only where a function's outcome or invariant is not apparent from its signature.
- Keep one source for knowledge that must change together. Do not merge similar code that has independent reasons to change.
