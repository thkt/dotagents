/** @file Outcome: The shared runner applies isolated actor changes and executes verification. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { CodexWorkflowAgent, type WorkflowAgent } from '../../execution/agent.ts';
import type { BuildReviewInput } from '../../execution/contracts.ts';
import { runWorkflow, workflowMain, type WorkflowRuntime } from '../../execution/engine.ts';
import { statePath } from '../../runtime/storage.ts';
import { armIntent } from '../../runtime/invocation.ts';
import { FlowError } from '../../shared/errors.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-runner-tests-');

function reviewResult(input: BuildReviewInput) {
  return {
    protocol: 'codex-build-review-candidate' as const,
    step_id: 'review:build' as const,
    source_digest: input.source_digest,
    actor_receipt_digest: input.actor_receipt_digest,
    dispatch_id: input.dispatch_id,
    summary: 'pass',
    findings: [],
  };
}

function repository(): string {
  const repo = temporaryDirectory('codex-runner-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Runner Test',
    '-c',
    'user.email=runner@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

function codeInput(repo: string, runId: string, testCommand = 'git diff --check') {
  const pending = armIntent({ runId, workflow: 'code', cwd: repo });
  fs.writeFileSync(
    pending.input_path,
    JSON.stringify({
      repo,
      request: '値を更新する',
      scope_paths: ['src'],
      test_command: testCommand,
    }),
  );
  return pending;
}

test('a competing runner and cancellation cannot dispatch; a killed worker resumes with a new attempt', async () => {
  const repo = repository();
  const runId = crypto.randomUUID();
  const pending = codeInput(repo, runId);
  const script = path.join(temporaryDirectory('runner-process-'), 'worker.ts');
  const engine = path.resolve(import.meta.dir, '../../execution/engine.ts');
  fs.writeFileSync(
    script,
    `import {runWorkflow} from ${JSON.stringify(engine)};
    await runWorkflow(${JSON.stringify(runId)}, ${JSON.stringify(pending.input_path)}, {
      agent: {async runActor(repo, directive) { console.log(JSON.stringify({attempt:directive.binding.attempt, sandbox:repo})); await new Promise(() => setInterval(() => {}, 1000)); }, async reviewBuild(){ throw Error('unexpected'); }}, executeAction(){throw Error('unexpected');}
    });`,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let sandbox: string | undefined;
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const started = JSON.parse(new TextDecoder().decode(first.value));
    sandbox = started.sandbox;
    const before = fs.readFileSync(statePath(runId), 'utf8');
    const agent: WorkflowAgent = {
      async runActor(sandboxRepo, directive) {
        assert.ok(directive.binding.attempt > started.attempt);
        fs.writeFileSync(path.join(sandboxRepo, 'src/value.ts'), 'export const value = 3;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'reconstructed',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_repo, directive) {
        return reviewResult(directive.input);
      },
    };
    await assert.rejects(
      runWorkflow(runId, pending.input_path, { agent, executeAction() {} }),
      /active runtime owner/,
    );
    await assert.rejects(
      workflowMain('code', ['cancel', '--run-id', runId, '--input', pending.input_path]),
      /active runtime owner/,
    );
    assert.throws(() => armIntent({ runId, workflow: 'code', cwd: repo }), /active runtime owner/);
    assert.equal(fs.readFileSync(statePath(runId), 'utf8'), before);
    assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 1/);
    child.kill('SIGKILL');
    await child.exited;
    const recovered = await runWorkflow(runId, pending.input_path, {
      agent,
      executeAction() {
        throw Error('Code Git action');
      },
    });
    assert.equal(recovered.exitCode, 0);
    assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 3/);
  } finally {
    child.kill();
    await child.exited;
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Code runs the shared actor and test without invoking any Git action', async () => {
  const repo = repository();
  const runId = `runner-code-${crypto.randomUUID()}`;
  const pending = codeInput(repo, runId);
  let actions = 0;
  const agent: WorkflowAgent = {
    async runActor(sandboxRepo, directive) {
      fs.writeFileSync(path.join(sandboxRepo, 'src/value.ts'), 'export const value = 2;\n');
      return {
        protocol: 'codex-flow-actor-result',
        binding: directive.binding,
        status: 'completed',
        summary: 'done',
        route: null,
        question: null,
      };
    },
    async reviewBuild(_repo, directive) {
      return reviewResult(directive.input);
    },
  };
  const runtime: WorkflowRuntime = {
    agent,
    executeAction() {
      actions += 1;
    },
  };
  const result = await runWorkflow(runId, pending.input_path, runtime);
  assert.equal(result.exitCode, 0);
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'completed');
  assert.equal(actions, 0);
  assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 2/u);
});

test('an invalid actor result blocks without publishing its sandbox', async () => {
  const repo = repository();
  const runId = `runner-actor-invalid-${crypto.randomUUID()}`;
  const pending = codeInput(repo, runId);
  let calls = 0;
  const agent: WorkflowAgent = {
    async runActor(sandboxRepo) {
      calls += 1;
      fs.writeFileSync(
        path.join(sandboxRepo, 'src/value.ts'),
        `export const value = ${calls + 1};\n`,
      );
      throw new FlowError(
        'completed result must have null route and question',
        'actor_result_invalid',
      );
    },
    async reviewBuild(_repo, directive) {
      return reviewResult(directive.input);
    },
  };

  const result = await runWorkflow(runId, pending.input_path, { agent, executeAction() {} });
  assert.equal(result.exitCode, 2);
  assert.equal(calls, 1);
  assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 1/u);
  assert.ok('runtime_failure' in result.result);
  assert.equal(result.result.runtime_failure?.classification, 'actor_result_invalid');
  assert.match(
    result.result.runtime_failure?.error ?? '',
    /completed result must have null route/u,
  );
});

test('an unsupported handoff continues in the same sandbox and publishes only completion', async () => {
  const repo = repository();
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex/OUTCOME.md'), '# Outcome\nUpdate the value.');
  const pending = codeInput(repo, `runner-handoff-${crypto.randomUUID()}`);
  let calls = 0;
  let starts = 0;
  let reviews = 0;
  const agent = new CodexWorkflowAgent({
    startThread(options) {
      const file = path.join(options!.workingDirectory!, 'src/value.ts');
      assert.notEqual(options!.workingDirectory, repo);
      if (options?.sandboxMode === 'read-only') {
        return {
          async run(prompt) {
            reviews += 1;
            if (prompt.includes('Review review:build'))
              return { finalResponse: JSON.stringify({ summary: 'pass', findings: [] }) };
            assert.match(fs.readFileSync(file, 'utf8'), /value = 2/u);
            assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 1/u);
            return {
              finalResponse: JSON.stringify({
                decision: 'continue',
                reason: 'Complete the authorized value update.',
              }),
            };
          },
        };
      }
      starts += 1;
      return {
        async run() {
          calls += 1;
          if (calls === 1) {
            fs.writeFileSync(file, 'export const value = 2;\n');
            return {
              finalResponse: JSON.stringify({
                status: 'escalated',
                route: 'think',
                question: 'Please provide another implementation turn.',
                summary: 'Partial progress.',
              }),
            };
          }
          assert.match(fs.readFileSync(file, 'utf8'), /value = 2/u);
          fs.writeFileSync(file, 'export const value = 3;\n');
          return {
            finalResponse: JSON.stringify({
              status: 'completed',
              route: null,
              question: null,
              summary: 'Implemented and verified.',
            }),
          };
        },
      };
    },
  });
  const result = await runWorkflow(pending.run_id, pending.input_path, {
    agent,
    executeAction() {
      throw new Error('Code must not perform Git actions');
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(starts, 1);
  assert.equal(calls, 2);
  assert.equal(reviews, 2);
  assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 3/u);
});

test('a failing repository test stops the flow', async () => {
  const repo = repository();
  const runId = `runner-fail-${crypto.randomUUID()}`;
  const pending = codeInput(repo, runId, 'false');
  let calls = 0;
  const agent: WorkflowAgent = {
    async runActor(_repo, directive) {
      calls += 1;
      return {
        protocol: 'codex-flow-actor-result',
        binding: directive.binding,
        status: 'completed',
        summary: 'done',
        route: null,
        question: null,
      };
    },
    async reviewBuild(_repo, directive) {
      return reviewResult(directive.input);
    },
  };
  const result = await runWorkflow(runId, pending.input_path, { agent, executeAction() {} });
  assert.equal(result.exitCode, 2);
  assert.ok('status' in result.result);
  assert.equal(result.result.status, 'blocked');
  assert.equal(result.result.last_gate?.gate_id, 'test:implementation');
  assert.equal(calls, 4);
  const before = fs.readFileSync(statePath(runId), 'utf8');
  const resumed = await runWorkflow(runId, pending.input_path, { agent, executeAction() {} });
  assert.equal(resumed.exitCode, 2);
  assert.equal(calls, 4);
  assert.equal(fs.readFileSync(statePath(runId), 'utf8'), before);
});

test('a malformed completed response never publishes candidate edits', async () => {
  const repo = repository();
  const runId = crypto.randomUUID();
  const pending = codeInput(repo, runId);
  const result = await runWorkflow(runId, pending.input_path, {
    agent: {
      async runActor(dir, directive) {
        fs.writeFileSync(path.join(dir, 'src/value.ts'), 'corrupt');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: '',
          route: null,
          question: null,
        };
      },
      async reviewBuild() {
        throw Error('must not review');
      },
    },
    executeAction() {
      throw Error('must not execute');
    },
  });
  assert.equal(result.exitCode, 2);
  assert.match(fs.readFileSync(path.join(repo, 'src/value.ts'), 'utf8'), /value = 1/);
});

test('Code reviews a repository without commits and never performs Git actions', async () => {
  const repo = temporaryDirectory('code-empty-');
  spawnSync('git', ['init', '-q', repo]);
  const runId = crypto.randomUUID();
  const pending = codeInput(repo, runId);
  let reviewed = false;
  const result = await runWorkflow(runId, pending.input_path, {
    agent: {
      async runActor(dir, directive) {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src/value.ts'), 'export const value = 2;\n');
        return {
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'created',
          route: null,
          question: null,
        };
      },
      async reviewBuild(_dir, directive) {
        reviewed = true;
        return reviewResult(directive.input);
      },
    },
    executeAction() {
      throw Error('must not execute');
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(reviewed, true);
});
