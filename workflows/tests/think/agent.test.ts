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
