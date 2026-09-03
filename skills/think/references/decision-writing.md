# Decision Writing

Read this reference when wording the outcome or Plan.

## Concrete claims

- Write the condition and observable result instead of `correct`, `normal`, or `as intended`.
- Name the actual operation and content instead of `process`, `data`, or `information`.
- State the measured value and comparison target instead of `fast`, `large`, `latest`, or similar relative terms.
- Keep one claim per sentence.
- Name missing evidence as an unknown. Do not invent a number, owner, date, or failure mode to make the text concrete.

## Outcome and Plan

- Describe a subject's observable done state without naming the implementation.
- Make each unit goal independently observable and each contract name the source or constraint it preserves.
- Write each `unit.tests[]` item as an observable acceptance condition under `test_command`.
- Do not copy source citations, repository rules, hashes, alternatives, or rationale into the Plan. Think uses them to decide; Build does not need them to implement.

## Deletion

Remove progress narration, schema restatement, code restatement, revision history, filler headings, and a closing summary that repeats the artifact.
