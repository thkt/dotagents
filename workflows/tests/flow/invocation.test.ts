/** @file Outcome: Build shipping accepts only the approval record armed for this task and repository. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { armIntent, clearIntent, requireBuildShipApproval } from '../../invocation.ts';
import {
  buildShipApprovalPath,
  intentPath,
  workflowInputPath,
  workflowRunDirectory,
} from '../../shared/storage.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-invocation-storage-');

function repoFixture(): string {
  const repo = temporaryDirectory('codex-invocation-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  return repo;
}

function armedApproval(runId: string): { repo: string; record: Record<string, unknown> } {
  const repo = repoFixture();
  const intent = armIntent({ runId, workflow: 'build', cwd: repo });
  const record = JSON.parse(fs.readFileSync(buildShipApprovalPath(runId), 'utf8')) as Record<
    string,
    unknown
  >;
  return { repo: intent.repo, record };
}

test('the armed build Ship approval passes as written', () => {
  const runId = 'ship-approval-valid';
  const { repo } = armedApproval(runId);
  try {
    assert.doesNotThrow(() => requireBuildShipApproval(runId, repo));
  } finally {
    clearIntent(runId);
  }
});

test('one task owns one versionless runtime directory', () => {
  const runId = 'task-runtime-layout';
  const { repo } = armedApproval(runId);
  try {
    const directory = workflowRunDirectory(runId);
    assert.equal(path.dirname(intentPath(runId)), directory);
    assert.equal(path.dirname(buildShipApprovalPath(runId)), directory);
    assert.equal(path.dirname(workflowInputPath(runId)), directory);
    assert.equal(path.basename(intentPath(runId)), 'intent.json');
    assert.equal(path.basename(workflowInputPath(runId)), 'input.json');
    assert.doesNotMatch(directory, /(?:^|[/\\])v\d+(?:$|[/\\])/u);
    assert.doesNotThrow(() => requireBuildShipApproval(runId, repo));
  } finally {
    clearIntent(runId);
  }
});

const rejectedRecords: [string, (record: Record<string, unknown>) => Record<string, unknown>][] = [
  ['protocol', (record) => ({ ...record, protocol: 'codex-issue-approval/v1' })],
  ['run_id', (record) => ({ ...record, run_id: 'another-run' })],
  ['repo', (record) => ({ ...record, repo: '/elsewhere' })],
  ['operation', (record) => ({ ...record, operation: 'publish-one-github-issue' })],
  ['extra field', (record) => ({ ...record, granted_by: 'hook' })],
  ['missing field', ({ operation: _dropped, ...record }) => record],
];

for (const [name, mutate] of rejectedRecords) {
  test(`a build Ship approval with a wrong ${name} is rejected as an invalid shape`, () => {
    const runId = `ship-approval-${name.replace(' ', '-')}`;
    const { repo, record } = armedApproval(runId);
    fs.writeFileSync(buildShipApprovalPath(runId), JSON.stringify(mutate(record)));
    try {
      assert.throws(
        () => requireBuildShipApproval(runId, repo),
        /build Ship approval has an invalid shape/u,
      );
    } finally {
      clearIntent(runId);
    }
  });
}

test('a build Ship approval for another repository is rejected', () => {
  const runId = 'ship-approval-other-repo';
  armedApproval(runId);
  const other = repoFixture();
  try {
    assert.throws(
      () => requireBuildShipApproval(runId, other),
      /build Ship approval has an invalid shape/u,
    );
  } finally {
    clearIntent(runId);
  }
});
