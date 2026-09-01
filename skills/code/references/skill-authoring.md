# Skill Authoring

Read this reference when the requested code change edits `skills/**` or `.ja/skills/**` in this package. Apply the installed Skill Creator instructions first.

## Package contract

- Keep one user outcome per Skill and name it after the operation.
- Keep `SKILL.md` to purpose, decisions, authority boundaries, report shape, and conditional reference links.
- Put deterministic validation and transition policy in TypeScript. Do not restate it as prose.
- Add a reference only when a condition in `SKILL.md` tells the reader when to open it.
- Preserve `agents/openai.yaml` invocation policy unless the request changes it.

## English and Japanese

Treat `.ja/` as the wording source. Update the English mirror in the same change.

- Keep headings, links, identifiers, JSON keys, commands, and stopped values aligned.
- Translate prose instead of copying it.
- Keep Japanese terms concrete when an English loanword obscures the operation or result.

## Verification

Run Skill validation, documentation tests, and Japanese textlint. Test behavior or a real invariant instead of matching optional wording.
