/** @file Outcome: The controller executes compiled semantic inputs in order and enforces scope. */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test, onTestFinished } from 'bun:test';
import type { FlowState } from '../../execution/contracts.ts';
import { runWorkflow, type WorkflowRuntime } from '../../execution/engine.ts';
import { actorScreenshotAttachments, sealScreenshotAttachments } from '../../build/screenshots.ts';
import { executeAction } from '../../build/git-actions.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';

import {
  completeCurrentDirective,
  completeBuildReview,
  prepareWorkflowDispatch,
  currentDirective,
  startOrResumeWorkflow,
  workflowStatus,
} from '../../execution/controller.ts';
import { runRecoverableActor } from '../../execution/repository-isolation.ts';
import { statePath } from '../../runtime/storage.ts';
import { armIntent } from '../../runtime/invocation.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-controller-tests-');

function repository(): string {
  const repo = temporaryDirectory('codex-controller-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Flow Test',
    '-c',
    'user.email=flow@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

function startCode(repo: string, runId: string) {
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({
      repo,
      request: '値を更新する',
      scope_paths: ['src'],
      test_command: 'git diff --check',
    }),
  );
  startOrResumeWorkflow(runId, pending.input_path);
  return pending;
}

function completeActor(runId: string, stepId: string): void {
  const directive = currentDirective(runId);
  assert.equal(directive.kind, 'run-actor');
  if (directive.kind !== 'run-actor') return;
  completeCurrentDirective(runId, stepId, {
    protocol: 'codex-flow-actor-result',
    binding: directive.binding,
    status: 'completed',
    summary: 'done',
    route: null,
    question: null,
  });
}

test('redispatch rejects an earlier worker result and preserves state on rejection', () => {
  const repo = repository();
  const runId = crypto.randomUUID();
  startCode(repo, runId);
  prepareWorkflowDispatch(runId);
  const old = currentDirective(runId);
  assert.equal(old.kind, 'run-actor');
  if (old.kind !== 'run-actor') return;
  prepareWorkflowDispatch(runId);
  const before = fs.readFileSync(statePath(runId), 'utf8');
  assert.throws(
    () =>
      completeCurrentDirective(runId, old.step_id, {
        protocol: 'codex-flow-actor-result',
        binding: old.binding,
        status: 'completed',
        summary: 'late',
        route: null,
        question: null,
      }),
    /stale or invalid/,
  );
  assert.equal(fs.readFileSync(statePath(runId), 'utf8'), before);
});

test('controller rejects malformed completion without advancing or changing state', () => {
  const runId = crypto.randomUUID();
  startCode(repository(), runId);
  const directive = currentDirective(runId);
  assert.equal(directive.kind, 'run-actor');
  if (directive.kind !== 'run-actor') return;
  const before = fs.readFileSync(statePath(runId), 'utf8');
  for (const invalid of [{ summary: ' ' }, { route: 'think' }, { question: 'Change scope?' }]) {
    assert.throws(
      () =>
        completeCurrentDirective(runId, directive.step_id, {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
          ...invalid,
        }),
      /stale or invalid/,
    );
    assert.equal(fs.readFileSync(statePath(runId), 'utf8'), before);
  }
});

test('Code findings bind to direct request criteria without a public Issue', () => {
  const runId = crypto.randomUUID();
  startCode(repository(), runId);
  completeActor(runId, 'implementation');
  completeCurrentDirective(runId, 'test:implementation');
  const review = currentDirective(runId);
  assert.equal(review.kind, 'run-review');
  if (review.kind !== 'run-review') return;
  assert.equal(review.input.source, undefined);
  assert.equal(review.input.criteria.outcome, '値を更新する');
  const finding = {
    severity: 'blocking',
    code: 'value_unchanged',
    message: 'The requested change is missing.',
    unit_ids: ['unrelated'],
    files: ['src/value.ts'],
    evidence: [{ path: 'src/value.ts', detail: 'The original value remains.' }],
  };
  const candidate = {
    protocol: 'codex-build-review-candidate',
    step_id: review.step_id,
    dispatch_id: review.input.dispatch_id,
    source_digest: review.input.source_digest,
    actor_receipt_digest: review.input.actor_receipt_digest,
    summary: 'Correction required.',
    findings: [finding],
  };
  assert.throws(() => completeBuildReview(runId, review.step_id, candidate, 0), /unknown unit/);
  finding.unit_ids = [review.input.criteria.units[0]!.id];
  completeBuildReview(runId, review.step_id, candidate, 0);
  assert.equal(currentDirective(runId).kind, 'run-actor');
});

test('a redispatched review rejects the earlier response even for the same source', () => {
  const repo = repository();
  const runId = crypto.randomUUID();
  startCode(repo, runId);
  completeActor(runId, 'implementation');
  completeCurrentDirective(runId, 'test:implementation');
  prepareWorkflowDispatch(runId);
  const old = currentDirective(runId);
  assert.equal(old.kind, 'run-review');
  if (old.kind !== 'run-review') return;
  const result = {
    protocol: 'codex-build-review-candidate',
    step_id: old.step_id,
    dispatch_id: old.input.dispatch_id,
    source_digest: old.input.source_digest,
    actor_receipt_digest: old.input.actor_receipt_digest,
    summary: 'pass',
    findings: [],
  };
  prepareWorkflowDispatch(runId);
  assert.throws(() => completeBuildReview(runId, old.step_id, result, 0), /stale or invalid/);
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'changed after test');
  assert.throws(() => currentDirective(runId), /current passing tests/);
});

test('starts from a Code request and completes one implementation and test', () => {
  const repo = repository();
  const runId = `controller-code-${crypto.randomUUID()}`;
  startCode(repo, runId);
  assert.equal(currentDirective(runId).kind, 'run-actor');
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  completeActor(runId, 'implementation');
  assert.equal(currentDirective(runId).kind, 'run-gate');
  completeCurrentDirective(runId, 'test:implementation');
  const review = currentDirective(runId);
  assert.equal(review.kind, 'run-review');
  if (review.kind === 'run-review')
    completeBuildReview(
      runId,
      review.step_id,
      {
        protocol: 'codex-build-review-candidate',
        step_id: review.step_id,
        dispatch_id: review.input.dispatch_id,
        source_digest: review.input.source_digest,
        actor_receipt_digest: review.input.actor_receipt_digest,
        summary: 'pass',
        findings: [],
      },
      0,
    );
  assert.equal(workflowStatus(runId).status, 'completed');
});

test('blocks actor completion from changing paths outside requested scope', () => {
  const repo = repository();
  const runId = `controller-scope-${crypto.randomUUID()}`;
  startCode(repo, runId);
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'unexpected\n');
  assert.throws(() => completeActor(runId, 'implementation'), /outside its declared scope/u);
});

test('requires the hook-bound input path but does not expose internal manifests', () => {
  const repo = repository();
  const runId = `controller-bound-${crypto.randomUUID()}`;
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  const other = path.join(repo, 'input.json');
  fs.writeFileSync(other, JSON.stringify({ repo, request: '更新する' }));
  assert.throws(() => startOrResumeWorkflow(runId, other), /path supplied by the workflow hook/u);
  assert.ok(!('steps' in JSON.parse(fs.readFileSync(other, 'utf8'))));
  assert.ok(pending.input_path !== other);
});

test('resume rejects incomplete execution state before executing work', () => {
  const repo = repository();
  const runId = `old-state-${crypto.randomUUID()}`;
  const pending = startCode(repo, runId);
  const file = statePath(runId);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.actor_attempt;
  delete state.actor_receipt;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(
    () => startOrResumeWorkflow(runId, pending.input_path),
    /obsolete execution contract; start a new workflow/u,
  );
  assert.equal(
    fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'),
    'export const value = 1;\n',
  );
});

test('an older execution revision is retained with recovery instructions before any work', () => {
  const repo = repository();
  const runId = crypto.randomUUID();
  const pending = startCode(repo, runId);
  const file = statePath(runId);
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old.execution_revision;
  fs.writeFileSync(file, JSON.stringify(old));
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => startOrResumeWorkflow(runId, pending.input_path), /original runtime/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a durable worker result is recovered without redispatch and duplicate completion is rejected', async () => {
  const repo = repository();
  const runId = crypto.randomUUID();
  const pending = startCode(repo, runId);
  prepareWorkflowDispatch(runId);
  const directive = currentDirective(runId);
  assert.equal(directive.kind, 'run-actor');
  if (directive.kind !== 'run-actor') return;
  const result = {
    protocol: 'codex-flow-actor-result' as const,
    binding: directive.binding,
    status: 'completed' as const,
    summary: 'durable',
    route: null,
    question: null,
  };
  await runRecoverableActor(runId, directive.step_id, repo, ['src'], async (dir) => {
    fs.writeFileSync(path.join(dir, 'src/value.ts'), 'export const value = 2;\n');
    return result;
  });
  startOrResumeWorkflow(runId, pending.input_path);
  prepareWorkflowDispatch(runId);
  const recovered = await runRecoverableActor(runId, directive.step_id, repo, ['src'], async () => {
    throw Error('must not redispatch');
  });
  completeCurrentDirective(runId, directive.step_id, recovered);
  // Simulate interruption after state advancement but before publication-record cleanup.
  assert.equal(currentDirective(runId).kind, 'run-gate');
  assert.throws(
    () => completeCurrentDirective(runId, directive.step_id, result),
    /expected|current|step|order/,
  );
  completeCurrentDirective(runId, 'test:implementation');
  assert.equal(currentDirective(runId).kind, 'run-review');
});

test('test completion rejects source changed after actor acceptance', () => {
  const repo = repository();
  const runId = `stale-source-${crypto.randomUUID()}`;
  startCode(repo, runId);
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  completeActor(runId, 'implementation');
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 3;\n');
  assert.throws(
    () => completeCurrentDirective(runId, 'test:implementation'),
    /actor receipt is stale/u,
  );
});

test('a fresh Build invocation replaces completed Code state in the same task', () => {
  const repo = repository();
  const runId = `switch-workflow-${crypto.randomUUID()}`;
  startCode(repo, runId);
  completeActor(runId, 'implementation');
  completeCurrentDirective(runId, 'test:implementation');
  const review = currentDirective(runId);
  assert.equal(review.kind, 'run-review');
  if (review.kind === 'run-review')
    completeBuildReview(
      runId,
      review.step_id,
      {
        protocol: 'codex-build-review-candidate',
        step_id: review.step_id,
        dispatch_id: review.input.dispatch_id,
        source_digest: review.input.source_digest,
        actor_receipt_digest: review.input.actor_receipt_digest,
        summary: 'pass',
        findings: [],
      },
      0,
    );
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({
      repo,
      issue_number: 1,
      ship: false,
    }),
  );
  const result = startOrResumeWorkflow(runId, pending.input_path);
  assert.equal(result.workflow, 'build');
  assert.equal(result.status, 'running');
  assert.equal(result.current_step?.id, 'load:plan');
});

test('a fresh invocation cannot reuse an unresolved actor publication', async () => {
  const repo = repository();
  const runId = `pending-publication-${crypto.randomUUID()}`;
  startCode(repo, runId);
  await runRecoverableActor(runId, 'implementation', repo, ['src'], async (sandbox) => {
    fs.writeFileSync(path.join(sandbox, 'src/value.ts'), 'export const value = 2;\n');
    return { summary: 'pending work' };
  });
  const file = statePath(runId);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.status = 'cancelled';
  fs.writeFileSync(file, JSON.stringify(state));
  const next = armIntent({ runId, workflow: 'code', cwd: repo });
  fs.writeFileSync(
    next.input_path,
    JSON.stringify({
      repo,
      request: 'new request',
      scope_paths: ['src'],
      test_command: 'git diff --check',
    }),
  );
  assert.throws(
    () => startOrResumeWorkflow(runId, next.input_path),
    /previous actor publication is unresolved/u,
  );
});

/** Runs actual controller entrypoints in another process, with no actor or GitHub fallback. */
function restartTimeout(runId: string, input: string, execute = false) {
  const modulePath = path.resolve(import.meta.dirname, '../../execution/controller.ts');
  return spawnSync(
    process.execPath,
    [
      '-e',
      `
    import { startOrResumeWorkflow, currentDirective, completeCurrentDirective } from ${JSON.stringify(modulePath)};
    try {
      startOrResumeWorkflow(${JSON.stringify(runId)}, ${JSON.stringify(input)});
      const directive = currentDirective(${JSON.stringify(runId)});
      if (${execute} && directive.kind === 'run-gate') completeCurrentDirective(${JSON.stringify(runId)}, directive.step_id);
    } catch (error) { console.error(String(error)); process.exitCode = 2; }
  `,
    ],
    { encoding: 'utf8', env: process.env },
  );
}

function timeoutFixture(
  workflow: 'build' | 'code',
  timeoutMs: number | null = 500,
  mode = 'timeout',
  screenshots = false,
) {
  const repo = repository();
  const control = path.join(temporaryDirectory('gate-mode-'), 'mode');
  const runId = crypto.randomUUID();
  fs.writeFileSync(control, mode);
  fs.writeFileSync(
    path.join(repo, 'check.ts'),
    `
    import fs from 'node:fs';
    const evidence = JSON.parse(fs.readFileSync(${JSON.stringify(statePath(runId))}, 'utf8')).implementation_test_recovery;
    fs.appendFileSync(${JSON.stringify(control + '.launches')}, JSON.stringify(evidence) + '\\n');
    const mode = await Bun.file(${JSON.stringify(control)}).text();
    if (mode === 'timeout') await Bun.sleep(2000);
    if (mode === 'interrupted') process.kill(process.pid, 'SIGTERM');
    process.exit(mode === 'fail' ? 1 : 0);
  `,
  );
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('add', 'check.ts');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'check');
  const pending = armIntent({ runId, workflow, cwd: repo });
  const reads = path.join(temporaryDirectory('gate-gh-'), 'reads');
  fs.writeFileSync(reads, '');
  if (workflow === 'build') {
    git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const body = renderPublicIssueBody('Fixture', {
      outcome: 'Update value',
      test_command: 'bun check.ts',
      units: [
        {
          goal: 'Update value',
          contract: 'value is 2',
          files: ['src/value.ts'],
          tests: ['value is 2'],
        },
      ],
    });
    const issue = path.join(path.dirname(reads), 'issue.json');
    fs.writeFileSync(
      issue,
      JSON.stringify({
        number: 1,
        title: 'Fixture',
        body,
        url: 'https://github.com/owner/repo/issues/1',
      }),
    );
    fs.writeFileSync(
      path.join(path.dirname(reads), 'gh'),
      `#!/bin/sh\nprintf x >> '${reads}'\nexec cat '${issue}'\n`,
      { mode: 0o700 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${path.dirname(reads)}:${previous}`;
    onTestFinished(() => {
      process.env.PATH = previous;
    });
    fs.writeFileSync(
      pending.input_path,
      JSON.stringify({
        repo,
        issue_number: 1,
        ship: screenshots,
        ...(screenshots ? { screenshots: [{ name: 'proof.png', alt: 'fixture' }] } : {}),
      }),
    );
  } else {
    fs.writeFileSync(
      pending.input_path,
      JSON.stringify({
        repo,
        request: 'Update value',
        scope_paths: ['src/value.ts'],
        test_command: 'bun check.ts',
      }),
    );
  }
  startOrResumeWorkflow(runId, pending.input_path);
  if (workflow === 'build') {
    completeCurrentDirective(runId, 'load:plan');
    const branch = currentDirective(runId);
    assert.equal(branch.kind, 'run-action');
    if (branch.kind !== 'run-action') throw new Error('branch missing');
    executeAction(repo, branch);
    completeCurrentDirective(runId, branch.step_id);
  }
  // Configure the existing internal gate deadline before collecting real timeout evidence.
  const stateFile = statePath(runId);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as FlowState;
  const gate = state.manifest.steps.find((step) => step.id === 'test:implementation');
  assert.ok(gate?.kind === 'gate' && gate.gate.authority === 'shell');
  if (timeoutMs !== null) gate.gate.timeout_ms = timeoutMs;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  const actor = currentDirective(runId);
  if (actor.kind === 'run-actor')
    for (const screenshot of actor.screenshots ?? []) {
      fs.mkdirSync(path.dirname(screenshot.path), { recursive: true });
      fs.writeFileSync(screenshot.path, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    }
  completeActor(runId, 'implementation');
  const initial = restartTimeout(runId, pending.input_path, true);
  assert.equal(initial.status, 0, initial.stderr);
  const blocked = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as FlowState;
  assert.equal(blocked.status, mode === 'timeout' ? 'blocked' : 'running');
  assert.equal(
    blocked.gate_reports.at(-1)?.classification,
    mode === 'timeout' ? 'timeout' : 'pass',
  );
  return { repo, control, runId, input: pending.input_path, stateFile, blocked, reads };
}

for (const workflow of ['build', 'code'] as const) {
  test(`${workflow} isolation failure preserves the unconsumed retry through the engine`, async () => {
    const fixture = timeoutFixture(workflow);
    const bin = temporaryDirectory('retry-failed-isolation-');
    const originalPath = process.env.PATH;
    const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = clone ]; then exit 1; fi\nexec '${git}' "$@"\n`,
      { mode: 0o700 },
    );
    let before = '';
    const launches = fs.readFileSync(`${fixture.control}.launches`, 'utf8');
    try {
      process.env.PATH = `${bin}:${originalPath}`;
      await assert.rejects(
        runWorkflow(fixture.runId, fixture.input, {
          agent: {
            async runActor() {
              throw new Error('must not redispatch actor');
            },
            async reviewBuild() {
              throw new Error('must not advance to review');
            },
          },
          executeAction() {
            throw new Error('must not repeat action');
          },
          onDirective() {
            before = fs.readFileSync(fixture.stateFile, 'utf8');
          },
        }),
        /preparation failed before shell launch/u,
      );
      assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
      assert.equal(fs.readFileSync(`${fixture.control}.launches`, 'utf8'), launches);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
    fs.writeFileSync(fixture.control, 'pass');
    assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 0);
    const passed = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')) as FlowState;
    assert.equal(passed.gate_reports.at(-1)?.verdict, 'pass');
    assert.equal(passed.implementation_test_recovery?.phase, 'consumed');
    assert.deepEqual(passed.gate_reports.slice(0, -1), fixture.blocked.gate_reports);
  }, 30_000);

  test(`${workflow} timeout resumes in a new process without replay and preserves accepted work`, () => {
    const fixture = timeoutFixture(workflow);
    const { runId, input, stateFile, blocked } = fixture;
    const resumed = restartTimeout(runId, input);
    assert.equal(resumed.status, 0, resumed.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state, { ...blocked, status: 'running' });
    fs.writeFileSync(fixture.control, 'pass');
    const result = restartTimeout(runId, input, true);
    assert.equal(result.status, 0, result.stderr);
    const passed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as FlowState;
    assert.equal(passed.gate_reports.at(-1)?.verdict, 'pass');
    assert.equal(passed.cursor, blocked.cursor + 1);
    assert.equal(passed.actor_attempt, blocked.actor_attempt);
    assert.deepEqual(passed.actor_receipt, blocked.actor_receipt);
    assert.deepEqual(passed.correction_counts, blocked.correction_counts);
    assert.deepEqual(passed.gate_reports.slice(0, -1), blocked.gate_reports);
    assert.equal(
      fs.readFileSync(`${fixture.control}.launches`, 'utf8').trim().split('\n').length,
      2,
    );
    assert.equal(fs.readFileSync(fixture.reads, 'utf8'), workflow === 'build' ? 'x' : '');
  }, 30_000);

  test(`${workflow} second timeout stays blocked and a real failure routes to implementation`, () => {
    const fixture = timeoutFixture(workflow);
    let result = restartTimeout(fixture.runId, fixture.input, true);
    assert.equal(result.status, 0, result.stderr);
    const twice = fs.readFileSync(fixture.stateFile, 'utf8');
    const state = JSON.parse(twice) as FlowState;
    assert.equal(state.status, 'blocked');
    assert.equal(state.gate_reports.length, fixture.blocked.gate_reports.length + 1);
    assert.deepEqual(state.correction_counts, {});
    result = restartTimeout(fixture.runId, fixture.input, true);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), twice);
    fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.blocked));
    fs.writeFileSync(fixture.control, 'interrupted');
    result = restartTimeout(fixture.runId, fixture.input, true);
    assert.equal(result.status, 0, result.stderr);
    const interrupted = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')) as FlowState;
    assert.equal(interrupted.status, 'blocked');
    assert.equal(interrupted.gate_reports.at(-1)?.classification, 'signal');
    assert.deepEqual(interrupted.correction_counts, {});
    // Independently exercise the first retry with a genuine assertion failure.
    fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.blocked));
    fs.writeFileSync(fixture.control, 'fail');
    result = restartTimeout(fixture.runId, fixture.input, true);
    assert.equal(result.status, 0, result.stderr);
    const failed = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')) as FlowState;
    assert.equal(failed.manifest.steps[failed.cursor]?.id, 'implementation');
    assert.equal(failed.actor_attempt, fixture.blocked.actor_attempt + 1);
    assert.equal(failed.correction_counts['test:implementation'], 1);
    assert.equal(failed.actor_receipt, null);
  }, 30_000);

  test(`${workflow} invalid timeout authority and bindings never dispatch or change saved state`, () => {
    const fixture = timeoutFixture(workflow);
    const mutations: Array<(s: FlowState) => void> = [
      (s) => {
        delete s.implementation_test_recovery;
      },
      (s) => {
        s.implementation_test_recovery!.phase = 'consumed';
      },
      (s) => {
        s.implementation_test_recovery!.timeout_ms++;
      },
      (s) => {
        s.implementation_test_recovery!.binding_digest = '0'.repeat(64);
      },
      (s) => {
        s.implementation_test_recovery!.report_count++;
      },
      (s) => {
        const gate = s.manifest.steps[s.cursor];
        if (gate?.kind === 'gate' && gate.gate.authority === 'shell') gate.gate.timeout_ms = 200;
      },
      (s) => {
        s.screenshots = [{ name: 'edited.png', alt: 'edited' }];
      },
      (s) => {
        s.cursor++;
      },
      (s) => {
        s.run_id = 'other';
      },
      (s) => {
        s.invocation_id = 'other';
      },
      (s) => {
        s.workflow = workflow === 'build' ? 'code' : 'build';
      },
      (s) => {
        s.manifest.shipping_authorized = !s.manifest.shipping_authorized;
      },
      (s) => {
        s.ship_authorization_revoked = true;
      },
      (s) => {
        s.manifest.max_corrections++;
      },
      (s) => {
        s.actor_attempt++;
      },
      (s) => {
        s.actor_receipt = null;
      },
      (s) => {
        s.actor_receipt!.summary = 'edited';
      },
      (s) => {
        s.gate_reports.at(-1)!.command = 'false';
      },
      (s) => {
        s.gate_reports.at(-1)!.cwd = '/tmp';
      },
      (s) => {
        s.gate_reports.at(-1)!.failure_route = 'direct:implementation';
      },
      (s) => {
        s.gate_reports.at(-1)!.configured_failure_route = 'blocked';
      },
      (s) => {
        s.gate_reports.at(-1)!.source_digest = '0'.repeat(64);
      },
      (s) => {
        s.gate_reports.at(-1)!.actor_receipt_digest = '0'.repeat(64);
      },
      (s) => {
        s.gate_reports.at(-1)!.classification = 'execution_error';
      },
      (s) => {
        s.gate_reports.at(-1)!.gate_id = 'other';
      },
      (s) => {
        s.status = 'cancelled';
      },
      (s) => {
        const gate = s.manifest.steps[s.cursor];
        if (gate?.kind === 'gate') delete gate.owner;
      },
      (s) => {
        s.gate_reports = [];
      },
      (s) => {
        const actor = s.manifest.steps.find((step) => step.kind === 'actor');
        if (actor?.kind === 'actor') actor.outcome = 'edited';
      },
      ...(workflow === 'build'
        ? [
            (s: FlowState) => {
              s.build_plan!.title = 'edited';
            },
            (s: FlowState) => {
              s.build_plan!.units[0]!.tests[0]!.id = 'edited';
            },
            (s: FlowState) => {
              s.build_plan!.outcome = 'edited';
            },
          ]
        : []),
    ];
    for (const mutate of mutations) {
      const state = structuredClone(fixture.blocked);
      mutate(state);
      fs.writeFileSync(fixture.stateFile, JSON.stringify(state));
      const before = fs.readFileSync(fixture.stateFile, 'utf8');
      restartTimeout(fixture.runId, fixture.input, true);
      assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before, mutate.toString());
    }
    fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.blocked));
    const originalInput = fs.readFileSync(fixture.input, 'utf8');
    fs.writeFileSync(fixture.input, `${originalInput}\n`);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 2);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
    fs.writeFileSync(fixture.input, originalInput);
    fs.writeFileSync(path.join(fixture.repo, 'src/value.ts'), 'changed\n');
    assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 2);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
    assert.equal(fs.readFileSync(fixture.reads, 'utf8'), workflow === 'build' ? 'x' : '');
  }, 60_000);
}

for (const workflow of ['build', 'code'] as const) {
  test(`${workflow} production shell sees prepared recovery and effective deadline in another process`, () => {
    const normal = timeoutFixture(workflow, null, 'pass');
    const entry = JSON.parse(fs.readFileSync(`${normal.control}.launches`, 'utf8').trim());
    assert.equal(entry.phase, 'prepared');
    assert.equal(entry.timeout_ms, 600_000);
    assert.match(entry.binding_digest, /^[0-9a-f]{64}$/u);
    // Normal completed gates must remain resumable at review.
    assert.equal(restartTimeout(normal.runId, normal.input).status, 0);
    const short = timeoutFixture(workflow, 500);
    const shortEntry = JSON.parse(fs.readFileSync(`${short.control}.launches`, 'utf8').trim());
    assert.equal(shortEntry.timeout_ms, 500);
    const report = short.blocked.gate_reports.at(-1)!;
    assert.equal(report.classification, 'timeout');
    assert.ok(report.duration_ms < 1500, 'explicit deadline must stop the two-second command');
  }, 30_000);

  test(`${workflow} a killed retry process cannot dispatch again from persisted running state`, async () => {
    const fixture = timeoutFixture(workflow);
    const modulePath = path.resolve(import.meta.dirname, '../../execution/controller.ts');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      import { startOrResumeWorkflow, completeCurrentDirective } from ${JSON.stringify(modulePath)};
      startOrResumeWorkflow(${JSON.stringify(fixture.runId)}, ${JSON.stringify(fixture.input)});
      completeCurrentDirective(${JSON.stringify(fixture.runId)}, 'test:implementation');
    `,
      ],
      { stdio: 'ignore', env: process.env },
    );
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      let consumed = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && child.exitCode === null) {
        const state = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')) as FlowState;
        // Wait for the already dispatched shell to record its launch before killing
        // the controller, so that its delayed write cannot look like a third launch.
        const launchCount = fs
          .readFileSync(`${fixture.control}.launches`, 'utf8')
          .trim()
          .split('\n').length;
        if (state.implementation_test_recovery?.phase === 'consumed' && launchCount === 2) {
          consumed = true;
          break;
        }
        await Bun.sleep(5);
      }
      assert.ok(consumed, 'must observe durable consumption before the gate result');
      child.kill('SIGKILL');
      await closed;
      const before = fs.readFileSync(fixture.stateFile, 'utf8');
      const state = JSON.parse(before) as FlowState;
      assert.equal(state.status, 'running');
      assert.deepEqual(state.gate_reports, fixture.blocked.gate_reports);
      const launches = fs.readFileSync(`${fixture.control}.launches`, 'utf8');
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 2);
        assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
        assert.equal(fs.readFileSync(`${fixture.control}.launches`, 'utf8'), launches);
      }
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }, 30_000);

  test(`${workflow} reopened running retries reject changed input and source before launch`, () => {
    const fixture = timeoutFixture(workflow);
    assert.equal(restartTimeout(fixture.runId, fixture.input).status, 0);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    const launches = fs.readFileSync(`${fixture.control}.launches`, 'utf8');
    const original = fs.readFileSync(fixture.input, 'utf8');
    fs.writeFileSync(fixture.input, `${original}\n`);
    assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 2);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
    fs.writeFileSync(fixture.input, original);
    fs.writeFileSync(path.join(fixture.repo, 'src/value.ts'), 'changed\n');
    assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 2);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
    assert.equal(fs.readFileSync(`${fixture.control}.launches`, 'utf8'), launches);
  }, 30_000);
}

for (const workflow of ['build', 'code'] as const) {
  test(`${workflow} the engine rejects pre-dispatch edits without persisting a failure`, async () => {
    const fixture = timeoutFixture(workflow);
    const originalInput = fs.readFileSync(fixture.input, 'utf8');
    const source = path.join(fixture.repo, 'src/value.ts');
    const originalSource = fs.readFileSync(source, 'utf8');
    const launches = fs.readFileSync(`${fixture.control}.launches`, 'utf8');
    for (const change of ['input', 'source', 'owner', 'authority'] as const) {
      fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.blocked));
      let before = '';
      const runtime: WorkflowRuntime = {
        agent: {
          async runActor() {
            throw new Error('must not redispatch actor');
          },
          async reviewBuild() {
            throw new Error('must not advance to review');
          },
        },
        executeAction() {
          throw new Error('must not repeat action');
        },
        onDirective(directive) {
          assert.equal(directive.kind, 'run-gate');
          if (change === 'input') fs.appendFileSync(fixture.input, '\n');
          if (change === 'source') fs.appendFileSync(source, '// edited\n');
          if (change === 'owner' || change === 'authority') {
            const state = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')) as FlowState;
            const gate = state.manifest.steps[state.cursor];
            assert.ok(gate?.kind === 'gate');
            if (change === 'owner') delete gate.owner;
            else
              gate.gate = {
                authority: 'build-artifacts',
                command: 'codex-build-artifacts',
                failure_route: 'blocked',
              };
            fs.writeFileSync(fixture.stateFile, JSON.stringify(state));
          }
          before = fs.readFileSync(fixture.stateFile, 'utf8');
        },
      };
      await assert.rejects(
        runWorkflow(fixture.runId, fixture.input, runtime),
        /original workflow input|retry authority changed|retry is unavailable or invalid/u,
      );
      assert.ok(before);
      assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
      assert.equal(fs.readFileSync(`${fixture.control}.launches`, 'utf8'), launches);
      fs.writeFileSync(fixture.input, originalInput);
      fs.writeFileSync(source, originalSource);
    }
    // Restoration makes the unconsumed retry usable again.
    fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.blocked));
    fs.writeFileSync(fixture.control, 'pass');
    assert.equal(restartTimeout(fixture.runId, fixture.input, true).status, 0);
  }, 30_000);
}

test('Build engine rejects altered screenshot bytes, seal, or a coherently replaced pair', async () => {
  const fixture = timeoutFixture('build', 500, 'timeout', true);
  const attachments = actorScreenshotAttachments(fixture.blocked, 'implementation');
  const image = attachments[0]!.path;
  const bytes = fs.readFileSync(image);
  const launches = fs.readFileSync(`${fixture.control}.launches`, 'utf8');
  for (const change of ['bytes', 'seal', 'pair'] as const) {
    fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.blocked));
    fs.writeFileSync(image, bytes);
    sealScreenshotAttachments(fixture.runId, attachments);
    let before = '';
    const runtime: WorkflowRuntime = {
      agent: {
        async runActor() {
          throw new Error('must not redispatch actor');
        },
        async reviewBuild() {
          throw new Error('must not advance to review');
        },
      },
      executeAction() {
        throw new Error('must not repeat action');
      },
      onDirective() {
        fs.appendFileSync(image, '\0');
        if (change !== 'bytes') sealScreenshotAttachments(fixture.runId, attachments);
        if (change === 'seal') fs.writeFileSync(image, bytes);
        before = fs.readFileSync(fixture.stateFile, 'utf8');
      },
    };
    await assert.rejects(
      runWorkflow(fixture.runId, fixture.input, runtime),
      /screenshot changed|retry authority changed/u,
    );
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
    assert.equal(fs.readFileSync(`${fixture.control}.launches`, 'utf8'), launches);
  }
});
