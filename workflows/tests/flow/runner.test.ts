/** @file Outcome: The SDK runner advances workflows without delegating controller decisions to an agent. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { actionInvocations } from '../../flow/build/actions.ts';
import {
  actorPrompt,
  ActorEscalation,
  CodexWorkflowAgent,
  evidencePrompt,
  type WorkflowAgent,
} from '../../flow/agent.ts';
import { cleanCodexEnvironment } from '../../shared/codex.ts';
import { ProgressReporter, type ProgressEvent } from '../../shared/progress.ts';
import { MANIFEST_PROTOCOL, type FlowDirective, type FlowManifest } from '../../flow/contracts.ts';
import { runIsolatedActor } from '../../flow/isolation.ts';
import { main, runWorkflow, type WorkflowRuntime } from '../../flow/runner.ts';
import { armIntent } from '../../invocation.ts';

type ActorDirective = Extract<FlowDirective, { kind: 'run-actor' }>;
type SealDirective = Extract<FlowDirective, { kind: 'seal-gate' }>;

const ACTOR_DIRECTIVE: ActorDirective = {
  kind: 'run-actor',
  step_id: 'U-001:direct',
  outcome: 'The value is written.',
  files: ['value.txt'],
  verification: { command: 'node verify.js', expect: 'pass' },
  correction: null,
};

const SEAL_DIRECTIVE: SealDirective = {
  kind: 'seal-gate',
  step_id: 'U-001:red:gate',
  calibration: {
    command: 'node test.js',
    exit_code: 1,
    stdout_tail: 'expected failure\n',
    stderr_tail: '',
    candidates: [{ id: 'stdout:L1', text: 'expected failure', test_id: 'T-001' }],
  },
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

test('uses write scope for actors and read-only scope for calibration evidence', async () => {
  const starts: unknown[] = [];
  const prompts: string[] = [];
  const responses = [
    JSON.stringify({ status: 'completed', summary: 'written', route: null, question: null }),
    JSON.stringify({ candidate_id: 'stdout:L1' }),
  ];
  const client = {
    startThread(options: unknown) {
      starts.push(options);
      return {
        async run(prompt: string) {
          prompts.push(prompt);
          return { finalResponse: responses.shift()! };
        },
      };
    },
  };
  const agent = new CodexWorkflowAgent(client);
  await agent.runActor('/tmp/repo', ACTOR_DIRECTIVE);

  assert.equal(await agent.selectEvidenceCandidate('/tmp/repo', SEAL_DIRECTIVE), 'stdout:L1');
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
  assert.match(prompts[1]!, /BEGIN OBSERVED OUTPUT [0-9a-f-]{36}/u);
  assert.match(prompts[1]!, /"id":"stdout:L1"/u);
  assert.doesNotMatch(prompts[1]!, /stdout_tail/u);
  assert.match(evidencePrompt(SEAL_DIRECTIVE, 'fixed-nonce'), /END OBSERVED OUTPUT fixed-nonce/u);
});

test('publishes only allowed changes from an isolated actor', async (t) => {
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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

test('publishes allowed changes when source ignored files drift during an isolated actor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ignored-source-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  spawnSync('git', ['-C', repo, 'add', '.gitignore']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await runIsolatedActor(repo, ['allowed.txt'], async (sandboxRepo) => {
    fs.mkdirSync(path.join(repo, 'cache'));
    fs.writeFileSync(path.join(repo, 'cache', 'external'), 'drift\n');
    fs.writeFileSync(path.join(sandboxRepo, 'allowed.txt'), 'published\n');
  });
  assert.equal(fs.readFileSync(path.join(repo, 'allowed.txt'), 'utf8'), 'published\n');
});

test('rejects an ignored path created by an isolated actor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ignored-sandbox-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  spawnSync('git', ['-C', repo, 'add', '.gitignore']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    runIsolatedActor(repo, [], async (sandboxRepo) => {
      fs.mkdirSync(path.join(sandboxRepo, 'cache'));
      fs.writeFileSync(path.join(sandboxRepo, 'cache', 'actor'), 'mutation\n');
    }),
    /changed repository control state: ignored files/u,
  );
});

test('resumes an SDK actor after a transient runner failure', async (t) => {
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
  const previousStateDirectory = process.env.CODEX_FLOW_STATE_DIR;
  process.env.CODEX_FLOW_STATE_DIR = stateDirectory;
  t.after(() => {
    if (previousStateDirectory === undefined) delete process.env.CODEX_FLOW_STATE_DIR;
    else process.env.CODEX_FLOW_STATE_DIR = previousStateDirectory;
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
  let failOnce = true;
  const agent: WorkflowAgent = {
    async runActor(actorRepo, directive) {
      actorCalls += 1;
      assert.notEqual(actorRepo, realRepo);
      assert.equal(directive.outcome, 'value.txt contains done.');
      if (failOnce) {
        failOnce = false;
        throw new Error('transient SDK failure');
      }
      fs.writeFileSync(path.join(actorRepo, 'value.txt'), 'done\n');
    },
    async selectEvidenceCandidate() {
      throw new Error('calibration is not expected');
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
  await assert.rejects(runWorkflow(runId, pending.input_path, runtime), /transient SDK failure/);
  assert.equal(fs.existsSync(path.join(repo, 'value.txt')), false);
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.equal('status' in result.result && result.result.status, 'completed');
  assert.equal('escalation' in result.result && result.result.escalation, null);
  assert.equal(actorCalls, 2);
  assert.ok(progressEvents.every((event) => event.workflow === 'code'));
  assert.ok(
    progressEvents.some(
      (event) =>
        event.stage === 'actor_model_call' &&
        event.unit_id === 'U-001' &&
        event.status === 'failed' &&
        event.classification === 'execution_error',
    ),
  );
  assert.ok(
    progressEvents.some(
      (event) => event.stage === 'gate_verification' && event.status === 'completed',
    ),
  );
});

test('blocks and discards sandbox edits on actor escalation, then resumes without recall', async (t) => {
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
  const previous = process.env.CODEX_FLOW_STATE_DIR;
  process.env.CODEX_FLOW_STATE_DIR = stateDirectory;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_FLOW_STATE_DIR;
    else process.env.CODEX_FLOW_STATE_DIR = previous;
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
      async selectEvidenceCandidate() {
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
  assert.equal(first.result.protocol, 'codex-flow-control/v5');
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

test('CLI exposes only describe and run', async () => {
  const described = await main(['describe', '--workflow', 'code']);
  assert.equal(
    'protocol' in described.result && described.result.protocol,
    'codex-flow-description/v6',
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
