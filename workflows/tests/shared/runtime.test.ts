/** @file Outcome: Shared runtime input handling preserves strict absolute-path behavior. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliErrorResult, readAbsoluteJson } from '../../shared/runtime.ts';

test('reads absolute JSON and rejects relative or malformed input', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-')), 'input.json');
  test.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
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
