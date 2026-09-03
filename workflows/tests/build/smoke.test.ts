/** @file Outcome: A minimal Build input reaches a verified local completion from one public Issue read. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { executeAction } from '../../build/actions.ts';
import { compileBuildPlan, type BuildPlanAuthoring } from '../../plan/contracts.ts';
import type { FlowDirective } from '../../flow/contracts.ts';
import { runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { armIntent } from '../../invocation.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-build-smoke-storage-');

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function buildFixture(plan: BuildPlanAuthoring) {
  const repo = temporaryDirectory('codex-build-smoke-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@example.test');
  git(repo, 'config', 'user.name', 'Smoke');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  fs.writeFileSync(path.join(repo, 'unit.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'other.ts'), 'export const other = 1;\n');
  git(repo, 'add', 'unit.ts', 'other.ts');
  git(repo, 'commit', '-qm', 'init');
  const startPoint = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', startPoint);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const body = renderPublicIssueBody(
    '',
    compileBuildPlan(plan),
    '00000000-0000-4000-8000-000000000002',
  );
  const issueFile = `${repo}.issue.json`;
  fs.writeFileSync(
    issueFile,
    JSON.stringify({
      number: 1,
      title: 'Smoke build',
      body,
      url: 'https://github.com/owner/repo/issues/1',
      labels: [],
    }),
  );
  const bin = `${repo}.bin`;
  fs.mkdirSync(bin);
  const countFile = path.join(bin, 'count');
  fs.writeFileSync(countFile, '');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\nprintf x >> '${countFile}'\nexec /bin/cat '${issueFile}'\n`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ''}`;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    fs.rmSync(issueFile, { force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const runId = `build-smoke-${crypto.randomUUID()}`;
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  fs.writeFileSync(pending.input_path, JSON.stringify({ repo, issue_number: 1, ship: false }));
  return { repo, startPoint, countFile, runId, input: pending.input_path };
}

test('Build fetches the Issue Plan, implements, verifies, reviews, and commits once', async () => {
  const plan: BuildPlanAuthoring = {
    outcome: '値が更新される。',
    test_command: 'git diff --check',
    manual_verification: [],
    units: [
      {
        goal: '値を更新する。',
        files: ['unit.ts'],
        contract: 'value が 2 になる。',
        tests: ['差分に空白エラーがない。'],
      },
    ],
  };
  const { repo, startPoint, countFile, runId, input } = buildFixture(plan);
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo) {
        fs.writeFileSync(path.join(sandboxRepo, 'unit.ts'), 'export const value = 2;\n');
      },
      async reviewBuild() {
        return {
          protocol: 'codex-build-review',
          verdict: 'pass',
          classification: 'pass',
          reason_codes: [],
          failure_route: null,
          summary: 'Plan を満たす。',
          findings: [],
        };
      },
    },
    executeAction,
  };
  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 0);
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 2/u);
  assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
}, 30_000);

test('a blocking semantic review corrects the shared actor, then re-verifies and commits once', async () => {
  const plan: BuildPlanAuthoring = {
    outcome: '両方の値が更新される。',
    test_command: 'git diff --check',
    manual_verification: [],
    units: [
      {
        goal: '主値を更新する。',
        files: ['unit.ts'],
        contract: 'value が更新される。',
        tests: ['差分に空白エラーがない。'],
      },
      {
        goal: '関連値を更新する。',
        files: ['other.ts'],
        contract: 'other が更新される。',
        tests: ['関連ファイルも検証される。'],
      },
    ],
  };
  const { repo, startPoint, countFile, runId, input } = buildFixture(plan);
  type ActorDirective = Extract<FlowDirective, { kind: 'run-actor' }>;
  const actorCalls: ActorDirective[] = [];
  const actions: string[] = [];
  let reviews = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo, directive) {
        actorCalls.push(directive);
        const value = directive.correction ? 3 : 2;
        fs.writeFileSync(path.join(sandboxRepo, 'unit.ts'), `export const value = ${value};\n`);
        fs.writeFileSync(path.join(sandboxRepo, 'other.ts'), 'export const other = 2;\n');
      },
      async reviewBuild() {
        reviews += 1;
        if (reviews === 1) {
          return {
            protocol: 'codex-build-review',
            verdict: 'fail',
            classification: 'semantic_review_failed',
            reason_codes: ['incomplete'],
            failure_route: 'blocked',
            summary: '主値に修正が必要。',
            findings: [
              {
                severity: 'blocking',
                code: 'incomplete',
                message: '主値を修正する。',
                files: ['unit.ts'],
              },
            ],
          };
        }
        return {
          protocol: 'codex-build-review',
          verdict: 'pass',
          classification: 'pass',
          reason_codes: [],
          failure_route: null,
          summary: 'Plan を満たす。',
          findings: [],
        };
      },
    },
    executeAction(actionRepo, directive) {
      actions.push(directive.action);
      executeAction(actionRepo, directive);
    },
  };

  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 0);
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(reviews, 2);
  assert.equal(actorCalls.length, 2);
  assert.equal(actorCalls[0]?.correction, null);
  assert.deepEqual(
    actorCalls.map((call) => call.files),
    [
      ['unit.ts', 'other.ts'],
      ['unit.ts', 'other.ts'],
    ],
  );
  assert.equal(actorCalls[1]?.correction?.attempt, 1);
  assert.equal(actorCalls[1]?.correction?.gate.gate_id, 'review:build');
  const gateIds = result.result.gate_reports.map((gate) => gate.gate_id);
  assert.equal(gateIds.filter((id) => id === 'load:plan').length, 1);
  assert.equal(gateIds.filter((id) => id === 'test').length, 2);
  assert.equal(gateIds.filter((id) => id === 'review:build').length, 2);
  assert.deepEqual(actions, ['branch', 'commit']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 3/u);
  assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
}, 30_000);
