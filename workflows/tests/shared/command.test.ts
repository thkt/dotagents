/** @file Outcome: Shell command construction cannot reinterpret controller arguments as executable syntax. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';

import { shellCommand, shellSafeText } from '../../shared/command.ts';

test('quotes controller-supplied shell arguments without evaluating their contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shell-command-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'expanded');
  const argument = `literal ' quote $(touch ${marker})`;
  const result = spawnSync(shellCommand('printf', ['%s', argument]), {
    encoding: 'utf8',
    shell: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, argument);
  assert.equal(fs.existsSync(marker), false);
});

test('flattens shell control sequences to single spaces and keeps every other character', () => {
  const cases: [string, string][] = [
    ['plain title', 'plain title'],
    ['  padded\ttabs  ', 'padded tabs'],
    ['line\nbreak\r\nreturn', 'line break return'],
    ['a && b || c', 'a b c'],
    ['a; b & c | d', 'a b c d'],
    ['`cmd` $(cmd) <in >out', 'cmd cmd) in out'],
    ['quotes \' " and $VAR stay', 'quotes \' " and $VAR stay'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shellSafeText(input), expected, JSON.stringify(input));
  }
});
