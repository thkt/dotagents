/** @file Outcome: Progress is deterministic, stderr-only, cleaned up, and verdict-neutral. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { FlowError } from '../../../workflows/shared/errors.ts';
import { ProgressReporter, type ProgressEvent } from '../../../workflows/shared/progress.ts';

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

test('CLI result JSON stays isolated on stdout while progress is NDJSON on stderr', () => {
  const progressUrl = new URL('../../../workflows/shared/progress.ts', import.meta.url).href;
  const runtimeUrl = new URL('../../../workflows/shared/runtime.ts', import.meta.url).href;
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
