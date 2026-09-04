/** @file Outcome: Every model response contract can be submitted as a strict Structured Output. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { ACTOR_RESULT_SCHEMA, BUILD_REVIEW_CANDIDATE_SCHEMA } from '../../execution/agent.ts';
import { BUILD_PLAN_AUTHORING_SCHEMA } from '../../plan/contracts.ts';
import { RESEARCH_AUDIT_SCHEMA, RESEARCH_DRAFT_SCHEMA } from '../../research/contracts.ts';
import {
  NON_BLANK_STRING_SCHEMA,
  assertStructuredOutputSchema,
} from '../../shared/structured-output.ts';
import { THINK_DRAFT_SCHEMA, THINK_REVIEW_SCHEMA } from '../../think/contracts.ts';

test('all model response schemas satisfy the API boundary', () => {
  for (const schema of [
    RESEARCH_DRAFT_SCHEMA,
    RESEARCH_AUDIT_SCHEMA,
    THINK_DRAFT_SCHEMA,
    THINK_REVIEW_SCHEMA,
    ACTOR_RESULT_SCHEMA,
    BUILD_REVIEW_CANDIDATE_SCHEMA,
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

test('model response schemas reject blank free-form text at the API boundary', () => {
  const schemas: unknown[] = [
    RESEARCH_DRAFT_SCHEMA,
    RESEARCH_AUDIT_SCHEMA,
    THINK_DRAFT_SCHEMA,
    THINK_REVIEW_SCHEMA,
    ACTOR_RESULT_SCHEMA,
    BUILD_REVIEW_CANDIDATE_SCHEMA,
  ];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const schema = value as Record<string, unknown>;
    if (schema.type === 'string' && schema.enum === undefined) {
      assert.equal(typeof schema.pattern, 'string', JSON.stringify(schema));
      assert.equal(new RegExp(String(schema.pattern), 'u').test('   '), false);
    }
    for (const child of Object.values(schema)) visit(child);
  };
  schemas.forEach(visit);
  assert.equal(NON_BLANK_STRING_SCHEMA.pattern, '\\S');
});

test('model response schemas require collections rejected as empty by runtime validation', () => {
  assert.equal(BUILD_PLAN_AUTHORING_SCHEMA.properties.units.minItems, 1);
  assert.equal(BUILD_PLAN_AUTHORING_SCHEMA.properties.units.items.properties.files.minItems, 1);
  assert.equal(BUILD_PLAN_AUTHORING_SCHEMA.properties.units.items.properties.tests.minItems, 1);
  assert.equal(RESEARCH_DRAFT_SCHEMA.properties.findings.items.properties.evidence.minItems, 1);
  assert.equal(RESEARCH_AUDIT_SCHEMA.properties.findings.items.properties.evidence.minItems, 1);
  assert.match(
    RESEARCH_AUDIT_SCHEMA.properties.findings.items.properties.evidence.items.anyOf[1].properties
      .source.pattern,
    /https/u,
  );
});
