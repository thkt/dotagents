/** @file Outcome: The controller executes compiled semantic inputs in order and enforces scope. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

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
  fs.writeFileSync(pending.input_path, JSON.stringify({ repo, issue_number: 1, ship: false }));
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
