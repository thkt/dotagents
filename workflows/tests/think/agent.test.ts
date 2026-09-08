/** @file Outcome: Designers receive correction context while independent reviewers only return findings. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { CodexThinkAgent } from '../../think/agent.ts';
import { parseThinkReview, type ThinkDraft } from '../../think/contracts.ts';
import type { CodexClientLike } from '../../shared/codex.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

test('separate read-only SDK threads receive the candidate and designer correction without reviewer authorship', async () => {
  const repo = temporaryDirectory('think-agent-');
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(
    path.join(repo, '.codex/OUTCOME.md'),
    '# Project outcome\n\nVerify a deployment requirement.\n',
  );
  const input = { repo, request: 'Which deployment value is required?', research_reports: [] };
  const candidate: ThinkDraft = {
    status: 'research_required',
    plan: null,
    research_questions: ['Obtain the absent deployment contract.'],
  };
  const correction = {
    candidate,
    reason: 'Name the missing contract and why it affects the required value.',
  };
  const prompts: string[] = [];
  let threads = 0;
  const client: CodexClientLike = {
    startThread(options) {
      assert.ok(options);
      assert.equal(options.workingDirectory, repo);
      assert.equal(options.sandboxMode, 'read-only');
      assert.equal(options.model, 'gpt-6-astra');
      assert.equal(options.modelReasoningEffort, 'high');
      assert.equal(options.webSearchMode, 'disabled');
      const author = threads++ === 0;
      return {
        async run(prompt) {
          prompts.push(prompt);
          return {
            finalResponse: JSON.stringify(
              author
                ? candidate
                : { summary: 'The required external contract is absent.', findings: [] },
            ),
          };
        },
      };
    },
  };
  const agent = new CodexThinkAgent(client);
  const draft = await agent.design(input, [], [], {}, repo, correction);
  const review = await agent.review(input, draft, [], [], {}, repo);
  assert.equal(threads, 2);
  assert.deepEqual(draft, candidate);
  assert.deepEqual(review.findings, []);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(input.request));
    assert.ok(prompt.includes(candidate.research_questions[0]!));
    assert.ok(prompt.includes('# Project outcome'));
    assert.match(prompt, /completed observable requirements/);
    assert.match(prompt, /Omit superseded planning or publication history/);
    assert.match(prompt, /Keep necessary current safety and authorization conditions/);
  }
  assert.ok(prompts[0]!.includes(correction.reason));
  assert.throws(() => parseThinkReview(candidate), /unknown key/);
  assert.throws(
    () =>
      parseThinkReview({
        summary: 'Unsupported',
        findings: [
          { severity: 'blocking', condition: 'Required fact', message: 'Missing', evidence: [] },
        ],
      }),
    /needs evidence/,
  );
});

test('production Think prompts and structured schema distinguish authoring from independent question acceptance', async () => {
  const repo = temporaryDirectory('think-question-agent-');
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(
    path.join(repo, '.codex/OUTCOME.md'),
    '# Project outcome\n\nChoose an access policy.\n',
  );
  const question = {
    id: 'access',
    prompt: 'Which access policy is required?',
    choices: [
      { label: 'Public', description: 'Public access.' },
      { label: 'Private', description: 'Private access.' },
    ],
    recommendation: null,
  };
  const prompts: string[] = [];
  const draft: ThinkDraft = { status: 'waiting', plan: null, research_questions: [], question };
  const client: CodexClientLike = {
    startThread() {
      return {
        async run(prompt, options) {
          prompts.push(prompt);
          if (prompts.length === 1) {
            assert.match(JSON.stringify(options?.outputSchema), /description/);
            return { finalResponse: JSON.stringify(draft) };
          }
          return {
            finalResponse: JSON.stringify({
              summary: 'A necessary user-owned policy.',
              findings: [],
            }),
          };
        },
      };
    },
  };
  const agent = new CodexThinkAgent(client);
  const input = { repo, request: 'Plan deployment access.', research_reports: [] };
  const authored = await agent.design(input, [], [], {}, repo);
  await agent.review(input, authored, [], [], {}, repo);
  assert.match(prompts[0]!, /may author one waiting question/);
  assert.doesNotMatch(prompts[0]!, /Never author or replace a question/);
  assert.match(prompts[1]!, /Never author or replace a question/);
  for (const prohibited of [
    'gratuitous preferences',
    'factual questions',
    'internal implementation choices',
    'materially unnecessary',
  ])
    assert(prompts[1]!.includes(prohibited));
});
