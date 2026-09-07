/** @file Outcome: Cleanup inventory detects changes beyond the tracked working tree. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { temporaryDirectory } from '../shared/fixtures.ts';
import {
  git,
  gitText,
  inventoryRepository,
  inventoryDigest,
  parseInventory,
} from '../../cleanup/inventory.ts';

test('inventory distinguishes staged, unstaged, ignored, refs, reflogs, configuration and other worktrees', () => {
  const repo = temporaryDirectory('cleanup-inventory-');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(repo, 'value'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const original = inventoryRepository(repo);
  assert.deepEqual(parseInventory(original), original);
  const change = (effect: () => void) => {
    const before = inventoryDigest(inventoryRepository(repo));
    effect();
    assert.notEqual(inventoryDigest(inventoryRepository(repo)), before);
  };
  change(() => fs.writeFileSync(path.join(repo, 'value'), 'unstaged\n'));
  change(() => git(repo, ['add', 'value']));
  change(() => fs.chmodSync(path.join(repo, 'value'), 0o755));
  change(() => fs.writeFileSync(path.join(repo, 'ignored'), 'private bytes'));
  change(() => fs.writeFileSync(path.join(repo, 'untracked'), 'untracked bytes'));
  change(() => git(repo, ['update-ref', 'refs/heads/same-oid', original.head]));
  change(() => git(repo, ['config', 'branch.same-oid.description', 'protected']));
  change(() => git(repo, ['symbolic-ref', 'refs/custom-symbolic', 'refs/heads/main']));
  const other = temporaryDirectory('cleanup-worktree-');
  fs.rmdirSync(other);
  git(repo, ['worktree', 'add', '-q', '-b', 'other', other]);
  change(() => fs.writeFileSync(path.join(other, 'value'), 'other dirty\n'));
  const current = inventoryRepository(repo);
  assert.equal(current.refs['refs/heads/same-oid'], original.head);
  assert.equal(current.head, gitText(repo, ['rev-parse', 'HEAD']));
});

test('unsupported index flags stop inventory instead of silently omitting them', () => {
  const repo = temporaryDirectory('cleanup-index-');
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'x'), 'x');
  git(repo, ['add', 'x']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.test',
    'commit',
    '-qm',
    'initial',
  ]);
  git(repo, ['update-index', '--assume-unchanged', 'x']);
  assert.throws(() => inventoryRepository(repo), /unsupported index flags/);
});

test('branch reflog-only drift is sealed and intent-to-add is rejected without changing its flags', () => {
  const repo = temporaryDirectory('cleanup-index-flags-');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'source',
  ]);
  const before = inventoryRepository(repo);
  const log = path.join(repo, '.git', 'logs', 'refs', 'heads', 'main');
  fs.appendFileSync(log, fs.readFileSync(log));
  assert.notEqual(inventoryDigest(inventoryRepository(repo)), inventoryDigest(before));
  fs.writeFileSync(path.join(repo, 'intent'), 'not staged yet');
  git(repo, ['add', '-N', 'intent']);
  const index = fs.readFileSync(path.join(repo, '.git', 'index'));
  assert.throws(() => inventoryRepository(repo), /intent-to-add/);
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index);
});
