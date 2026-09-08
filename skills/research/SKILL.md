---
name: research
description: Investigate one repository question into a source-checked report with independent audit and explicit unknowns. Use for an explicit research request; it does not implement changes or create a Plan.
---

# Research

Follow the common [contract granularity](../../workflows/README.md) when deciding what this stage must establish.

Read [.codex/OUTCOME.md](../../.codex/OUTCOME.md) and inspect only the minimal relevant primary sources. If it is missing, ask the user to create it with the project outcome and verifiable completion criteria before running Research.

Inspect the current input and artifact contract with `codex-research describe`.
Invoke the first bound workflow command itself with network escalation, requesting persistent approval for prefix `["codex-research", "run"]` in that same tool call when supported. If a genuine transient `model_unavailable` occurs, preserve the intent and retry the exact same command with network escalation.

## Decisions

- State one answerable question.
- Set repository scope only when evidence outside it must be excluded.
- Enable external sources only when repository evidence cannot answer the question; prefer primary sources when enabled.

## Boundaries

- Leave unresolved factual claims explicit; an internal implementation choice left to the owner is not a factual unknown.
- Treat related Knowledge as a lead and cite the current repository or external source that supports each finding.

## Report

Research or Think may return exactly one stable investigator- or designer-authored question only when a necessary, materially outcome-changing preference, scope, or policy decision requires user authority. Independent audit or review must accept the complete question before it is shown. It has two or three distinct choices with descriptions and an optional recommendation naming one choice. Factual uncertainty remains an audited Research unknown; internal implementation choices remain delegated.

The host displays the identical complete prompt, choices, descriptions and recommendation using an available permitted question UI, otherwise as text. UI headers and recommendation markers are presentation only; workflow contracts contain no tool names, host modes, UI schemas or recommendation suffixes. Accept an explicit listed selection or free-text answer. Append one record containing the runtime-supplied owner binding, complete displayed question context and verbatim answer to the original hook-supplied root input, then rerun the exact original root command under the same task identity. Never re-arm or create a replacement invocation, edit a nested child input, or infer an answer from labels or concurrent instructions. Empty, cancelled, timed-out, absent, silent, inferred and prose-only responses leave the workflow waiting.

Use the root input's `clarification_answers` array. Each appended record contains `owner`, `question_id` copied from the pending `id`, unchanged `prompt`, `choices`, and `recommendation` (null if absent), plus `selection` and `answer`. Set exactly one of these last two fields to the explicit listed label or verbatim free text, and the other to null. Retain every original field and earlier record.

Waiting creates no incomplete Research or Think report, Knowledge, Plan or Issue. It preserves the original invocation, immutable startup snapshot, selected evidence, accepted history, correction and retry budgets, actor state and child ownership, including the root-wide two-child maximum. An identical unanswered rerun makes no model or child call. The runtime journals and routes a valid answer only to its exact waiting leaf, including Think → Research, Build → Research, Build → Think and Build → Think → Research. Refreshing repository evidence requires a new explicit invocation.

Think keeps `research_required` internal: it automatically runs Research and returns to design and independent review, publishing only a verified ready Plan. A proposed Plan requires separate Issue publication and a new Build. The public Issue remains Build's sole implementation authority. While waiting, Build cannot reread or edit the Issue, change the captured Plan, resume implementation, write the repository, commit or Ship. Answers inform child analysis only; they never authorize Issue publication, expand the public Plan or authorize Ship. Existing explicit-invocation and network-execution rules still apply.

Successful Research attempts to rebuild a topic-based Knowledge index of persisted reports. A Knowledge write failure does not invalidate the Research report. Keep workflow artifacts in English. Translate only the final user-facing report into the configured language, including the answer, finding and unknown counts, artifact paths, and `think` as the next state. Do not continue into Think.
