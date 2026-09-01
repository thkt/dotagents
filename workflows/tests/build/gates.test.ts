/** @file Outcome: Plan and manifest divergence is detected before build execution can continue. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildManifestPlanBlockers } from '../../flow/build/gates.ts';
import type { BuildPlanContext, FlowManifest } from '../../flow/contracts.ts';

const plan: BuildPlanContext = {
  repository: 'owner/repo',
  issue: 123,
  title: 'Feature',
  body_sha256: '0'.repeat(64),
  manual_verification: [],
  units: [
    {
      id: 'U-001',
      contract: 'tested behavior',
      files: ['src/value.ts', 'tests/value.test.ts'],
      tests: [{ id: 'T-001', name: 'empty input returns an error' }],
      seam: false,
    },
    {
      id: 'U-002',
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

function tempRepo(t: TestContext, existingFiles: string[] = []): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-build-gates-'));
  for (const file of existingFiles) {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

test('accepts manifest units, strategies, and scopes that match the validated Plan', (t) => {
  const repo = tempRepo(t, ['src/value.ts', 'tests/value.test.ts']);
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

test('rejects units, strategies, and scopes that diverge from the validated Plan', (t) => {
  const repo = tempRepo(t, ['src/value.ts', 'tests/value.test.ts']);
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

test('requires initially absent tested-unit files in both Red and Green scopes', (t) => {
  const repo = tempRepo(t);
  const result = buildManifestPlanBlockers(
    manifest([
      { id: 'U-001:red', kind: 'actor', outcome: 'x', files: ['tests/value.test.ts'] },
      { id: 'U-001:green', kind: 'actor', outcome: 'x', files: ['src/value.ts'] },
      { id: 'U-002:direct', kind: 'actor', outcome: 'x', files: ['README.md'] },
    ]),
    plan,
    repo,
  );
  assert.deepEqual(result, [
    'U-001:red scope is missing initially absent Plan file: src/value.ts',
    'U-001:green scope is missing initially absent Plan file: tests/value.test.ts',
  ]);
});

test('accepts initially absent files when both actors include them', (t) => {
  const repo = tempRepo(t);
  assert.deepEqual(
    buildManifestPlanBlockers(
      manifest([
        {
          id: 'U-001:red',
          kind: 'actor',
          outcome: 'x',
          files: ['tests/value.test.ts', 'src/value.ts'],
        },
        {
          id: 'U-001:green',
          kind: 'actor',
          outcome: 'x',
          files: ['src/value.ts', 'tests/value.test.ts'],
        },
        { id: 'U-002:direct', kind: 'actor', outcome: 'x', files: ['README.md'] },
      ]),
      plan,
      repo,
    ),
    [],
  );
});
