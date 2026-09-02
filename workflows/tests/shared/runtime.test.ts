/** @file Outcome: Shared runtime input handling preserves strict absolute-path behavior. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';
import { cliErrorResult, readAbsoluteJson, runCli } from '../../shared/runtime.ts';

test('reads absolute JSON and rejects relative or malformed input', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-')), 'input.json');
  onTestFinished(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, '{"ok":true}');
  assert.deepEqual(readAbsoluteJson(file, 'test'), { ok: true });
  assert.throws(() => readAbsoluteJson('input.json', 'test'), /absolute/);
  fs.writeFileSync(file, '{');
  assert.throws(() => readAbsoluteJson(file, 'test'), /unreadable/);
  const result = cliErrorResult('TEST/1', new Error('broken'));
  assert.deepEqual(result, {
    protocol: 'TEST/1',
    status: 'blocked',
    classification: 'execution_error',
    error: 'broken',
  });
});

test('a throwing workflow writes the blocked result and sets exit code 2', async () => {
  const written: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const previousExitCode = process.exitCode;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  onTestFinished(() => {
    process.stdout.write = stdoutWrite;
    // Bun keeps a previously assigned exit code when it is reassigned undefined, so reset to 0.
    process.exitCode = previousExitCode ?? 0;
  });

  runCli(() => {
    throw new Error('workflow failed');
  }, 'TEST/1');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(process.exitCode, 2);
  assert.deepEqual(JSON.parse(written.join('')), {
    protocol: 'TEST/1',
    status: 'blocked',
    classification: 'execution_error',
    error: 'workflow failed',
  });
});
