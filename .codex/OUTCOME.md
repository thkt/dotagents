# Project outcome

Turn Research findings into a Think Plan, publish that Plan once in a public Issue, then implement and verify the selected Issue.

## Verifiable boundaries

- Research gathers the requested repository and optional external evidence into an independently audited report, then best-effort rebuilds derived topic-based Knowledge from persisted Research. It may instead wait for one independently accepted user-owned decision without publishing incomplete evidence.
- Think reads selected Research and related Knowledge, automatically resolves reviewed factual gaps through Research, and returns only a verified ready Plan or one independently accepted waiting question.
- Issue uses Research and Think to publish readable prose plus one canonical Plan, and can update the complete title and body of a selected Issue.
- Build reads the selected Issue once as its sole implementation authority, verifies the complete result, and Ships only with explicit authorization.
- Code uses the same implementation executor as Build without creating commits, pushes, or pull requests.
- Workflow contracts and canonical JSON Plans stay in English; human-facing Issue prose, visible Plan Markdown, and final reports use the configured language.

Contract granularity follows [the common workflow policy](../workflows/README.md): establish observable requirements and necessary compatibility/safety boundaries, then delegate in-scope implementation decisions.

Verification uses `bun run check`.

## Pending user decisions

Research or Think may return exactly one stable investigator- or designer-authored question only when a necessary, materially outcome-changing preference, scope, or policy decision requires user authority. Independent audit or review must accept the complete question before it is shown. It has two or three distinct choices with descriptions and an optional recommendation naming one choice. Factual uncertainty remains an audited Research unknown; internal implementation choices remain delegated.

The host displays the identical complete prompt, choices, descriptions and recommendation using an available permitted question UI, otherwise as text. UI headers and recommendation markers are presentation only; workflow contracts contain no tool names, host modes, UI schemas or recommendation suffixes. Accept an explicit listed selection or free-text answer. Append one record containing the runtime-supplied owner binding, complete displayed question context and verbatim answer to the original hook-supplied root input, then rerun the exact original root command under the same task identity. Never re-arm or create a replacement invocation, edit a nested child input, or infer an answer from labels or concurrent instructions. Empty, cancelled, timed-out, absent, silent, inferred and prose-only responses leave the workflow waiting.

Waiting creates no incomplete Research or Think report, Knowledge, Plan or Issue. It preserves the original invocation, immutable startup snapshot, selected evidence, accepted history, correction and retry budgets, actor state and child ownership, including the root-wide two-child maximum. An identical unanswered rerun makes no model or child call. The runtime journals and routes a valid answer only to its exact waiting leaf, including Think → Research, Build → Research, Build → Think and Build → Think → Research. Refreshing repository evidence requires a new explicit invocation.

Think keeps `research_required` internal: it automatically runs Research and returns to design and independent review, publishing only a verified ready Plan. A proposed Plan requires separate Issue publication and a new Build. The public Issue remains Build's sole implementation authority. While waiting, Build cannot reread or edit the Issue, change the captured Plan, resume implementation, write the repository, commit or Ship. Answers inform child analysis only; they never authorize Issue publication, expand the public Plan or authorize Ship. Existing explicit-invocation and network-execution rules still apply.
