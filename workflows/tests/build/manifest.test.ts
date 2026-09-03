/** @file Outcome: Build compiles a public Plan to one implementation, verification, and commit sequence. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { compileBuildManifest } from '../../build/manifest.ts';
import { buildReviewGateReport } from '../../build/verification.ts';
import { parseBuildRunInput } from '../../build/input.ts';
import { describe } from '../../execution/controller.ts';
import type { BuildPlanContext } from '../../execution/contracts.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function repository(): { repo: string; head: string } {
  const repo = temporaryDirectory('codex-build-compile-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'compile@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Compile Test']);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'tests/value.test.ts'), 'fixture\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  return { repo, head };
}

const plan: BuildPlanContext = {
  repository: 'owner/repo',
  issue: 123,
  title: 'Feature',
  outcome: 'Feature is delivered.',
  test_command: 'bun test',
  units: [
    {
      id: 'U-001',
      goal: 'Implement the feature.',
      contract: 'The saved value is returned.',
      files: ['src', 'tests'],
      tests: [{ id: 'T-001', name: 'saved values are returned' }],
    },
  ],
};

test('Build adds Issue loading and one final commit around the shared implementation steps', () => {
  const { repo, head } = repository();
  const manifest = compileBuildManifest({
    repo,
    input: path.join(repo, '.build-input.json'),
    plan,
    branchName: 'codex/issue-123',
    startPoint: head,
    ship: false,
  });
  assert.deepEqual(
    manifest.steps.map((step) => step.id),
    [
      'load:plan',
      'branch',
      'implementation:direct',
      'test',
      'artifacts',
      'review:build',
      'build:commit',
    ],
  );
  assert.equal(
    manifest.steps.filter((step) => step.kind === 'action' && step.action === 'commit').length,
    1,
  );
});

test('multiple Plan units share one correction actor with their combined scope', () => {
  const { repo, head } = repository();
  const manifest = compileBuildManifest({
    repo,
    input: path.join(repo, '.build-input.json'),
    plan: {
      ...plan,
      units: [
        plan.units[0]!,
        {
          id: 'U-002',
          goal: 'Update the tests.',
          contract: 'The behavior stays covered.',
          files: ['tests'],
          tests: [{ id: 'T-001', name: 'updated behavior is covered' }],
        },
      ],
    },
    branchName: 'codex/issue-123',
    startPoint: head,
    ship: false,
  });
  const actor = manifest.steps.find((step) => step.id === 'implementation:direct');
  assert.ok(actor?.kind === 'actor');
  assert.deepEqual(actor.files, ['src', 'tests']);
  for (const id of ['test', 'review:build']) {
    const gate = manifest.steps.find((step) => step.id === id);
    assert.ok(gate?.kind === 'gate');
    assert.equal(gate.gate.failure_route, 'direct:implementation');
  }
  const review = manifest.steps.find((step) => step.id === 'review:build');
  assert.ok(review?.kind === 'gate');
  const report = buildReviewGateReport(
    review,
    repo,
    {
      protocol: 'codex-build-review',
      verdict: 'fail',
      classification: 'semantic_review_failed',
      reason_codes: ['incomplete'],
      failure_route: 'blocked',
      summary: 'A unit is incomplete.',
      findings: [
        { severity: 'blocking', code: 'incomplete', message: 'Fix the unit.', files: ['src'] },
      ],
    },
    1,
  );
  assert.equal(report.failure_route, 'direct:implementation');
});

test('Ship is an explicit optional suffix', () => {
  const { repo, head } = repository();
  const manifest = compileBuildManifest({
    repo,
    input: path.join(repo, '.build-input.json'),
    plan,
    branchName: 'codex/issue-123',
    startPoint: head,
    baseBranch: 'main',
    ship: true,
  });
  assert.deepEqual(
    manifest.steps.slice(-2).map((step) => step.id),
    ['ship', 'ship:verify'],
  );
});

test('Build input contains only the Issue selector and optional delivery settings', () => {
  const { repo } = repository();
  assert.deepEqual(parseBuildRunInput({ ...describe('build').input_template, repo }), {
    repo,
    issue_number: 123,
    ship: false,
    screenshots: [],
  });
});

test('Build input accepts screenshots only as optional Ship delivery artifacts', () => {
  const { repo } = repository();
  assert.deepEqual(
    parseBuildRunInput({
      repo,
      issue_number: 123,
      ship: true,
      screenshots: [{ name: 'home.png', alt: 'Completed home screen' }],
    }).screenshots,
    [{ name: 'home.png', alt: 'Completed home screen' }],
  );
  assert.throws(
    () =>
      parseBuildRunInput({
        repo,
        issue_number: 123,
        ship: false,
        screenshots: [{ name: 'home.png', alt: 'Completed home screen' }],
      }),
    /require ship to be true/u,
  );
});
