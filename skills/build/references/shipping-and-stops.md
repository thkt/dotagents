# Shipping decisions

Ship only when the user explicitly authorized both push and draft-PR creation and the controller returns an authorized Ship directive.

## PR body input

Run `codex-build-pr-body describe`, copy its `input_template` to a temporary JSON file, and populate mechanical fields only from controller and command results.

Human-authored `manual_checks` and `advisories` must be concrete and attributable. Never accept actor booleans or invent a plausible replacement body when rendering fails.

## Terminal reporting

Return a PR URL only after Ship verification succeeds. Otherwise preserve the terminal directive and upstream classifications exactly, report any retained cleanup stash, and leave backlog candidates uncreated.
