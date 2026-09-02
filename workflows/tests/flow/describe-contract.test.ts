/** @file Outcome: Flow descriptions materialize into valid manifests and runnable local controllers. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe } from '../../flow/controller.ts';
import { validateManifest } from '../../flow/manifest.ts';
import { armIntent } from '../../invocation.ts';
import { runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { executeAction } from '../../flow/build/actions.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-flow-storage-');

function materialize(value: unknown, replacements: Record<string, string>): unknown {
  let json = JSON.stringify(value);
  for (const [from, to] of Object.entries(replacements)) json = json.replaceAll(from, to);
  return JSON.parse(json) as unknown;
}

test('describe exposes a complete executable sequence for code and build', () => {
  for (const workflow of ['code', 'build'] as const) {
    const result = describe(workflow);
    assert.ok(result.executable_example);
    assert.equal(result.executable_example!.required_sequence.length > 0, true);
    assert.ok(result.cli_contracts?.reports.every((report) => report.protocol && report.command));
  }
});

test('described manifests materialize and pass the real validator', () => {
  const root = temporaryDirectory('codex-flow-describe-');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.test']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'unit.ts'), 'export {}\n');
  spawnSync('git', ['-C', root, 'add', 'unit.ts']);
  spawnSync('git', ['-C', root, 'commit', '-qm', 'init']);
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const source = path.join(root, 'source.json');
  fs.writeFileSync(source, '{}');
  for (const workflow of ['code', 'build'] as const) {
    const description = describe(workflow);
    const manifest = validateManifest(
      materialize(description.executable_example!.manifest, {
        '<absolute-build-source-json>': source,
        '<repo-relative-file>': 'unit.ts',
        '<unit-outcome>': 'done',
        '<unit-summary>': 'unit',
        '<git-ref>': head,
        '<absolute-git-root>': root,
      }),
    );
    assert.equal(manifest.workflow, workflow);
    assert.equal(manifest.repo, fs.realpathSync(root));
    const materializedSequence = manifest.steps.flatMap((step) => {
      if (step.kind === 'action' && step.action === 'branch') return ['branch'];
      if (step.id.startsWith('baseline:')) return ['baseline'];
      if (step.id.startsWith('final:')) return ['final'];
      if (step.id === 'review:build') return ['review'];
      return [];
    });
    assert.deepEqual(materializedSequence, description.executable_example!.required_sequence);
  }
});

test('described code manifest reaches terminal state with fake actor runtime', async () => {
  const root = temporaryDirectory('codex-flow-smoke-');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 'smoke@example.test']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Smoke']);
  fs.writeFileSync(path.join(root, 'unit.ts'), 'export {}\n');
  spawnSync('git', ['-C', root, 'add', 'unit.ts']);
  spawnSync('git', ['-C', root, 'commit', '-qm', 'init']);
  const d = describe('code');
  const manifest = validateManifest(
    materialize(d.executable_example!.manifest, {
      '<absolute-git-root>': root,
      '<repo-relative-file>': 'unit.ts',
      '<unit-outcome>': 'done',
      '<unit-summary>': 'unit',
      '<git-ref>': '0000000000000000000000000000000000000000',
    }),
  );
  const runId = `describe-smoke-${Date.now()}`;
  const pending = armIntent({ runId, workflow: 'code', cwd: root });
  fs.mkdirSync(path.dirname(pending.input_path), { recursive: true });
  fs.writeFileSync(pending.input_path, JSON.stringify(manifest));
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor() {},
      async selectEvidenceCandidate() {
        throw new Error('unexpected calibration');
      },
      async reviewBuild() {
        throw new Error('unexpected build review');
      },
    },
    executeAction,
  };
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.equal('status' in result.result && result.result.status, 'completed');
});
