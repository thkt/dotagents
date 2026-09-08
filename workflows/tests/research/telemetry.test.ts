/** @file Outcome: Research telemetry remains typed, bounded, and diagnosable at every model boundary. */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { CodexResearchAgent } from '../../research/agent.ts';
import type { CodexClientLike } from '../../shared/codex.ts';
import type { ResearchInput, ResearchDraft } from '../../research/contracts.ts';
import { FlowError, errorCode } from '../../shared/errors.ts';
import { ProgressReporter, type ProgressEvent } from '../../shared/progress.ts';
import * as fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from '../shared/fixtures.ts';

const input: ResearchInput = {
  repo: '/tmp/repo',
  question: 'q',
  scope_paths: [],
  allow_external_sources: false,
};

function snapshotRepo(): string {
  const repo = temporaryDirectory('codex-research-telemetry-');
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex/OUTCOME.md'), '# Project outcome\n\nTest.\n');
  return repo;
}
test('Research invalid structured output keeps stage and elapsed duration', async () => {
  const events: ProgressEvent[] = [];
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => ({ finalResponse: 'not json' }),
    }),
  };
  const agent = new CodexResearchAgent(
    client,
    new ProgressReporter({
      write: (line) => events.push(JSON.parse(line) as ProgressEvent),
      setInterval: () => ({}),
      clearInterval: () => undefined,
    }),
  );
  await assert.rejects(
    agent.investigate(input, [], snapshotRepo()),
    /research investigator structured validation failed after \d+ms/u,
  );
  assert.deepEqual(
    events.map(({ stage, status }) => [stage, status]),
    [
      ['investigator_model_call', 'started'],
      ['investigator_model_call', 'completed'],
      ['investigator_structured_validation', 'started'],
      ['investigator_structured_validation', 'failed'],
    ],
  );
});

test('Research model failure keeps model stage and elapsed duration', async () => {
  const client: CodexClientLike = {
    startThread: () => ({
      run: async () => {
        throw new Error('boom');
      },
    }),
  };
  const agent = new CodexResearchAgent(client);
  await assert.rejects(
    agent.investigate(input, [], snapshotRepo()),
    /research investigator model call failed after \d+ms/u,
  );
});

test('Research model failure preserves the idle classification from the shared boundary', async () => {
  const client: CodexClientLike = {
    startThread: () => ({
      run: async (_prompt, options) => {
        assert.equal(options.modelRun.idleCode, 'research_investigator_idle_timeout');
        throw new FlowError('idle stream', 'research_investigator_idle_timeout');
      },
    }),
  };
  const agent = new CodexResearchAgent(client);
  await assert.rejects(agent.investigate(input, [], snapshotRepo()), (error: unknown) => {
    assert.equal(errorCode(error), 'research_investigator_idle_timeout');
    assert.match(String((error as Error).message), /idle stream/u);
    return true;
  });
});

test('independent read-only threads receive the governing input, candidate and correction context', async () => {
  const repo = snapshotRepo();
  const request = { ...input, repo, question: 'Which deployment uses the value?' };
  const candidate: ResearchDraft = {
    answer: 'Deployment cannot be established.',
    findings: [],
    rejected: [],
    unknowns: [
      {
        question: 'No deployment is described in the inspected source.',
        resolution: 'Obtain deployment configuration.',
      },
    ],
    limitations: [],
  };
  const correction = { candidate, reason: 'Include the inspected scope in the explanation.' };
  const knowledge = [
    {
      topic: request.question,
      sources: [
        {
          research_id: 'a'.repeat(64),
          report: 'prior.json',
          generated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
      updated_at: '2026-09-01T00:00:00.000Z',
    },
  ];
  const prompts: string[] = [];
  let threads = 0;
  const client: CodexClientLike = {
    startThread(options) {
      const author = threads++ === 0;
      assert.ok(options);
      assert.equal(options.workingDirectory, repo);
      assert.equal(options.sandboxMode, 'read-only');
      assert.equal(options.webSearchMode, 'disabled');
      return {
        async run(prompt) {
          prompts.push(prompt);
          return {
            finalResponse: JSON.stringify(
              author ? { result: candidate } : { summary: 'Supported unknown.', findings: [] },
            ),
          };
        },
      };
    },
  };
  const agent = new CodexResearchAgent(client);
  const draft = await agent.investigate(request, knowledge, repo, correction);
  assert.deepEqual(draft, candidate);
  assert.deepEqual(await agent.audit(request, draft, knowledge, repo), {
    summary: 'Supported unknown.',
    findings: [],
  });
  assert.equal(threads, 2);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(request.question));
    assert.ok(prompt.includes('prior.json'));
    assert.ok(prompt.includes(candidate.answer));
    assert.ok(prompt.includes('# Project outcome'));
  }
  assert.ok(prompts[0]!.includes(correction.reason));
});

test('public-safety model and structured-validation telemetry omit response contents on success and failure', async () => {
  const { canonicalReport } = await import('../../research/corpus.ts');
  const { safetyContext } = await import('../../research/public-safety.ts');
  const context = safetyContext(
    canonicalReport({
      protocol: 'codex-research-report',
      generated_at: '2026-09-01T00:00:00.000Z',
      question: 'Private question marker',
      scope_paths: [],
      answer: 'Private answer marker',
      findings: [],
      rejected: [],
      unknowns: [{ question: 'Missing fact', resolution: 'Inspect evidence' }],
      limitations: [],
    }),
  );
  for (const mode of ['safe', 'malformed', 'transport']) {
    const lines: string[] = [];
    const agent = new CodexResearchAgent(
      {
        startThread() {
          return {
            async run() {
              if (mode === 'transport') throw new Error('Private transport marker');
              return {
                finalResponse:
                  mode === 'malformed'
                    ? 'Private malformed marker'
                    : JSON.stringify({
                        verdict: 'safe',
                        coverage: context.strings.map((item) => item.path),
                        findings: [],
                      }),
              };
            },
          };
        },
      },
      new ProgressReporter({ write: (line) => lines.push(line) }),
    );
    if (mode === 'safe') await agent.auditPublicSafety(input, context, input.repo);
    else await assert.rejects(agent.auditPublicSafety(input, context, input.repo), /public-safety/);
    assert(lines.length <= 4);
    assert(lines.some((line) => line.includes('safety_model_call')));
    if (mode !== 'transport')
      assert(lines.some((line) => line.includes('safety_structured_validation')));
    assert(!lines.join('').includes('Private'));
  }
});
