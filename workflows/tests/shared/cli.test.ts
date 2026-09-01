/** @file Outcome: Shared workflow CLI parsing rejects ambiguous commands and flags. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCommand, parseCommandWithRepeatable, requireExactFlags } from '../../shared/cli.ts';

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

test('preserves repeatable typed workflow flags and rejects unknown or singleton duplicates', () => {
  const parsed = parseCommandWithRepeatable(
    ['run', '--scope-path', 'src', '--scope-path', 'test', '--external-sources', 'none'],
    ['--scope-path'],
  );
  assert.deepEqual(parsed.flags['--scope-path'], ['src', 'test']);
  assert.throws(
    () =>
      parseCommandWithRepeatable(
        ['run', '--external-sources', 'none', '--external-sources', 'broad'],
        ['--scope-path'],
      ),
    /only once/,
  );
  const unknown = parseCommandWithRepeatable(['run', '--unknown', 'x'], []);
  assert.throws(() => requireExactFlags(unknown.flags, ['--run-id']), /unsupported flag/);
});
