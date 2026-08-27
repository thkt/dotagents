import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as hook from '../../hooks/workflow-enforcer.ts';
import * as flow from '../core/flow-control.ts';
import * as intent from '../core/intent.ts';
import type { FlowManifest, PublicState } from '../core/contracts.ts';

const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS_CONFIG = path.resolve(AGENTS_ROOT, 'hooks/hooks.json');

function fixture(
  t: TestContext,
  { failingUnitGate = false, workflow = 'code' }: { failingUnitGate?: boolean; workflow?: 'code' | 'build' } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-test-'));
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'flow@example.test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Flow Test'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repo, 'add', 'README.md'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture'], { encoding: 'utf8' });
  const startPoint = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const steps: any[] = [
    {
      id: 'baseline:test',
      kind: 'gate',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
    },
    { id: 'U-001:direct', kind: 'actor', files: ['src.js'] },
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
    steps.splice(0, steps.length,
      {
        id: 'load:plan', kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'revalidate:plan', kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'branch', kind: 'action', action: 'branch',
        branch_name: 'codex/flow-test', start_point: startPoint,
      },
      {
        id: 'branch:verify', kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'baseline:test', kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      { id: 'U-001:direct', kind: 'actor', files: ['src.js'] },
      {
        id: 'U-001:direct:gate', kind: 'gate', owner: 'U-001:direct',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'direct:U-001' },
      },
      {
        id: 'U-001:artifacts', kind: 'gate', owner: 'U-001:direct',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'direct:U-001' },
      },
      { id: 'U-001:commit', kind: 'action', action: 'commit' },
      {
        id: 'U-001:commit:verify', kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' },
      },
      {
        id: 'final:test', kind: 'gate',
        gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'triage' },
      });
  }
  const manifest: any = {
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
    if (previous === undefined) delete process.env.CODEX_FLOW_STATE_DIR;
    else process.env.CODEX_FLOW_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manifest, manifestFile, repo, startPoint };
}

function startFlow(runId: string, manifestFile: string): PublicState {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as FlowManifest;
  const pending = intent.armIntent({
    runId,
    workflow: manifest.workflow,
    cwd: manifest.repo,
  });
  fs.copyFileSync(manifestFile, pending.manifest_path);
  return flow.start(runId, pending.manifest_path);
}

test('advances only through the declared actor and deterministic gates', (t) => {
  const { manifestFile } = fixture(t);
  const turn = 'turn-success';
  assert.equal(startFlow(turn, manifestFile).current_step?.id, 'baseline:test');
  const beforeNext = fs.readFileSync(flow.statePath(turn), 'utf8');
  const baselineDirective = flow.nextDirective(turn);
  assert.equal(baselineDirective.kind, 'run-gate');
  assert.equal('report_result' in baselineDirective && baselineDirective.report_result, 'verify');
  assert.equal(fs.readFileSync(flow.statePath(turn), 'utf8'), beforeNext, 'next must be read-only');
  assert.equal(flow.report(turn, 'baseline:test', 'verify').result.current_step?.id, 'U-001:direct');
  const actorDirective = flow.nextDirective(turn);
  assert.equal(actorDirective.kind, 'run-actor');
  assert.equal('report_result' in actorDirective && actorDirective.report_result, 'actor-completed');
  assert.throws(() => flow.report(turn, 'U-001:direct:gate', 'verify'), /expected report for U-001:direct/);
  assert.equal(flow.report(turn, 'U-001:direct', 'actor-completed').result.current_step?.id, 'U-001:direct:gate');
  assert.equal(flow.report(turn, 'U-001:direct:gate', 'verify').result.current_step?.id, 'final:test');
  const final = flow.report(turn, 'final:test', 'verify');
  assert.equal(final.exitCode, 0);
  assert.equal(final.result.status, 'completed');
  assert.equal(flow.nextDirective(turn).kind, 'done');
});

test('routes a failed gate to its owner and blocks after correction budget', (t) => {
  const { manifestFile } = fixture(t, { failingUnitGate: true });
  const turn = 'turn-failure';
  startFlow(turn, manifestFile);
  flow.report(turn, 'baseline:test', 'verify');
  flow.report(turn, 'U-001:direct', 'actor-completed');
  const first = flow.report(turn, 'U-001:direct:gate', 'verify');
  assert.equal(first.exitCode, 1);
  assert.equal(first.result.current_step?.id, 'U-001:direct');
  assert.equal(first.result.correction_counts['U-001:direct:gate'], 1);
  flow.report(turn, 'U-001:direct', 'actor-completed');
  const second = flow.report(turn, 'U-001:direct:gate', 'verify');
  assert.equal(second.exitCode, 2);
  assert.equal(second.result.status, 'blocked');
});

test('seals a Red fingerprint only from observed calibration output', (t) => {
  const { manifest, manifestFile, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'red.js'), "console.error('not ok T-001 rejects invalid input'); process.exit(1);\n");
  manifest.steps.splice(1, 2,
    { id: 'U-001:red', kind: 'actor', files: ['test.js'] },
    {
      id: 'U-001:red:gate', kind: 'gate', owner: 'U-001:red',
      gate: { command: 'node red.js', expect: 'fail', failure_route: 'red:U-001', calibrate: true },
    },
    { id: 'U-001:green', kind: 'actor', files: ['src.js'] },
    {
      id: 'U-001:green:gate', kind: 'gate', owner: 'U-001:green',
      gate: { command: 'git status --porcelain', expect: 'pass', failure_route: 'green:U-001' },
    });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-calibrate';
  startFlow(turn, manifestFile);
  flow.report(turn, 'baseline:test', 'verify');
  flow.report(turn, 'U-001:red', 'actor-completed');
  const calibrationDirective = flow.nextDirective(turn);
  assert.equal(calibrationDirective.kind, 'calibrate-gate');
  assert.equal('report_result' in calibrationDirective && calibrationDirective.report_result, 'calibrate');
  const calibrated = flow.report(turn, 'U-001:red:gate', 'calibrate');
  assert.equal(calibrated.exitCode, 0);
  const sealDirective = flow.nextDirective(turn);
  assert.equal(sealDirective.kind, 'seal-gate');
  assert.equal('report_result' in sealDirective && sealDirective.report_result, 'seal');
  assert.equal(
    sealDirective.kind === 'seal-gate' && sealDirective.evidence_source,
    'calibration-literal',
  );
  assert.throws(() => flow.report(turn, 'U-001:red:gate', 'seal', 'not present'), /not present/);
  flow.report(turn, 'U-001:red:gate', 'seal', 'not ok T-001 rejects invalid input');
  const gated = flow.report(turn, 'U-001:red:gate', 'verify');
  assert.equal(gated.exitCode, 0);
  assert.equal(gated.result.current_step?.id, 'U-001:green');
});

test('rejects a build manifest that omits required artifact and commit gates', (t) => {
  const { manifest } = fixture(t);
  manifest.workflow = 'build';
  assert.throws(() => flow.validateManifest(manifest), /build must start/);
});

test('derives an owned gate route from its actor and rejects conflicting input', (t) => {
  const { manifest } = fixture(t);
  const gate = manifest.steps.find((step: any) => step.id === 'U-001:direct:gate').gate;
  delete gate.failure_route;
  const normalized = flow.validateManifest(manifest);
  const normalizedGate = normalized.steps.find((step) => step.id === 'U-001:direct:gate');
  assert.equal(normalizedGate?.kind === 'gate' && normalizedGate.gate.failure_route, 'direct:U-001');

  gate.failure_route = 'green:U-001';
  assert.throws(() => flow.validateManifest(manifest), /conflicts with owner/);
});

test('enforces build Branch and commit postconditions before ship-ready', (t) => {
  const { manifestFile, repo, startPoint } = fixture(t, { workflow: 'build' });
  const turn = 'turn-build';
  startFlow(turn, manifestFile);
  flow.report(turn, 'load:plan', 'verify');
  flow.report(turn, 'revalidate:plan', 'verify');
  const branch = flow.nextDirective(turn);
  assert.equal(branch.kind, 'run-action');
  if (branch.kind !== 'run-action') throw new Error('expected branch action');
  const branchParameters = branch.parameters as { branch_name: string; start_point: string };
  assert.deepEqual(branchParameters, {
    branch_name: 'codex/flow-test',
    start_point: startPoint,
  });
  assert.throws(() => flow.report(turn, 'branch', 'action-completed'), /did not reach/);
  const switched = spawnSync(
    'git',
    ['-C', repo, 'switch', '-q', '-c', branchParameters.branch_name, branchParameters.start_point],
    { encoding: 'utf8' },
  );
  assert.equal(switched.status, 0, switched.stderr);
  flow.report(turn, 'branch', 'action-completed');
  flow.report(turn, 'branch:verify', 'verify');
  flow.report(turn, 'baseline:test', 'verify');
  fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
  flow.report(turn, 'U-001:direct', 'actor-completed');
  flow.report(turn, 'U-001:direct:gate', 'verify');
  flow.report(turn, 'U-001:artifacts', 'verify');
  spawnSync('git', ['-C', repo, 'add', 'src.js']);
  assert.deepEqual(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'Bash',
    tool_input: { command: 'git commit -m unit' },
  }), {});
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'unit']);
  flow.report(turn, 'U-001:commit', 'action-completed');
  flow.report(turn, 'U-001:commit:verify', 'verify');
  flow.report(turn, 'final:test', 'verify');
  assert.equal(flow.nextDirective(turn).kind, 'ship-ready');
});

test('blocks a gate that mutates Git state', (t) => {
  const { manifest, manifestFile, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'mutate.js'), "require('fs').writeFileSync('created.js', 'x');\n");
  manifest.steps[0].gate.command = 'node mutate.js';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-mutating-gate';
  startFlow(turn, manifestFile);
  const result = flow.report(turn, 'baseline:test', 'verify');
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.gate?.classification, 'gate_mutated_repository');
  assert.equal(flow.nextDirective(turn).kind, 'blocked');
});

test('hook limits patches to the active actor and keeps an unfinished flow open', (t) => {
  const { manifestFile, repo } = fixture(t);
  const turn = 'turn-hook';
  startFlow(turn, manifestFile);
  flow.report(turn, 'baseline:test', 'verify');

  const allowed = hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'apply_patch', cwd: repo,
    tool_input: { command: '*** Begin Patch\n*** Update File: src.js\n*** End Patch' },
  });
  assert.deepEqual(allowed, {});
  const denied = hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'apply_patch', cwd: repo,
    tool_input: { command: '*** Begin Patch\n*** Update File: other.js\n*** End Patch' },
  });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(hook.stop({ session_id: turn, stop_hook_active: false }).decision, 'block');
});

test('controller and PostToolUse reject shell edits outside actor scope', (t) => {
  const { manifestFile, repo } = fixture(t);
  const turn = 'turn-scope';
  startFlow(turn, manifestFile);
  flow.report(turn, 'baseline:test', 'verify');
  fs.writeFileSync(path.join(repo, 'outside.js'), 'outside\n');

  const post = hook.postToolUse({
    hook_event_name: 'PostToolUse', session_id: turn, tool_name: 'Bash',
    tool_input: { command: 'touch outside.js' },
  });
  assert.equal(post.decision, 'block');
  assert.match(post.reason || '', /outside\.js/);
  assert.throws(
    () => flow.report(turn, 'U-001:direct', 'actor-completed'),
    /outside its declared scope: outside\.js/,
  );
});

test('preserves unrelated dirty files that predate actor entry', (t) => {
  const { manifestFile, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user change\n');
  const turn = 'turn-dirty-baseline';
  startFlow(turn, manifestFile);
  flow.report(turn, 'baseline:test', 'verify');
  fs.writeFileSync(path.join(repo, 'src.js'), 'allowed\n');
  assert.equal(
    flow.report(turn, 'U-001:direct', 'actor-completed').result.current_step?.id,
    'U-001:direct:gate',
  );
  assert.equal(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'user change\n');
});

test('detects modification of a dirty file that predates actor entry', (t) => {
  const { manifestFile, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user change\n');
  const turn = 'turn-dirty-fingerprint';
  startFlow(turn, manifestFile);
  flow.report(turn, 'baseline:test', 'verify');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'actor changed it\n');
  assert.throws(
    () => flow.report(turn, 'U-001:direct', 'actor-completed'),
    /outside its declared scope: unrelated\.txt/,
  );
});

test('self-describes the current manifest and directive contract without workflow state', () => {
  const code = flow.describe('code');
  assert.equal(code.protocol, flow.DESCRIPTION_PROTOCOL);
  assert.equal(code.manifest_template.protocol, flow.MANIFEST_PROTOCOL);
  assert.deepEqual(code.sequence.unit_modes.direct, [
    'U-NNN:direct',
    'U-NNN:direct:gate',
  ]);
  assert.equal(code.step_contracts.some((contract) => contract.kind === 'action'), false);
  assert.deepEqual(
    Object.fromEntries(code.directives.reports.map((item) => [item.kind, item.report_result])),
    {
      'run-actor': 'actor-completed',
      'run-action': 'action-completed',
      'calibrate-gate': 'calibrate',
      'seal-gate': 'seal',
      'run-gate': 'verify',
    },
  );

  const build = flow.describe('build');
  assert.equal(build.step_contracts.some((contract) => contract.kind === 'action'), true);
  assert.deepEqual(build.sequence.opening.slice(0, 4), [
    'load:plan',
    'revalidate:plan',
    'branch',
    'branch:verify',
  ]);
  assert.deepEqual(flow.main(['describe', '--workflow', 'build']).result, build);
  assert.throws(() => flow.main(['describe', '--workflow', 'other']), /code or build/);
});

test('public CLI exposes only describe, start, status, next, and report', (t) => {
  const { manifestFile } = fixture(t);
  const turn = 'turn-closed-cli';
  startFlow(turn, manifestFile);
  assert.throws(
    () => flow.main(['gate', '--step', 'baseline:test', '--run-id', turn]),
    /unknown command: gate/,
  );
  assert.throws(
    () => flow.main(['next', '--extra', 'value', '--run-id', turn]),
    /unsupported flag/,
  );
});

test('starts only from the manifest armed by an explicit workflow invocation', (t) => {
  const { manifestFile, repo } = fixture(t);
  const turn = 'turn-explicit-start';
  assert.throws(
    () => flow.start(turn, manifestFile),
    /explicit \$code invocation is required/,
  );

  const pending = intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });
  assert.equal(pending.repo, fs.realpathSync(repo));
  assert.equal(intent.loadIntent(turn)?.manifest_path, pending.manifest_path);
  assert.throws(
    () => flow.start(turn, manifestFile),
    /manifest path supplied by the workflow hook/,
  );

  fs.copyFileSync(manifestFile, pending.manifest_path);
  assert.equal(flow.start(turn, pending.manifest_path).status, 'running');
  assert.equal(intent.loadIntent(turn), null);
});

test('UserPromptSubmit arms only a leading explicit workflow invocation', (t) => {
  const { repo } = fixture(t);
  const natural = hook.handle({
    hook_event_name: 'UserPromptSubmit', session_id: 'turn-natural', cwd: repo,
    prompt: 'Please use $build when it is appropriate.',
  });
  assert.deepEqual(natural, {});
  assert.equal(intent.loadIntent('turn-natural'), null);

  const explicit = hook.handle({
    hook_event_name: 'UserPromptSubmit', session_id: 'turn-explicit-hook', cwd: repo,
    prompt: '$build #123',
  });
  const pending = intent.loadIntent('turn-explicit-hook');
  assert.equal(pending?.workflow, 'build');
  assert.equal(explicit.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(explicit.hookSpecificOutput?.additionalContext || '', /codex-flow start/);
  assert.match(explicit.hookSpecificOutput?.additionalContext || '', new RegExp(pending!.manifest_path));
});

test('pending intent permits manifest preparation and blocks unrelated mutation', (t) => {
  const { repo } = fixture(t);
  const turn = 'turn-pending-policy';
  const pending = intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });

  assert.deepEqual(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'Bash', cwd: repo,
    tool_input: { command: 'rg --files' },
  }), {});
  assert.deepEqual(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'apply_patch', cwd: repo,
    tool_input: { command: `*** Begin Patch\n*** Add File: ${pending.manifest_path}\n*** End Patch` },
  }), {});
  assert.equal(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'apply_patch', cwd: repo,
    tool_input: { command: '*** Begin Patch\n*** Add File: src.js\n*** End Patch' },
  }).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'Bash', cwd: repo,
    tool_input: { command: 'touch src.js' },
  }).hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'Bash', cwd: repo,
    tool_input: { command: 'codex-flow describe --workflow code' },
  }), {});

  const start = hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: turn, tool_name: 'Bash', cwd: repo,
    tool_input: { command: `codex-flow start --manifest ${pending.manifest_path}` },
  });
  assert.equal(start.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(
    start.hookSpecificOutput?.updatedInput?.command,
    `codex-flow start --manifest ${pending.manifest_path} --run-id "${turn}"`,
  );
  assert.equal(hook.stop({ session_id: turn, stop_hook_active: false }).decision, 'block');
});

test('directive validation rejects open or malformed shapes', () => {
  assert.throws(() => flow.validateDirective({
    protocol: flow.DIRECTIVE_PROTOCOL,
    kind: 'done',
    workflow: 'code',
    extra: true,
  }), /unknown fields/);
  assert.throws(() => flow.validateDirective({
    protocol: flow.DIRECTIVE_PROTOCOL,
    kind: 'run-actor',
    workflow: 'code',
    step_id: 'U-001:direct',
    files: ['src.js'],
    report_result: 'verify',
  }), /report_result is invalid/);
});

test('hook binds flow-control commands to the current Codex task', () => {
  const result = hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: 'session-123', tool_name: 'Bash',
    tool_input: { command: `${hook.FLOW_COMMAND} status` },
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(
    result.hookSpecificOutput?.updatedInput?.command,
    'codex-flow status --run-id "session-123"',
  );
  assert.deepEqual(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: 'session-123', tool_name: 'Bash',
    tool_input: { command: 'echo codex-flow status' },
  }), {});
  assert.deepEqual(hook.preToolUse({
    hook_event_name: 'PreToolUse', session_id: 'session-123', tool_name: 'Bash',
    tool_input: { command: 'codex-flow describe --workflow code' },
  }), {});
});

test('portable hook configuration covers the full explicit workflow lifecycle', () => {
  const config = JSON.parse(fs.readFileSync(HOOKS_CONFIG, 'utf8'));
  const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  const commands: string[] = events.flatMap((event) => config.hooks[event])
    .flatMap((entry: any) => entry.hooks)
    .map((entry: any) => entry.command);
  assert.deepEqual(commands, Array(4).fill('codex-workflow-hook'));
});
