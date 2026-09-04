/** @file Outcome: Canonical source seals change only with review-visible source or logical Git identity. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { sealRepository } from '../../execution/source-seal.ts';
import { temporaryDirectory } from '../shared/fixtures.ts';

function repository(): string {
  const repo = temporaryDirectory('codex-source-seal-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'one\n');
  fs.mkdirSync(path.join(repo, 'empty'));
  execFileSync('git', ['add', '.gitignore', 'value.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
  return repo;
}

test('visible bytes, mode, symlink, empty directory, and logical Git identity are sealed', () => {
  const repo = repository();
  const initial = sealRepository(repo, { scopes: ['value.txt', 'missing'] });
  fs.mkdirSync(path.join(repo, 'ignored'));
  fs.writeFileSync(path.join(repo, 'ignored', 'cache'), 'ignored');
  assert.deepEqual(sealRepository(repo, { scopes: ['value.txt', 'missing'] }), initial);

  fs.writeFileSync(path.join(repo, 'value.txt'), 'two\n');
  const bytes = sealRepository(repo);
  assert.notEqual(bytes.content_digest, initial.content_digest);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'one\n');
  fs.chmodSync(path.join(repo, 'value.txt'), 0o755);
  assert.notEqual(sealRepository(repo).content_digest, initial.content_digest);
  fs.chmodSync(path.join(repo, 'value.txt'), 0o644);
  fs.symlinkSync('value.txt', path.join(repo, 'link'));
  assert.notEqual(sealRepository(repo).content_digest, initial.content_digest);
  fs.unlinkSync(path.join(repo, 'link'));
  fs.rmdirSync(path.join(repo, 'empty'));
  assert.notEqual(sealRepository(repo).content_digest, initial.content_digest);
  fs.mkdirSync(path.join(repo, 'empty'));

  const logical = sealRepository(repo, {
    logical: { head: initial.head, branch: 'other', base_commit: initial.base_commit },
  });
  assert.equal(logical.content_digest, initial.content_digest);
  assert.notEqual(logical.source_digest, initial.source_digest);
  assert.match(initial.scopes[1]?.digest ?? '', /^[0-9a-f]{64}$/u);
});

test('a commit preserves content digest and changes full source digest', () => {
  const repo = repository();
  fs.writeFileSync(path.join(repo, 'next.txt'), 'next\n');
  const before = sealRepository(repo);
  execFileSync('git', ['add', 'next.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'next'], { cwd: repo });
  const after = sealRepository(repo);
  assert.equal(after.content_digest, before.content_digest);
  assert.notEqual(after.source_digest, before.source_digest);
});
