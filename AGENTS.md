# Project guidance

This harness provides shared `scoping` and `implement` workflows. Agreed Issues own requirements; the host owns execution, verification and publication checks; humans own approval and merge.

Use the references that apply to the change:

- [Project overview](README.md): workflow responsibilities, supported scope and adoption status.
- [Development policy](docs/wiki/development-policy.md): the relevant requirements, documentation, test or review policy. For Markdown changes, include its Japanese review requirements before adoption or publication.
- [CLI guide](scripts/README.md): target configuration, execution, publication or recovery operations.

Complete authorized edits and affected checks without asking again for routine implementation choices. Follow explicit user instructions over general skill guidance within the agreed requirements and authorization. Investigate available facts; ask early for facts only the user can provide or unresolved intent and requirements. Before requesting approval, prepare a concrete proposal or result and explain its impact using work already authorized and independent of that decision. Wait for decisions that affect requirements or authorization, and continue independent work while awaiting them.

If an instruction file causes a confirmation request or a pause, link the file actually read, quote the relevant instruction, and distinguish its explicit requirement from your interpretation.

Use `bun run check` before submitting harness changes. Its control tests use simulated commands; live models, GitHub publication and product tests are separate operations. After required checks pass, repeat or broaden them only for changed inputs, failures or unresolved concerns.
