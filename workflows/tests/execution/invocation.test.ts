/** @file Outcome: Build shipping accepts only the approval record armed for this task and repository. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { armIntent, clearIntent, requireBuildShipApproval } from '../../invocation.ts';
import { handle } from '../../../hooks/workflow-enforcer.ts';
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

test('one task owns one runtime directory', () => {
  const runId = 'task-runtime-layout';
  const { repo } = armedApproval(runId);
  try {
    const directory = workflowRunDirectory(runId);
    assert.equal(path.dirname(intentPath(runId)), directory);
    assert.equal(path.dirname(buildShipApprovalPath(runId)), directory);
    assert.equal(path.dirname(workflowInputPath(runId)), directory);
    assert.equal(path.basename(intentPath(runId)), 'intent.json');
    assert.equal(path.basename(workflowInputPath(runId)), 'input.json');
    assert.doesNotThrow(() => requireBuildShipApproval(runId, repo));
  } finally {
    clearIntent(runId);
  }
});

const rejectedRecords: [string, (record: Record<string, unknown>) => Record<string, unknown>][] = [
  ['protocol', (record) => ({ ...record, protocol: 'codex-build-ship-approval-obsolete' })],
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

test('explicit workflows require network escalation on their first bound command', () => {
  const repo = repoFixture();
  const persistent = new Map([
    ['build', '["codex-build", "run"]'],
    ['research', '["codex-research", "run"]'],
    ['think', '["codex-think", "run"]'],
    ['issue', '["codex-issue", "draft"]'],
  ]);
  for (const workflow of ['research', 'think', 'code', 'issue', 'build'] as const) {
    const runId = `network-${workflow}`;
    try {
      const response = handle({
        hook_event_name: 'UserPromptSubmit',
        session_id: runId,
        cwd: repo,
        prompt: `$${workflow}`,
      });
      const context = response.hookSpecificOutput?.additionalContext ?? '';
      assert.match(
        context,
        workflow === 'issue'
          ? /first bound draft command itself with network escalation/u
          : workflow === 'build'
            ? /first bound Build command itself with network escalation/u
            : /first bound workflow command itself with network escalation/u,
      );
      const prefix = persistent.get(workflow);
      if (prefix) {
        assert.match(context, /request persistent approval/u);
        assert.equal(context.includes(prefix), true);
      } else {
        assert.match(context, /Do not request persistent approval/u);
      }
      if (workflow === 'issue') assert.match(context, /stop command does not require/u);
    } finally {
      clearIntent(runId);
    }
  }
});

test('an armed Build runs only through the Build-only command', () => {
  const repo = repoFixture();
  const runId = 'build-only-hook-route';
  const pending = armIntent({ runId, workflow: 'build', cwd: repo });
  try {
    const allowed = handle({
      hook_event_name: 'PreToolUse',
      session_id: runId,
      cwd: repo,
      tool_name: 'Bash',
      tool_input: { command: `codex-build run --input ${pending.input_path}` },
    });
    assert.equal(allowed.hookSpecificOutput?.permissionDecision, 'allow');
    assert.match(
      String(allowed.hookSpecificOutput?.updatedInput?.command),
      /codex-build run .* --run-id 'build-only-hook-route'$/u,
    );

    const rejected = handle({
      hook_event_name: 'PreToolUse',
      session_id: runId,
      cwd: repo,
      tool_name: 'Bash',
      tool_input: { command: `codex-code run --input ${pending.input_path}` },
    });
    assert.equal(rejected.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(String(rejected.hookSpecificOutput?.permissionDecisionReason), /codex-build/u);
  } finally {
    clearIntent(runId);
  }
});
