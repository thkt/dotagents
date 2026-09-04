/** @file Outcome: A minimal Build input reaches a verified local completion from one public Issue read. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { executeAction } from '../../build/git-actions.ts';
import { compileBuildPlan, type BuildPlanAuthoring } from '../../plan/contracts.ts';
import type { FlowDirective } from '../../execution/contracts.ts';
import { runWorkflow, type WorkflowRuntime } from '../../execution/engine.ts';
import { armIntent } from '../../invocation.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-build-smoke-storage-');

function reviewPair(directive: Extract<FlowDirective, { kind: 'run-review' }>, blocking = false) {
  return (['contract', 'quality'] as const).map((role) => ({
    protocol: `codex-build-${role}-review` as const,
    role,
    step_id: 'review:build' as const,
    source_digest: directive.input.source_digest,
    receipt_set_digest: directive.input.receipt_set_digest,
    summary: blocking && role === 'contract' ? '主値に修正が必要。' : 'Plan を満たす。',
    findings:
      blocking && role === 'contract'
        ? [
            {
              severity: 'blocking' as const,
              code: 'incomplete',
              message: '主値を修正する。',
              unit_ids: ['U-001'],
              files: ['unit.ts'],
              evidence: [{ path: 'unit.ts', detail: 'value is incomplete' }],
            },
          ]
        : [],
  }));
}

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
  fs.writeFileSync(path.join(repo, '.gitignore'), '.DS_Store\n');
  git(repo, 'add', 'unit.ts', 'other.ts');
  git(repo, 'commit', '-qm', 'init');
  const startPoint = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', startPoint);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const body = renderPublicIssueBody('Build fixture.', compileBuildPlan(plan));
  const issueFile = `${repo}.issue.json`;
  fs.writeFileSync(
    issueFile,
    JSON.stringify({
      number: 1,
      title: 'Smoke build',
      body,
      url: 'https://github.com/owner/repo/issues/1',
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
      async runActor(sandboxRepo, directive) {
        fs.writeFileSync(path.join(sandboxRepo, 'unit.ts'), 'export const value = 2;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        return reviewPair(directive);
      },
    },
    executeAction,
  };
  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 0, JSON.stringify(result.result));
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
  const directives: string[] = [];
  let reviews = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo, directive) {
        actorCalls.push(directive);
        if (!directive.solidify) {
          const target = directive.files[0]!;
          const value = actorCalls.length >= 5 ? 3 : 2;
          fs.writeFileSync(
            path.join(sandboxRepo, target),
            target === 'unit.ts' ? `export const value = ${value};\n` : 'export const other = 2;\n',
          );
        }
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        reviews += 1;
        return reviewPair(directive, reviews === 1);
      },
    },
    executeAction(actionRepo, directive) {
      actions.push(directive.action);
      executeAction(actionRepo, directive);
    },
    onDirective(directive) {
      if (directive.kind === 'run-actor')
        directives.push(directive.solidify ? 'solidify' : 'implementation');
      else if (directive.kind === 'run-gate') directives.push(directive.step_id);
      else if (directive.kind === 'run-review') directives.push('review:build');
      else if (directive.kind === 'run-action') directives.push(directive.action);
    },
  };

  const result = await runWorkflow(runId, input, runtime);
  assert.equal(result.exitCode, 0, JSON.stringify(result.result));
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(reviews, 2);
  assert.equal(actorCalls.length, 6);
  assert.equal(actorCalls[0]?.correction, null);
  assert.deepEqual(
    actorCalls.map((call) => call.files),
    [['unit.ts'], ['unit.ts'], ['other.ts'], ['other.ts'], ['unit.ts'], ['unit.ts']],
  );
  assert.equal(actorCalls[4]?.correction?.attempt, 1);
  assert.equal(actorCalls[4]?.correction?.gate.gate_id, 'review:build');
  assert.equal(actorCalls[1]?.solidify?.outcome, plan.units[0]?.goal);
  assert.equal(actorCalls[3]?.solidify?.outcome, plan.units[1]?.goal);
  assert.deepEqual(actorCalls[1]?.solidify?.files, ['unit.ts']);
  assert.deepEqual(directives, [
    'load:plan',
    'branch',
    'implementation',
    'U-001:test',
    'solidify',
    'U-001:solidify:test',
    'implementation',
    'U-002:test',
    'solidify',
    'U-002:solidify:test',
    'artifacts',
    'review:build',
    'implementation',
    'U-001:test',
    'solidify',
    'U-001:solidify:test',
    'artifacts',
    'review:build',
    'commit',
  ]);
  const gateIds = result.result.gate_reports.map((gate) => gate.gate_id);
  assert.equal(gateIds.filter((id) => id === 'load:plan').length, 1);
  assert.equal(gateIds.filter((id) => id.endsWith(':test')).length, 6);
  assert.equal(gateIds.filter((id) => id === 'review:build').length, 2);
  assert.deepEqual(actions, ['branch', 'commit']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /value = 3/u);
  assert.equal(git(repo, 'rev-list', '--count', `${startPoint}..HEAD`), '1');
}, 30_000);
