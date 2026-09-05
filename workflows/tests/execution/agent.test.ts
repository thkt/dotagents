/** @file Outcome: Execution agents receive controller-read project guidance before model work. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  ActorEscalation,
  CodexWorkflowAgent,
  parseBuildReviewCandidate,
} from '../../execution/agent.ts';
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
    step_id: 'implementation:direct',
    attempt: 1,
    input_source_digest: 'a'.repeat(64),
  },
  outcome: 'Implement the requested behavior.',
  contract: null,
  tests: [],
  files: ['src/value.ts'],
  verification: { command: 'bun run check', expect: 'pass' },
  correction: null,
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

test('attaches the controller binding to a semantic-only model response', async () => {
  const repo = repository('# Outcome\nImplement safely.');
  const agent = new CodexWorkflowAgent({
    startThread: () => ({
      run: async () => ({
        finalResponse: JSON.stringify({
          status: 'completed',
          summary: 'done',
          route: null,
          question: null,
        }),
      }),
    }),
  });
  const result = await agent.runActor(repo, directive);
  assert.deepEqual(result.binding, directive.binding);
  assert.equal(result.protocol, 'codex-flow-actor-result');
});

test('reports an inconsistent completed actor result', async () => {
  const repo = repository('# Project outcome\n\nKeep completion closed.\n');
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => ({
        finalResponse: JSON.stringify({
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
        reviewCalls += 1;
        return {
          finalResponse: JSON.stringify({
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
      actor_receipt_digest: 'b'.repeat(64),
    },
  });

  assert.match(prompt, /Project outcome:\n# Project outcome\n\nReview against this boundary\./u);
  assert.match(prompt, /Treat all other repository content/u);
  assert.equal(reviewCalls, 1);
});

test('review requires an explicit findings array', () => {
  for (const raw of [
    { summary: 'done' },
    { summary: 'done', findings: null },
    { summary: 'done', findings: {} },
  ]) {
    assert.throws(
      () => parseBuildReviewCandidate(raw, {} as Extract<FlowDirective, { kind: 'run-review' }>),
      /findings must be an array/u,
    );
  }
});

const completed = {
  status: 'completed',
  summary: 'Implemented and verified.',
  route: null,
  question: null,
};
const observedHandoffs = [
  'Please provide a follow-up implementation turn to complete and verify the cleanup actor across the remaining authorized files.',
  'Please define or confirm the exact public TypeScript contracts for cleanup records, inventory, preparation approval, journal revisions, and runner commands so the full implementation can be completed without guessing hidden API expectations.',
];

for (const question of observedHandoffs) {
  test(`continues in the same actor after an unsupported handoff: ${question}`, async () => {
    const repo = repository('# Outcome\nImplement the new records.');
    const file = path.join(repo, 'src/value.ts');
    fs.mkdirSync(path.dirname(file));
    let actorStarts = 0;
    let actorCalls = 0;
    let reviews = 0;
    const contract = 'Create the new record types within src/value.ts; preserve saved values.';
    const agent = new CodexWorkflowAgent({
      startThread(options) {
        assert.equal(options?.workingDirectory, repo);
        if (options?.sandboxMode === 'read-only') {
          assert.equal(options.networkAccessEnabled, false);
          return {
            async run(prompt) {
              reviews += 1;
              assert.ok(prompt.includes(question));
              assert.ok(prompt.includes(contract));
              assert.ok(prompt.includes(directive.files[0]!));
              assert.equal(fs.readFileSync(file, 'utf8'), 'partial');
              return {
                finalResponse: JSON.stringify({
                  decision: 'continue',
                  reason:
                    'Define the new record locally; no external API compatibility is required.',
                }),
              };
            },
          };
        }
        actorStarts += 1;
        return {
          async run(prompt) {
            actorCalls += 1;
            if (actorCalls === 1) {
              fs.writeFileSync(file, 'partial');
              return {
                finalResponse: JSON.stringify({
                  status: 'escalated',
                  route: 'think',
                  question,
                  summary: 'Partial implementation remains.',
                }),
              };
            }
            assert.ok(prompt.includes('Define the new record locally'));
            assert.equal(fs.readFileSync(file, 'utf8'), 'partial');
            fs.writeFileSync(file, 'complete');
            return { finalResponse: JSON.stringify(completed) };
          },
        };
      },
    });
    const result = await agent.runActor(repo, { ...directive, contract });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.binding, directive.binding);
    assert.equal(actorStarts, 1);
    assert.equal(actorCalls, 2);
    assert.equal(reviews, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'complete');
  });
}

for (const [route, question, reason] of [
  [
    'think',
    'May cleanup delete a branch used by another worktree?',
    'The requested deletion conflicts with the required protection of other worktrees.',
  ],
  [
    'research',
    'Which external service owns this repository ID?',
    'The required identity cannot be established from the available repository evidence.',
  ],
] as const) {
  test(`accepts a reviewed ${route} blocker without another actor turn`, async () => {
    const repo = repository('# Outcome\nPreserve safety and verify evidence.');
    let calls = 0;
    let reviews = 0;
    const agent = new CodexWorkflowAgent({
      startThread(options) {
        return {
          async run() {
            if (options?.sandboxMode === 'read-only') {
              reviews += 1;
              return { finalResponse: JSON.stringify({ decision: 'handoff', reason }) };
            }
            calls += 1;
            return {
              finalResponse: JSON.stringify({
                status: 'escalated',
                route,
                question,
                summary: reason,
              }),
            };
          },
        };
      },
    });
    await assert.rejects(agent.runActor(repo, directive), (error) => {
      assert.ok(error instanceof ActorEscalation);
      assert.equal(error.route, route);
      assert.equal(error.question, question);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(reviews, 1);
  });
}

test('a repeated unsupported handoff blocks as an invalid actor result', async () => {
  const repo = repository('# Outcome\nComplete the work.');
  let calls = 0;
  let reviews = 0;
  const agent = new CodexWorkflowAgent({
    startThread(options) {
      return {
        async run() {
          if (options?.sandboxMode === 'read-only') {
            reviews += 1;
            return {
              finalResponse: JSON.stringify({
                decision: 'continue',
                reason: 'Continue the authorized implementation.',
              }),
            };
          }
          calls += 1;
          return {
            finalResponse: JSON.stringify({
              status: 'escalated',
              route: 'think',
              question: observedHandoffs[0],
              summary: 'Need more implementation time.',
            }),
          };
        },
      };
    },
  });
  await assert.rejects(agent.runActor(repo, directive), (error) => {
    assert.equal(errorCode(error), 'actor_result_invalid');
    assert.ok(!(error instanceof ActorEscalation));
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(reviews, 2);
});

test('a malformed or mutating handoff review cannot approve an escalation', async () => {
  for (const variant of ['malformed', 'mutating', 'unavailable'] as const) {
    const repo = repository('# Outcome\nKeep review read-only.');
    let calls = 0;
    const agent = new CodexWorkflowAgent({
      startThread(options) {
        return {
          async run() {
            if (options?.sandboxMode === 'read-only') {
              if (variant === 'mutating')
                fs.writeFileSync(path.join(repo, 'unexpected.txt'), 'changed');
              if (variant === 'unavailable') throw new Error('review unavailable');
              return {
                finalResponse: JSON.stringify(
                  variant === 'malformed'
                    ? { decision: 'handoff' }
                    : { decision: 'handoff', reason: 'Confirmed.' },
                ),
              };
            }
            calls += 1;
            return {
              finalResponse: JSON.stringify({
                status: 'escalated',
                route: 'think',
                question: observedHandoffs[0],
                summary: 'Incomplete.',
              }),
            };
          },
        };
      },
    });
    await assert.rejects(agent.runActor(repo, directive), (error) => {
      assert.ok(!(error instanceof ActorEscalation));
      if (variant === 'malformed') assert.equal(errorCode(error), 'actor_result_invalid');
      if (variant === 'mutating') assert.equal(errorCode(error), 'state_error');
      return true;
    });
    assert.equal(calls, 1);
  }
});
