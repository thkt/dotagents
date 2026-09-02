/** @file Outcome: Plan and manifest divergence is detected before build execution can continue. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { buildManifestPlanBlockers } from '../../flow/build/gates.ts';
import type { BuildPlanContext, FlowManifest } from '../../flow/contracts.ts';

const plan: BuildPlanContext = {
  repository: 'owner/repo',
  issue: 123,
  title: 'Feature',
  body_sha256: '0'.repeat(64),
  outcome: 'Feature is delivered.',
  test_command: 'npm test',
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

function manifest(steps: FlowManifest['steps']): FlowManifest {
  return { steps } as unknown as FlowManifest;
}

function tempRepo(existingFiles: string[] = []): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-build-gates-'));
  for (const file of existingFiles) {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

test('accepts manifest units, strategies, and scopes that match the validated Plan', () => {
  const repo = tempRepo(['src/value.ts', 'tests/value.test.ts']);
  assert.deepEqual(
    buildManifestPlanBlockers(
      manifest([
        {
          id: 'U-001:red',
          kind: 'actor',
          outcome: 'Preserve the value contract.',
          files: ['tests/value.test.ts'],
        },
        {
          id: 'U-001:green',
          kind: 'actor',
          outcome: 'Preserve the value contract.',
          files: ['src/value.ts'],
        },
        {
          id: 'U-002:direct',
          kind: 'actor',
          outcome: 'Document the value contract.',
          files: ['README.md'],
        },
      ]),
      plan,
      repo,
    ),
    [],
  );
});

test('rejects units, strategies, and scopes that diverge from the validated Plan', () => {
  const repo = tempRepo(['src/value.ts', 'tests/value.test.ts']);
  assert.deepEqual(
    buildManifestPlanBlockers(
      manifest([
        {
          id: 'U-001:direct',
          kind: 'actor',
          outcome: 'Preserve the value contract.',
          files: ['src/value.ts', 'src/extra.ts'],
        },
        {
          id: 'U-003:direct',
          kind: 'actor',
          outcome: 'Document the value contract.',
          files: ['README.md'],
        },
      ]),
      plan,
      repo,
    ),
    [
      'manifest has unit absent from Plan: U-003',
      'U-001 requires red,green actors from its Plan tests',
      'U-001 actor scope is missing Plan files: tests/value.test.ts',
      'U-001 actor scope has files absent from Plan: src/extra.ts',
      'manifest is missing Plan unit: U-002',
    ],
  );
});

test('requires initially absent tested-unit files in both Red and Green scopes', () => {
  const repo = tempRepo();
  const result = buildManifestPlanBlockers(
    manifest([
      {
        id: 'U-001:red',
        kind: 'actor',
        outcome: 'Preserve the value contract.',
        files: ['tests/value.test.ts'],
      },
      {
        id: 'U-001:green',
        kind: 'actor',
        outcome: 'Preserve the value contract.',
        files: ['src/value.ts'],
      },
      {
        id: 'U-002:direct',
        kind: 'actor',
        outcome: 'Document the value contract.',
        files: ['README.md'],
      },
    ]),
    plan,
    repo,
  );
  assert.deepEqual(result, [
    'U-001:red scope is missing initially absent Plan file: src/value.ts',
    'U-001:green scope is missing initially absent Plan file: tests/value.test.ts',
  ]);
});

test('accepts initially absent files when both actors include them', () => {
  const repo = tempRepo();
  assert.deepEqual(
    buildManifestPlanBlockers(
      manifest([
        {
          id: 'U-001:red',
          kind: 'actor',
          outcome: 'Preserve the value contract.',
          files: ['tests/value.test.ts', 'src/value.ts'],
        },
        {
          id: 'U-001:green',
          kind: 'actor',
          outcome: 'Preserve the value contract.',
          files: ['src/value.ts', 'tests/value.test.ts'],
        },
        {
          id: 'U-002:direct',
          kind: 'actor',
          outcome: 'Document the value contract.',
          files: ['README.md'],
        },
      ]),
      plan,
      repo,
    ),
    [],
  );
});

test('rejects manifest outcomes and test commands that rewrite the published Plan', () => {
  const repo = tempRepo(['src/value.ts', 'tests/value.test.ts']);
  const result = buildManifestPlanBlockers(
    manifest([
      {
        id: 'baseline:test',
        kind: 'gate',
        gate: {
          authority: 'shell',
          command: 'true',
          expect: 'pass',
          calibrate: false,
          failure_route: 'blocked',
          require_output: [],
          forbid_output: [],
        },
      },
      {
        id: 'U-001:red',
        kind: 'actor',
        outcome: 'Delete unrelated behavior.',
        files: ['tests/value.test.ts'],
      },
      {
        id: 'U-001:red:gate',
        kind: 'gate',
        owner: 'U-001:red',
        gate: {
          authority: 'shell',
          command: 'true',
          expect: 'fail',
          calibrate: true,
          failure_route: 'red:U-001',
          require_output: [],
          forbid_output: [],
        },
      },
      {
        id: 'U-001:green',
        kind: 'actor',
        outcome: 'Preserve the value contract.',
        files: ['src/value.ts'],
      },
      {
        id: 'U-002:direct',
        kind: 'actor',
        outcome: 'Document the value contract.',
        files: ['README.md'],
      },
      {
        id: 'final:test',
        kind: 'gate',
        gate: {
          authority: 'shell',
          command: 'npm test',
          expect: 'pass',
          calibrate: false,
          failure_route: 'blocked',
          require_output: [],
          forbid_output: [],
        },
      },
    ]),
    plan,
    repo,
  );
  assert.deepEqual(result, [
    'U-001:red.outcome must equal U-001.goal from the Plan',
    'baseline:test.gate.command must equal Plan test_command',
    'U-001:red:gate.gate.command must equal Plan test_command',
  ]);
});
