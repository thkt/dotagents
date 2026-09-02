/** @file Outcome: Controller and hook integration enforces every declared transition, scope, and correction boundary. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { executeAction, type CommandInvocation } from '../../flow/build/actions.ts';
import * as flow from '../../flow/controller.ts';
import { validateManifest } from '../../flow/manifest.ts';
import { buildShipApprovalPath } from '../../shared/storage.ts';

import {
  enableShipping,
  fixture,
  passBuildReview,
  requireGate,
  startFlow,
} from './controller-fixture.ts';

test('advances only through the declared actor and deterministic gates', () => {
  const { manifestFile } = fixture();
  const turn = 'turn-success';
  assert.equal(startFlow(turn, manifestFile).current_step?.id, 'baseline:test');
  const beforeNext = fs.readFileSync(flow.statePath(turn), 'utf8');
  const baselineDirective = flow.currentDirective(turn);
  assert.equal(baselineDirective.kind, 'run-gate');
  assert.equal(
    fs.readFileSync(flow.statePath(turn), 'utf8'),
    beforeNext,
    'current directive must be read-only',
  );
  assert.equal(
    flow.completeCurrentDirective(turn, 'baseline:test').result.current_step?.id,
    'U-001:direct',
  );
  const actorDirective = flow.currentDirective(turn);
  assert.equal(actorDirective.kind, 'run-actor');
  assert.equal(actorDirective.kind === 'run-actor' && actorDirective.correction, null);
  assert.equal(
    actorDirective.kind === 'run-actor' && actorDirective.outcome,
    'The fixture behavior is implemented.',
  );
  assert.deepEqual(actorDirective.kind === 'run-actor' && actorDirective.verification, {
    command: 'git status --porcelain',
    expect: 'pass',
  });
  assert.throws(
    () => flow.completeCurrentDirective(turn, 'U-001:direct:gate'),
    /expected completion for U-001:direct/,
  );
  assert.equal(
    flow.completeCurrentDirective(turn, 'U-001:direct').result.current_step?.id,
    'U-001:direct:gate',
  );
  assert.equal(
    flow.completeCurrentDirective(turn, 'U-001:direct:gate').result.current_step?.id,
    'final:test',
  );
  const final = flow.completeCurrentDirective(turn, 'final:test');
  assert.equal(final.exitCode, 0);
  assert.equal(final.result.status, 'completed');
  assert.equal(flow.currentDirective(turn).kind, 'done');
});

test('rejects an obsolete manifest and requires regeneration from the current contract', () => {
  const { manifest } = fixture();
  assert.throws(
    () => validateManifest({ ...manifest, protocol: 'codex-flow-manifest/v5' }),
    /obsolete contract; regenerate it from the current codex-flow describe output/u,
  );
});

test('rejects obsolete workflow state instead of migrating an active run', () => {
  const { manifestFile } = fixture();
  const turn = 'turn-obsolete-state';
  startFlow(turn, manifestFile);
  const stateFile = flow.statePath(turn);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, protocol: 'codex-flow-state/v9' }));

  assert.throws(
    () => flow.currentDirective(turn),
    /obsolete contract; start a new workflow from current inputs/u,
  );
});

test('routes a failed gate to its owner and blocks after correction budget', () => {
  const { manifestFile } = fixture({ failingUnitGate: true });
  const turn = 'turn-failure';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  flow.completeCurrentDirective(turn, 'U-001:direct');
  const first = flow.completeCurrentDirective(turn, 'U-001:direct:gate');
  assert.equal(first.exitCode, 1);
  assert.equal(first.result.current_step?.id, 'U-001:direct');
  assert.equal(first.result.correction_counts['U-001:direct:gate'], 1);
  const correction = flow.currentDirective(turn);
  assert.equal(correction.kind, 'run-actor');
  if (correction.kind !== 'run-actor' || !correction.correction) {
    throw new Error('expected correction actor');
  }
  assert.equal(correction.correction.attempt, 1);
  assert.equal(correction.correction.max_attempts, 1);
  assert.equal(correction.correction.gate.gate_id, 'U-001:direct:gate');
  assert.equal(correction.correction.gate.classification, 'unexpected_failure');
  flow.completeCurrentDirective(turn, 'U-001:direct');
  const second = flow.completeCurrentDirective(turn, 'U-001:direct:gate');
  assert.equal(second.exitCode, 2);
  assert.equal(second.result.status, 'blocked');
});

test('seals a Red fingerprint only from observed calibration output', () => {
  const { manifest, manifestFile, repo } = fixture();
  fs.writeFileSync(
    path.join(repo, 'red.js'),
    "console.error('not ok T-001 rejects invalid input'); process.exit(1);\n",
  );
  manifest.steps.splice(
    1,
    2,
    { id: 'U-001:red', kind: 'actor', outcome: 'Invalid input is rejected.', files: ['test.js'] },
    {
      id: 'U-001:red:gate',
      kind: 'gate',
      owner: 'U-001:red',
      gate: { command: 'node red.js', expect: 'fail', failure_route: 'red:U-001', calibrate: true },
    },
    { id: 'U-001:green', kind: 'actor', outcome: 'Invalid input is rejected.', files: ['src.js'] },
    {
      id: 'U-001:green:gate',
      kind: 'gate',
      owner: 'U-001:green',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'green:U-001' },
    },
  );
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-calibrate';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  flow.completeCurrentDirective(turn, 'U-001:red');
  const calibrationDirective = flow.currentDirective(turn);
  assert.equal(calibrationDirective.kind, 'calibrate-gate');
  const calibrated = flow.completeCurrentDirective(turn, 'U-001:red:gate');
  assert.equal(calibrated.exitCode, 0);
  const sealDirective = flow.currentDirective(turn);
  assert.equal(sealDirective.kind, 'seal-gate');
  if (sealDirective.kind !== 'seal-gate') return;
  assert.deepEqual(sealDirective.calibration.candidates, [
    { id: 'stderr:L1', text: 'not ok T-001 rejects invalid input' },
  ]);
  assert.throws(
    () => flow.completeCurrentDirective(turn, 'U-001:red:gate', 'not present'),
    /not a calibration candidate/u,
  );
  flow.completeCurrentDirective(
    turn,
    'U-001:red:gate',
    sealDirective.calibration.candidates[0]!.id,
  );
  const gated = flow.completeCurrentDirective(turn, 'U-001:red:gate');
  assert.equal(gated.exitCode, 0);
  assert.equal(gated.result.current_step?.id, 'U-001:green');
});

test('returns Red to its owner when calibration has no failure evidence', () => {
  const { manifest, manifestFile, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'red.js'), 'process.exit(1);\n');
  manifest.steps.splice(
    1,
    2,
    { id: 'U-001:red', kind: 'actor', outcome: 'Invalid input is rejected.', files: ['test.js'] },
    {
      id: 'U-001:red:gate',
      kind: 'gate',
      owner: 'U-001:red',
      gate: { command: 'node red.js', expect: 'fail', failure_route: 'red:U-001', calibrate: true },
    },
    { id: 'U-001:green', kind: 'actor', outcome: 'Invalid input is rejected.', files: ['src.js'] },
    {
      id: 'U-001:green:gate',
      kind: 'gate',
      owner: 'U-001:green',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'green:U-001' },
    },
  );
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-calibrate-without-evidence';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  flow.completeCurrentDirective(turn, 'U-001:red');

  const result = flow.completeCurrentDirective(turn, 'U-001:red:gate');

  assert.equal(result.exitCode, 1);
  assert.equal(result.result.current_step?.id, 'U-001:red');
  assert.equal(result.result.last_gate?.classification, 'calibration_missing_calibration_evidence');
});

test('rejects a build manifest that omits required artifact and commit actions', () => {
  const { manifest } = fixture();
  manifest.workflow = 'build';
  assert.throws(() => flow.validateManifest(manifest), /build must start/);
});

test('requires Build Red gates to use runtime calibration instead of manual anchors', () => {
  const { manifest } = fixture({ workflow: 'build' });
  const start = manifest.steps.findIndex((step) => step.id === 'U-001:direct');
  manifest.steps.splice(
    start,
    4,
    {
      id: 'U-001:red',
      kind: 'actor',
      outcome: 'red',
      files: ['src.js'],
    },
    {
      id: 'U-001:red:gate',
      kind: 'gate',
      owner: 'U-001:red',
      gate: {
        command: 'false',
        expect: 'fail',
        require_output: ['FAIL'],
        failure_route: 'red:U-001',
      },
    },
    { id: 'U-001:green', kind: 'actor', outcome: 'green', files: ['src.js'] },
    {
      id: 'U-001:green:gate',
      kind: 'gate',
      owner: 'U-001:green',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'green:U-001' },
    },
    {
      id: 'U-001:artifacts',
      kind: 'gate',
      owner: 'U-001:green',
      gate: {
        authority: 'build-artifacts',
        input: '/tmp/plan.json',
        unit_id: 'U-001',
        failure_route: 'green:U-001',
      },
    },
    { id: 'U-001:commit', kind: 'action', action: 'commit', subject: 'chore: fixture' },
  );
  assert.throws(() => flow.validateManifest(manifest), /calibrated shell failure gate/);
  const redGate = requireGate(manifest, 'U-001:red:gate').gate;
  redGate.calibrate = true;
  redGate.require_output = [];
  assert.doesNotThrow(() => flow.validateManifest(manifest));
});

test('derives an owned gate route from its actor and rejects conflicting input', () => {
  const { manifest } = fixture();
  const gate = requireGate(manifest, 'U-001:direct:gate').gate;
  delete gate.failure_route;
  const normalized = flow.validateManifest(manifest);
  const normalizedGate = normalized.steps.find((step) => step.id === 'U-001:direct:gate');
  assert.equal(
    normalizedGate?.kind === 'gate' && normalizedGate.gate.failure_route,
    'direct:U-001',
  );

  gate.failure_route = 'green:U-001';
  assert.throws(() => flow.validateManifest(manifest), /conflicts with owner/);
});

test('enforces build Branch and commit postconditions before ship-ready', () => {
  const { manifestFile, repo, startPoint } = fixture({ workflow: 'build' });
  const turn = 'turn-build';
  startFlow(turn, manifestFile);
  const loaded = flow.completeCurrentDirective(turn, 'load:plan');
  assert.equal(loaded.result.status, 'running', JSON.stringify(loaded.result.last_gate));
  assert.equal(loaded.result.gate?.evidence.kind, 'structured');
  if (loaded.result.gate?.evidence.kind !== 'structured') return;
  assert.equal('expected' in loaded.result.gate, false);
  assert.equal(loaded.result.gate.evidence.report.protocol, 'codex-build-plan');
  assert.equal(loaded.result.gate_reports.length, 1);
  const revalidated = flow.completeCurrentDirective(turn, 'revalidate:plan');
  assert.equal(revalidated.result.status, 'running', JSON.stringify(revalidated.result.last_gate));
  const branch = flow.currentDirective(turn);
  assert.equal(branch.kind, 'run-action');
  if (branch.kind !== 'run-action' || branch.action !== 'branch')
    throw new Error('expected branch action');
  const branchParameters = branch.parameters;
  assert.equal(branchParameters.branch_name, 'codex/flow-test');
  assert.equal(branchParameters.start_point, startPoint);
  assert.equal(flow.reconcileCurrentAction(turn, 'branch'), false);
  assert.throws(() => flow.completeCurrentDirective(turn, 'branch'), /did not reach/);
  executeAction(repo, branch);
  assert.equal(flow.reconcileCurrentAction(turn, 'branch'), true);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
  flow.completeCurrentDirective(turn, 'U-001:direct');
  flow.completeCurrentDirective(turn, 'U-001:direct:gate');
  flow.completeCurrentDirective(turn, 'U-001:artifacts');
  const commit = flow.currentDirective(turn);
  assert.equal(commit.kind, 'run-action');
  if (commit.kind !== 'run-action' || commit.action !== 'commit')
    throw new Error('expected commit action');
  assert.equal(flow.reconcileCurrentAction(turn, 'U-001:commit'), false);
  executeAction(repo, commit);
  assert.equal(flow.reconcileCurrentAction(turn, 'U-001:commit'), true);
  flow.completeCurrentDirective(turn, 'final:test');
  flow.completeCurrentDirective(turn, 'revalidate:review');
  assert.equal(flow.currentDirective(turn).kind, 'run-review');
  passBuildReview(turn);
  assert.equal(flow.currentDirective(turn).kind, 'ship-ready');
});

test('a shipping build cannot start without its explicit invocation approval', () => {
  const { manifest, manifestFile } = fixture({ workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const runId = 'turn-build-ship-missing-approval';

  assert.throws(
    () =>
      startFlow(runId, manifestFile, () => {
        fs.unlinkSync(buildShipApprovalPath(runId));
      }),
    /explicit \$build Ship approval is required/,
  );
});

test('Ship directive owns its PR input, render path, and external targets', () => {
  const { manifest, manifestFile, repo, startPoint } = fixture({ workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-ship-contract';
  startFlow(turn, manifestFile, undefined, [
    { name: 'fixture.png', alt: 'Rendered fixture value' },
  ]);
  assert.equal(fs.existsSync(buildShipApprovalPath(turn)), false);
  const loaded = flow.completeCurrentDirective(turn, 'load:plan');
  assert.equal(loaded.result.status, 'running', JSON.stringify(loaded.result.last_gate));
  const revalidated = flow.completeCurrentDirective(turn, 'revalidate:plan');
  assert.equal(revalidated.result.status, 'running', JSON.stringify(revalidated.result.last_gate));
  spawnSync('git', ['-C', repo, 'switch', '-q', '-c', 'codex/flow-test', startPoint]);
  flow.completeCurrentDirective(turn, 'branch');
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
  const implementation = flow.currentDirective(turn);
  assert.equal(implementation.kind, 'run-actor');
  if (implementation.kind !== 'run-actor') throw new Error('expected implementation actor');
  assert.equal(implementation.screenshots?.length, 1);
  fs.mkdirSync(path.dirname(implementation.screenshots![0]!.path), { recursive: true });
  const screenshotBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  fs.writeFileSync(implementation.screenshots![0]!.path, screenshotBytes);
  flow.completeCurrentDirective(turn, 'U-001:direct');
  flow.completeCurrentDirective(turn, 'U-001:direct:gate');
  flow.completeCurrentDirective(turn, 'U-001:artifacts');
  spawnSync('git', ['-C', repo, 'add', 'src.js']);
  spawnSync('git', [
    '-C',
    repo,
    'commit',
    '-qm',
    'chore: update fixture',
    '--trailer',
    'Unit: U-001',
    '--trailer',
    'Contract: preserve fixture contract',
    '--trailer',
    'Issue: #42',
  ]);
  flow.completeCurrentDirective(turn, 'U-001:commit');
  const state = flow.loadWorkflowState(turn).state;
  const staleFinalFailure = structuredClone(state.gate_reports.at(-1)!);
  staleFinalFailure.gate_id = 'final:test';
  staleFinalFailure.verdict = 'fail';
  staleFinalFailure.classification = 'unexpected_exit';
  staleFinalFailure.failure_route = 'blocked';
  state.gate_reports.push(staleFinalFailure);
  fs.writeFileSync(flow.statePath(turn), JSON.stringify(state));
  flow.completeCurrentDirective(turn, 'final:test');
  passBuildReview(turn);
  const shipRevalidation = flow.completeCurrentDirective(turn, 'revalidate:ship');
  assert.equal(shipRevalidation.result.gate?.verdict, 'pass');

  const directive = flow.currentDirective(turn);
  assert.equal(directive.kind, 'run-action');
  if (directive.kind !== 'run-action' || directive.action !== 'ship')
    throw new Error('expected Ship action');
  const parameters = directive.parameters;
  const payload = JSON.parse(fs.readFileSync(parameters.pr_input_path, 'utf8'));
  assert.equal(payload.issue, 42);
  assert.equal(payload.gates_pass, true);
  assert.equal(payload.language, 'japanese');
  assert.deepEqual(payload.manual_checks, ['Open the fixture and observe the rendered value.']);
  assert.deepEqual(payload.screenshots, [{ name: 'fixture.png', alt: 'Rendered fixture value' }]);
  assert.equal(fs.existsSync(parameters.pr_body_path), false);

  const invocations: CommandInvocation[] = [];
  fs.appendFileSync(implementation.screenshots![0]!.path, 'changed');
  assert.throws(
    () => executeAction(repo, directive, (invocation) => invocations.push(invocation)),
    /required screenshot changed after actor completion/u,
  );
  assert.equal(invocations.length, 0);
  fs.writeFileSync(implementation.screenshots![0]!.path, screenshotBytes);
  executeAction(repo, directive, (invocation) => invocations.push(invocation));
  assert.equal(fs.existsSync(parameters.pr_body_path), true);
  assert.deepEqual(
    invocations.map(({ executable }) => executable),
    ['git', 'gh'],
  );
  assert.deepEqual(invocations[1]?.args.slice(0, 6), [
    'pr',
    'create',
    '--draft',
    '--repo',
    'owner/project',
    '--head',
  ]);
  assert.deepEqual(invocations[1]?.args.slice(-2), [
    '--attach',
    `${implementation.screenshots![0]!.path}#Rendered fixture value`,
  ]);
  assert.equal(invocations[1]?.args[invocations[1]!.args.indexOf('--title') + 1], 'フィクスチャ');
});

test('blocks a gate that mutates Git state', () => {
  const { manifest, manifestFile, repo } = fixture();
  fs.writeFileSync(
    path.join(repo, 'mutate.js'),
    "require('fs').writeFileSync('created.js', 'x');\n",
  );
  requireGate(manifest, 'baseline:test').gate.command = 'node mutate.js';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-mutating-gate';
  startFlow(turn, manifestFile);
  const result = flow.completeCurrentDirective(turn, 'baseline:test');
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.gate?.classification, 'gate_attempted_repository_mutation');
  assert.equal(flow.currentDirective(turn).kind, 'blocked');
  assert.equal(fs.existsSync(path.join(repo, 'created.js')), false);
});

test('blocks a gate that mutates an ignored repository path', () => {
  const { manifest, manifestFile, repo } = fixture();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  fs.writeFileSync(
    path.join(repo, 'mutate-ignored.js'),
    "require('fs').mkdirSync('cache', { recursive: true }); require('fs').writeFileSync('cache/result', 'x');\n",
  );
  requireGate(manifest, 'baseline:test').gate.command = 'node mutate-ignored.js';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-mutating-ignored-gate';
  startFlow(turn, manifestFile);
  const result = flow.completeCurrentDirective(turn, 'baseline:test');
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.gate?.classification, 'gate_attempted_repository_mutation');
  assert.equal(flow.currentDirective(turn).kind, 'blocked');
});

test('blocks a gate that mutates Git metadata without changing HEAD', () => {
  const { manifest, manifestFile } = fixture();
  requireGate(manifest, 'baseline:test').gate.command = 'git branch unexpected';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-mutating-git-metadata';
  startFlow(turn, manifestFile);
  const result = flow.completeCurrentDirective(turn, 'baseline:test');
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.gate?.classification, 'gate_attempted_repository_mutation');
});

test('controller rejects edits outside an SDK actor scope', () => {
  const { manifestFile, repo } = fixture();
  const turn = 'turn-scope';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'outside.js'), 'outside\n');
  assert.throws(
    () => flow.completeCurrentDirective(turn, 'U-001:direct'),
    /outside its declared scope: outside\.js/,
  );
});

test('controller rejects commits made inside an SDK actor boundary', () => {
  const { manifestFile, repo } = fixture();
  const turn = 'turn-actor-commit';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'src.js'), 'committed by actor\n');
  spawnSync('git', ['-C', repo, 'add', 'src.js']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'actor commit']);
  assert.throws(
    () => flow.completeCurrentDirective(turn, 'U-001:direct'),
    /changed repository control state: HEAD, Git metadata/,
  );
});

test('controller allows source ignored-file drift inside an SDK actor boundary', () => {
  const { manifestFile, repo } = fixture();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  spawnSync('git', ['-C', repo, 'add', '.gitignore']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'ignore cache']);
  const turn = 'turn-actor-ignored';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.mkdirSync(path.join(repo, 'cache'));
  fs.writeFileSync(path.join(repo, 'cache', 'value'), 'actor cache\n');
  assert.equal(
    flow.completeCurrentDirective(turn, 'U-001:direct').result.current_step?.id,
    'U-001:direct:gate',
  );
});

test('preserves unrelated dirty files that predate actor entry', () => {
  const { manifestFile, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user change\n');
  const turn = 'turn-dirty-baseline';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'src.js'), 'allowed\n');
  assert.equal(
    flow.completeCurrentDirective(turn, 'U-001:direct').result.current_step?.id,
    'U-001:direct:gate',
  );
  assert.equal(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'user change\n');
});

test('detects modification of a dirty file that predates actor entry', () => {
  const { manifestFile, repo } = fixture();
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user change\n');
  const turn = 'turn-dirty-fingerprint';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'actor changed it\n');
  assert.throws(
    () => flow.completeCurrentDirective(turn, 'U-001:direct'),
    /outside its declared scope: unrelated\.txt/,
  );
});

test('self-describes the manifest contract without workflow state', () => {
  const code = flow.describe('code');
  assert.equal(code.protocol, 'codex-flow-description');
  assert.equal(code.manifest_template.protocol, 'codex-flow-manifest');
  assert.deepEqual(code.cli, {
    describe: 'codex-flow describe --workflow code',
    run: 'codex-flow run --manifest <absolute-json>',
    cancel: 'codex-flow cancel --manifest <hook-supplied-json>',
    task_binding: 'hook-injected',
  });
  assert.equal(code.defaults.gate_timeout_ms, 60_000);
  assert.deepEqual(code.sequence.unit_modes.direct, ['U-NNN:direct', 'U-NNN:direct:gate']);
  assert.equal(
    code.step_contracts.some((contract) => contract.kind === 'action'),
    false,
  );
  const build = flow.describe('build');
  assert.equal(code.inputs, undefined);
  assert.equal(build.inputs?.source.template.protocol, 'codex-build-source');
  assert.equal(build.inputs?.source.template.repository, 'owner/name');
  assert.equal(build.inputs?.source.template.issue_number, 123);
  assert.equal(
    build.step_contracts.some((contract) => contract.kind === 'action'),
    true,
  );
  assert.deepEqual(build.sequence.opening.slice(0, 3), ['load:plan', 'revalidate:plan', 'branch']);
  const gateContract = build.step_contracts.find((contract) => contract.kind === 'gate');
  assert.deepEqual(gateContract?.conditional_required?.['build-artifacts'], [
    'gate.input',
    'gate.unit_id',
  ]);
  assert.deepEqual(gateContract?.conditional_optional?.shell, [
    'gate.calibrate',
    'gate.timeout_ms',
    'gate.require_output',
    'gate.forbid_output',
  ]);
  assert.deepEqual(gateContract?.conditional_optional?.['build-plan'], []);
  const actionContract = build.step_contracts.find((contract) => contract.kind === 'action');
  assert.deepEqual(actionContract?.conditional_required?.ship, [
    'remote',
    'repository',
    'base_branch',
  ]);
});
