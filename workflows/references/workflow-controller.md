# Workflow controller

`../core/flow-control.ts` and the workflow hook are the executable authority for `code` and `build`. Instruction documents describe decisions and usage; they do not duplicate transition or enforcement logic.

## Discover the contract

Run `codex-flow describe --workflow code` or select `build`. The versioned JSON result contains the manifest template, current step contracts, enforced sequence, directive protocols, matching `report_result` values, and any `evidence_source`.

Start the user prompt with `$code` or `$build`. The hook arms that workflow for the current task and returns its manifest path. Copy `manifest_template` to that path, replace its placeholders, and populate `steps` from the returned contract. Do not maintain another static template or choose another path.

The caller chooses only facts the controller cannot infer: units, allowed files, repository-native commands, correction owner, correction budget, and Ship authorization. For Red, choose the sealed literal later from returned calibration evidence. For a fail-closed gate, omit `owner` and choose `blocked` or `triage`.

## Runtime interface

Run the start command returned by the hook; it binds the current task, so omit `--run-id`. Then use `next` and `report`. Execute only the returned directive payload and echo its `report_result` and requested evidence into `report`. Terminal directives need no report.

Preserve controller protocol, classification, evidence, and terminal status rather than reconstructing them in prose.
