/** @file Outcome: The SDK runner advances workflows without delegating controller decisions to an agent. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { actionInvocations } from '../../flow/build/actions.ts';
import {
  actorPrompt,
  ActorEscalation,
  buildReviewPrompt,
  CodexWorkflowAgent,
  parseBuildReviewResult,
  type WorkflowAgent,
} from '../../flow/agent.ts';
import { cleanCodexEnvironment } from '../../shared/codex-home.ts';
import { FlowError } from '../../shared/errors.ts';
import { ProgressReporter, type ProgressEvent } from '../../shared/progress.ts';
import { MANIFEST_PROTOCOL, type FlowDirective, type FlowManifest } from '../../flow/contracts.ts';
import { runIsolatedActor, runIsolatedShellVerification } from '../../flow/isolation.ts';
import { main, runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { armIntent } from '../../invocation.ts';

type ActorDirective = Extract<FlowDirective, { kind: 'run-actor' }>;
type ReviewDirective = Extract<FlowDirective, { kind: 'run-review' }>;

const ACTOR_DIRECTIVE: ActorDirective = {
  kind: 'run-actor',
  step_id: 'U-001:direct',
  outcome: 'The value is written.',
  contract: null,
  files: ['value.txt'],
  verification: { command: 'node verify.js', expect: 'pass' },
  correction: null,
};

const REVIEW_DIRECTIVE: ReviewDirective = {
  kind: 'run-review',
  step_id: 'review:build',
  input: {
    issue: 42,
    base_ref: 'abc123',
    plan: {
      repository: 'owner/repo',
      issue: 42,
      title: 'Published change',
      body_sha256: '0'.repeat(64),
      outcome: 'The value is persisted.',
      test_command: 'node --test',
      manual_verification: [],
      units: [
        {
          id: 'U-001',
          goal: 'Persist the value.',
          contract: 'Existing reads remain compatible.',
          files: ['value.ts'],
          tests: [{ id: 'T-001', name: 'persists a value' }],
          seam: false,
        },
      ],
    },
    verification: [{ gate_id: 'final:test', verdict: 'pass', classification: 'pass' }],
  },
};

const PASSING_REVIEW = {
  protocol: 'codex-build-review' as const,
  verdict: 'pass' as const,
  classification: 'pass' as const,
  reason_codes: [],
  failure_route: null,
  summary: 'The implementation satisfies the published contract.',
  findings: [],
};

test('builds a self-contained actor prompt and removes API billing credentials', () => {
  const prompt = actorPrompt(ACTOR_DIRECTIVE);
  assert.match(prompt, /The value is written\./u);
  assert.match(prompt, /value\.txt/u);
  assert.match(prompt, /node verify\.js must pass/u);
  assert.match(prompt, /Do not commit, push/u);
  assert.deepEqual(
    cleanCodexEnvironment({
      PATH: '/bin',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
      EMPTY: undefined,
    }),
    { PATH: '/bin' },
  );
});

test('validates completed and escalated actor results', async () => {
  const response = (value: unknown) => ({
    startThread() {
      return {
        async run() {
          return { finalResponse: JSON.stringify(value) };
        },
      };
    },
  });
  const run = (value: unknown, directive = ACTOR_DIRECTIVE) =>
    new CodexWorkflowAgent(response(value)).runActor('/tmp/repo', directive);
  await run({ status: 'completed', summary: 'done', route: null, question: null });
  for (const [route, summary] of [
    ['think', 'Decision missing'],
    ['research', 'Fact missing'],
  ] as const) {
    await assert.rejects(
      run({ status: 'escalated', summary, route, question: 'Which contract should apply?' }),
      (error: unknown) =>
        error instanceof ActorEscalation &&
        error.route === route &&
        error.question === 'Which contract should apply?' &&
        error.summary === summary,
    );
  }
  for (const value of [
    { status: 'unknown', summary: 'bad', route: null, question: null },
    { status: 'completed', summary: 'bad', route: 'think', question: null },
    { status: 'escalated', summary: 'bad', route: 'think', question: '' },
  ])
    await assert.rejects(run(value), /invalid actor result/u);
});

test('actor prompt includes escalation and sandbox discard guidance', () => {
  const prompt = actorPrompt(ACTOR_DIRECTIVE);
  assert.match(prompt, /escalate to think/u);
  assert.match(prompt, /facts or evidence are missing, escalate to research/u);
  assert.match(prompt, /corrected locally/u);
  assert.match(prompt, /discards all sandbox edits/u);
  assert.match(
    prompt,
    /status: completed with route and question set to null; on handoff use status: escalated with a think\/research route and a concrete question/u,
  );
});

test('gives Red actors executable-test and scaffold constraints', () => {
  const prompt = actorPrompt({ ...ACTOR_DIRECTIVE, step_id: 'U-001:red' });
  assert.match(
    prompt,
    /discoverable and runnable, with the intended new behavior failing at an assertion/u,
  );
  assert.match(prompt, /smallest API scaffold/u);
  assert.match(prompt, /invalid Red evidence/u);
});

test('binds semantic review to the published Plan and rejects inconsistent verdicts', () => {
  const prompt = buildReviewPrompt(REVIEW_DIRECTIVE, 'fixed-nonce');
  assert.match(prompt, /diff from abc123 through HEAD/u);
  assert.match(prompt, /Existing reads remain compatible/u);
  assert.match(prompt, /END PUBLISHED BUILD CONTRACT fixed-nonce/u);
  assert.deepEqual(parseBuildReviewResult(PASSING_REVIEW), PASSING_REVIEW);
  assert.throws(
    () =>
      parseBuildReviewResult({
        ...PASSING_REVIEW,
        findings: [
          {
            severity: 'blocking',
            code: 'contract_regression',
            message: 'Existing reads fail.',
            files: ['value.ts'],
          },
        ],
      }),
    /invalid semantic verdict/u,
  );
});

test('uses write scope for actors and read-only scope for semantic review', async () => {
  const starts: unknown[] = [];
  const prompts: string[] = [];
  const idleCodes: string[] = [];
  const responses = [
    JSON.stringify({ status: 'completed', summary: 'written', route: null, question: null }),
    JSON.stringify(PASSING_REVIEW),
  ];
  const client = {
    startThread(options: unknown) {
      starts.push(options);
      return {
        async run(prompt: string, turnOptions: { modelRun: { idleCode: string } }) {
          prompts.push(prompt);
          idleCodes.push(turnOptions.modelRun.idleCode);
          return { finalResponse: responses.shift()! };
        },
      };
    },
  };
  const agent = new CodexWorkflowAgent(client);
  await agent.runActor('/tmp/repo', ACTOR_DIRECTIVE);

  assert.deepEqual(await agent.reviewBuild('/tmp/repo', REVIEW_DIRECTIVE), PASSING_REVIEW);
  assert.deepEqual(starts, [
    {
      model: 'gpt-5.6-luna',
      modelReasoningEffort: 'low',
      workingDirectory: '/tmp/repo',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    },
    {
      model: 'gpt-5.6-sol',
      modelReasoningEffort: 'high',
      workingDirectory: '/tmp/repo',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    },
  ]);
  assert.deepEqual(idleCodes, ['actor_model_idle_timeout', 'build_review_idle_timeout']);
  assert.match(prompts[1]!, /BEGIN PUBLISHED BUILD CONTRACT [0-9a-f-]{36}/u);
});

test('publishes only allowed changes from an isolated actor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-isolated-actor-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, 'allowed.txt'), 'before\n');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'before\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    runIsolatedActor(repo, ['allowed.txt'], async (sandboxRepo) => {
      fs.writeFileSync(path.join(sandboxRepo, 'allowed.txt'), 'discarded\n');
      fs.writeFileSync(path.join(sandboxRepo, 'outside.txt'), 'outside\n');
    }),
    /outside its declared scope: outside\.txt/u,
  );
  assert.equal(fs.readFileSync(path.join(repo, 'allowed.txt'), 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(path.join(repo, 'outside.txt'), 'utf8'), 'before\n');

  await runIsolatedActor(repo, ['allowed.txt'], async (sandboxRepo) => {
    fs.writeFileSync(path.join(sandboxRepo, 'allowed.txt'), 'after\n');
  });
  assert.equal(fs.readFileSync(path.join(repo, 'allowed.txt'), 'utf8'), 'after\n');
});

test('blocks without running a shell gate when repository isolation cannot be created', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-isolation-failure-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = runIsolatedShellVerification({
    gateId: 'baseline:test',
    failureRoute: 'blocked',
    cwd,
    expect: 'pass',
    command: 'touch must-not-exist',
    timeoutMs: 1_000,
    tailBytes: 1_000,
    requiredOutput: [],
    forbiddenOutput: [],
  });

  assert.equal(result.processExitCode, 2);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.report.verdict, 'blocked');
  assert.equal(result.report.classification, 'gate_isolation_failed');
  assert.deepEqual(result.report.reason_codes, ['gate_isolation_failed']);
  assert.equal(fs.existsSync(path.join(cwd, 'must-not-exist')), false);
});

test('publishes allowed changes when source ignored files drift during an isolated actor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ignored-source-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  spawnSync('git', ['-C', repo, 'add', '.gitignore']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  await runIsolatedActor(repo, ['allowed.txt'], async (sandboxRepo) => {
    fs.mkdirSync(path.join(repo, 'cache'));
    fs.writeFileSync(path.join(repo, 'cache', 'external'), 'drift\n');
    fs.writeFileSync(path.join(sandboxRepo, 'allowed.txt'), 'published\n');
  });
  assert.equal(fs.readFileSync(path.join(repo, 'allowed.txt'), 'utf8'), 'published\n');
});

test('rejects an ignored path created by an isolated actor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ignored-sandbox-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  spawnSync('git', ['-C', repo, 'add', '.gitignore']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    runIsolatedActor(repo, [], async (sandboxRepo) => {
      fs.mkdirSync(path.join(sandboxRepo, 'cache'));
      fs.writeFileSync(path.join(sandboxRepo, 'cache', 'actor'), 'mutation\n');
    }),
    /changed repository control state: ignored files/u,
  );
});

test('blocks in-process actor errors and retries only model unavailability', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sdk-runner-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  fs.writeFileSync(
    path.join(repo, 'verify.js'),
    "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt', 'utf8') === 'done\\n' ? 0 : 1);\n",
  );
  spawnSync('git', ['-C', repo, 'add', 'README.md', 'verify.js']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);

  const stateDirectory = path.join(root, 'state');
  const previousStateDirectory = process.env.CODEX_FLOW_RUNTIME_DIR;
  process.env.CODEX_FLOW_RUNTIME_DIR = stateDirectory;
  onTestFinished(() => {
    if (previousStateDirectory === undefined) delete process.env.CODEX_FLOW_RUNTIME_DIR;
    else process.env.CODEX_FLOW_RUNTIME_DIR = previousStateDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manifest: FlowManifest = {
    protocol: MANIFEST_PROTOCOL,
    workflow: 'code',
    repo,
    max_corrections: 1,
    shipping_authorized: false,
    steps: [
      {
        id: 'baseline:test',
        kind: 'gate',
        gate: {
          authority: 'shell',
          command: 'git status --porcelain',
          expect: 'pass',
          failure_route: 'blocked',
          calibrate: false,
          require_output: [],
          forbid_output: [],
        },
      },
      {
        id: 'U-001:direct',
        kind: 'actor',
        outcome: 'value.txt contains done.',
        files: ['value.txt'],
      },
      {
        id: 'U-001:direct:gate',
        kind: 'gate',
        owner: 'U-001:direct',
        gate: {
          authority: 'shell',
          command: 'node verify.js',
          expect: 'pass',
          failure_route: 'direct:U-001',
          calibrate: false,
          require_output: [],
          forbid_output: [],
        },
      },
      {
        id: 'final:test',
        kind: 'gate',
        gate: {
          authority: 'shell',
          command: 'node verify.js',
          expect: 'pass',
          failure_route: 'blocked',
          calibrate: false,
          require_output: [],
          forbid_output: [],
        },
      },
    ],
  };
  const runId = 'sdk-runner';
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  const realRepo = fs.realpathSync(repo);
  fs.mkdirSync(path.dirname(pending.input_path), { recursive: true });
  fs.writeFileSync(pending.input_path, JSON.stringify(manifest));

  let actorCalls = 0;
  const failures: Error[] = [
    new Error('invalid actor result'),
    new FlowError('model stream unavailable', 'model_unavailable'),
  ];
  const agent: WorkflowAgent = {
    async runActor(actorRepo, directive, onActivity) {
      actorCalls += 1;
      assert.notEqual(actorRepo, realRepo);
      assert.equal(directive.outcome, 'value.txt contains done.');
      assert.ok(onActivity);
      onActivity?.({ event_type: 'turn.started', event_count: actorCalls });
      const failure = failures.shift();
      if (failure) throw failure;
      fs.writeFileSync(path.join(actorRepo, 'value.txt'), 'done\n');
    },
    async reviewBuild() {
      throw new Error('build review is not expected');
    },
  };
  const progressEvents: ProgressEvent[] = [];
  const runtime: WorkflowRuntime = {
    agent,
    progress: new ProgressReporter({
      write: (line) => progressEvents.push(JSON.parse(line) as ProgressEvent),
      setInterval: () => ({}),
      clearInterval: () => undefined,
    }),
    executeAction() {
      throw new Error('actions are not expected');
    },
  };
  const terminalFailure = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(terminalFailure.exitCode, 2);
  assert.equal('status' in terminalFailure.result && terminalFailure.result.status, 'blocked');
  if (!('runtime_failure' in terminalFailure.result)) throw new Error('missing runtime failure');
  assert.equal(terminalFailure.result.runtime_failure?.step_id, 'U-001:direct');
  assert.equal(terminalFailure.result.runtime_failure?.stage, 'actor_model_call');
  assert.equal(terminalFailure.result.runtime_failure?.classification, 'execution_error');
  assert.equal(terminalFailure.result.runtime_failure?.error, 'invalid actor result');
  assert.equal(terminalFailure.result.runtime_failure?.retryable, false);
  assert.match(terminalFailure.result.runtime_failure?.repository_sha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(repo, 'value.txt')), false);
  const unchanged = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal('status' in unchanged.result && unchanged.result.status, 'blocked');
  assert.equal(actorCalls, 1);

  await main(['cancel', '--manifest', pending.input_path, '--run-id', runId]);
  armIntent({ runId, workflow: 'code', cwd: repo });
  const unavailable = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(unavailable.exitCode, 2);
  if (!('runtime_failure' in unavailable.result)) throw new Error('missing runtime failure');
  assert.equal(unavailable.result.runtime_failure?.classification, 'model_unavailable');
  assert.equal(unavailable.result.runtime_failure?.retryable, true);
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed\n');
  await assert.rejects(
    runWorkflow(runId, pending.input_path, runtime),
    /repository changed after the retryable runtime failure/u,
  );
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.equal('status' in result.result && result.result.status, 'completed');
  assert.equal('escalation' in result.result && result.result.escalation, null);
  assert.equal(actorCalls, 3);
  assert.ok(progressEvents.every((event) => event.workflow === 'code'));
  assert.ok(
    progressEvents.some(
      (event) =>
        event.stage === 'actor_model_call' &&
        event.unit_id === 'U-001' &&
        event.status === 'failed' &&
        event.classification === 'model_unavailable',
    ),
  );
  assert.ok(
    progressEvents.some(
      (event) => event.stage === 'gate_verification' && event.status === 'completed',
    ),
  );
});

test('blocks and discards sandbox edits on actor escalation, then resumes without recall', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-escalation-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  const stateDirectory = path.join(root, 'state');
  const previous = process.env.CODEX_FLOW_RUNTIME_DIR;
  process.env.CODEX_FLOW_RUNTIME_DIR = stateDirectory;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.CODEX_FLOW_RUNTIME_DIR;
    else process.env.CODEX_FLOW_RUNTIME_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manifest: FlowManifest = {
    protocol: MANIFEST_PROTOCOL,
    workflow: 'code',
    repo,
    max_corrections: 1,
    shipping_authorized: false,
    steps: [
      {
        id: 'baseline:test',
        kind: 'gate',
        gate: {
          authority: 'shell',
          command: 'git status --porcelain',
          expect: 'pass',
          failure_route: 'blocked',
          calibrate: false,
          require_output: [],
          forbid_output: [],
        },
      },
      { id: 'U-001:direct', kind: 'actor', outcome: 'value.txt is written.', files: ['value.txt'] },
      {
        id: 'U-001:direct:gate',
        kind: 'gate',
        owner: 'U-001:direct',
        gate: {
          authority: 'shell',
          command: 'true',
          expect: 'pass',
          failure_route: 'direct:U-001',
          calibrate: false,
          require_output: [],
          forbid_output: [],
        },
      },
      {
        id: 'final:test',
        kind: 'gate',
        gate: {
          authority: 'shell',
          command: 'true',
          expect: 'pass',
          failure_route: 'blocked',
          calibrate: false,
          require_output: [],
          forbid_output: [],
        },
      },
    ],
  };
  const runId = 'escalation-run';
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  fs.mkdirSync(path.dirname(pending.input_path), { recursive: true });
  fs.writeFileSync(pending.input_path, JSON.stringify(manifest));
  let actorCalls = 0;
  const runtime: WorkflowRuntime = {
    agent: {
      async runActor(actorRepo) {
        actorCalls += 1;
        fs.writeFileSync(path.join(actorRepo, 'value.txt'), 'discarded\n');
        throw new ActorEscalation('think', 'Which contract should apply?', 'Decision missing');
      },
      async reviewBuild() {
        throw new Error('not expected');
      },
    },
    executeAction() {
      throw new Error('not expected');
    },
  };
  const first = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(first.exitCode, 2);
  assert.equal('status' in first.result && first.result.status, 'blocked');
  assert.equal(first.result.protocol, 'codex-flow-control');
  assert.deepEqual('escalation' in first.result && first.result.escalation, {
    step_id: 'U-001:direct',
    next_step: 'think',
    question: 'Which contract should apply?',
    summary: 'Decision missing',
  });
  assert.equal(fs.existsSync(path.join(repo, 'value.txt')), false);
  const second = await runWorkflow(runId, pending.input_path, runtime);
  assert.deepEqual(
    'escalation' in second.result && second.result.escalation,
    'escalation' in first.result && first.result.escalation,
  );
  assert.equal(actorCalls, 1);
});

test('CLI exposes only describe, run, and task-bound cancel', async () => {
  const described = await main(['describe', '--workflow', 'code']);
  assert.equal(
    'protocol' in described.result && described.result.protocol,
    'codex-flow-description',
  );
  await assert.rejects(main(['status']), /unknown command: status/);
  await assert.rejects(
    main(['describe', '--workflow', 'code', '--extra', 'value']),
    /unsupported flag: --extra/,
  );
});

test('derives action subprocess arguments from typed controller parameters', () => {
  const directive: Extract<FlowDirective, { kind: 'run-action' }> = {
    kind: 'run-action',
    step_id: 'branch',
    action: 'branch',
    parameters: {
      branch_name: 'codex/unit',
      start_point: 'abc123',
    },
  };
  assert.deepEqual(actionInvocations('/repo', directive), [
    {
      executable: 'git',
      args: ['-C', '/repo', 'switch', '-c', 'codex/unit', 'abc123'],
    },
  ]);
});

test('actor prompt requires declared screenshots at controller-owned paths', () => {
  const prompt = actorPrompt({
    ...ACTOR_DIRECTIVE,
    screenshots: [{ path: '/tmp/run/screenshots/home.png', name: 'home.png', alt: 'Home screen' }],
  });
  assert.match(prompt, /capture these exact screenshots/u);
  assert.match(prompt, /\/tmp\/run\/screenshots\/home\.png — Home screen/u);
  assert.match(prompt, /do not add them to the repository/u);
});
