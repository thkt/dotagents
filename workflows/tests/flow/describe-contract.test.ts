/** @file Outcome: Flow descriptions materialize into valid manifests and runnable local controllers. */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe } from '../../flow/controller.ts';
import { validateManifest } from '../../flow/manifest.ts';
import { armIntent } from '../../invocation.ts';
import { runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { executeAction } from '../../flow/build/actions.ts';
import type { FlowManifest } from '../../flow/contracts.ts';

process.env.CODEX_FLOW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-state-'));

function materialize(value: unknown, replacements: Record<string, string>): FlowManifest {
  let json = JSON.stringify(value);
  for (const [from, to] of Object.entries(replacements)) json = json.replaceAll(from, to);
  return validateManifest(JSON.parse(json));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-describe-'));
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
    materialize(description.executable_example!.manifest, {
      '<absolute-build-source-json>': source,
      '<repo-relative-file>': 'unit.ts',
      '<unit-outcome>': 'done',
      '<unit-summary>': 'unit',
      '<git-ref>': head,
      '<absolute-git-root>': root,
    });
  }
});

test('described code manifest reaches terminal state with fake actor runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-smoke-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 'smoke@example.test']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Smoke']);
  fs.writeFileSync(path.join(root, 'unit.ts'), 'export {}\n');
  spawnSync('git', ['-C', root, 'add', 'unit.ts']);
  spawnSync('git', ['-C', root, 'commit', '-qm', 'init']);
  const d = describe('code');
  const manifest = materialize(d.executable_example!.manifest, {
    '<absolute-git-root>': root,
    '<repo-relative-file>': 'unit.ts',
    '<unit-outcome>': 'done',
    '<unit-summary>': 'unit',
    '<git-ref>': '0000000000000000000000000000000000000000',
  });
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
    },
    executeAction,
  };
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.equal('status' in result.result && result.result.status, 'completed');
});
