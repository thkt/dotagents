/** @file Outcome: Shared workflow CLI parsing rejects ambiguous commands and flags. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCommand, requireExactFlags } from '../../shared/cli.ts';

test('parses one command with singleton flags', () => {
  const parsed = parseCommand(['run', '--input', '/tmp/input.json', '--run-id', 'task-1']);
  assert.equal(parsed.command, 'run');
  assert.deepEqual({ ...parsed.flags }, { '--input': '/tmp/input.json', '--run-id': 'task-1' });
});

test('rejects duplicate and incomplete flags', () => {
  assert.throws(() => parseCommand(['run', '--input', 'a', '--input', 'b']), /only once/);
  assert.throws(() => parseCommand(['run', '--input']), /missing value/);
});

test('requires the exact flag set', () => {
  const { flags } = parseCommand(['run', '--input', 'a']);
  assert.doesNotThrow(() => requireExactFlags(flags, ['--input']));
  assert.throws(() => requireExactFlags(flags, ['--run-id']), /unsupported flag/);
});
