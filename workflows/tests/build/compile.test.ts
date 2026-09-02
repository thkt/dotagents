/** @file Outcome: Build execution is derived completely and deterministically from its public Plan. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { compileBuildManifest } from '../../flow/build/compile.ts';
import { parseBuildRunInput } from '../../flow/build/handoff.ts';
import type { ActorStep, BuildPlanContext, GateStep } from '../../flow/contracts.ts';

const plan: BuildPlanContext = {
  repository: 'owner/repo',
  issue: 123,
  title: 'Feature',
  body_sha256: '0'.repeat(64),
  outcome: 'Feature is delivered.',
  test_command: 'bun test',
  manual_verification: [],
  units: [
    {
      id: 'U-001',
      goal: 'Preserve the value contract.',
      contract: 'tested behavior',
      files: ['src/value.ts', 'tests/value.test.ts'],
      tests: [{ id: 'T-001', name: 'empty input returns an error' }],
      seam: false,
    },
    {
      id: 'U-002',
      goal: 'Document the value contract.',
      contract: 'documentation',
      files: ['README.md'],
      tests: [],
      seam: false,
    },
  ],
};

function repository(): { repo: string; head: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-build-compile-'));
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'compile@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Compile Test']);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  return { repo, head };
}

test('derives actor modes, exact Plan scopes, gates, and commits without caller-authored steps', () => {
  const { repo, head } = repository();
  const input = path.join(repo, '.build-input.json');
  const manifest = compileBuildManifest({
    repo,
    input,
    plan,
    branchName: 'codex/issue-123',
    startPoint: head,
    baseBranch: 'main',
    ship: false,
  });

  assert.deepEqual(
    manifest.steps.map((step) => step.id),
    [
      'load:plan',
      'revalidate:plan',
      'branch',
      'baseline:test',
      'U-001:red',
      'U-001:red:gate',
      'U-001:green',
      'U-001:green:gate',
      'U-001:artifacts',
      'U-001:commit',
      'U-002:direct',
      'U-002:direct:gate',
      'U-002:artifacts',
      'U-002:commit',
      'final:test',
      'revalidate:review',
      'review:build',
    ],
  );
  const actors = manifest.steps.filter((step): step is ActorStep => step.kind === 'actor');
  assert.deepEqual(
    actors.map(({ id, outcome, files }) => ({ id, outcome, files })),
    [
      {
        id: 'U-001:red',
        outcome: plan.units[0]!.goal,
        files: plan.units[0]!.files,
      },
      {
        id: 'U-001:green',
        outcome: plan.units[0]!.goal,
        files: plan.units[0]!.files,
      },
      {
        id: 'U-002:direct',
        outcome: plan.units[1]!.goal,
        files: plan.units[1]!.files,
      },
    ],
  );
  const shellGates = manifest.steps.filter(
    (step): step is GateStep => step.kind === 'gate' && step.gate.authority === 'shell',
  );
  assert.equal(
    shellGates.every((step) => step.gate.command === plan.test_command),
    true,
  );
  const red = shellGates.find((step) => step.id === 'U-001:red:gate');
  assert.equal(red?.gate.authority === 'shell' && red.gate.calibrate, true);
  assert.equal(manifest.shipping_authorized, false);
  assert.deepEqual(
    manifest.steps
      .filter((step) => step.kind === 'action' && step.action === 'commit')
      .map((step) => step.subject),
    ['chore(u-001): preserve the value contract.', 'chore(u-002): document the value contract.'],
  );
});

test('adds only the closed Ship sequence when the Build input authorizes it', () => {
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

  assert.equal(manifest.shipping_authorized, true);
  assert.deepEqual(
    manifest.steps.slice(-3).map((step) => step.id),
    ['revalidate:ship', 'ship', 'ship:verify'],
  );
});

test('normalizes Japanese unit goals to valid commit subjects', () => {
  const { repo, head } = repository();
  const localizedPlan: BuildPlanContext = {
    ...plan,
    units: [
      {
        ...plan.units[1]!,
        id: 'U-001',
        goal: '`.codex/OUTCOME.md` を更新する',
        files: ['README.md'],
      },
      {
        ...plan.units[1]!,
        id: 'U-002',
        goal: '-v フラグを受け付ける',
        files: ['flags.md'],
      },
      {
        ...plan.units[1]!,
        id: 'U-003',
        goal: '表示を更新する',
        files: ['display.md'],
      },
    ],
  };
  const manifest = compileBuildManifest({
    repo,
    input: path.join(repo, '.build-input.json'),
    plan: localizedPlan,
    branchName: 'codex/issue-123',
    startPoint: head,
    ship: false,
  });

  assert.deepEqual(
    manifest.steps
      .filter((step) => step.kind === 'action' && step.action === 'commit')
      .map((step) => step.subject),
    [
      'chore(u-001): codex/outcome.md',
      'chore(u-002): v',
      'chore(u-003): implement published plan unit',
    ],
  );
});

test('refuses an existing Build branch at a different start point', () => {
  const { repo, head } = repository();
  spawnSync('git', ['-C', repo, 'branch', 'codex/issue-123', head]);
  fs.appendFileSync(path.join(repo, 'README.md'), 'next\n');
  spawnSync('git', ['-C', repo, 'add', 'README.md']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'next fixture']);
  const next = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();

  assert.throws(
    () =>
      compileBuildManifest({
        repo,
        input: path.join(repo, '.build-input.json'),
        plan,
        branchName: 'codex/issue-123',
        startPoint: next,
        ship: false,
      }),
    /branch_name already exists at a different commit/u,
  );
});

test('keeps the caller-authored Build input closed and small', () => {
  assert.deepEqual(
    parseBuildRunInput({
      protocol: 'codex-build-run',
      source: { repository: 'owner/repo', issue_number: 123 },
      ship: false,
    }),
    {
      protocol: 'codex-build-run',
      source: { repository: 'owner/repo', issue_number: 123 },
      ship: false,
    },
  );
  assert.throws(
    () =>
      parseBuildRunInput({
        protocol: 'codex-build-run',
        source: { repository: 'owner/repo', issue_number: 123 },
        ship: false,
        steps: [],
      }),
    /unknown key: steps/u,
  );
});
