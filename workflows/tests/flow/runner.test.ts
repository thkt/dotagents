/** @file Outcome: The shared runner applies isolated actor changes and executes verification. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import type { WorkflowAgent } from '../../flow/agent.ts';
import type { BuildReviewResult } from '../../flow/contracts.ts';
import { runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { armIntent } from '../../invocation.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-runner-tests-');

const unusedReview: BuildReviewResult = {
  protocol: 'codex-build-review',
  verdict: 'pass',
  classification: 'pass',
  reason_codes: [],
  failure_route: null,
  summary: 'pass',
  findings: [],
};

function repository(): string {
  const repo = temporaryDirectory('codex-runner-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Runner Test',
    '-c',
    'user.email=runner@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

test('Code runs the shared actor and test without invoking any Git action', async () => {
  const repo = repository();
  const runId = `runner-code-${crypto.randomUUID()}`;
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
  let actions = 0;
  const agent: WorkflowAgent = {
    async runActor(sandboxRepo) {
      fs.writeFileSync(path.join(sandboxRepo, 'src/value.ts'), 'export const value = 2;\n');
    },
    async reviewBuild() {
      return unusedReview;
    },
  };
  const runtime: WorkflowRuntime = {
    agent,
    executeAction() {
      actions += 1;
    },
  };
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(actions, 0);
  assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 2/u);
});

test('a failing repository test stops the flow', async () => {
  const repo = repository();
  const runId = `runner-fail-${crypto.randomUUID()}`;
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({ repo, request: '値を更新する', scope_paths: ['src'], test_command: 'false' }),
  );
  const agent: WorkflowAgent = {
    async runActor() {},
    async reviewBuild() {
      return unusedReview;
    },
  };
  const result = await runWorkflow(runId, pending.input_path, { agent, executeAction() {} });
  assert.equal(result.exitCode, 2);
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'blocked');
  assert.equal(result.result.last_gate?.gate_id, 'test');
});
