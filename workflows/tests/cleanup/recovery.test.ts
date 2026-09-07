/** @file Outcome: Recovery ownership pins native commit OIDs and restores dirty paths against the verified base. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { temporaryDirectory } from '../shared/fixtures.ts';
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
