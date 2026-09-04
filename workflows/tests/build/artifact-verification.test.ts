/** @file Outcome: Build checks the completed diff only against Plan path scope. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { gitFileList, verifyArtifacts } from '../../build/artifact-verification.ts';
import { run } from '../../runtime/cli.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function fixture(): string {
  const repo = temporaryDirectory('codex-build-artifacts-');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  run('git', ['init', '-q'], repo);
  run('git', ['add', '.'], repo);
  run(
    'git',
    [
      '-c',
      'user.name=Codex Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'base',
    ],
    repo,
  );
  return repo;
}

const plan = { units: [{ files: ['src'] }] };

test('accepts changed files covered by a Plan path', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  const report = verifyArtifacts(plan, repo, gitFileList(repo, 'HEAD'));
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.changed_files, ['src/value.ts']);
});

test('blocks only changes outside the combined Plan scope', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'unexpected\n');
  const report = verifyArtifacts(plan, repo, gitFileList(repo, 'HEAD'));
  assert.equal(report.verdict, 'blocked');
  assert.deepEqual(report.scope_deviations, ['outside.txt']);
});

test('ignores paths that were already changed before Build started', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'notes.local'), 'pre-existing\n');
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 2;\n');
  const report = verifyArtifacts(plan, repo, gitFileList(repo, 'HEAD'), ['notes.local']);
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.changed_files, ['src/value.ts']);
});

test('keeps spaces in file names from NUL-delimited Git output', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'file with spaces.txt'), 'value\n');
  assert.ok(gitFileList(repo, 'HEAD').includes('file with spaces.txt'));
});
