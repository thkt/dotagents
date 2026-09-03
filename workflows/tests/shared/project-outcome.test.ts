/** @file Outcome: One shared loader supplies project scope or tells the user how to create it. */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { projectOutcomeContext } from '../../shared/project-outcome.ts';
import { errorCode } from '../../shared/errors.ts';
import { temporaryDirectory } from './fixtures.ts';

test('renders one shared context from a regular OUTCOME.md', () => {
  const repo = temporaryDirectory('codex-project-outcome-');
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(
    path.join(repo, '.codex/OUTCOME.md'),
    '# Project outcome\n\nDeliver an observable result.\n',
  );

  const context = projectOutcomeContext(repo);

  assert.match(context, /workflow runtime has already read/u);
  assert.match(context, /Project outcome:\n# Project outcome\n\nDeliver an observable result\./u);
});

test('asks for OUTCOME.md creation when it is missing', () => {
  const repo = temporaryDirectory('codex-project-outcome-missing-');

  assert.throws(
    () => projectOutcomeContext(repo),
    (error: unknown) => {
      assert.equal(errorCode(error), 'state_error');
      assert.match(String((error as Error).message), /OUTCOME\.md is missing; create it/u);
      assert.match(String((error as Error).message), /verifiable completion criteria/u);
      return true;
    },
  );
});

test('rejects unsafe or unbounded OUTCOME.md files', () => {
  const targetRepo = temporaryDirectory('codex-project-outcome-target-');
  fs.writeFileSync(path.join(targetRepo, 'target.md'), '# Project outcome\n');
  const symlinkRepo = temporaryDirectory('codex-project-outcome-symlink-');
  fs.mkdirSync(path.join(symlinkRepo, '.codex'));
  fs.symlinkSync(path.join(targetRepo, 'target.md'), path.join(symlinkRepo, '.codex/OUTCOME.md'));
  assert.throws(
    () => projectOutcomeContext(symlinkRepo),
    /OUTCOME\.md is unreadable|OUTCOME\.md must be a readable regular file/u,
  );

  const emptyRepo = temporaryDirectory('codex-project-outcome-empty-');
  fs.mkdirSync(path.join(emptyRepo, '.codex'));
  fs.writeFileSync(path.join(emptyRepo, '.codex/OUTCOME.md'), ' \n');
  assert.throws(() => projectOutcomeContext(emptyRepo), /OUTCOME\.md is empty/u);

  const largeRepo = temporaryDirectory('codex-project-outcome-large-');
  fs.mkdirSync(path.join(largeRepo, '.codex'));
  fs.writeFileSync(path.join(largeRepo, '.codex/OUTCOME.md'), 'x'.repeat(64 * 1024 + 1));
  assert.throws(() => projectOutcomeContext(largeRepo), /OUTCOME\.md exceeds 65536 bytes/u);
});
