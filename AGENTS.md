# Project guidance

This harness provides shared `scoping` and `implement` workflows. Agreed Issues own requirements; the host owns execution, verification and publication checks; humans own approval and merge.

Use the references that apply to the change:

- [Project outcome](.codex/OUTCOME.md): workflow responsibilities, supported scope and adoption status.
- [Development policy](DEVELOPMENT.md): the relevant requirements, documentation, test or review policy. For Markdown changes, include its Japanese review requirements before adoption or publication.
- [CLI guide](scripts/README.md): target configuration, execution, publication or recovery operations.

Complete authorized edits and affected checks without asking again for routine implementation choices. Ask when requirements or authorization must change, and continue independent work while awaiting that decision.

Use `bun run check` before submitting harness changes. Its control tests use simulated commands; live models, GitHub publication and product tests are separate operations. After required checks pass, repeat or broaden them only for changed inputs, failures or unresolved concerns.
