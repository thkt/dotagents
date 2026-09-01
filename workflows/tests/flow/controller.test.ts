/** @file Outcome: Controller and hook integration enforces every declared transition, scope, and correction boundary. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as hook from '../../../hooks/workflow-enforcer.ts';
import { executeAction, type CommandInvocation } from '../../flow/build/actions.ts';
import { renderPlanMarkdown, type BuildPlanAuthoring } from '../../flow/build/authoring.ts';
import { BUILD_SOURCE_PROTOCOL } from '../../flow/build/handoff.ts';
import { runStructuredBuildGate } from '../../flow/build/gates.ts';
import { parsePublicIssueBody, renderPublicIssueBody } from '../../issue/public-contract.ts';
import * as flow from '../../flow/controller.ts';
import { main as flowMain } from '../../flow/runner.ts';
import * as intent from '../../invocation.ts';
import { buildShipApprovalPath, intentPath, workflowInputPath } from '../../shared/storage.ts';
import type {
  ActionStep,
  ActorStep,
  FlowManifest,
  GateAuthority,
  GateExpectation,
  PublicState,
  Workflow,
} from '../../flow/contracts.ts';

const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOOKS_CONFIG = path.resolve(AGENTS_ROOT, 'hooks/hooks.json');

interface FixtureGateStep {
  id: string;
  kind: 'gate';
  owner?: string;
  gate: {
    authority?: GateAuthority;
    command?: string;
    input?: string;
    unit_id?: string;
    expect?: GateExpectation;
    calibrate?: boolean;
    timeout_ms?: number;
    failure_route?: string;
    require_output?: string[];
    forbid_output?: string[];
  };
}

type FixtureStep = ActorStep | ActionStep | FixtureGateStep;

interface FixtureManifest {
  protocol: typeof flow.MANIFEST_PROTOCOL;
  workflow: Workflow;
  repo: string;
  max_corrections: number;
  shipping_authorized?: boolean;
  steps: FixtureStep[];
}

function fixture(
  t: TestContext,
  {
    failingUnitGate = false,
    workflow = 'code',
  }: { failingUnitGate?: boolean; workflow?: 'code' | 'build' } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-test-'));
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const issueFile = path.join(root, 'github-issue.json');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\nexec /bin/cat '${issueFile}'\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ''}`;
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'flow@example.test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Flow Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/project.git'], {
    encoding: 'utf8',
  });
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repo, 'add', 'README.md'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture'], { encoding: 'utf8' });
  const startPoint = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const steps: FixtureStep[] = [
    {
      id: 'baseline:test',
      kind: 'gate',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
    },
    {
      id: 'U-001:direct',
      kind: 'actor',
      outcome: 'The fixture behavior is implemented.',
      files: ['src.js'],
    },
    {
      id: 'U-001:direct:gate',
      kind: 'gate',
      owner: 'U-001:direct',
      gate: {
        command: failingUnitGate ? 'false' : 'git status --porcelain',
        expect: 'pass',
        failure_route: 'direct:U-001',
      },
    },
    {
      id: 'final:test',
      kind: 'gate',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'triage' },
    },
  ];
  if (workflow === 'build') {
    steps.splice(
      0,
      steps.length,
      {
        id: 'load:plan',
        kind: 'gate',
        gate: {
          authority: 'build-plan',
          input: path.join(root, 'plan.json'),
          failure_route: 'blocked',
        },
      },
      {
        id: 'revalidate:plan',
        kind: 'gate',
        gate: {
          authority: 'build-revalidate',
          input: path.join(root, 'plan.json'),
          failure_route: 'blocked',
        },
      },
      {
        id: 'branch',
        kind: 'action',
        action: 'branch',
        branch_name: 'codex/flow-test',
        start_point: startPoint,
      },
      {
        id: 'branch:verify',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'baseline:test',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'U-001:direct',
        kind: 'actor',
        outcome: 'The fixture behavior is implemented.',
        files: ['src.js'],
      },
      {
        id: 'U-001:direct:gate',
        kind: 'gate',
        owner: 'U-001:direct',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'direct:U-001' },
      },
      {
        id: 'U-001:artifacts',
        kind: 'gate',
        owner: 'U-001:direct',
        gate: {
          authority: 'build-artifacts',
          input: path.join(root, 'plan.json'),
          unit_id: 'U-001',
          failure_route: 'direct:U-001',
        },
      },
      { id: 'U-001:commit', kind: 'action', action: 'commit', subject: 'chore: update fixture' },
      {
        id: 'U-001:commit:verify',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'final:test',
        kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'triage' },
      },
    );
  }
  const manifest: FixtureManifest = {
    protocol: flow.MANIFEST_PROTOCOL,
    workflow,
    repo,
    max_corrections: 1,
    steps,
  };
  const manifestFile = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const previous = process.env.CODEX_FLOW_STATE_DIR;
  process.env.CODEX_FLOW_STATE_DIR = state;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previous === undefined) delete process.env.CODEX_FLOW_STATE_DIR;
    else process.env.CODEX_FLOW_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manifest, manifestFile, repo, startPoint };
}

function requireGate(manifest: FixtureManifest, id: string): FixtureGateStep {
  const step = manifest.steps.find(
    (candidate): candidate is FixtureGateStep => candidate.kind === 'gate' && candidate.id === id,
  );
  if (!step) throw new Error(`missing gate fixture: ${id}`);
  return step;
}

function requireActor(manifest: FixtureManifest): ActorStep {
  const step = manifest.steps.find(
    (candidate): candidate is ActorStep => candidate.kind === 'actor',
  );
  if (!step) throw new Error('missing actor fixture');
  return step;
}

function enableShipping(manifest: FixtureManifest): void {
  manifest.shipping_authorized = true;
  manifest.steps.push(
    {
      id: 'revalidate:ship',
      kind: 'gate',
      gate: {
        authority: 'build-revalidate',
        input: '/hook-supplied-build-source.json',
        failure_route: 'blocked',
      },
    },
    {
      id: 'ship',
      kind: 'action',
      action: 'ship',
      remote: 'origin',
      repository: 'owner/project',
      base_branch: 'main',
    },
    {
      id: 'ship:verify',
      kind: 'gate',
      gate: { authority: 'build-ship', failure_route: 'blocked' },
    },
  );
}

function startFlow(runId: string, manifestFile: string, beforeStart?: () => void): PublicState {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as FlowManifest;
  const pending = intent.armIntent({
    runId,
    workflow: manifest.workflow,
    cwd: manifest.repo,
  });
  if (manifest.workflow === 'build') {
    if (!pending.build_source_path) throw new Error('missing fixture build source path');
    fs.mkdirSync(path.dirname(pending.build_source_path), { recursive: true });
    const plan: BuildPlanAuthoring = {
      outcome: 'fixture outcome',
      root_cause: null,
      test_command: 'node --test',
      reference_module: {
        kind: 'no-module',
        reason: 'fixture has no reference module',
        path: null,
        files: [],
        instances: 0,
        conventions: [],
      },
      preconditions: [],
      backlog_candidates: [],
      rules: [],
      manual_verification: ['Open the fixture and observe the rendered value.'],
      units: [
        {
          id: 'U-001',
          goal: 'fixture unit',
          files: ['src.js'],
          contract: 'preserve fixture contract',
          tests: [],
          seam: false,
        },
      ],
    };
    const body = renderPublicIssueBody(renderPlanMarkdown(plan), plan, 'english');
    const issueFile = path.join(path.dirname(manifest.repo), 'github-issue.json');
    fs.writeFileSync(
      issueFile,
      JSON.stringify({
        number: 42,
        title: 'フィクスチャ',
        body,
        url: 'https://github.com/owner/project/issues/42',
        labels: [],
      }),
    );
    fs.writeFileSync(
      pending.build_source_path,
      JSON.stringify({
        protocol: BUILD_SOURCE_PROTOCOL,
        repository: 'owner/project',
        issue_number: 42,
      }),
    );
    for (const step of manifest.steps) {
      if (
        step.kind === 'gate' &&
        (step.gate.authority === 'build-plan' ||
          step.gate.authority === 'build-revalidate' ||
          step.gate.authority === 'build-artifacts')
      ) {
        step.gate.input = pending.build_source_path;
      }
    }
    fs.writeFileSync(pending.input_path, JSON.stringify(manifest));
    beforeStart?.();
    return flow.startWorkflow(runId, pending.input_path);
  } else {
    fs.copyFileSync(manifestFile, pending.input_path);
  }
  beforeStart?.();
  return flow.startWorkflow(runId, pending.input_path);
}

test('advances only through the declared actor and deterministic gates', (t) => {
  const { manifestFile } = fixture(t);
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

test('routes a failed gate to its owner and blocks after correction budget', (t) => {
  const { manifestFile } = fixture(t, { failingUnitGate: true });
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

test('seals a Red fingerprint only from observed calibration output', (t) => {
  const { manifest, manifestFile, repo } = fixture(t);
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

test('returns Red to its owner when calibration has no failure evidence', (t) => {
  const { manifest, manifestFile, repo } = fixture(t);
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

test('rejects a build manifest that omits required artifact and commit gates', (t) => {
  const { manifest } = fixture(t);
  manifest.workflow = 'build';
  assert.throws(() => flow.validateManifest(manifest), /build must start/);
});

test('requires Build Red gates to use runtime calibration instead of manual anchors', (t) => {
  const { manifest } = fixture(t, { workflow: 'build' });
  const start = manifest.steps.findIndex((step) => step.id === 'U-001:direct');
  manifest.steps.splice(
    start,
    5,
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
    {
      id: 'U-001:commit:verify',
      kind: 'gate',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
    },
  );
  assert.throws(() => flow.validateManifest(manifest), /calibrated shell failure gate/);
  const redGate = requireGate(manifest, 'U-001:red:gate').gate;
  redGate.calibrate = true;
  redGate.require_output = [];
  assert.doesNotThrow(() => flow.validateManifest(manifest));
});

test('derives an owned gate route from its actor and rejects conflicting input', (t) => {
  const { manifest } = fixture(t);
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

test('enforces build Branch and commit postconditions before ship-ready', (t) => {
  const { manifestFile, repo, startPoint } = fixture(t, { workflow: 'build' });
  const turn = 'turn-build';
  startFlow(turn, manifestFile);
  const loaded = flow.completeCurrentDirective(turn, 'load:plan');
  assert.equal(loaded.result.status, 'running', JSON.stringify(loaded.result.last_gate));
  assert.equal(loaded.result.gate?.evidence.kind, 'structured');
  if (loaded.result.gate?.evidence.kind !== 'structured') return;
  assert.equal('expected' in loaded.result.gate, false);
  assert.equal(loaded.result.gate.evidence.report.protocol, 'codex-build-plan/v3');
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
  assert.throws(() => flow.completeCurrentDirective(turn, 'branch'), /did not reach/);
  executeAction(repo, branch);
  flow.completeCurrentDirective(turn, 'branch');
  flow.completeCurrentDirective(turn, 'branch:verify');
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
  flow.completeCurrentDirective(turn, 'U-001:direct');
  flow.completeCurrentDirective(turn, 'U-001:direct:gate');
  flow.completeCurrentDirective(turn, 'U-001:artifacts');
  const commit = flow.currentDirective(turn);
  assert.equal(commit.kind, 'run-action');
  if (commit.kind !== 'run-action' || commit.action !== 'commit')
    throw new Error('expected commit action');
  executeAction(repo, commit);
  flow.completeCurrentDirective(turn, 'U-001:commit');
  flow.completeCurrentDirective(turn, 'U-001:commit:verify');
  flow.completeCurrentDirective(turn, 'final:test');
  assert.equal(flow.currentDirective(turn).kind, 'ship-ready');
});

test('a shipping build cannot start without its explicit invocation approval', (t) => {
  const { manifest, manifestFile } = fixture(t, { workflow: 'build' });
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

test('Ship directive owns its PR input, render path, and external targets', (t) => {
  const { manifest, manifestFile, repo, startPoint } = fixture(t, { workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-ship-contract';
  startFlow(turn, manifestFile);
  assert.equal(fs.existsSync(buildShipApprovalPath(turn)), false);
  const loaded = flow.completeCurrentDirective(turn, 'load:plan');
  assert.equal(loaded.result.status, 'running', JSON.stringify(loaded.result.last_gate));
  const revalidated = flow.completeCurrentDirective(turn, 'revalidate:plan');
  assert.equal(revalidated.result.status, 'running', JSON.stringify(revalidated.result.last_gate));
  spawnSync('git', ['-C', repo, 'switch', '-q', '-c', 'codex/flow-test', startPoint]);
  flow.completeCurrentDirective(turn, 'branch');
  flow.completeCurrentDirective(turn, 'branch:verify');
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
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
  flow.completeCurrentDirective(turn, 'U-001:commit:verify');
  const state = flow.loadWorkflowState(turn).state;
  const staleFinalFailure = structuredClone(state.gate_reports.at(-1)!);
  staleFinalFailure.gate_id = 'final:test';
  staleFinalFailure.verdict = 'fail';
  staleFinalFailure.classification = 'unexpected_exit';
  staleFinalFailure.failure_route = 'blocked';
  state.gate_reports.push(staleFinalFailure);
  fs.writeFileSync(flow.statePath(turn), JSON.stringify(state));
  flow.completeCurrentDirective(turn, 'final:test');
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
  assert.equal(fs.existsSync(parameters.pr_body_path), false);

  const invocations: CommandInvocation[] = [];
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
  assert.equal(invocations[1]?.args[invocations[1]!.args.indexOf('--title') + 1], 'フィクスチャ');
});

test('blocks a gate that mutates Git state', (t) => {
  const { manifest, manifestFile, repo } = fixture(t);
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

test('blocks a gate that mutates an ignored repository path', (t) => {
  const { manifest, manifestFile, repo } = fixture(t);
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

test('blocks a gate that mutates Git metadata without changing HEAD', (t) => {
  const { manifest, manifestFile } = fixture(t);
  requireGate(manifest, 'baseline:test').gate.command = 'git branch unexpected';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-mutating-git-metadata';
  startFlow(turn, manifestFile);
  const result = flow.completeCurrentDirective(turn, 'baseline:test');
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.gate?.classification, 'gate_attempted_repository_mutation');
});

test('controller rejects edits outside an SDK actor scope', (t) => {
  const { manifestFile, repo } = fixture(t);
  const turn = 'turn-scope';
  startFlow(turn, manifestFile);
  flow.completeCurrentDirective(turn, 'baseline:test');
  fs.writeFileSync(path.join(repo, 'outside.js'), 'outside\n');
  assert.throws(
    () => flow.completeCurrentDirective(turn, 'U-001:direct'),
    /outside its declared scope: outside\.js/,
  );
});

test('controller rejects commits made inside an SDK actor boundary', (t) => {
  const { manifestFile, repo } = fixture(t);
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

test('controller allows source ignored-file drift inside an SDK actor boundary', (t) => {
  const { manifestFile, repo } = fixture(t);
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

test('preserves unrelated dirty files that predate actor entry', (t) => {
  const { manifestFile, repo } = fixture(t);
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

test('detects modification of a dirty file that predates actor entry', (t) => {
  const { manifestFile, repo } = fixture(t);
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
  assert.equal(code.protocol, flow.DESCRIPTION_PROTOCOL);
  assert.equal(code.manifest_template.protocol, flow.MANIFEST_PROTOCOL);
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
  assert.equal(build.inputs?.source.template.protocol, BUILD_SOURCE_PROTOCOL);
  assert.equal(build.inputs?.source.template.repository, 'owner/name');
  assert.equal(build.inputs?.source.template.issue_number, 123);
  assert.equal(
    build.step_contracts.some((contract) => contract.kind === 'action'),
    true,
  );
  assert.deepEqual(build.sequence.opening.slice(0, 4), [
    'load:plan',
    'revalidate:plan',
    'branch',
    'branch:verify',
  ]);
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

test('starts only from the manifest armed by an explicit workflow invocation', (t) => {
  const { manifestFile, repo } = fixture(t);
  const turn = 'turn-explicit-start';
  assert.throws(
    () => flow.startWorkflow(turn, manifestFile),
    /explicit \$code invocation is required/,
  );

  const pending = intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });
  assert.equal(pending.repo, fs.realpathSync(repo));
  assert.equal(intent.loadIntent(turn)?.input_path, pending.input_path);
  const storedIntent = JSON.parse(fs.readFileSync(intentPath(turn), 'utf8'));
  assert.deepEqual(Object.keys(storedIntent).sort(), ['protocol', 'repo', 'run_id', 'workflow']);
  assert.throws(
    () => flow.startWorkflow(turn, manifestFile),
    /manifest path supplied by the workflow hook/,
  );

  fs.copyFileSync(manifestFile, pending.input_path);
  assert.equal(flow.startWorkflow(turn, pending.input_path).status, 'running');
  assert.equal(intent.loadIntent(turn), null);
});

test('UserPromptSubmit arms only a leading explicit workflow invocation', (t) => {
  const { repo } = fixture(t);
  const natural = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-natural',
    cwd: repo,
    prompt: 'Please use $build when it is appropriate.',
  });
  assert.deepEqual(natural, {});
  assert.equal(intent.loadIntent('turn-natural'), null);

  const explicit = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-explicit-hook',
    cwd: repo,
    prompt: '$build #123',
  });
  const pending = intent.loadIntent('turn-explicit-hook');
  assert.equal(pending?.workflow, 'build');
  assert.equal(explicit.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(explicit.hookSpecificOutput?.additionalContext || '', /codex-flow run/);
  assert.match(
    explicit.hookSpecificOutput?.additionalContext || '',
    new RegExp(pending!.input_path),
  );
});

test('UserPromptSubmit accepts a leading Codex skill link as an explicit invocation', (t) => {
  const { repo } = fixture(t);
  const linked = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-linked-hook',
    cwd: repo,
    prompt: '[$code](/Users/example/.agents/skills/code/SKILL.md) workflow smoke test',
  });
  const pending = intent.loadIntent('turn-linked-hook');
  assert.equal(pending?.workflow, 'code');
  assert.equal(linked.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(linked.hookSpecificOutput?.additionalContext || '', /codex-flow run/);

  const embedded = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-embedded-link',
    cwd: repo,
    prompt: 'Please use [$code](/Users/example/.agents/skills/code/SKILL.md) when appropriate.',
  });
  assert.deepEqual(embedded, {});
  assert.equal(intent.loadIntent('turn-embedded-link'), null);
});

test('explicit issue invocation communicates its single-publication authorization', (t) => {
  const { repo } = fixture(t);
  const response = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-explicit-issue',
    cwd: repo,
    prompt: '$issue publish the reviewed plan',
  });

  assert.match(
    response.hookSpecificOutput?.additionalContext || '',
    /authorizes exactly one GitHub Issue create or edit/,
  );
  assert.match(
    response.hookSpecificOutput?.additionalContext || '',
    /no additional publication confirmation/,
  );
});

test('explicit build invocation communicates and records its single-Ship authorization', (t) => {
  const { repo } = fixture(t);
  const runId = 'turn-explicit-build-ship';
  const response = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: runId,
    cwd: repo,
    prompt: '$build implement the published issue',
  });

  assert.match(
    response.hookSpecificOutput?.additionalContext || '',
    /authorizes exactly one push and one draft PR creation/,
  );
  assert.match(response.hookSpecificOutput?.additionalContext || '', /include Ship unless/);
  assert.match(response.hookSpecificOutput?.additionalContext || '', /do not request another/);
  assert.equal(fs.existsSync(buildShipApprovalPath(runId)), true);
});

test('build Ship approval is task- and repository-bound', (t) => {
  const { repo } = fixture(t);
  const runId = 'turn-build-ship-approval-binding';
  intent.armIntent({ runId, workflow: 'build', cwd: repo });
  assert.doesNotThrow(() => intent.requireBuildShipApproval(runId, repo));

  const file = buildShipApprovalPath(runId);
  const approval = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...approval, repo: path.dirname(repo) }));
  assert.throws(
    () => intent.requireBuildShipApproval(runId, repo),
    /build Ship approval has an invalid shape/,
  );
});

test('pending intent permits workflow input preparation and blocks unrelated mutation', (t) => {
  const { repo } = fixture(t);
  const turn = 'turn-pending-policy';
  const pending = intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });

  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'rg --files' },
    }),
    {},
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'apply_patch',
      cwd: repo,
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${pending.input_path}\n*** End Patch`,
      },
    }),
    {},
  );
  assert.equal(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'apply_patch',
      cwd: repo,
      tool_input: { command: '*** Begin Patch\n*** Add File: src.js\n*** End Patch' },
    }).hookSpecificOutput?.permissionDecision,
    'deny',
  );
  assert.equal(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'touch src.js' },
    }).hookSpecificOutput?.permissionDecision,
    'deny',
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'codex-flow describe --workflow code' },
    }),
    {},
  );

  const start = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow run --manifest ${pending.input_path}` },
  });
  assert.equal(start.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(
    start.hookSpecificOutput?.updatedInput?.command,
    `codex-flow run --manifest ${pending.input_path} --run-id '${turn}'`,
  );
  assert.equal(hook.stop({ session_id: turn, stop_hook_active: false }).decision, 'block');
  const secondStop = hook.stop({ session_id: turn, stop_hook_active: true });
  assert.equal(secondStop.continue, false);
  assert.equal(secondStop.decision, undefined);
  assert.equal(intent.loadIntent(turn), null);
});

test('pending build permits only its published source and manifest files', (t) => {
  const { repo } = fixture(t);
  const turn = 'turn-pending-build-policy';
  const pending = intent.armIntent({ runId: turn, workflow: 'build', cwd: repo });
  if (!pending.build_source_path) throw new Error('missing build source path');
  assert.equal(fs.statSync(path.dirname(pending.build_source_path)).isDirectory(), true);
  for (const command of ['codex-flow describe --workflow build']) {
    assert.deepEqual(
      hook.preToolUse({
        hook_event_name: 'PreToolUse',
        session_id: turn,
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command },
      }),
      {},
      command,
    );
  }
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Write',
      cwd: repo,
      tool_input: { file_path: pending.build_source_path },
    }),
    {},
  );
  for (const command of [
    'codex-build-plan describe',
    'codex-build-revalidate describe',
    'codex-build-artifacts describe',
    'codex-build-pr-body describe',
    'gh issue view 42 --repo owner/project --json number,title,body',
    'gh issue edit 42 --title changed',
    'gh issue view 42 --web',
    'gh issue view branch --repo owner/project',
  ]) {
    assert.equal(
      hook.preToolUse({
        hook_event_name: 'PreToolUse',
        session_id: turn,
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command },
      }).hookSpecificOutput?.permissionDecision,
      'deny',
      command,
    );
  }
});

test('pending intent rejects destructive forms of nominally read-only commands', (t) => {
  const { repo } = fixture(t);
  const turn = 'turn-pending-shell-policy';
  intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });

  for (const command of [
    'ls & touch outside.js',
    'find . -delete',
    'git branch new-branch',
    'rg --pre touch pattern .',
    'git diff --output=outside.diff',
  ]) {
    const result = hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command },
    });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('active workflow permits inspection and only its controller resume command', (t) => {
  const { manifestFile, repo } = fixture(t);
  const turn = 'turn-active-shell-policy';
  startFlow(turn, manifestFile);

  for (const command of ['touch outside.js', 'find . -delete', 'git branch new-branch']) {
    const result = hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command },
    });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'git status --short' },
    }),
    {},
  );
  const resumed = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow run --manifest ${workflowInputPath(turn)}` },
  });
  assert.equal(
    resumed.hookSpecificOutput?.updatedInput?.command,
    `codex-flow run --manifest ${workflowInputPath(turn)} --run-id '${turn}'`,
  );
  assert.match(hook.stop({ session_id: turn }).reason || '', /Resume its controller/u);
});

test('active Build can be cancelled only by its exact task-bound controller', async (t) => {
  const { manifest, manifestFile, repo, startPoint } = fixture(t, { workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-cancel-active-build';
  startFlow(turn, manifestFile);
  const expected = workflowInputPath(turn);

  const wrong = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'codex-flow cancel --manifest /tmp/other-run.json' },
  });
  assert.equal(wrong.hookSpecificOutput?.permissionDecision, 'deny');

  const allowed = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow cancel --manifest ${expected}` },
  });
  assert.equal(
    allowed.hookSpecificOutput?.updatedInput?.command,
    `codex-flow cancel --manifest ${expected} --run-id '${turn}'`,
  );

  const cancelled = (await flowMain(['cancel', '--manifest', expected, '--run-id', turn])).result;
  if (!('status' in cancelled)) throw new Error('missing cancellation status');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.ship_authorization_revoked, true);
  assert.equal(cancelled.current_step, null);
  assert.equal(flow.currentDirective(turn).kind, 'cancelled');
  assert.equal(flow.cancelWorkflow(turn, expected).status, 'cancelled');
  assert.deepEqual(hook.stop({ session_id: turn }), {});
  assert.equal(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: `codex-flow run --manifest ${expected}` },
    }).hookSpecificOutput?.permissionDecision,
    'deny',
  );
  assert.equal(
    spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    startPoint,
  );
  assert.equal(
    spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim(),
    'master',
  );
  assert.equal(fs.existsSync(path.join(repo, 'src.js')), false);
});

test('Ship revalidation rejects an Issue body edited after load:plan', (t) => {
  const { manifest, manifestFile, repo } = fixture(t, { workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-stale-public-issue';
  startFlow(turn, manifestFile);
  assert.equal(flow.completeCurrentDirective(turn, 'load:plan').result.status, 'running');

  const issueFile = path.join(path.dirname(repo), 'github-issue.json');
  const issue = JSON.parse(fs.readFileSync(issueFile, 'utf8')) as Record<string, unknown>;
  const parsed = parsePublicIssueBody(String(issue.body));
  issue.body = renderPublicIssueBody(
    `Edited after Build started.\n\n${parsed.visibleBody}`,
    parsed.plan,
    'english',
  );
  fs.writeFileSync(issueFile, JSON.stringify(issue));

  const state = flow.loadWorkflowState(turn).state;
  const step = state.manifest.steps.find(
    (candidate) => candidate.kind === 'gate' && candidate.id === 'revalidate:ship',
  );
  if (!step || step.kind !== 'gate') throw new Error('missing Ship revalidation gate');
  const report = runStructuredBuildGate(state, step);
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.classification, 'issue_contract_stale');
  assert.deepEqual(report.reason_codes, ['issue_contract_stale']);
});

test('corrupt workflow intent blocks hook execution instead of disabling enforcement', (t) => {
  fixture(t);
  const turn = 'turn-corrupt-intent';
  const file = intentPath(turn);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const result = hook.handle({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: process.cwd(),
    tool_input: { command: 'touch outside.js' },
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    result.hookSpecificOutput?.permissionDecisionReason || '',
    /unavailable|invalid|unreadable/i,
  );
});

test('manifest validation closes action ids, scalar types, unknown keys, and actor boundaries', (t) => {
  const { manifest, repo } = fixture(t, { workflow: 'build' });

  const extraAction = structuredClone(manifest);
  extraAction.steps.push({
    id: 'extra:commit',
    kind: 'action',
    action: 'commit',
    subject: 'chore: extra fixture',
  });
  assert.throws(() => flow.validateManifest(extraAction), /commit.*id|supported action id/);

  assert.throws(
    () => flow.validateManifest({ ...structuredClone(manifest), shipping_authorized: 'false' }),
    /shipping_authorized.*boolean/,
  );
  assert.throws(
    () => flow.validateManifest({ ...structuredClone(manifest), max_corrections: '1' }),
    /max_corrections.*integer/,
  );
  assert.throws(
    () => flow.validateManifest({ ...structuredClone(manifest), unexpected: true }),
    /unknown key/,
  );

  const gitMetadata = structuredClone(manifest);
  requireActor(gitMetadata).files = ['.git/config'];
  assert.throws(() => flow.validateManifest(gitMetadata), /\.git/);

  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.js\n');
  const ignored = structuredClone(manifest);
  requireActor(ignored).files = ['ignored.js'];
  assert.throws(() => flow.validateManifest(ignored), /ignored/);

  const outside = path.join(path.dirname(repo), 'outside.js');
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(outside, path.join(repo, 'linked.js'));
  const linked = structuredClone(manifest);
  requireActor(linked).files = ['linked.js'];
  assert.throws(() => flow.validateManifest(linked), /symbolic link|repository/);
});

test('build start rejects a pre-existing staged baseline instead of deadlocking at commit', (t) => {
  const { manifestFile, repo } = fixture(t, { workflow: 'build' });
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'user staged change\n');
  spawnSync('git', ['-C', repo, 'add', 'staged.txt']);
  assert.throws(() => startFlow('turn-staged-baseline', manifestFile), /clean index.*staged\.txt/);
});

test('build start rejects pre-existing changes to an actor-owned file', (t) => {
  const { manifestFile, repo } = fixture(t, { workflow: 'build' });
  fs.writeFileSync(path.join(repo, 'src.js'), 'user change\n');
  assert.throws(
    () => startFlow('turn-dirty-actor-baseline', manifestFile),
    /clean actor files.*src\.js/,
  );
});

test('build required gates reject vacuous shell substitutes', (t) => {
  const { manifest } = fixture(t, { workflow: 'build' });
  const load = requireGate(manifest, 'load:plan');
  load.gate = { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' };
  assert.throws(() => flow.validateManifest(manifest), /load:plan must use build-plan authority/);
});

test('structured gates reject shell-only configuration', (t) => {
  const { manifest } = fixture(t, { workflow: 'build' });
  for (const [key, value] of [
    ['expect', 'pass'],
    ['calibrate', false],
    ['timeout_ms', 1_000],
    ['require_output', []],
    ['forbid_output', []],
  ] as const) {
    const candidate = structuredClone(manifest);
    Object.assign(requireGate(candidate, 'load:plan').gate, { [key]: value });
    assert.throws(
      () => flow.validateManifest(candidate),
      new RegExp(`${key} is supported only by shell authority`),
    );
  }
});

test('Ship rejects a remote that is not the declared GitHub repository', (t) => {
  const { manifest, repo } = fixture(t, { workflow: 'build' });
  enableShipping(manifest);
  spawnSync('git', [
    '-C',
    repo,
    'remote',
    'set-url',
    '--push',
    'origin',
    'git@gitlab.com:owner/project.git',
  ]);
  assert.throws(() => flow.validateManifest(manifest), /must be GitHub repository owner\/project/);
});

test('hook exposes only describe without an explicit workflow', () => {
  const denied = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: 'session-123',
    tool_name: 'Bash',
    tool_input: { command: `${hook.FLOW_COMMAND} run --manifest /tmp/manifest.json` },
  });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'session-123',
      tool_name: 'Bash',
      tool_input: { command: 'echo codex-flow run' },
    }),
    {},
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'session-123',
      tool_name: 'Bash',
      tool_input: { command: 'codex-flow describe --workflow code' },
    }),
    {},
  );
});

test('portable hook configuration covers the full explicit workflow lifecycle', () => {
  const config = JSON.parse(fs.readFileSync(HOOKS_CONFIG, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  const commands: string[] = events
    .flatMap((event) => config.hooks[event] || [])
    .flatMap((entry) => entry.hooks)
    .map((entry) => entry.command);
  assert.deepEqual(
    commands.filter((command) => command === 'codex-workflow-hook'),
    Array(3).fill('codex-workflow-hook'),
  );
});
