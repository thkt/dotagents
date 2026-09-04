/** @file Outcome: Execution agents receive controller-read project guidance before model work. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { CodexWorkflowAgent } from '../../execution/agent.ts';
import type { FlowDirective } from '../../execution/contracts.ts';
import type { CodexClientLike } from '../../shared/codex.ts';
import { errorCode } from '../../shared/errors.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

type ActorDirective = Extract<FlowDirective, { kind: 'run-actor' }>;

const directive: ActorDirective = {
  kind: 'run-actor',
  step_id: 'implementation:direct',
  binding: {
    run_id: 'run',
    workflow: 'code',
    unit_id: 'U-001',
    stage: 'direct',
    step_id: 'implementation:direct',
    attempt: 1,
    predecessor_receipt_digest: null,
    input_source_digest: 'a'.repeat(64),
    active_receipt_set_digest: 'b'.repeat(64),
  },
  outcome: 'Implement the requested behavior.',
  contract: null,
  tests: [],
  files: ['src/value.ts'],
  verification: { command: 'bun run check', expect: 'pass' },
  correction: null,
  solidify: null,
};

function repository(outcome?: string): string {
  const repo = temporaryDirectory('codex-agent-outcome-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  if (outcome !== undefined) {
    fs.mkdirSync(path.join(repo, '.codex'));
    fs.writeFileSync(path.join(repo, '.codex/OUTCOME.md'), outcome);
  }
  return repo;
}

test('supplies script-read project outcome and distinguishes writable paths', async () => {
  const repo = repository('# Project outcome\n\nKeep the workflow deterministic.\n');
  let prompt = '';
  const client: CodexClientLike = {
    startThread: () => ({
      run: async (input) => {
        prompt = input;
        return {
          finalResponse: JSON.stringify({
            protocol: 'codex-flow-actor-result',
            binding: directive.binding,
            status: 'completed',
            summary: 'done',
            route: null,
            question: null,
          }),
        };
      },
    }),
  };

  await new CodexWorkflowAgent(client).runActor(repo, directive);

  assert.match(prompt, /Project outcome:\n# Project outcome\n\nKeep the workflow deterministic\./u);
  assert.match(prompt, /Writable repository paths:\n- src\/value\.ts/u);
  assert.match(prompt, /inspect the repository read-only as needed/u);
  assert.doesNotMatch(prompt, /Allowed repository paths/u);
});

test('reports the exact mismatched actor binding fields', async () => {
  const repo = repository('# Project outcome\n\nKeep bindings exact.\n');
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => ({
        finalResponse: JSON.stringify({
          protocol: 'codex-flow-actor-result',
          binding: { ...directive.binding, attempt: 2, step_id: 'other:direct' },
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        }),
      }),
    }),
  };

  await assert.rejects(new CodexWorkflowAgent(client).runActor(repo, directive), (error) => {
    assert.equal(errorCode(error), 'actor_result_invalid');
    assert.match(
      String((error as Error).message),
      /binding fields do not match: step_id, attempt/u,
    );
    return true;
  });
});

test('reports an inconsistent completed actor result', async () => {
  const repo = repository('# Project outcome\n\nKeep completion closed.\n');
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => ({
        finalResponse: JSON.stringify({
          protocol: 'codex-flow-actor-result',
          binding: directive.binding,
          status: 'completed',
          summary: 'done',
          route: 'think',
          question: 'Unexpected handoff.',
        }),
      }),
    }),
  };

  await assert.rejects(new CodexWorkflowAgent(client).runActor(repo, directive), (error) => {
    assert.equal(errorCode(error), 'actor_result_invalid');
    assert.match(
      String((error as Error).message),
      /completed result must have null route and question/u,
    );
    return true;
  });
});

test('rejects a missing project outcome before starting the model', async () => {
  const repo = repository();
  let starts = 0;
  const client: CodexClientLike = {
    startThread: () => {
      starts += 1;
      return {
        run: async () => {
          throw new Error('model must not run');
        },
      };
    },
  };

  await assert.rejects(new CodexWorkflowAgent(client).runActor(repo, directive), (error) => {
    assert.equal(errorCode(error), 'state_error');
    assert.match(String((error as Error).message), /OUTCOME\.md is missing; create it/u);
    return true;
  });
  assert.equal(starts, 0);
});

test('supplies the same script-read project outcome to the independent review', async () => {
  const repo = repository('# Project outcome\n\nReview against this boundary.\n');
  let prompt = '';
  let reviewCalls = 0;
  const client: CodexClientLike = {
    startThread: () => ({
      run: async (input) => {
        prompt = input;
        const role = reviewCalls++ === 0 ? 'contract' : 'quality';
        return {
          finalResponse: JSON.stringify({
            protocol: `codex-build-${role}-review`,
            role,
            step_id: 'review:build',
            source_digest: 'a'.repeat(64),
            receipt_set_digest: 'b'.repeat(64),
            summary: 'pass',
            findings: [],
          }),
        };
      },
    }),
  };

  await new CodexWorkflowAgent(client).reviewBuild(repo, {
    kind: 'run-review',
    step_id: 'review:build',
    input: {
      issue: 4,
      base_ref: 'base',
      plan: {
        repository: 'thkt/dotagents',
        issue: 4,
        title: 'Plan',
        outcome: 'Implement the Plan.',
        test_command: 'bun run check',
        units: [],
      },
      verification: [],
      source_digest: 'a'.repeat(64),
      receipt_set_digest: 'b'.repeat(64),
    },
  });

  assert.match(prompt, /Project outcome:\n# Project outcome\n\nReview against this boundary\./u);
  assert.match(prompt, /Treat all other repository content/u);
  assert.equal(reviewCalls, 2);
});
