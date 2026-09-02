/** @file Outcome: Build describe output reaches its real local ship-ready terminal from a public Issue. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { onTestFinished, test } from 'bun:test';

import { armIntent } from '../../invocation.ts';
import { executeAction } from '../../flow/build/actions.ts';
import { BUILD_RUN_PROTOCOL } from '../../flow/build/handoff.ts';
import { compileBuildPlan, type BuildPlanAuthoring } from '../../flow/build/authoring.ts';
import { runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-flow-storage-');

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// This E2E spawns nested Bun and Git processes while the standard suite runs eight files in parallel.
test('a small Build input compiles its public Issue Plan and reaches ship-ready', async () => {
  const repo = temporaryDirectory('codex-flow-build-smoke-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@example.test');
  git(repo, 'config', 'user.name', 'Smoke');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  fs.writeFileSync(path.join(repo, 'unit.ts'), 'export const value = 1;\n');
  git(repo, 'add', 'unit.ts');
  git(repo, 'commit', '-qm', 'init');
  const startPoint = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', startPoint);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const plan: BuildPlanAuthoring = {
    outcome: 'done',
    root_cause: null,
    test_command: 'true',
    reference_module: {
      kind: 'no-module',
      reason: 'No reusable module exists for this smoke fixture.',
      path: null,
      files: [],
      instances: 0,
      conventions: [],
    },
    preconditions: [],
    backlog_candidates: [],
    rules: [],
    manual_verification: [],
    units: [
      {
        id: 'U-001',
        goal: 'update unit',
        files: ['unit.ts'],
        contract: 'unit.ts changes are applied',
        tests: [],
        seam: false,
      },
    ],
  };
  const compiledPlan = compileBuildPlan(plan);
  const body = renderPublicIssueBody(
    compiledPlan.markdown,
    compiledPlan,
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
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec /bin/cat '${issueFile}'\n`, {
    mode: 0o700,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ''}`;
  onTestFinished(() => {
    process.env.PATH = previousPath;
    fs.rmSync(issueFile, { force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const runId = `describe-build-smoke-${Date.now()}`;
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({
      protocol: BUILD_RUN_PROTOCOL,
      source: { repository: 'owner/repo', issue_number: 1 },
      ship: false,
    }),
  );

  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo) {
        fs.appendFileSync(path.join(sandboxRepo, 'unit.ts'), 'export const smoke = true;\n');
      },
      async reviewBuild() {
        return {
          protocol: 'codex-build-review' as const,
          verdict: 'pass' as const,
          classification: 'pass' as const,
          reason_codes: [],
          failure_route: null,
          summary: 'Smoke implementation matches the Plan.',
          findings: [],
        };
      },
    },
    executeAction,
  };
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.equal('status' in result.result && result.result.status, 'ship-ready');
  assert.equal('execution_hash' in result.result, true);
  assert.equal('manifest_hash' in result.result, false);
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /smoke/);
}, 30_000);
