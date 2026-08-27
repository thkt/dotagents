import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { revalidatePlan, targetsFromPlan } from '../scripts/revalidate.ts';

function fixture(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'codex-build-revalidate-'));
  fs.mkdirSync(path.join(repo, 'src', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'value.js'), 'function stableSymbol() {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'reference', 'index.js'), 'module.exports = {};\n');
  return repo;
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    preconditions: [{ path: 'src/value.js', pattern: 'stableSymbol' }],
    reference_module: {
      kind: 'module',
      path: 'src/reference',
      files: ['src/reference/index.js'],
    },
    ...overrides,
  };
}

test('passes when preconditions and reference paths exist', () => {
  const repo = fixture();
  try {
    const report = revalidatePlan(plan(), repo);
    assert.equal(report.verdict, 'pass');
    assert.equal(report.results.length, 3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reports a missing file and literal mismatch as plan drift', () => {
  const repo = fixture();
  try {
    const report = revalidatePlan(plan({
      preconditions: [
        { path: 'src/missing.js' },
        { path: 'src/value.js', pattern: 'absentSymbol' },
      ],
    }), repo);
    assert.equal(report.verdict, 'fail');
    assert.equal(report.classification, 'plan_drift');
    assert.equal(report.failure_route, 'blocked');
    assert.equal(report.drift.length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects traversal instead of reading outside the repository', () => {
  const repo = fixture();
  try {
    const report = revalidatePlan(plan({ preconditions: [{ path: '../outside' }] }), repo);
    assert.equal(report.verdict, 'fail');
    assert.equal(report.drift[0].valid_path, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects a repository symlink whose target is outside the repository', () => {
  const repo = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'codex-build-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'planned-marker\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'linked-secret.txt'));
    const report = revalidatePlan(plan({
      preconditions: [{ path: 'linked-secret.txt', pattern: 'planned-marker' }],
      reference_module: { kind: 'no-module' },
    }), repo);
    assert.equal(report.verdict, 'fail');
    assert.equal(report.drift[0].valid_path, true);
    assert.equal(report.drift[0].inside_repo, false);
    assert.equal(report.drift[0].matches, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('deduplicates a reference path also named as a precondition', () => {
  const targets = targetsFromPlan(plan({
    preconditions: [{ path: 'src/reference', pattern: '' }],
  }));
  assert.equal(targets.filter((entry) => entry.path === 'src/reference').length, 1);
});

test('an empty target set passes without consulting AI', () => {
  const repo = fixture();
  try {
    const report = revalidatePlan({ preconditions: [], reference_module: { kind: 'no-module' } }, repo);
    assert.equal(report.verdict, 'pass');
    assert.deepEqual(report.results, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
