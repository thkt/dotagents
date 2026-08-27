import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  gitFileList,
  main as verifyArtifactsMain,
  verifyArtifacts,
} from '../scripts/verify-artifacts.ts';
import { run } from '../scripts/lib.ts';

function fixture(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'codex-build-artifacts-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), '// baseline\n');
  run('git', ['init', '-q'], repo);
  run('git', ['add', 'src/value.js', 'test/value.test.js'], repo);
  run('git', ['-c', 'user.name=Codex Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], repo);
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
  try {
    fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), "test('[T-001] empty input returns an error', () => {});\n");
    const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
    assert.equal(report.verdict, 'pass');
    assert.equal(report.gate_id, 'artifacts');
    assert.deepEqual(report.changed_files, ['src/value.js', 'test/value.test.js']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('carries a stable caller-provided gate id', () => {
  const repo = fixture();
  try {
    const report = verifyArtifacts({ units: [] }, repo, [], [], 'final:artifacts');
    assert.equal(report.gate_id, 'final:artifacts');
    assert.throws(() => verifyArtifacts({ units: [] }, repo, [], [], '../bad'), /invalid shape/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('requires gate id at the CLI boundary and returns it in the report', () => {
  const repo = fixture();
  const inputDir = mkdtempSync(path.join(tmpdir(), 'codex-build-artifact-input-'));
  const input = path.join(inputDir, 'plan.json');
  try {
    fs.writeFileSync(input, JSON.stringify({ units: [] }));
    assert.throws(
      () => verifyArtifactsMain(['--input', input, '--repo', repo, '--base', 'HEAD']),
      /--gate-id is required/,
    );
    const result = verifyArtifactsMain([
      '--gate-id',
      'final:artifacts',
      '--input',
      input,
      '--repo',
      repo,
      '--base',
      'HEAD',
    ]);
    assert.equal(result.report.verdict, 'pass');
    assert.equal(result.report.gate_id, 'final:artifacts');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(inputDir, { recursive: true, force: true });
  }
});

test('routes a missing planned test to the Red owner', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), '// changed without T-001\n');
    const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
    assert.equal(report.verdict, 'fail');
    assert.equal(report.failure_route, 'red:U-001');
    assert.equal(report.missing_tests[0].test_id, 'T-001');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('routes an out-of-scope file to triage', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), "test('[T-001] empty input returns an error', () => {});\n");
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'unexpected\n');
    const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
    assert.equal(report.verdict, 'fail');
    assert.equal(report.failure_route, 'triage');
    assert.deepEqual(report.scope_deviations, ['outside.txt']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('routes an untouched tested file to Green', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), "test('[T-001] empty input returns an error', () => {});\n");
    const report = verifyArtifacts(plan(), repo, gitFileList(repo, 'HEAD'));
    assert.equal(report.verdict, 'fail');
    assert.equal(report.failure_route, 'green:U-001');
    assert.deepEqual(report.untouched_plan_files, [{ unit_id: 'U-001', file: 'src/value.js' }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('routes an untouched direct unit file to Direct', () => {
  const repo = fixture();
  try {
    const directPlan = plan({
      units: [{ id: 'U-002', files: ['src/value.js'], tests: [] }],
    });
    const report = verifyArtifacts(directPlan, repo, [], []);
    assert.equal(report.failure_route, 'direct:U-002');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('subtracts baseline untracked files from this build scope', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'notes.local'), 'pre-existing\n');
    fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(repo, 'test', 'value.test.js'), "test('[T-001] empty input returns an error', () => {});\n");
    const changed = gitFileList(repo, 'HEAD');
    assert.ok(changed.includes('notes.local'));
    const report = verifyArtifacts(plan(), repo, changed, ['notes.local']);
    assert.equal(report.verdict, 'pass');
    assert.ok(!report.changed_files.includes('notes.local'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('uses NUL-delimited git output so spaces in file names remain one path', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'file with spaces.txt'), 'value\n');
    assert.ok(gitFileList(repo, 'HEAD').includes('file with spaces.txt'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('does not satisfy test presence by reading through a symlink outside the repository', () => {
  const repo = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'codex-build-artifacts-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'external.test.js'), 'empty input returns an error\n');
    fs.symlinkSync(path.join(outside, 'external.test.js'), path.join(repo, 'linked.test.js'));
    const report = verifyArtifacts({
      units: [{
        id: 'U-001',
        files: ['linked.test.js'],
        tests: [{ id: 'T-001', name: 'empty input returns an error' }],
      }],
    }, repo, ['linked.test.js']);
    assert.equal(report.verdict, 'fail');
    assert.equal(report.missing_tests.length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
