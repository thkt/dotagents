# Workflow controller

`../core/flow-control.ts` is the executable authority for `code` and `build`. The Codex hook binds persisted state to the current task, so normal stateful calls omit `--run-id`.

## Discover the contract

Run `codex-flow describe --workflow code` or select `build`. The versioned JSON result contains the manifest template, current step contracts, enforced sequence, directive protocols, matching `report_result` values, and any `evidence_source`.

Copy `manifest_template` to a per-run temporary JSON file outside the repository, replace its placeholders, and populate `steps` from the returned contract. Do not maintain another static template.

The caller chooses only facts the controller cannot infer: units, allowed files, repository-native commands, correction owner, correction budget, and Ship authorization. For Red, choose the sealed literal later from returned calibration evidence. For a fail-closed gate, omit `owner` and choose `blocked` or `triage`.

## Runtime interface

Start with the absolute manifest, then use `next` and `report`. Execute only the returned directive payload and echo its `report_result` and requested evidence into `report`. Terminal directives need no report.

Preserve controller protocol, classification, evidence, and terminal status rather than reconstructing them in prose.
