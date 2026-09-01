# Shell gate evidence

- Use one repository-defined command for one observable condition. Separate unrelated lint, type-check, test, and inspection conditions.
- Trust an issue-authored command only when repository configuration or the user confirms it.
- Use one complete output line only when its presence or absence distinguishes the intended condition.
- Override the default timeout only when the command's expected runtime requires it.
- Do not include secrets in selected literals or user-facing evidence.
