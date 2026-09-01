/** @file Outcome: Artifact verification preserves unit scope and planned-test enforcement across Git states. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  gitFileList,
  main as verifyArtifactsMain,
  verifyArtifacts,
} from '../../flow/build/artifacts.ts';
import { run } from '../../flow/build/cli.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function fixture(): string {
  const repo = temporaryDirectory('codex-build-artifacts-');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), '// baseline\n');
  run('git', ['init', '-q'], repo);
  run('git', ['add', 'src/value.js', 'test/value.test.js'], repo);
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

function plan(overrides: Record<string, unknown> = {}) {
  return {
    units: [
      {
        id: 'U-001',
        files: ['src/value.js', 'test/value.test.js'],
        tests: [{ id: 'T-001', name: '[T-001] empty input returns an error' }],
      },
    ],
    ...overrides,
  };
}

test('passes when all planned files changed and planned test text exists', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  fs.writeFileSync(
    path.join(repo, 'test', 'value.test.js'),
    "test('[T-001] empty input returns an error', () => {});\n",
  );
  const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
  assert.equal(report.verdict, 'pass');
  assert.equal(report.gate_id, 'artifacts');
  assert.deepEqual(report.changed_files, ['src/value.js', 'test/value.test.js']);
});

test('accepts a literal test title when the plan appends assertion details', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  fs.writeFileSync(
    path.join(repo, 'test', 'value.test.js'),
    "test('increment increases a number by one', () => {});\n",
  );
  const report = verifyArtifacts(
    {
      units: [
        {
          id: 'U-001',
          files: ['src/value.js', 'test/value.test.js'],
          tests: [{ id: 'T-001', name: 'increment increases a number by one: increment(0) === 1' }],
        },
      ],
    },
    repo,
    gitFileList(repo, 'HEAD'),
  );
  assert.equal(report.verdict, 'pass');
});

test('carries a stable caller-provided gate id', () => {
  const repo = fixture();
  const report = verifyArtifacts({ units: [] }, repo, [], [], 'final:artifacts');
  assert.equal(report.gate_id, 'final:artifacts');
  assert.throws(() => verifyArtifacts({ units: [] }, repo, [], [], '../bad'), /invalid shape/);
});

test('requires gate id at the CLI boundary and returns it in the report', () => {
  const repo = fixture();
  const inputDir = temporaryDirectory('codex-build-artifact-input-');
  const input = path.join(inputDir, 'plan.json');
  fs.writeFileSync(
    input,
    JSON.stringify({
      units: [{ id: 'U-001', files: [], tests: [] }],
    }),
  );
  assert.throws(
    () => verifyArtifactsMain(['--input', input, '--repo', repo, '--base', 'HEAD']),
    /--gate-id is required/,
  );
  const result = verifyArtifactsMain([
    '--gate-id',
    'final:artifacts',
    '--unit',
    'U-001',
    '--input',
    input,
    '--repo',
    repo,
    '--base',
    'HEAD',
  ]);
  assert.equal(result.report.verdict, 'pass');
  assert.equal(result.report.gate_id, 'final:artifacts');
});

test('routes a missing planned test to the Red owner', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), '// changed without T-001\n');
  const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
  assert.equal(report.verdict, 'fail');
  assert.equal(report.failure_route, 'red:U-001');
  assert.equal(report.missing_tests[0]!.test_id, 'T-001');
});

test('routes an out-of-scope file to triage', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  fs.writeFileSync(
    path.join(repo, 'test', 'value.test.js'),
    "test('[T-001] empty input returns an error', () => {});\n",
  );
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'unexpected\n');
  const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
  assert.equal(report.verdict, 'fail');
  assert.equal(report.failure_route, 'triage');
  assert.deepEqual(report.scope_deviations, ['outside.txt']);
});

test('routes an untouched tested file to Green', () => {
  const repo = fixture();
  fs.writeFileSync(
    path.join(repo, 'test', 'value.test.js'),
    "test('[T-001] empty input returns an error', () => {});\n",
  );
  const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
  assert.equal(report.verdict, 'fail');
  assert.equal(report.failure_route, 'green:U-001');
  assert.deepEqual(report.untouched_plan_files, [{ unit_id: 'U-001', file: 'src/value.js' }]);
});

test('routes an untouched direct unit file to Direct', () => {
  const repo = fixture();
  const directPlan = plan({
    units: [{ id: 'U-002', files: ['src/value.js'], tests: [] }],
  });
  const report = verifyArtifacts(directPlan, repo, [], []);
  assert.equal(report.failure_route, 'direct:U-002');
});

test('subtracts baseline untracked files from this build scope', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'notes.local'), 'pre-existing\n');
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  fs.writeFileSync(
    path.join(repo, 'test', 'value.test.js'),
    "test('[T-001] empty input returns an error', () => {});\n",
  );
  const changed = gitFileList(repo, 'HEAD');
  assert.ok(changed.includes('notes.local'));
  const report = verifyArtifacts(plan(), repo, changed, ['notes.local']);
  assert.equal(report.verdict, 'pass');
  assert.ok(!report.changed_files.includes('notes.local'));
});

test('uses NUL-delimited git output so spaces in file names remain one path', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'file with spaces.txt'), 'value\n');
  assert.ok(gitFileList(repo, 'HEAD').includes('file with spaces.txt'));
});

test('does not satisfy test presence by reading through a symlink outside the repository', () => {
  const repo = fixture();
  const outside = temporaryDirectory('codex-build-artifacts-outside-');
  fs.writeFileSync(path.join(outside, 'external.test.js'), 'empty input returns an error\n');
  fs.symlinkSync(path.join(outside, 'external.test.js'), path.join(repo, 'linked.test.js'));
  const report = verifyArtifacts(
    {
      units: [
        {
          id: 'U-001',
          files: ['linked.test.js'],
          tests: [{ id: 'T-001', name: 'empty input returns an error' }],
        },
      ],
    },
    repo,
    ['linked.test.js'],
  );
  assert.equal(report.verdict, 'fail');
  assert.equal(report.missing_tests.length, 1);
});

test('a per-unit gate ignores untouched files owned by later units', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  const report = verifyArtifacts(
    {
      units: [
        { id: 'U-001', files: ['src/value.js'], tests: [] },
        { id: 'U-002', files: ['test/value.test.js'], tests: [] },
      ],
    },
    repo,
    gitFileList(repo, 'HEAD'),
    [],
    'U-001:artifacts',
    'U-001',
  );
  assert.equal(report.verdict, 'pass');
  assert.deepEqual(report.untouched_plan_files, []);
});

test('accepts the full validated Plan input wrapper', () => {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
  fs.writeFileSync(
    path.join(repo, 'test', 'value.test.js'),
    "test('[T-001] empty input returns an error', () => {});\n",
  );
  assert.equal(verifyArtifacts({ plan: plan() }, repo, gitFileList(repo, 'HEAD')).verdict, 'pass');
});
