/** @file Outcome: Repository mutation checks ignore host checkpoints but retain user Git state. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  repositoryControlChanges,
  repositoryInvariant,
  sameWorkflowRepositoryInvariant,
} from '../../../workflows/shared/repository.ts';

function repository(t: test.TestContext): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repository-invariant-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
  return repo;
}

function updateRef(repo: string, ref: string): void {
  execFileSync('git', ['update-ref', ref, 'HEAD'], { cwd: repo });
}

function legacyRefFingerprint(repo: string): string {
  return execFileSync('git', ['for-each-ref', '--format=%(refname)%00%(objectname)%00'], {
    cwd: repo,
  }).toString('base64');
}

test('Codex desktop refs are host state, not workflow repository mutations', (t) => {
  const repo = repository(t);
  const before = repositoryInvariant(repo);

  updateRef(repo, 'refs/codex/turn-diffs/checkpoints/task/turn/checkpoint');
  updateRef(repo, 'refs/codex/turn-diffs/captures/turn/capture/base');
  updateRef(repo, 'refs/codex/snapshots/task');

  const after = repositoryInvariant(repo);
  assert.equal(sameWorkflowRepositoryInvariant(before, after), true);
  assert.deepEqual(repositoryControlChanges(before, after), []);
});

test('repository-owned refs remain protected Git metadata', (t) => {
  const repo = repository(t);
  const before = repositoryInvariant(repo);
  assert.equal(before.metadata.refs, legacyRefFingerprint(repo));

  updateRef(repo, 'refs/heads/unexpected');

  const after = repositoryInvariant(repo);
  assert.equal(after.metadata.refs, legacyRefFingerprint(repo));
  assert.equal(sameWorkflowRepositoryInvariant(before, after), false);
  assert.deepEqual(repositoryControlChanges(before, after), ['Git metadata']);
});
