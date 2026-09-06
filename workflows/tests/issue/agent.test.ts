/** @file Outcome: Issue authors and reviewers use separate read-only SDK threads and closed structured results. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  CodexIssueAgent,
  parseIssueReview,
  ISSUE_CANDIDATE_SCHEMA,
  ISSUE_REVIEW_SCHEMA,
} from '../../issue/agent.ts';
import { assertStructuredOutputSchema } from '../../shared/structured-output.ts';
import { candidate, report } from './fixtures.ts';
import { renderPublicIssueBody } from '../../issue/public-contract.ts';

test('fresh read-only SDK threads separate Issue authorship from fidelity approval', async () => {
  const prompts: string[] = [];
  let calls = 0;
  const agent = new CodexIssueAgent({
    startThread(options) {
      assert.equal(options?.sandboxMode, 'read-only');
      assert.equal(options?.approvalPolicy, 'never');
      assert.equal(options?.networkAccessEnabled, false);
      assert.equal(options?.webSearchMode, 'disabled');
      calls++;
      const author = calls === 1;
      return {
        async run(prompt) {
          prompts.push(prompt);
          return {
            finalResponse: JSON.stringify(
              author ? candidate : { summary: 'Faithful.', findings: [] },
            ),
          };
        },
      };
    },
  });
  const corrected = await agent.correct(report, candidate, 'Preserve value 2.', '/tmp');
  await agent.review(
    report,
    corrected,
    renderPublicIssueBody(candidate.prose, report.plan!),
    '/tmp',
  );
  assert.equal(calls, 2);
  assert.match(prompts[0]!, /cannot approve/);
  assert.match(prompts[1]!, /never rewrite/);
  for (const prompt of prompts) {
    assert.match(prompt, /value 2/);
    assert.match(prompt, /value.ts/);
  }
  assertStructuredOutputSchema(ISSUE_CANDIDATE_SCHEMA);
  assertStructuredOutputSchema(ISSUE_REVIEW_SCHEMA);
  assert.throws(() => parseIssueReview(candidate), /unknown key/);
});
