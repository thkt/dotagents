/** @file Outcome: Shared clarification questions and answer deltas reject incomplete, edited, stale, and cross-owner submissions. */

import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import {
  answerForQuestion,
  parseClarificationAnswer,
  parsePendingQuestion,
  parseClarificationOwner,
  sameClarificationQuestion,
  validateAnswerDelta,
} from '../../runtime/clarification.ts';
import type { ClarificationBinding, ClarificationChoice } from '../../runtime/clarification.ts';

const bindingShape: ClarificationBinding | null = null;
const choiceShape: ClarificationChoice | null = null;
void bindingShape;
void choiceShape;

const owner = parseClarificationOwner(
  Object.fromEntries(
    [
      'task',
      'repo',
      'workflow',
      'root',
      'leaf',
      'snapshot',
      'candidate',
      'review',
      'dispatch',
      'permissions',
      'selected_context',
      'handoff',
    ].map((key) => [key, key]),
  ),
);

const question = parsePendingQuestion({
  id: 'deployment-target',
  prompt: 'Which target should be supported?',
  choices: [
    { label: 'web', description: 'The web deployment.' },
    { label: 'desktop', description: 'The desktop deployment.' },
  ],
  recommendation: 'web',
});

test('clarification preserves complete question context and accepts one listed answer', () => {
  const answer = answerForQuestion(question, {
    owner,
    question_id: question.id,
    prompt: question.prompt,
    choices: question.choices,
    recommendation: question.recommendation,
    selection: 'web',
    answer: null,
  });
  assert.equal(validateAnswerDelta(question, [], [answer], owner).selection, 'web');
});

test('optional recommendation is normalized and owner bindings are closed and nonblank', () => {
  const withoutRecommendation = parsePendingQuestion({
    id: 'target',
    prompt: 'Choose a target',
    choices: [
      { label: 'a', description: 'A' },
      { label: 'b', description: 'B' },
    ],
  });
  assert.equal(withoutRecommendation.recommendation, null);
  assert(sameClarificationQuestion(withoutRecommendation, { ...withoutRecommendation }));
  assert.throws(() => parseClarificationOwner({ task: 'x' }));
  assert.throws(() =>
    parseClarificationOwner(
      Object.fromEntries(
        [
          'task',
          'repo',
          'workflow',
          'root',
          'leaf',
          'snapshot',
          'candidate',
          'review',
          'dispatch',
          'permissions',
          'selected_context',
          'handoff',
        ].map((key) => [key, key === 'review' ? ' ' : key]),
      ),
    ),
  );
});

test('clarification rejects altered context, duplicate choices, and multiple answers', () => {
  assert.throws(() =>
    parsePendingQuestion({
      ...question,
      choices: [
        { label: 'web', description: 'x' },
        { label: 'web', description: 'y' },
      ],
    }),
  );
  assert.throws(() => parseClarificationAnswer({ ...question, selection: null, answer: '   ' }));
  const answer = {
    owner,
    question_id: question.id,
    prompt: 'changed',
    choices: question.choices,
    recommendation: question.recommendation,
    selection: 'web',
    answer: null,
  };
  assert.throws(() => answerForQuestion(question, answer));
  assert.throws(() => validateAnswerDelta(question, [], [answer, answer], owner));
});

test('a sole full-context delta rejects every owner-field change and every original-input or history edit', async () => {
  const { inputAnswerDelta } = await import('../../runtime/clarification.ts');
  const answer = {
    owner,
    question_id: question.id,
    prompt: question.prompt,
    choices: question.choices,
    recommendation: question.recommendation,
    selection: null,
    answer: '  Preserve this answer verbatim.  ',
  };
  const pending = { status: 'waiting' as const, question, owner };
  const original = {
    repo: '/original',
    request: 'Original',
    permissions: { external: false },
    selected: ['a', 'b'],
  };
  const submitted = { ...original, clarification_answers: [answer] };
  assert.deepEqual(inputAnswerDelta(original, submitted, pending), answer);
  assert.equal(inputAnswerDelta(submitted, structuredClone(submitted)), null);
  for (const key of Object.keys(owner)) {
    assert.throws(
      () =>
        inputAnswerDelta(
          original,
          {
            ...submitted,
            clarification_answers: [{ ...answer, owner: { ...owner, [key]: 'other-owner' } }],
          },
          pending,
        ),
      /owner/,
    );
  }
  for (const changed of [
    { ...submitted, selected: ['b', 'a'] },
    { ...submitted, permissions: { external: true } },
    { ...submitted, extra: true },
    { ...submitted, clarification_answers: [answer, answer] },
    {
      ...submitted,
      clarification_answers: [{ ...answer, choices: [...answer.choices].reverse() }],
    },
  ])
    assert.throws(() => inputAnswerDelta(original, changed, pending));
  assert.throws(
    () => inputAnswerDelta(submitted, { ...submitted, clarification_answers: [] }, pending),
    /history/,
  );
  assert.throws(
    () =>
      inputAnswerDelta(
        submitted,
        { ...submitted, clarification_answers: [{ ...answer, answer: 'edited' }] },
        pending,
      ),
    /history/,
  );
  assert.throws(() => inputAnswerDelta(original, submitted), /waiting owner/);
  assert.throws(() => validateAnswerDelta(question, [answer], [answer], owner), /already exists/);
  for (const invalid of [
    { ...question, header: 'UI only' },
    { ...question, recommendation: 'unlisted' },
    { ...question, choices: [{ label: 'x', description: 'X' }] },
    {
      ...question,
      choices: [
        { label: 'x', description: 'X' },
        { label: ' x ', description: 'Y' },
      ],
    },
    {
      ...question,
      choices: [
        { label: 'x', description: ' ' },
        { label: 'y', description: 'Y' },
      ],
    },
  ])
    assert.throws(() => parsePendingQuestion(invalid));
  for (const invalid of [
    { ...answer, answer: ' ' },
    { ...answer, selection: 'web' },
    { ...answer, selection: 'unlisted', answer: null },
    { ...answer, recommendation: undefined },
    { ...answer, owner: undefined },
  ])
    assert.throws(() => parseClarificationAnswer(invalid));
});
