/** @file Outcome: Shared Codex timing contracts remain closed, complete, and classified. */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STAGE_TIMING_KEYS,
  emptyStageTimings,
  parseStageTimings,
} from '../../../workflows/shared/codex.ts';

test('emptyStageTimings returns every timing key as zero', () => {
  const timings = emptyStageTimings();
  assert.deepEqual(Object.keys(timings), STAGE_TIMING_KEYS);
  for (const key of STAGE_TIMING_KEYS) assert.equal(timings[key], 0);
});

test('parseStageTimings accepts a complete closed object', () => {
  const input = Object.fromEntries(STAGE_TIMING_KEYS.map((key, index) => [key, index]));
  assert.deepEqual(parseStageTimings(input, 'timings'), input);
});

test('parseStageTimings rejects unknown keys', () => {
  const input = { ...emptyStageTimings(), unexpected: 1 };
  assert.throws(() => parseStageTimings(input, 'timings'), /unknown key: unexpected/u);
});

test('parseStageTimings rejects negative and non-finite values', () => {
  assert.throws(
    () => parseStageTimings({ ...emptyStageTimings(), reviewer_model_call_ms: -1 }, 'timings'),
    /non-negative finite milliseconds/u,
  );
  assert.throws(
    () =>
      parseStageTimings({ ...emptyStageTimings(), reviewer_model_call_ms: Number.NaN }, 'timings'),
    /non-negative finite milliseconds/u,
  );
});

test('parseStageTimings preserves the requested error code', () => {
  assert.throws(
    () =>
      parseStageTimings(
        { ...emptyStageTimings(), reviewer_model_call_ms: -1 },
        'timings',
        'execution_error',
      ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'execution_error',
  );
});
