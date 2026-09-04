/** @file Outcome: The persistently allowed Build entrypoint cannot execute the shared Code workflow. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { main } from '../../build/runner.ts';
import { main as codeMain } from '../../code/runner.ts';
import { armIntent } from '../../runtime/invocation.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-build-runner-tests-');

function repository(prefix: string): string {
  const repo = temporaryDirectory(prefix);
  const initialized = Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: repo });
  assert.equal(initialized.exitCode, 0, initialized.stderr.toString());
  return repo;
}

test('describe exposes only the Build command contract', async () => {
  const result = await main(['describe']);
  assert.equal(result.exitCode, 0);
  assert.ok('workflow' in result.result);
  assert.equal(result.result.workflow, 'build');
  assert.ok('cli' in result.result);
  assert.equal(result.result.cli.run, 'codex-build run --input <absolute-json>');
});

test('the Code command exposes only the Code command contract', async () => {
  const result = await codeMain(['describe']);
  assert.equal(result.exitCode, 0);
  assert.ok('workflow' in result.result);
  assert.equal(result.result.workflow, 'code');
  assert.ok('cli' in result.result);
  assert.equal(result.result.cli.run, 'codex-code run --input <absolute-json>');
});

test('run rejects a task-bound Code intent', async () => {
  const repo = repository('codex-build-runner-code-');
  fs.mkdirSync(path.join(repo, 'src'));
  const runId = `build-only-${crypto.randomUUID()}`;
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({ repo, request: 'change code', scope_paths: ['src'], test_command: 'true' }),
  );
  await assert.rejects(
    main(['run', '--input', pending.input_path, '--run-id', runId]),
    /explicit \$build invocation is required/u,
  );
});

test('the Code command rejects a task-bound Build intent', async () => {
  const repo = repository('codex-code-runner-build-');
  const runId = `code-only-${crypto.randomUUID()}`;
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({ repo, issue_number: 4, ship: true, screenshots: [] }),
  );
  await assert.rejects(
    codeMain(['run', '--input', pending.input_path, '--run-id', runId]),
    /explicit \$code invocation is required/u,
  );
});
