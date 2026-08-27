# Gate evidence

`../core/verify-command.ts` is the executable gate authority. The conductor supplies gate intent in the manifest and consumes the controller's structured result; it does not invoke the verifier directly.

## Command decisions

- Choose one repository-native command for one observable condition. Split unrelated lint, type-check, test, and inspection commands into separate gates.
- Accept an issue-authored command only when it is anchored in repository configuration or was supplied exactly by the user.
- Use `require_output` and `forbid_output` only for literal evidence whose presence or absence distinguishes the intended condition.
- Choose a timeout appropriate to the repository command; the default is 60 seconds.

## Red evidence

Prefer a command that selects the planned failing scenario and emits a stable failure marker. A bare test name is insufficient because it can appear while an unrelated test causes the non-zero exit.

Set `calibrate: true` without an initial `require_output`. When the controller returns `seal-gate`, choose one failure-specific literal found in its captured output and supply it from the directive's `evidence_source`. Do not synthesize or normalize that literal.

## Reporting

Use the directive's `report_result` and preserve the returned gate object unchanged. When presenting output to a user, remove secrets from displayed tails without rewriting the stored classification or routing evidence.
