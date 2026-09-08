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
  waitingInvocation,
} from '../../runtime/invocation.ts';
import { handle } from '../../../hooks/workflow-enforcer.ts';
import {
  intentPath,
  workflowInputPath,
  workflowRunDirectory,
  researchStatePath,
  thinkStatePath,
  statePath,
} from '../../runtime/storage.ts';
import {
  ignoreWorkflowStorage,
  temporaryDirectory,
  useTemporaryWorkflowStorage,
} from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-invocation-storage-');

function repoFixture(): string {
  const repo = temporaryDirectory('codex-invocation-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  ignoreWorkflowStorage(repo);
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
  ignoreWorkflowStorage(repo);
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

test('a waiting root prompt surfaces the original question without re-arming or inferring a concurrent answer', async () => {
  const { runResearchWorkflow } = await import('../../research/runner.ts');
  const repo = repoFixture();
  const runId = crypto.randomUUID();
  const bound = armIntent({ runId, workflow: 'research', cwd: repo });
  const question = {
    id: 'policy',
    prompt: 'Which user-owned policy is in scope?',
    choices: [
      { label: 'Public', description: 'Public deployment.' },
      { label: 'Private', description: 'Private deployment.' },
    ],
    recommendation: 'Private',
  };
  fs.writeFileSync(
    bound.input_path,
    JSON.stringify({
      repo,
      question: 'Investigate deployment policy.',
      scope_paths: [],
      allow_external_sources: false,
    }),
  );
  const result = await runResearchWorkflow(runId, bound.input_path, {
    async investigate() {
      return { status: 'waiting', question };
    },
    async audit() {
      return { summary: 'Necessary policy decision.', findings: [] };
    },
  });
  assert(result.status === 'waiting');
  const original = fs.readFileSync(bound.input_path, 'utf8');
  for (const prompt of ['Private', '$issue Publish something else', 'Continue', '']) {
    const response = handle({
      hook_event_name: 'UserPromptSubmit',
      session_id: runId,
      cwd: repo,
      prompt,
    });
    const context = response.hookSpecificOutput?.additionalContext;
    assert(context?.includes(JSON.stringify(question)));
    assert(context?.includes(JSON.stringify(result.owner)));
    assert(context?.includes('Do not re-arm'));
    assert.equal(fs.readFileSync(bound.input_path, 'utf8'), original);
    assert.equal(fs.existsSync(intentPath(runId)), false);
  }
});

test('nonwaiting records never intercept ordinary prompts, including obsolete state outside Git', () => {
  const repo = repoFixture();
  const outside = temporaryDirectory('codex-conversation-');
  for (const workflow of ['research', 'think', 'build'] as const) {
    const phases =
      workflow === 'research'
        ? ['completed', 'blocked', 'investigate']
        : workflow === 'think'
          ? ['completed', 'blocked', 'design', 'research']
          : ['completed', 'cancelled', 'blocked', 'running'];
    for (const version of ['obsolete', 'current']) {
      for (const phase of phases) {
        const runId = crypto.randomUUID();
        const directory = workflowRunDirectory(runId);
        fs.mkdirSync(directory, { recursive: true });
        const file =
          workflow === 'research'
            ? researchStatePath(runId)
            : workflow === 'think'
              ? thinkStatePath(runId)
              : statePath(runId);
        const protocol =
          workflow === 'research'
            ? `codex-research-state-v${version === 'obsolete' ? 3 : 5}`
            : `codex-think-state-v${version === 'obsolete' ? 2 : 6}`;
        const bytes = JSON.stringify(
          workflow === 'build'
            ? { workflow, status: phase, invocation_id: runId, manifest: { repo } }
            : { state: { protocol, phase, invocation: runId, input: { repo } } },
        );
        fs.writeFileSync(file, bytes);
        // An obsolete journal is irrelevant without an unanswered pending question.
        const journal = path.join(directory, `returns-${runId}.json`);
        const journalBytes = JSON.stringify({ state: { protocol: 'obsolete', waiting: null } });
        fs.writeFileSync(journal, journalBytes);
        for (const cwd of [repo, outside]) {
          assert.equal(waitingInvocation(runId, cwd), null);
          for (const prompt of ['Explain how Array.map works.', 'Private']) {
            assert.deepEqual(
              handle({ hook_event_name: 'UserPromptSubmit', session_id: runId, cwd, prompt }),
              {},
              `${workflow} ${version} ${phase} in ${cwd}`,
            );
          }
        }
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
        assert.equal(fs.readFileSync(journal, 'utf8'), journalBytes);
        assert.equal(fs.existsSync(intentPath(runId)), false);
        assert.equal(fs.existsSync(workflowInputPath(runId, workflow)), false);
      }
    }
  }
});

for (const workflow of ['research', 'think'] as const) {
  test(`the hook validates ${workflow} acceptance before displaying any waiting question`, async () => {
    const { runResearchWorkflow } = await import('../../research/runner.ts');
    const { runThinkWorkflow } = await import('../../think/runner.ts');
    const { researchStatePath, thinkStatePath } = await import('../../runtime/storage.ts');
    const { thinkDigest } = await import('../../think/state.ts');
    const repo = repoFixture();
    const runId = crypto.randomUUID();
    const bound = armIntent({ runId, workflow, cwd: repo });
    const question = {
      id: 'deployment-policy',
      prompt: 'Which deployment policy applies?',
      choices: [
        { label: 'Public', description: 'Allow public access.' },
        { label: 'Private', description: 'Require authenticated access.' },
      ],
      recommendation: 'Private',
    };
    fs.writeFileSync(
      bound.input_path,
      JSON.stringify(
        workflow === 'research'
          ? {
              repo,
              question: 'Investigate deployment policy.',
              scope_paths: [],
              allow_external_sources: false,
            }
          : { repo, request: 'Plan the deployment.', research_reports: [] },
      ),
    );
    let calls = 0;
    const accepted = { summary: 'Necessary user-owned deployment policy.', findings: [] };
    const result =
      workflow === 'research'
        ? await runResearchWorkflow(runId, bound.input_path, {
            async investigate() {
              calls++;
              return { status: 'waiting', question };
            },
            async audit() {
              calls++;
              return accepted;
            },
          })
        : await runThinkWorkflow(runId, bound.input_path, {
            async design() {
              calls++;
              return { status: 'waiting', plan: null, research_questions: [], question };
            },
            async review() {
              calls++;
              return accepted;
            },
          });
    assert(result.status === 'waiting');
    const file = workflow === 'research' ? researchStatePath(runId) : thinkStatePath(runId);
    const original = fs.readFileSync(file, 'utf8');
    const originalInput = fs.readFileSync(bound.input_path, 'utf8');
    const callCount = calls;
    for (const field of ['question', 'review', 'dispatch', 'owner', 'history', 'context']) {
      const envelope = JSON.parse(original);
      const state = envelope.state;
      if (field === 'question') {
        if (workflow === 'think') state.candidate.question.prompt = 'Unreviewed replacement prompt';
        else {
          state.pending_question.prompt = 'Unreviewed replacement prompt';
          state.investigations[0].proposal.prompt = state.pending_question.prompt;
        }
      } else if (field === 'review')
        (state.review ?? state.audit).summary = 'Unreviewed replacement acceptance';
      else if (field === 'dispatch') state.dispatch_history.push('unreviewed-dispatch');
      else if (field === 'owner') state.pending_owner.root = 'other-root';
      else if (field === 'history') state.accepted_questions.push({ edited: true });
      else state.input.repo = '/changed-repository';
      envelope.digest = thinkDigest(state);
      fs.writeFileSync(file, JSON.stringify(envelope));
      const edited = fs.readFileSync(file, 'utf8');
      assert.throws(() => waitingInvocation(runId, repo), /owner|acceptance|state cannot resume/);
      const response = handle({
        hook_event_name: 'UserPromptSubmit',
        session_id: runId,
        cwd: repo,
        prompt: '$think Continue',
      });
      assert.equal(response.decision, 'block', field);
      assert.equal(response.hookSpecificOutput?.additionalContext, undefined, field);
      assert.equal(fs.readFileSync(file, 'utf8'), edited);
      assert.equal(fs.readFileSync(bound.input_path, 'utf8'), originalInput);
      assert.equal(fs.existsSync(intentPath(runId)), false);
      assert.equal(calls, callCount);
    }
    fs.writeFileSync(file, original);
    // An unrelated obsolete terminal record cannot hide a valid pending invocation.
    const siblingFile = workflow === 'research' ? thinkStatePath(runId) : researchStatePath(runId);
    const sibling = JSON.stringify({ state: { protocol: 'obsolete', phase: 'completed' } });
    fs.writeFileSync(siblingFile, sibling);
    assert.deepEqual(waitingInvocation(runId, repo)?.question, question);
    const displayed = handle({
      hook_event_name: 'UserPromptSubmit',
      session_id: runId,
      cwd: repo,
      prompt: 'Explain how Array.map works.',
    });
    assert.equal(displayed.decision, undefined);
    assert(displayed.hookSpecificOutput?.additionalContext?.includes(JSON.stringify(question)));
    assert.deepEqual(
      handle({
        hook_event_name: 'UserPromptSubmit',
        session_id: runId,
        cwd: repo,
        prompt: '$think Replace the waiting invocation',
      }),
      displayed,
    );
    assert.equal(
      handle({
        hook_event_name: 'UserPromptSubmit',
        session_id: runId,
        cwd: temporaryDirectory('waiting-outside-git-'),
        prompt: 'Private',
      }).decision,
      'block',
    );
    const incompatible = JSON.parse(original);
    incompatible.state.protocol = 'obsolete';
    incompatible.digest = thinkDigest(incompatible.state);
    fs.writeFileSync(file, JSON.stringify(incompatible));
    for (const prompt of ['Explain how Array.map works.', `$${workflow} Replace`]) {
      const response = handle({
        hook_event_name: 'UserPromptSubmit',
        session_id: runId,
        cwd: repo,
        prompt,
      });
      assert.equal(response.decision, 'block');
      assert.match(response.reason!, /state cannot resume/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(incompatible));
    assert.equal(fs.readFileSync(siblingFile, 'utf8'), sibling);
    assert.equal(fs.readFileSync(bound.input_path, 'utf8'), originalInput);
    assert.equal(fs.existsSync(intentPath(runId)), false);
    assert.equal(calls, callCount);
  });
}
