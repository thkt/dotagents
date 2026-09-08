/** @file Outcome: Progress is deterministic, stderr-only, cleaned up, and verdict-neutral. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'bun:test';

import { FlowError } from '../../shared/errors.ts';
import type { ModelActivity } from '../../shared/codex.ts';
import { ProgressReporter, type ProgressEvent } from '../../shared/progress.ts';

function events(lines: string[]): ProgressEvent[] {
  return lines.map((line) => JSON.parse(line) as ProgressEvent);
}

test('emits a deterministic heartbeat and clears it after completion', () => {
  const lines: string[] = [];
  let now = 0;
  let heartbeat: (() => void) | undefined;
  let cleared = 0;
  const handle = {};
  const progress = new ProgressReporter({
    write: (line) => lines.push(line),
    now: () => now,
    setInterval: (callback, milliseconds) => {
      assert.equal(milliseconds, 30_000);
      heartbeat = callback;
      return handle;
    },
    clearInterval: (actual) => {
      assert.equal(actual, handle);
      cleared += 1;
    },
  });

  const stage = progress.start({ workflow: 'think', stage: 'designer_model_call' });
  now = 30_000;
  heartbeat?.();
  now = 31_250;
  stage.complete();
  heartbeat?.();

  assert.deepEqual(
    events(lines).map(({ status, elapsed_ms }) => [status, elapsed_ms]),
    [
      ['started', 0],
      ['still_running', 30_000],
      ['completed', 31_250],
    ],
  );
  assert.equal(cleared, 1);
});

test('annotates the heartbeat with the latest SDK activity', () => {
  const lines: string[] = [];
  let now = 0;
  let heartbeat: (() => void) | undefined;
  const progress = new ProgressReporter({
    write: (line) => lines.push(line),
    now: () => now,
    setInterval: (callback) => {
      heartbeat = callback;
      return {};
    },
    clearInterval: () => undefined,
  });

  const stage = progress.start({ workflow: 'think', stage: 'designer_model_call' });
  now = 100;
  stage.activity({ event_type: 'turn.started', event_count: 1 });
  now = 200;
  stage.activity({ event_type: 'item.updated', item_type: 'reasoning', event_count: 2 });
  now = 30_000;
  heartbeat?.();
  stage.complete();

  assert.deepEqual(
    events(lines).map(({ status, event_type, item_type, event_count }) => [
      status,
      event_type,
      item_type,
      event_count,
    ]),
    [
      ['started', undefined, undefined, undefined],
      ['still_running', 'item.updated', 'reasoning', 2],
      ['completed', 'item.updated', 'reasoning', 2],
    ],
  );
});

for (const status of ['completed', 'failed'] as const) {
  for (const ticks of [0, 2]) {
    for (const turns of [1, 2]) {
      test(`records ${turns} completed turn(s) once with ${ticks} heartbeats per turn before ${status}`, () => {
        const lines: string[] = [];
        let heartbeat = (): void => assert.fail('heartbeat was not scheduled');
        let cleared = 0;
        const progress = new ProgressReporter({
          write: (line) => lines.push(line),
          now: () => 0,
          setInterval: (callback) => {
            heartbeat = callback;
            return {};
          },
          clearInterval: () => {
            cleared += 1;
          },
        });
        const context = { workflow: 'code', stage: 'actor_model_call' } as const;
        const metadata = {
          event_count: 3,
          model: 'gpt-6-astra',
          model_reasoning_effort: 'high',
        } as const;
        const usage = Object.freeze({ input_tokens: 12, output_tokens: 3, cached_input_tokens: 0 });
        const completion: ModelActivity = Object.freeze({
          ...metadata,
          event_type: 'turn.completed',
          usage,
        });
        const stage = progress.start(context);
        const expected: ProgressEvent[] = [{ ...context, status: 'started', elapsed_ms: 0 }];
        for (let turn = 0; turn < turns; turn += 1) {
          // Distinct turns may supply the same event count and usage, even the same object.
          stage.activity(completion);
          expected.push({ ...context, status: 'still_running', elapsed_ms: 0, ...completion });
          assert.deepEqual(events(lines), expected, 'completion is emitted immediately');
          for (let tick = 0; tick < ticks; tick += 1) {
            heartbeat();
            expected.push({ ...context, status: 'still_running', elapsed_ms: 0, ...metadata });
          }
        }
        if (status === 'completed') stage.complete();
        else stage.fail(new FlowError('private failure detail', 'evidence_error'));
        expected.push({
          ...context,
          status,
          elapsed_ms: 0,
          ...metadata,
          ...(status === 'failed' ? { classification: 'evidence_error' } : {}),
        });
        heartbeat();
        stage.activity(completion);
        stage.complete();
        stage.fail(new Error('already finished'));

        const recorded = events(lines);
        assert.equal(recorded.filter((event) => event.usage !== undefined).length, turns);
        assert.equal(
          recorded.filter((event) => event.event_type === 'turn.completed').length,
          turns,
        );
        assert.deepEqual(recorded, expected);
        assert.equal(cleared, 1);
        assert.equal(completion.usage, usage, 'the caller-owned completion is not changed');
      });
    }
  }
}

test('failure emits only a classification and always clears the heartbeat', () => {
  const lines: string[] = [];
  let cleared = 0;
  const progress = new ProgressReporter({
    write: (line) => lines.push(line),
    now: () => 12,
    setInterval: () => ({}),
    clearInterval: () => {
      cleared += 1;
    },
  });

  assert.throws(
    () =>
      progress.runSync(
        { workflow: 'research', stage: 'controller_evidence_validation', attempt: 2 },
        () => {
          throw new FlowError('sensitive raw repository detail', 'evidence_error');
        },
      ),
    /sensitive raw repository detail/u,
  );

  const failed = events(lines).at(-1)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.classification, 'evidence_error');
  assert.equal(failed.attempt, 2);
  assert.doesNotMatch(lines.join(''), /sensitive|repository detail/u);
  assert.equal(cleared, 1);
});

test('telemetry writer and cleanup failures cannot change the operation result', () => {
  const progress = new ProgressReporter({
    write: () => {
      throw new Error('stderr unavailable');
    },
    setInterval: () => ({}),
    clearInterval: () => {
      throw new Error('timer unavailable');
    },
  });

  assert.equal(
    progress.runSync({ workflow: 'issue', stage: 'issue_draft' }, () => 42),
    42,
  );
});

for (const fails of [false, true]) {
  test(`completion telemetry failure preserves the ${fails ? 'failed' : 'successful'} operation verdict`, async () => {
    let heartbeat = (): void => assert.fail('heartbeat was not scheduled');
    let usageWrites = 0;
    const progress = new ProgressReporter({
      write: (line) => {
        if ((JSON.parse(line) as ProgressEvent).usage !== undefined) {
          usageWrites += 1;
          throw new Error('stderr unavailable');
        }
      },
      setInterval: (callback) => {
        heartbeat = callback;
        return {};
      },
      clearInterval: () => {
        throw new Error('timer unavailable');
      },
    });
    const failure = new Error('operation failed');
    const result = progress.run({ workflow: 'code', stage: 'actor_model_call' }, async (stage) => {
      stage.activity({ event_type: 'turn.completed', event_count: 1, usage: { output_tokens: 0 } });
      heartbeat();
      heartbeat();
      if (fails) throw failure;
      return 42;
    });
    if (fails) await assert.rejects(result, (error) => error === failure);
    else assert.equal(await result, 42);
    heartbeat();
    assert.equal(usageWrites, 1, 'failed telemetry is not replayed by heartbeats or finish');
  });
}

test('CLI result JSON stays isolated on stdout while progress is NDJSON on stderr', () => {
  const progressUrl = new URL('../../shared/progress.ts', import.meta.url).href;
  const runtimeUrl = new URL('../../runtime/cli.ts', import.meta.url).href;
  const script = [
    `import { ProgressReporter } from ${JSON.stringify(progressUrl)};`,
    `import { writeCliResult } from ${JSON.stringify(runtimeUrl)};`,
    `new ProgressReporter().runSync({ workflow: 'issue', stage: 'issue_publish' }, () => undefined);`,
    `writeCliResult({ protocol: 'result/v1', status: 'completed' });`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { protocol: 'result/v1', status: 'completed' });
  const stderr = result.stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ProgressEvent);
  assert.deepEqual(
    stderr.map((event) => event.status),
    ['started', 'completed'],
  );
  assert.ok(stderr.every((event) => event.workflow === 'issue'));
});
