/** @file Outcome: Shell command construction cannot reinterpret controller arguments as executable syntax. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { shellCommand } from '../../shared/command.ts';

test('quotes controller-supplied shell arguments without evaluating their contents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shell-command-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
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
