/** @file Outcome: Recovery ownership pins native commit OIDs and restores dirty paths against the verified base. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { ignoreWorkflowStorage, temporaryDirectory } from '../shared/fixtures.ts';
import { git, gitText, inventoryRepository } from '../../cleanup/inventory.ts';
import {
  captureRecovery,
  readRecovery,
  restoration,
  verifyRecoveryPreimage,
  writeFiles,
  writeIndex,
} from '../../cleanup/recovery.ts';
import { canonical, digest, probeDurability, publishRecord } from '../../cleanup/state.ts';
import { cleanupArtifactDirectory } from '../../runtime/storage.ts';

for (const format of ['sha1', 'sha256'] as const) {
  test(`${format} recovery keeps dirty index/files while untouched files follow the new base`, () => {
    const repo = temporaryDirectory('cleanup-recovery-');
    git(repo, ['init', '-q', '-b', 'main', `--object-format=${format}`]);
    ignoreWorkflowStorage(repo);
    git(repo, ['config', 'user.name', 'Fixture']);
    git(repo, ['config', 'user.email', 'fixture@example.test']);
    fs.writeFileSync(path.join(repo, 'dirty'), 'original');
    fs.writeFileSync(path.join(repo, 'untouched'), 'old');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'original']);
    const topic = gitText(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'untouched'), 'new base');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'new base']);
    const base = gitText(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-qb', 'topic', topic]);
    fs.writeFileSync(path.join(repo, 'dirty'), 'staged');
    git(repo, ['add', 'dirty']);
    fs.writeFileSync(path.join(repo, 'dirty'), 'unstaged');
    probeDurability(repo);
    const before = inventoryRepository(repo);
    const source = digest('source', topic);
    const recovery = captureRecovery(repo, source, before);
    assert.equal(recovery.recovery_oid.length, format === 'sha1' ? 40 : 64);
    assert.deepEqual(captureRecovery(repo, source, before), recovery);
    verifyRecoveryPreimage(repo, recovery, before);
    const restore = restoration(repo, before, base);
    writeFiles(repo, before.files, restore.materialized);
    writeFiles(repo, restore.materialized, restore.restored);
    writeIndex(repo, restore.restored_index);
    assert.equal(fs.readFileSync(path.join(repo, 'dirty'), 'utf8'), 'unstaged');
    assert.equal(fs.readFileSync(path.join(repo, 'untouched'), 'utf8'), 'new base');
    assert.equal(gitText(repo, ['show', ':dirty']), 'staged');
    assert.throws(
      () =>
        publishRecord(repo, 'recovery', recovery.ownership_id, { ...recovery, recovery_oid: base }),
      /conflict/,
    );
    const file = path.join(
      cleanupArtifactDirectory(repo),
      'recovery',
      `${recovery.ownership_id}.json`,
    );
    const original = fs.readFileSync(file, 'utf8');
    const blob = gitText(repo, ['rev-parse', `${topic}:dirty`]);
    for (const invalid of [
      base,
      topic.slice(0, 12),
      topic.toUpperCase(),
      'a'.repeat(format === 'sha1' ? 64 : 40),
      blob,
    ]) {
      const envelope = JSON.parse(original);
      envelope.value.recovery_oid = invalid;
      const { digest: _digest, ...data } = envelope;
      envelope.digest = digest('record', data);
      fs.writeFileSync(file, canonical(envelope) + '\n');
      assert.throws(() => readRecovery(repo, recovery.ownership_id, format));
    }
    fs.writeFileSync(file, original);
  });
}

test('an identical untracked path newly tracked by the base is a semantic restore conflict', () => {
  const repo = temporaryDirectory('cleanup-untracked-collision-');
  git(repo, ['init', '-q', '-b', 'main']);
  ignoreWorkflowStorage(repo);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['commit', '--allow-empty', '-qm', 'initial']);
  const old = gitText(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'new-file'), 'same bytes');
  git(repo, ['add', 'new-file']);
  git(repo, ['commit', '-qm', 'base tracks file']);
  const base = gitText(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-qB', 'topic', old]);
  fs.writeFileSync(path.join(repo, 'new-file'), 'same bytes');
  const before = inventoryRepository(repo);
  assert.throws(() => restoration(repo, before, base), /conflicts with saved path/);
  assert.deepEqual(inventoryRepository(repo), before);
});

test('restoration preserves unchanged entries and does not rewrite already applied paths on resume', () => {
  const repo = temporaryDirectory('cleanup-write-delta-');
  git(repo, ['init', '-q']);
  ignoreWorkflowStorage(repo);
  probeDurability(repo);
  fs.mkdirSync(path.join(repo, 'ignored'));
  fs.writeFileSync(path.join(repo, 'ignored/cache'), 'keep');
  fs.symlinkSync('cache', path.join(repo, 'ignored/link'));
  fs.writeFileSync(path.join(repo, 'changed'), 'before');
  const entries = {
    ignored: { kind: 'directory' as const, mode: 0o755, bytes: '' },
    'ignored/cache': {
      kind: 'file' as const,
      mode: 0o644,
      bytes: Buffer.from('keep').toString('base64'),
    },
    'ignored/link': {
      kind: 'symlink' as const,
      mode: fs.lstatSync(path.join(repo, 'ignored/link')).mode & 0o7777,
      bytes: Buffer.from('cache').toString('base64'),
    },
    changed: {
      kind: 'file' as const,
      mode: 0o644,
      bytes: Buffer.from('before').toString('base64'),
    },
  };
  const stamps = () =>
    Object.fromEntries(
      Object.keys(entries).map((key) => {
        const s = fs.lstatSync(path.join(repo, key));
        return [key, [s.ino, s.mtimeMs]];
      }),
    );
  const initial = stamps();
  const after = {
    ...entries,
    changed: { ...entries.changed, bytes: Buffer.from('after').toString('base64'), mode: 0o755 },
  };
  writeFiles(repo, entries, after);
  const applied = stamps();
  for (const key of ['ignored', 'ignored/cache', 'ignored/link'])
    assert.deepEqual(applied[key], initial[key]);
  assert.equal(fs.readFileSync(path.join(repo, 'changed'), 'utf8'), 'after');
  assert.equal(fs.statSync(path.join(repo, 'changed')).mode & 0o777, 0o755);
  writeFiles(repo, entries, after);
  assert.deepEqual(stamps(), applied);
});

test('unsafe restoration staging is rejected before source deletion, index replacement or private creation', () => {
  const repo = temporaryDirectory('cleanup-unsafe-restore-');
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'source'), 'preserve');
  git(repo, ['add', 'source']);
  const index = fs.readFileSync(path.join(repo, '.git/index'));
  const before = {
    source: {
      kind: 'file' as const,
      mode: 0o644,
      bytes: Buffer.from('preserve').toString('base64'),
    },
  };
  for (const write of [() => writeFiles(repo, before, {}), () => writeIndex(repo, {})]) {
    assert.throws(write, /Private storage/);
    assert.equal(fs.readFileSync(path.join(repo, 'source'), 'utf8'), 'preserve');
    assert.deepEqual(fs.readFileSync(path.join(repo, '.git/index')), index);
    assert.equal(fs.existsSync(path.join(repo, '.codex')), false);
  }
});
