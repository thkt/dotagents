# Decision Writing

Read this reference when wording the outcome or Plan. Follow the common [contract granularity](../../../workflows/README.md).

## Concrete claims

- Write the condition and observable result instead of `correct`, `normal`, or `as intended`.
- Name the actual operation and content instead of `process`, `data`, or `information`.
- State the measured value and comparison target instead of `fast`, `large`, `latest`, or similar relative terms.
- Keep one claim per sentence.
- Name missing evidence as an unknown. Do not invent a number, owner, date, or failure mode to make the text concrete.

## Outcome and Plan

- Describe a subject's observable done state without naming the implementation.
- Make each unit goal independently observable and each contract state the required behavior and constraints it preserves. Leave internal design choices open unless compatibility or safety requires a specific choice.
- Write each `unit.tests[]` item as an observable acceptance condition under `test_command`.
- Keep research citations, copied repository rules, alternatives, and general rationale out of the Plan. Include exact formats, identifiers, or digest behavior only when a stated external, persisted-compatibility, or safety requirement needs them; do not enumerate internal APIs for completeness.

## Deletion

Remove progress narration, schema restatement, code restatement, revision history, filler headings, and a closing summary that repeats the artifact.
