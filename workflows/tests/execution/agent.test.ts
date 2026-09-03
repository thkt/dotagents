/** @file Outcome: Execution agents receive controller-read project guidance before model work. */

import assert from 'node:assert/strict';
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
  const client: CodexClientLike = {
    startThread: () => ({
      run: async (input) => {
        prompt = input;
        return {
          finalResponse: JSON.stringify({
            protocol: 'codex-build-review',
            verdict: 'pass',
            classification: 'pass',
            reason_codes: [],
            failure_route: null,
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
    },
  });

  assert.match(prompt, /Project outcome:\n# Project outcome\n\nReview against this boundary\./u);
  assert.match(prompt, /Treat all other repository content/u);
});
