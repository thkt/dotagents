/** @file Outcome: Build shipping accepts only the approval record armed for this task and repository. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  armIntent,
  clearIntent,
  consumeIssueApproval,
  loadIntent,
  requireBuildShipApproval,
  requireWorkflowInput,
} from '../../runtime/invocation.ts';
import { handle } from '../../../hooks/workflow-enforcer.ts';
import { intentPath, workflowInputPath, workflowRunDirectory } from '../../runtime/storage.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-invocation-storage-');

function repoFixture(): string {
  const repo = temporaryDirectory('codex-invocation-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex/OUTCOME.md'), '# Project outcome\n\nTest.\n');
  return repo;
}

function armedApproval(runId: string): { repo: string; record: Record<string, unknown> } {
  const repo = repoFixture();
  const intent = armIntent({ runId, workflow: 'build', cwd: repo });
  const record = JSON.parse(fs.readFileSync(intentPath(runId), 'utf8')) as Record<string, unknown>;
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
    assert.equal(path.dirname(workflowInputPath(runId, 'build')), directory);
    assert.equal(path.basename(intentPath(runId)), 'intent.json');
    assert.equal(path.basename(workflowInputPath(runId, 'build')), 'build-input.json');
    assert.doesNotThrow(() => requireBuildShipApproval(runId, repo));
  } finally {
    clearIntent(runId);
  }
});

const rejectedRecords: [string, (record: Record<string, unknown>) => Record<string, unknown>][] = [
  ['protocol', (record) => ({ ...record, protocol: 'codex-build-ship-approval-obsolete' })],
  ['run_id', (record) => ({ ...record, run_id: 'another-run' })],
  ['repo', (record) => ({ ...record, repo: '/elsewhere' })],
  ['authorization', (record) => ({ ...record, authorization: 'publish-one-github-issue' })],
  ['extra field', (record) => ({ ...record, granted_by: 'hook' })],
  ['missing field', ({ authorization: _dropped, ...record }) => record],
];

for (const [name, mutate] of rejectedRecords) {
  test(`a build Ship approval with a wrong ${name} is rejected as an invalid shape`, () => {
    const runId = `ship-approval-${name.replace(' ', '-')}`;
    const { repo, record } = armedApproval(runId);
    fs.writeFileSync(intentPath(runId), JSON.stringify(mutate(record)));
    try {
      assert.throws(
        () => requireBuildShipApproval(runId, repo),
        /workflow intent has an invalid shape|explicit \$build authorization/u,
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
      /workflow intent has an invalid shape|explicit \$build authorization/u,
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

test('an explicit workflow asks for project outcome creation before arming', () => {
  const repo = temporaryDirectory('codex-invocation-missing-outcome-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  for (const workflow of ['research', 'think', 'code', 'issue', 'build'] as const) {
    const runId = `missing-project-outcome-${workflow}`;
    const response = handle({
      hook_event_name: 'UserPromptSubmit',
      session_id: runId,
      cwd: repo,
      prompt: `$${workflow}`,
    });

    assert.equal(response.decision, 'block');
    assert.match(String(response.reason), /OUTCOME\.md is missing; create it/u);
    assert.match(String(response.reason), /verifiable completion criteria/u);
    assert.equal(loadIntent(runId), null);
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

    assert.throws(
      () => requireWorkflowInput(runId, 'code', pending.input_path),
      /explicit \$code invocation is required/u,
    );
  } finally {
    clearIntent(runId);
  }
});

test('switching workflows selects a separate input and replaces publication authority', () => {
  const repo = repoFixture();
  const runId = 'switch-workflow-input';
  const build = armIntent({ runId, workflow: 'build', cwd: repo });
  fs.writeFileSync(build.input_path, JSON.stringify({ repo, issue_number: 4 }));
  const think = armIntent({ runId, workflow: 'think', cwd: repo });
  assert.notEqual(think.input_path, build.input_path);
  assert.equal(fs.existsSync(think.input_path), false);
  assert.equal(loadIntent(runId)?.workflow, 'think');
  assert.throws(() => requireBuildShipApproval(runId, repo), /authorization is required/u);
  clearIntent(runId);
});

test('one Issue invocation authorizes exactly one publication attempt', () => {
  const repo = repoFixture();
  const runId = 'issue-consumed-once';
  armIntent({ runId, workflow: 'issue', cwd: repo });
  assert.throws(() => consumeIssueApproval(runId, repoFixture()), /authorization is required/u);
  consumeIssueApproval(runId, repo);
  assert.throws(() => consumeIssueApproval(runId, repo), /authorization is required/u);
  assert.equal(loadIntent(runId), null);
});

test('host binding rejects forged task ids before dispatching a workflow command', () => {
  const result = handle({
    hook_event_name: 'PreToolUse',
    session_id: 'real-task',
    tool_name: 'Bash',
    tool_input: { command: 'codex-build run --input /tmp/input.json --run-id other-task' },
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput?.permissionDecisionReason ?? '', /omit --run-id/u);
});
