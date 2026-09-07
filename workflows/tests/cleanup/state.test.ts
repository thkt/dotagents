/** @file Outcome: Durable cleanup records reconcile identical writes and fail closed on corruption. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { temporaryDirectory } from '../shared/fixtures.ts';
import {
  canonical,
  assertNoImplementation,
  registerImplementation,
  closed,
  digest,
  oid,
  ownCleanup,
  probeDurability,
  publishBytes,
  publishRecord,
  readRecord,
} from '../../cleanup/state.ts';
import { git } from '../../cleanup/inventory.ts';
import { cleanupArtifactDirectory } from '../../runtime/storage.ts';

test('canonical records preserve exact identity and reject corruption and unknown fields', () => {
  const repo = temporaryDirectory('cleanup-record-');
  git(repo, ['init', '-q']);
  const id = digest('test', { a: 1, b: 2 });
  assert.equal(id, digest('test', { b: 2, a: 1 }));
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  const parse = (v: unknown) => closed(v, ['a', 'b'], 'test');
  publishRecord(repo, 'prepared', id, { a: 1, b: 2 });
  publishRecord(repo, 'prepared', id, { b: 2, a: 1 });
  assert.deepEqual(readRecord(repo, 'prepared', id, parse), { a: 1, b: 2 });
  assert.throws(() => publishRecord(repo, 'prepared', id, { a: 2, b: 2 }), /conflict/);
  const file = path.join(cleanupArtifactDirectory(repo), 'prepared', `${id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => readRecord(repo, 'source', id, parse), /ENOENT/);
  const record = JSON.parse(before);
  record.repository = '/another/repository';
  fs.writeFileSync(file, canonical(record) + '\n');
  assert.throws(() => readRecord(repo, 'prepared', id, parse), /invalid/);
  fs.writeFileSync(file, before);
  assert.throws(
    () => readRecord(repo, 'prepared', id, (v) => closed(v, ['a'], 'test')),
    /unknown key/,
  );
  assert.throws(() => oid('a'.repeat(39), 'sha1'), /full lowercase/);
  assert.throws(() => oid('A'.repeat(40), 'sha1'), /full lowercase/);
  assert.throws(() => oid('a'.repeat(64), 'sha1'), /full lowercase/);
});

test('fsync failure leaves no claimed success and revalidates visible records on retry', () => {
  const root = temporaryDirectory('cleanup-fsync-');
  const file = path.join(root, 'record');
  for (const boundary of [1, 2, 3, 4]) {
    fs.rmSync(file, { force: true });
    const original = fs.fsyncSync;
    let calls = 0;
    fs.fsyncSync = (fd) => {
      if (++calls === boundary) throw new Error('injected durability failure');
      original(fd);
    };
    try {
      assert.throws(() => publishBytes(file, 'retained'), /durability failure/);
    } finally {
      fs.fsyncSync = original;
    }
    assert.equal(
      fs.readdirSync(root).some((f) => f.startsWith('.pending-')),
      false,
    );
    publishBytes(file, 'retained');
    assert.equal(fs.readFileSync(file, 'utf8'), 'retained');
  }
});

test('repository owner excludes another cleanup across run identities', () => {
  const repo = temporaryDirectory('cleanup-owner-');
  git(repo, ['init', '-q']);
  probeDurability(repo);
  using owner = ownCleanup(repo);
  assert.throws(() => ownCleanup(repo), /active cleanup owner/);
  assert.ok(owner);
});

test('concurrent no-clobber writers keep one exact record and reject a conflicting publisher', async () => {
  const root = temporaryDirectory('cleanup-concurrent-');
  const file = path.join(root, 'record');
  const module = new URL('../../cleanup/state.ts', import.meta.url).href;
  const writer = (bytes: string) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `import {publishBytes} from ${JSON.stringify(module)}; publishBytes(${JSON.stringify(file)}, ${JSON.stringify(bytes)});`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
  const a = writer('same'),
    b = writer('same');
  assert.deepEqual(await Promise.all([a.exited, b.exited]), [0, 0]);
  fs.unlinkSync(file);
  const c = writer('left'),
    d = writer('right');
  assert.deepEqual(
    (await Promise.all([c.exited, d.exited])).sort((a, b) => a - b),
    [0, 1],
  );
  assert.ok(['left', 'right'].includes(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(fs.readdirSync(root), ['record']);
});

test('writer exclusion spans linked worktrees and unrecognized cleanup files are not hidden', () => {
  const repo = temporaryDirectory('cleanup-linked-owner-');
  const linked = temporaryDirectory('cleanup-linked-worktree-');
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
  git(repo, ['worktree', 'add', '-qb', 'other', linked]);
  {
    using owner = ownCleanup(repo);
    assert.ok(owner);
    assert.throws(() => ownCleanup(linked), /active cleanup owner/);
  }
  fs.writeFileSync(path.join(cleanupArtifactDirectory(repo), 'unrelated-user-file'), 'preserve');
  assert.throws(() => ownCleanup(repo), /unsupported cleanup namespace entry/);
  assert.equal(
    fs.readFileSync(path.join(cleanupArtifactDirectory(repo), 'unrelated-user-file'), 'utf8'),
    'preserve',
  );
});

test('completed implementation in another removed worktree does not block cleanup, while active or mismatched state does', () => {
  const repo = temporaryDirectory('cleanup-implementation-owner-');
  const linked = temporaryDirectory('cleanup-implementation-linked-');
  const stateFile = path.join(temporaryDirectory('cleanup-implementation-state-'), 'state.json');
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
  git(repo, ['worktree', 'add', '-qb', 'other', linked]);
  registerImplementation(linked, 'build-run', stateFile);
  const state = { run_id: 'build-run', manifest: { repo: linked }, status: 'running' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.throws(() => assertNoImplementation(repo), /must finish or be cancelled/);
  state.status = 'completed';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assertNoImplementation(repo);
  git(repo, ['worktree', 'remove', linked]);
  assertNoImplementation(repo);
  state.status = 'cancelled';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assertNoImplementation(repo);
  state.manifest.repo = repo;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.throws(() => assertNoImplementation(repo), /must finish or be cancelled/);
});
