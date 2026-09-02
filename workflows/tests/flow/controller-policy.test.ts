/** @file Outcome: Workflow hooks bind pending and active tasks to closed, repository-safe command policies. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import * as hook from '../../../hooks/workflow-enforcer.ts';
import type { GateReport, StructuredGateResult } from '../../flow/contracts.ts';
import { runStructuredBuildGate } from '../../flow/build/gates.ts';
import { parsePublicIssueBody, renderPublicIssueBody } from '../../issue/public-contract.ts';
import { stopIssueWorkflow } from '../../issue/runner.ts';
import * as flow from '../../flow/controller.ts';
import { main as flowMain } from '../../flow/runner.ts';
import * as intent from '../../invocation.ts';
import {
  buildShipApprovalPath,
  intentPath,
  issueApprovalPath,
  workflowInputPath,
} from '../../shared/storage.ts';
import {
  enableShipping,
  fixture,
  requireActor,
  requireGate,
  startFlow,
} from './controller-fixture.ts';

const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOOKS_CONFIG = path.resolve(AGENTS_ROOT, 'hooks/hooks.json');

function structuredResult(report: GateReport | null): StructuredGateResult {
  if (!report || report.evidence.kind !== 'structured') {
    throw new Error('expected a structured gate report');
  }
  return report.evidence.report;
}

test('starts only from the manifest armed by an explicit workflow invocation', () => {
  const { manifestFile, repo } = fixture();
  const turn = 'turn-explicit-start';
  assert.throws(
    () => flow.startWorkflow(turn, manifestFile),
    /explicit \$code invocation is required/,
  );

  const pending = intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });
  assert.equal(pending.repo, fs.realpathSync(repo));
  assert.equal(intent.loadIntent(turn)?.input_path, pending.input_path);
  const storedIntent = JSON.parse(fs.readFileSync(intentPath(turn), 'utf8'));
  assert.deepEqual(Object.keys(storedIntent).sort(), ['protocol', 'repo', 'run_id', 'workflow']);
  assert.throws(
    () => flow.startWorkflow(turn, manifestFile),
    /manifest path supplied by the workflow hook/,
  );

  fs.copyFileSync(manifestFile, pending.input_path);
  assert.equal(flow.startWorkflow(turn, pending.input_path).status, 'running');
  assert.equal(intent.loadIntent(turn), null);
});

test('UserPromptSubmit arms only a leading explicit workflow invocation', () => {
  const { repo } = fixture();
  const natural = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-natural',
    cwd: repo,
    prompt: 'Please use $build when it is appropriate.',
  });
  assert.deepEqual(natural, {});
  assert.equal(intent.loadIntent('turn-natural'), null);

  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);

  const explicit = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-explicit-hook',
    cwd: repo,
    prompt: '$build #123',
  });
  const pending = intent.loadIntent('turn-explicit-hook');
  assert.equal(pending?.workflow, 'build');
  assert.equal(explicit.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(explicit.hookSpecificOutput?.additionalContext || '', /codex-flow run/);
  assert.match(
    explicit.hookSpecificOutput?.additionalContext || '',
    new RegExp(pending!.input_path),
  );
  assert.match(explicit.hookSpecificOutput?.additionalContext || '', /controller will load/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(pending!.input_path, 'utf8')), {
    protocol: 'codex-build-run',
    source: { repository: 'owner/project', issue_number: 123 },
    ship: true,
  });
});

test('Build Issue shorthand rejects invalid numbers before arming an intent', () => {
  const { repo } = fixture();
  const response = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-invalid-build-issue',
    cwd: repo,
    prompt: '$build #0',
  });

  assert.match(response.reason || '', /positive integer/);
  assert.equal(intent.loadIntent('turn-invalid-build-issue'), null);
});

test('Build input preparation failure revokes the pending intent and Ship approval', () => {
  const { repo } = fixture();
  const runId = 'turn-build-source-write-failure';
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);
  fs.mkdirSync(intent.armIntent({ runId, workflow: 'build', cwd: repo }).input_path);
  intent.clearIntent(runId);

  const response = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: runId,
    cwd: repo,
    prompt: '$build #123',
  });

  assert.equal(response.decision, 'block');
  assert.equal(intent.loadIntent(runId), null);
  assert.equal(fs.existsSync(buildShipApprovalPath(runId)), false);
});

test('UserPromptSubmit accepts a leading Codex skill link as an explicit invocation', () => {
  const { repo } = fixture();
  const linked = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-linked-hook',
    cwd: repo,
    prompt: '[$code](/Users/example/.agents/skills/code/SKILL.md) workflow smoke test',
  });
  const pending = intent.loadIntent('turn-linked-hook');
  assert.equal(pending?.workflow, 'code');
  assert.equal(linked.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(linked.hookSpecificOutput?.additionalContext || '', /codex-flow run/);

  const embedded = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-embedded-link',
    cwd: repo,
    prompt: 'Please use [$code](/Users/example/.agents/skills/code/SKILL.md) when appropriate.',
  });
  assert.deepEqual(embedded, {});
  assert.equal(intent.loadIntent('turn-embedded-link'), null);
});

test('explicit issue invocation communicates its single-publication authorization', () => {
  const { repo } = fixture();
  const response = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'turn-explicit-issue',
    cwd: repo,
    prompt: '$issue publish the reviewed plan',
  });

  assert.match(
    response.hookSpecificOutput?.additionalContext || '',
    /authorizes at most one GitHub Issue create or edit/,
  );
  assert.match(response.hookSpecificOutput?.additionalContext || '', /priority label/);
  assert.match(
    response.hookSpecificOutput?.additionalContext || '',
    /no additional publication confirmation/,
  );
  assert.match(response.hookSpecificOutput?.additionalContext || '', /codex-issue stop --input/);
  assert.deepEqual(JSON.parse(fs.readFileSync(issueApprovalPath('turn-explicit-issue'), 'utf8')), {
    protocol: 'codex-issue-approval',
    run_id: 'turn-explicit-issue',
    repo: fs.realpathSync(repo),
    operation: 'publish-one-github-issue-and-ensure-priority-label',
  });
});

test('pending Issue permits only its exact missing-Think stop command', () => {
  const { repo } = fixture();
  const turn = 'turn-stop-pending-issue';
  const pending = intent.armIntent({ runId: turn, workflow: 'issue', cwd: repo });

  const wrong = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'codex-issue stop --input /tmp/other.json' },
  });
  assert.equal(wrong.hookSpecificOutput?.permissionDecision, 'deny');

  const allowed = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-issue stop --input ${pending.input_path}` },
  });
  assert.equal(
    allowed.hookSpecificOutput?.updatedInput?.command,
    `codex-issue stop --input ${pending.input_path} --run-id '${turn}'`,
  );
  assert.match(hook.stop({ session_id: turn }).reason || '', /codex-issue stop --input/u);

  assert.equal(stopIssueWorkflow(turn, pending.input_path).classification, 'missing_decision');
  assert.deepEqual(hook.stop({ session_id: turn }), {});
  assert.equal(fs.existsSync(issueApprovalPath(turn)), false);
});

test('explicit build invocation communicates and records its single-Ship authorization', () => {
  const { repo } = fixture();
  const runId = 'turn-explicit-build-ship';
  const response = hook.handle({
    hook_event_name: 'UserPromptSubmit',
    session_id: runId,
    cwd: repo,
    prompt: '$build implement the published issue',
  });

  assert.match(
    response.hookSpecificOutput?.additionalContext || '',
    /authorizes exactly one push and one draft PR creation/,
  );
  assert.match(response.hookSpecificOutput?.additionalContext || '', /include Ship unless/);
  assert.match(response.hookSpecificOutput?.additionalContext || '', /do not request another/);
  assert.equal(fs.existsSync(buildShipApprovalPath(runId)), true);
});

test('build Ship approval is task- and repository-bound', () => {
  const { repo } = fixture();
  const runId = 'turn-build-ship-approval-binding';
  const armed = intent.armIntent({ runId, workflow: 'build', cwd: repo });
  const file = buildShipApprovalPath(runId);
  const approval = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(approval, {
    operation: 'push-and-create-one-draft-pr',
    protocol: 'codex-build-ship-approval',
    repo: armed.repo,
    run_id: runId,
  });
  assert.doesNotThrow(() => intent.requireBuildShipApproval(runId, armed.repo));

  fs.writeFileSync(file, JSON.stringify({ ...approval, repo: path.dirname(armed.repo) }));
  assert.throws(
    () => intent.requireBuildShipApproval(runId, armed.repo),
    /build Ship approval has an invalid shape/,
  );
});

test('pending intent permits workflow input preparation and blocks unrelated mutation', () => {
  const { repo } = fixture();
  const turn = 'turn-pending-policy';
  const pending = intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });

  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'rg --files' },
    }),
    {},
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'apply_patch',
      cwd: repo,
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${pending.input_path}\n*** End Patch`,
      },
    }),
    {},
  );
  assert.equal(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'apply_patch',
      cwd: repo,
      tool_input: { command: '*** Begin Patch\n*** Add File: src.js\n*** End Patch' },
    }).hookSpecificOutput?.permissionDecision,
    'deny',
  );
  assert.equal(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'touch src.js' },
    }).hookSpecificOutput?.permissionDecision,
    'deny',
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'codex-flow describe --workflow code' },
    }),
    {},
  );

  const start = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow run --input ${pending.input_path}` },
  });
  assert.equal(start.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(
    start.hookSpecificOutput?.updatedInput?.command,
    `codex-flow run --input ${pending.input_path} --run-id '${turn}'`,
  );
  assert.equal(hook.stop({ session_id: turn, stop_hook_active: false }).decision, 'block');
  const secondStop = hook.stop({ session_id: turn, stop_hook_active: true });
  assert.equal(secondStop.continue, false);
  assert.equal(secondStop.decision, undefined);
  assert.equal(intent.loadIntent(turn), null);
});

test('pending build permits only its small request file', () => {
  const { repo } = fixture();
  const turn = 'turn-pending-build-policy';
  const pending = intent.armIntent({ runId: turn, workflow: 'build', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({
      protocol: 'codex-build-run',
      source: { repository: 'owner/project', issue_number: 42 },
      ship: true,
    }),
  );
  assert.equal(fs.statSync(path.dirname(pending.input_path)).isDirectory(), true);
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'codex-flow describe --workflow build' },
    }),
    {},
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Write',
      cwd: repo,
      tool_input: { file_path: pending.input_path },
    }),
    {},
  );
  for (const command of [
    'codex-build-plan describe',
    'codex-build-revalidate describe',
    'codex-build-artifacts describe',
    'codex-build-pr-body describe',
    'gh issue view 42 --repo owner/project --json number,title,body',
    'gh issue view 43 --repo owner/project --json number,title,body,url,labels',
    'gh issue view 42 --repo other/project --json number,title,body,url,labels',
    'gh issue edit 42 --title changed',
    'gh issue view 42 --web',
    'gh issue view branch --repo owner/project',
  ]) {
    assert.equal(
      hook.preToolUse({
        hook_event_name: 'PreToolUse',
        session_id: turn,
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command },
      }).hookSpecificOutput?.permissionDecision,
      'deny',
      command,
    );
  }
});

test('pending intent rejects destructive forms of nominally read-only commands', () => {
  const { repo } = fixture();
  const turn = 'turn-pending-shell-policy';
  intent.armIntent({ runId: turn, workflow: 'code', cwd: repo });

  for (const command of [
    'ls & touch outside.js',
    'find . -delete',
    "find . -exec touch outside.js ';'",
    "sed -n 'w outside.js' README.md",
    'git branch new-branch',
    'git remote set-url origin https://example.invalid/owner/project.git',
    'gh issue edit 42 --title changed',
    'rg pattern . | head -20 && touch outside.js',
    'rg --pre touch pattern .',
    'git diff --output=outside.diff',
  ]) {
    const result = hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command },
    });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('pending Think permits common composed read-only inspection commands', () => {
  const { repo } = fixture();
  const turn = 'turn-pending-read-policy';
  intent.armIntent({ runId: turn, workflow: 'think', cwd: repo });

  for (const command of [
    "sed -n '1,20p' README.md",
    'rg pattern . | head -20',
    'grep pattern README.md',
    'find . -maxdepth 2 -type f',
    'git status --short && git branch --show-current',
    'git remote -v',
    'git remote get-url origin',
    'cd . && pwd',
    'echo fixture | sort | cut -c 1-4 | nl',
    'gh issue view 42 --repo owner/project',
  ]) {
    assert.deepEqual(
      hook.preToolUse({
        hook_event_name: 'PreToolUse',
        session_id: turn,
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command },
      }),
      {},
      command,
    );
  }
});

test('active workflow permits inspection and only its controller resume command', () => {
  const { manifestFile, repo } = fixture();
  const turn = 'turn-active-shell-policy';
  startFlow(turn, manifestFile);

  for (const command of ['touch outside.js', 'find . -delete', 'git branch new-branch']) {
    const result = hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command },
    });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: 'git status --short' },
    }),
    {},
  );
  const resumed = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow run --input ${workflowInputPath(turn)}` },
  });
  assert.equal(
    resumed.hookSpecificOutput?.updatedInput?.command,
    `codex-flow run --input ${workflowInputPath(turn)} --run-id '${turn}'`,
  );
  assert.match(hook.stop({ session_id: turn }).reason || '', /Resume its controller/u);
});

test('active Build can be cancelled only by its exact task-bound controller', async () => {
  const { manifest, manifestFile, repo, startPoint } = fixture({ workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-cancel-active-build';
  startFlow(turn, manifestFile);
  const expected = workflowInputPath(turn);

  const wrong = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'codex-flow cancel --input /tmp/other-run.json' },
  });
  assert.equal(wrong.hookSpecificOutput?.permissionDecision, 'deny');

  const allowed = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow cancel --input ${expected}` },
  });
  assert.equal(
    allowed.hookSpecificOutput?.updatedInput?.command,
    `codex-flow cancel --input ${expected} --run-id '${turn}'`,
  );

  const cancelled = (await flowMain(['cancel', '--input', expected, '--run-id', turn])).result;
  if (!('status' in cancelled)) throw new Error('missing cancellation status');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.ship_authorization_revoked, true);
  assert.equal(cancelled.current_step, null);
  assert.equal(flow.currentDirective(turn).kind, 'cancelled');
  assert.equal(flow.cancelWorkflow(turn, expected).status, 'cancelled');
  assert.deepEqual(hook.stop({ session_id: turn }), {});
  assert.equal(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: turn,
      tool_name: 'Bash',
      cwd: repo,
      tool_input: { command: `codex-flow run --input ${expected}` },
    }).hookSpecificOutput?.permissionDecision,
    'deny',
  );
  assert.equal(
    spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    startPoint,
  );
  assert.equal(
    spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim(),
    'master',
  );
  assert.equal(fs.existsSync(path.join(repo, 'src.js')), false);
});

test('Ship revalidation rejects an Issue body edited after load:plan', () => {
  const { manifest, manifestFile, repo } = fixture({ workflow: 'build' });
  enableShipping(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const turn = 'turn-stale-public-issue';
  startFlow(turn, manifestFile);
  assert.equal(flow.completeCurrentDirective(turn, 'load:plan').result.status, 'running');

  const issueFile = path.join(path.dirname(repo), 'github-issue.json');
  const issue = JSON.parse(fs.readFileSync(issueFile, 'utf8')) as Record<string, unknown>;
  const parsed = parsePublicIssueBody(String(issue.body));
  const unsealedVisibleBody = parsed.visibleBody.replace(
    /\n\n<!-- codex-issue-publication\npublication_id:[^\n]+\n-->\n\n/u,
    '\n\n',
  );
  issue.body = renderPublicIssueBody(
    `Edited after Build started.\n\n${unsealedVisibleBody}`,
    parsed.plan,
    '00000000-0000-4000-8000-000000000003',
  );
  fs.writeFileSync(issueFile, JSON.stringify(issue));

  const state = flow.loadWorkflowState(turn).state;
  const step = state.manifest.steps.find(
    (candidate) => candidate.kind === 'gate' && candidate.id === 'revalidate:ship',
  );
  if (!step || step.kind !== 'gate') throw new Error('missing Ship revalidation gate');
  const report = runStructuredBuildGate(state, step);
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.classification, 'issue_contract_stale');
  assert.deepEqual(report.reason_codes, ['issue_contract_stale']);
});

test('a cursor-zero GitHub access failure resumes only the same unchanged Build', () => {
  const { manifestFile, repo } = fixture({ workflow: 'build' });
  const gh = path.join(path.dirname(repo), 'bin', 'gh');
  const issueFile = path.join(path.dirname(repo), 'github-issue.json');
  const turn = 'turn-retry-github-access';
  startFlow(turn, manifestFile, () => {
    fs.writeFileSync(
      gh,
      "#!/bin/sh\nprintf '%s' 'error connecting to api.github.com' >&2\nexit 1\n",
      { mode: 0o700 },
    );
  });
  const expected = workflowInputPath(turn);

  const blocked = flow.completeCurrentDirective(turn, 'load:plan').result;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.cursor, 0);
  assert.equal(blocked.last_gate?.classification, 'github_issue_read_failed');
  assert.deepEqual(blocked.last_gate?.reason_codes, ['github_issue_read_failed']);
  assert.equal(structuredResult(blocked.last_gate).retryable, true);
  const legacyState = structuredClone(flow.loadWorkflowState(turn).state);
  const legacyGate = legacyState.gate_reports.at(-1);
  if (!legacyGate || legacyGate.evidence.kind !== 'structured') {
    throw new Error('missing legacy gate fixture');
  }
  legacyGate.classification = 'issue_contract_invalid';
  delete legacyGate.evidence.report.retryable;
  assert.equal(flow.isRetryableGitHubAccessBlock(legacyState), true);

  const resume = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: `codex-flow run --input ${expected}` },
  });
  assert.equal(resume.hookSpecificOutput?.permissionDecision, 'allow');
  const originalInput = fs.readFileSync(expected);
  const changedInput = JSON.parse(originalInput.toString('utf8')) as Record<string, unknown>;
  changedInput.ship = !changedInput.ship;
  fs.writeFileSync(expected, JSON.stringify(changedInput));
  assert.throws(() => flow.startOrResumeWorkflow(turn, expected), /original workflow input/);
  fs.writeFileSync(expected, originalInput);
  fs.writeFileSync(gh, `#!/bin/sh\nexec /bin/cat '${issueFile}'\n`, { mode: 0o700 });
  assert.equal(flow.startOrResumeWorkflow(turn, expected).current_step?.id, 'load:plan');
  assert.equal(flow.completeCurrentDirective(turn, 'load:plan').result.status, 'running');
});

test('a GitHub command failure is blocked at cursor zero but is not network-retryable', () => {
  const { manifestFile, repo } = fixture({ workflow: 'build' });
  const gh = path.join(path.dirname(repo), 'bin', 'gh');
  const turn = 'turn-nonretry-github-command';
  startFlow(turn, manifestFile, () => {
    fs.writeFileSync(gh, "#!/bin/sh\nprintf '%s' 'issue not found' >&2\nexit 1\n", {
      mode: 0o700,
    });
  });
  const blocked = flow.completeCurrentDirective(turn, 'load:plan').result;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.last_gate?.classification, 'github_issue_read_failed');
  assert.equal(structuredResult(blocked.last_gate).retryable, false);
  assert.equal(flow.isRetryableGitHubAccessBlock(flow.loadWorkflowState(turn).state), false);
  assert.throws(
    () => flow.startOrResumeWorkflow(turn, workflowInputPath(turn)),
    /explicit \$build invocation is required/u,
  );
});

test('malformed GitHub Issue output is a contract failure, not a network retry', () => {
  const { manifestFile, repo } = fixture({ workflow: 'build' });
  const gh = path.join(path.dirname(repo), 'bin', 'gh');
  const turn = 'turn-invalid-github-response';
  startFlow(turn, manifestFile, () => {
    fs.writeFileSync(gh, "#!/bin/sh\nprintf '%s' '{broken'\n", { mode: 0o700 });
  });
  const blocked = flow.completeCurrentDirective(turn, 'load:plan').result;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.last_gate?.classification, 'issue_contract_invalid');
  assert.equal(structuredResult(blocked.last_gate).retryable, false);
  assert.equal(flow.isRetryableGitHubAccessBlock(flow.loadWorkflowState(turn).state), false);
});

test('corrupt workflow intent blocks hook execution instead of disabling enforcement', () => {
  fixture();
  const turn = 'turn-corrupt-intent';
  const file = intentPath(turn);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const result = hook.handle({
    hook_event_name: 'PreToolUse',
    session_id: turn,
    tool_name: 'Bash',
    cwd: process.cwd(),
    tool_input: { command: 'touch outside.js' },
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    result.hookSpecificOutput?.permissionDecisionReason || '',
    /unavailable|invalid|unreadable/i,
  );
});

test('manifest validation closes action ids, scalar types, unknown keys, and actor boundaries', () => {
  const { manifest, repo } = fixture({ workflow: 'build' });

  const extraAction = structuredClone(manifest);
  extraAction.steps.push({
    id: 'extra:commit',
    kind: 'action',
    action: 'commit',
    subject: 'chore: extra fixture',
  });
  assert.throws(() => flow.validateManifest(extraAction), /commit.*id|supported action id/);

  assert.throws(
    () => flow.validateManifest({ ...structuredClone(manifest), shipping_authorized: 'false' }),
    /shipping_authorized.*boolean/,
  );
  assert.throws(
    () => flow.validateManifest({ ...structuredClone(manifest), max_corrections: '1' }),
    /max_corrections.*integer/,
  );
  assert.throws(
    () => flow.validateManifest({ ...structuredClone(manifest), unexpected: true }),
    /unknown key/,
  );

  const gitMetadata = structuredClone(manifest);
  requireActor(gitMetadata).files = ['.git/config'];
  assert.throws(() => flow.validateManifest(gitMetadata), /\.git/);

  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.js\n');
  const ignored = structuredClone(manifest);
  requireActor(ignored).files = ['ignored.js'];
  assert.throws(() => flow.validateManifest(ignored), /ignored/);

  const outside = path.join(path.dirname(repo), 'outside.js');
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(outside, path.join(repo, 'linked.js'));
  const linked = structuredClone(manifest);
  requireActor(linked).files = ['linked.js'];
  assert.throws(() => flow.validateManifest(linked), /symbolic link|repository/);
});

test('build start rejects a pre-existing staged baseline instead of deadlocking at commit', () => {
  const { manifestFile, repo } = fixture({ workflow: 'build' });
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'user staged change\n');
  spawnSync('git', ['-C', repo, 'add', 'staged.txt']);
  assert.throws(() => startFlow('turn-staged-baseline', manifestFile), /clean index.*staged\.txt/);
});

test('Plan compilation blocks pre-existing changes to an actor-owned file', () => {
  const { manifestFile, repo } = fixture({ workflow: 'build' });
  fs.writeFileSync(path.join(repo, 'src.js'), 'user change\n');
  const runId = 'turn-dirty-actor-baseline';
  startFlow(runId, manifestFile);
  const blocked = flow.completeCurrentDirective(runId, 'load:plan').result;
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.last_gate?.classification, 'scope_error');
  assert.match(String(structuredResult(blocked.last_gate).error), /clean actor files.*src\.js/);
});

test('build required gates reject vacuous shell substitutes', () => {
  const { manifest } = fixture({ workflow: 'build' });
  const load = requireGate(manifest, 'load:plan');
  load.gate = { command: 'git status --porcelain', expect: 'pass', failure_route: 'blocked' };
  assert.throws(() => flow.validateManifest(manifest), /load:plan must use build-plan authority/);
});

test('build rejects cleanup actors outside the published Plan units', () => {
  const { manifest } = fixture({ workflow: 'build' });
  const final = manifest.steps.findIndex((step) => step.id === 'final:test');
  manifest.steps.splice(
    final,
    0,
    {
      id: 'cleanup:extra',
      kind: 'actor',
      outcome: 'Change an unplanned file.',
      files: ['README.md'],
    },
    {
      id: 'cleanup:extra:gate',
      kind: 'gate',
      owner: 'cleanup:extra',
      gate: { command: 'true', expect: 'pass', failure_route: 'cleanup:extra' },
    },
  );

  assert.throws(
    () => flow.validateManifest(manifest),
    /does not accept actor outside published Plan units/u,
  );
});

test('structured gates reject shell-only configuration', () => {
  const { manifest } = fixture({ workflow: 'build' });
  for (const [key, value] of [
    ['expect', 'pass'],
    ['calibrate', false],
    ['timeout_ms', 1_000],
    ['require_output', []],
    ['forbid_output', []],
  ] as const) {
    const candidate = structuredClone(manifest);
    Object.assign(requireGate(candidate, 'load:plan').gate, { [key]: value });
    assert.throws(
      () => flow.validateManifest(candidate),
      new RegExp(`${key} is supported only by shell authority`),
    );
  }
});

test('Ship rejects a remote that is not the declared GitHub repository', () => {
  const { manifest, repo } = fixture({ workflow: 'build' });
  enableShipping(manifest);
  spawnSync('git', [
    '-C',
    repo,
    'remote',
    'set-url',
    '--push',
    'origin',
    'git@gitlab.com:owner/project.git',
  ]);
  assert.throws(() => flow.validateManifest(manifest), /must be GitHub repository owner\/project/);
});

test('hook exposes only describe without an explicit workflow', () => {
  const denied = hook.preToolUse({
    hook_event_name: 'PreToolUse',
    session_id: 'session-123',
    tool_name: 'Bash',
    tool_input: { command: `${hook.FLOW_COMMAND} run --input /tmp/manifest.json` },
  });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'session-123',
      tool_name: 'Bash',
      tool_input: { command: 'echo codex-flow run' },
    }),
    {},
  );
  assert.deepEqual(
    hook.preToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'session-123',
      tool_name: 'Bash',
      tool_input: { command: 'codex-flow describe --workflow code' },
    }),
    {},
  );
});

test('portable hook configuration covers the full explicit workflow lifecycle', () => {
  const config = JSON.parse(fs.readFileSync(HOOKS_CONFIG, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  const commands: string[] = events
    .flatMap((event) => config.hooks[event] || [])
    .flatMap((entry) => entry.hooks)
    .map((entry) => entry.command);
  assert.deepEqual(
    commands.filter((command) => command === 'codex-workflow-hook'),
    Array(3).fill('codex-workflow-hook'),
  );
});
