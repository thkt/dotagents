/** @file Outcome: Every model response contract can be submitted as a strict Structured Output. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { ACTOR_RESULT_SCHEMA, BUILD_REVIEW_RESULT_SCHEMA } from '../../flow/agent.ts';
import { RESEARCH_AUDIT_SCHEMA, RESEARCH_DRAFT_SCHEMA } from '../../research/contracts.ts';
import { assertStructuredOutputSchema } from '../../shared/structured-output.ts';
import { THINK_DRAFT_SCHEMA, THINK_REVIEW_SCHEMA } from '../../think/contracts.ts';

test('all model response schemas satisfy the API boundary', () => {
  for (const schema of [
    RESEARCH_DRAFT_SCHEMA,
    RESEARCH_AUDIT_SCHEMA,
    THINK_DRAFT_SCHEMA,
    THINK_REVIEW_SCHEMA,
    ACTOR_RESULT_SCHEMA,
    BUILD_REVIEW_RESULT_SCHEMA,
  ]) {
    assert.doesNotThrow(() => assertStructuredOutputSchema(schema));
  }
});

test('the API boundary rejects an incomplete object schema before execution', () => {
  assert.throws(
    () =>
      assertStructuredOutputSchema({
        type: 'object',
        properties: { result: { type: 'string' } },
        required: [],
        additionalProperties: false,
      }),
    /required fields must equal its properties/u,
  );
});
