/** @file Outcome: User inputs select work while controller policy remains internal. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { compileCodeManifest, parseCodeInput } from '../../code/manifest.ts';
import { describe } from '../../execution/controller.ts';
import { parseBuildIssueNumber, parseExplicitInvocation } from '../../runtime/invocation.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function repository(): string {
  const repo = temporaryDirectory('codex-policy-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'value\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Policy Test',
    '-c',
    'user.email=policy@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

test('describe exposes semantic inputs for internally compiled execution', () => {
  const build = describe('build');
  const code = describe('code');
  assert.deepEqual(build.input_template, {
    repo: '/absolute/git-root',
    issue_number: 123,
    ship: false,
    screenshots: [],
  });
  assert.deepEqual(code.input_template, {
    repo: '/absolute/git-root',
    request: 'One direct repository change',
    scope_paths: [],
  });
  for (const description of [build, code]) {
    assert.ok(description.execution);
    assert.ok(description.input_template);
    assert.equal(description.execution.compiled, true);
    assert.equal('manifest' in description.input_template, false);
    assert.ok(
      description.cli_contracts.reports.every((report) => report.protocol && report.command),
    );
  }
});

test('caller-authored execution controls are ignored rather than handed through', () => {
  const repo = repository();
  const input = parseCodeInput({
    repo,
    request: '更新する',
    scope_paths: ['src'],
    test_command: 'git diff --check',
    steps: [{ kind: 'action', action: 'ship' }],
    max_corrections: 20,
  });
  const manifest = compileCodeManifest(input);
  assert.deepEqual(
    manifest.steps.map((step) => step.id),
    ['implementation', 'test:implementation'],
  );
  assert.equal(manifest.shipping_authorized, false);
});

test('explicit workflow routing remains a small leading-token decision', () => {
  assert.equal(parseExplicitInvocation('$build #12'), 'build');
  assert.equal(parseBuildIssueNumber('$build #12'), 12);
  assert.equal(parseExplicitInvocation('please use $build'), null);
});
