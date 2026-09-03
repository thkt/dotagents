/** @file Outcome: The controller executes compiled semantic inputs in order and enforces scope. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  completeCurrentDirective,
  currentDirective,
  startOrResumeWorkflow,
  workflowStatus,
} from '../../flow/controller.ts';
import { armIntent } from '../../invocation.ts';
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

test('starts from a Code request and completes actor then test', () => {
  const repo = repository();
  const runId = `controller-code-${crypto.randomUUID()}`;
  startCode(repo, runId);
  assert.equal(currentDirective(runId).kind, 'run-actor');
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  completeCurrentDirective(runId, 'implementation:direct');
  assert.equal(currentDirective(runId).kind, 'run-gate');
  completeCurrentDirective(runId, 'test');
  assert.equal(workflowStatus(runId).status, 'completed');
});

test('blocks actor completion from changing paths outside requested scope', () => {
  const repo = repository();
  const runId = `controller-scope-${crypto.randomUUID()}`;
  startCode(repo, runId);
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'unexpected\n');
  assert.throws(
    () => completeCurrentDirective(runId, 'implementation:direct'),
    /outside its declared scope/u,
  );
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
