/** @file Outcome: Code compiles a direct request to the shared implementation and test sequence. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { compileCodeManifest, parseCodeInput } from '../../code/manifest.ts';
import { describe } from '../../execution/controller.ts';
import { validateManifest } from '../../execution/manifest.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function repository(): string {
  const repo = temporaryDirectory('codex-code-compile-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Code Test',
    '-c',
    'user.email=code@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

test('described Code input uses the shared actor and test without Git actions', () => {
  const repo = repository();
  const manifest = compileCodeManifest(
    parseCodeInput({
      ...describe('code').input_template,
      repo,
      request: 'Implement the feature.',
      scope_paths: ['src'],
      test_command: 'bun test',
    }),
  );
  assert.deepEqual(
    manifest.steps.map((step) => step.id),
    ['implementation', 'test:implementation', 'review:build'],
  );
  assert.equal(
    manifest.steps.some((step) => step.kind === 'action'),
    false,
  );
});

test('Code prefers a repository-defined check command', () => {
  const repo = repository();
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { check: 'bun test && tsc' } }),
  );
  fs.writeFileSync(path.join(repo, 'bun.lock'), '');
  assert.equal(
    parseCodeInput({ repo, request: 'Implement the feature.' }).test_command,
    'bun run check',
  );
});

test('a shell command cannot impersonate the independent review gate', () => {
  const repo = repository();
  const manifest = compileCodeManifest(
    parseCodeInput({ repo, request: 'Update value', scope_paths: ['src'], test_command: 'true' }),
  );
  manifest.steps[2] = {
    id: 'review:build',
    kind: 'gate',
    owner: 'implementation',
    gate: {
      authority: 'shell',
      command: 'true',
      expect: 'pass',
      failure_route: 'direct:implementation',
    },
  };
  assert.throws(() => validateManifest(manifest), /independent review/);
});
