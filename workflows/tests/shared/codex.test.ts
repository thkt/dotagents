/** @file Outcome: Shared Codex timing contracts remain closed, complete, and classified. */

import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { ThreadEvent } from '@openai/codex-sdk';

import {
  STAGE_TIMING_KEYS,
  emptyStageTimings,
  parseStageTimings,
  runStreamedCodexTurn,
  type IdleTimer,
  type ModelActivity,
} from '../../shared/codex.ts';
import { errorCode } from '../../shared/errors.ts';

const usage = {
  input_tokens: 1,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 1,
  reasoning_output_tokens: 0,
};

function streamed(...events: ThreadEvent[]) {
  return {
    async runStreamed() {
      return {
        events: (async function* () {
          yield* events;
        })(),
      };
    },
  };
}

test('streaming turn returns the final agent response and exposes safe activity metadata', async () => {
  const activities: ModelActivity[] = [];
  const result = await runStreamedCodexTurn(
    streamed(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'reasoning-1', type: 'reasoning', text: 'private reasoning' },
      },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: '{"ok":true}' },
      },
      { type: 'turn.completed', usage },
    ),
    'prompt',
    {
      outputSchema: {},
      modelRun: {
        label: 'test model',
        idleCode: 'test_model_idle_timeout',
        onActivity: (activity) => activities.push(activity),
      },
    },
  );

  assert.equal(result.finalResponse, '{"ok":true}');
  assert.deepEqual(activities, [
    { event_type: 'thread.started', event_count: 1 },
    { event_type: 'turn.started', event_count: 2 },
    { event_type: 'item.started', item_type: 'reasoning', event_count: 3 },
    { event_type: 'item.completed', item_type: 'agent_message', event_count: 4 },
    { event_type: 'turn.completed', event_count: 5 },
  ]);
  assert.equal(JSON.stringify(activities).includes('private reasoning'), false);
  assert.equal(JSON.stringify(activities).includes('{"ok"'), false);
});

test('streaming turn allows a reconnect error before successful completion', async () => {
  const result = await runStreamedCodexTurn(
    streamed(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'error', message: 'Reconnecting... 2/5' },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: '{"ok":true}' },
      },
      { type: 'turn.completed', usage },
    ),
    'prompt',
    { modelRun: { label: 'reconnecting model', idleCode: 'reconnecting_model_idle' } },
  );

  assert.equal(result.finalResponse, '{"ok":true}');
});

test('streaming turn fails with the last stream error when no lifecycle terminal arrives', async () => {
  await assert.rejects(
    runStreamedCodexTurn(
      streamed({ type: 'error', message: 'connection retries exhausted' }),
      'prompt',
      { modelRun: { label: 'failed model', idleCode: 'failed_model_idle' } },
    ),
    /connection retries exhausted/u,
  );
});

test('streaming turn fails immediately on turn.failed', async () => {
  await assert.rejects(
    runStreamedCodexTurn(
      streamed({ type: 'turn.failed', error: { message: 'terminal failure' } }),
      'prompt',
      { modelRun: { label: 'failed model', idleCode: 'failed_model_idle' } },
    ),
    /terminal failure/u,
  );
});

test('streaming turn stops only after an idle window and preserves the idle diagnosis', async () => {
  let timeout: (() => void) | undefined;
  let scheduledFor = 0;
  let cancelled = 0;
  const startIdleTimer: IdleTimer = (callback, milliseconds) => {
    timeout = callback;
    scheduledFor = milliseconds;
    return () => {
      cancelled += 1;
    };
  };
  const turn = runStreamedCodexTurn(
    {
      async runStreamed(_input, options) {
        const signal = options?.signal;
        return {
          events: (async function* () {
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            yield { type: 'turn.started' as const };
          })(),
        };
      },
    },
    'prompt',
    {
      modelRun: {
        label: 'idle test model',
        idleCode: 'idle_test_timeout',
        idleTimeoutMs: 1234,
      },
    },
    startIdleTimer,
  );

  await Promise.resolve();
  assert.equal(scheduledFor, 1234);
  timeout?.();
  await assert.rejects(turn, (error: unknown) => {
    assert.equal(errorCode(error), 'idle_test_timeout');
    assert.match(String((error as Error).message), /last activity: request_started; events: 0/u);
    return true;
  });
  assert.equal(cancelled, 1);
});

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
