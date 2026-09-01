/** @file Outcome: Build describe output reaches its real local ship-ready terminal from a published receipt. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { armIntent } from '../../invocation.ts';
import { describe } from '../../flow/controller.ts';
import { validateManifest } from '../../flow/manifest.ts';
import { executeAction } from '../../flow/build/actions.ts';
import { BUILD_SOURCE_PROTOCOL, PUBLISHED_ISSUE_PROTOCOL } from '../../flow/build/handoff.ts';
import { renderPlanMarkdown, type BuildPlanAuthoring } from '../../flow/build/authoring.ts';
import { runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { issueArtifactDirectory } from '../../shared/storage.ts';
import { sha256 } from '../../shared/evidence.ts';

process.env.CODEX_FLOW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-state-'));

function materializeRaw(value: unknown, replacements: Record<string, string>): unknown {
  let json = JSON.stringify(value);
  for (const [from, to] of Object.entries(replacements)) json = json.replaceAll(from, to);
  const raw = JSON.parse(json) as unknown;
  validateManifest(raw);
  return raw;
}

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('describe(build) materializes a published source and reaches completed state', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-build-smoke-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@example.test');
  git(repo, 'config', 'user.name', 'Smoke');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  fs.writeFileSync(path.join(repo, 'unit.ts'), 'export const value = 1;\n');
  git(repo, 'add', 'unit.ts');
  git(repo, 'commit', '-qm', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');

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
  const body = renderPlanMarkdown(plan);
  const published = {
    protocol: PUBLISHED_ISSUE_PROTOCOL,
    published_at: new Date().toISOString(),
    repo: fs.realpathSync(repo),
    repository: 'owner/repo',
    remote: 'origin',
    draft_sha256: sha256('draft'),
    issue_number: 1,
    url: 'https://github.com/owner/repo/issues/1',
    title: 'Smoke build',
    body,
    body_sha256: sha256(body),
    plan,
  };
  const receipt = path.join(issueArtifactDirectory(repo), 'smoke.published.json');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify(published));

  const runId = `describe-build-smoke-${Date.now()}`;
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  assert.ok(pending.build_source_path);
  fs.writeFileSync(
    pending.build_source_path,
    JSON.stringify({ protocol: BUILD_SOURCE_PROTOCOL, receipt }),
  );
  const manifest = materializeRaw(describe('build').executable_example!.manifest, {
    '<absolute-git-root>': repo,
    '<absolute-build-source-json>': pending.build_source_path,
    '<repo-relative-file>': 'unit.ts',
    '<unit-outcome>': 'done',
    '<unit-summary>': 'unit',
    '<git-ref>': head,
  });
  fs.writeFileSync(pending.input_path, JSON.stringify(manifest));

  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(sandboxRepo) {
        fs.appendFileSync(path.join(sandboxRepo, 'unit.ts'), 'export const smoke = true;\n');
      },
      async selectEvidenceCandidate() {
        throw new Error('unexpected evidence selection');
      },
    },
    executeAction,
  };
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.equal('status' in result.result && result.result.status, 'ship-ready');
  assert.match(fs.readFileSync(path.join(repo, 'unit.ts'), 'utf8'), /smoke/);
});
