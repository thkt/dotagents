/** @file Outcome: Approved cleanup restores dirty state and resumes each durable effect safely. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from '../shared/fixtures.ts';
import { git, gitText, inventoryRepository } from '../../cleanup/inventory.ts';
import {
  captureShipReceipt,
  selectSource,
  type Proof,
  type EvidenceGateway,
} from '../../cleanup/evidence.ts';
import { cleanupArtifactDirectory, cleanupRepository } from '../../runtime/storage.ts';
import { approveCleanup, prepareCleanup, runCleanup } from '../../cleanup/controller.ts';

function fixture({
  legacy = false,
  tracking = false,
  missingBase = false,
  linkedCurrent = false,
  conflict = false,
  merge = null,
}: {
  legacy?: boolean;
  tracking?: boolean;
  missingBase?: boolean;
  linkedCurrent?: boolean;
  conflict?: boolean;
  merge?: 'merge-commit' | 'squash' | 'rebase' | null;
} = {}) {
  let repo = temporaryDirectory('cleanup-controller-');
  git(repo, ['init', '-q', '-b', 'topic']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(repo, 'dirty'), 'original\n');
  fs.writeFileSync(path.join(repo, 'untouched'), 'old\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'source']);
  git(repo, ['branch', 'main']);
  git(repo, ['branch', 'unrelated']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  git(repo, ['config', 'branch.topic.remote', 'origin']);
  git(repo, ['config', 'branch.topic.merge', 'refs/heads/topic']);
  if (legacy) {
    git(repo, ['config', 'core.logAllRefUpdates', 'always']);
    fs.writeFileSync(path.join(repo, 'dirty'), 'legacy stash');
    git(repo, ['stash', 'push', '-qm', 'legacy']);
    git(repo, ['config', 'branch.unrelated.remote', 'preserved']);
    const other = temporaryDirectory('cleanup-other-worktree-');
    git(repo, ['worktree', 'add', '-qb', 'other', other]);
    fs.writeFileSync(path.join(other, 'dirty'), 'other staged');
    git(other, ['add', 'dirty']);
    fs.writeFileSync(path.join(other, 'dirty'), 'other unstaged');
    fs.symlinkSync('dirty', path.join(repo, 'untracked-link'));
  }
  if (linkedCurrent) {
    const linked = temporaryDirectory('cleanup-current-worktree-');
    git(repo, ['switch', '-q', 'unrelated']);
    git(repo, ['worktree', 'add', '-q', linked, 'topic']);
    repo = linked;
  }
  const originalBase = gitText(repo, ['rev-parse', 'refs/heads/main']);
  if (merge) {
    fs.writeFileSync(path.join(repo, 'feature'), 'shipped feature');
    git(repo, ['add', 'feature']);
    git(repo, ['commit', '-qm', 'shipped topic']);
  }
  const head = gitText(repo, ['rev-parse', 'HEAD']);
  if (tracking) git(repo, ['update-ref', 'refs/remotes/origin/topic', head]);
  const proof: Proof = {
    repository_id: 'R_fixture',
    repository_name: 'fixture/repo',
    head_repository_id: 'R_fixture',
    head_repository_name: 'fixture/repo',
    number: 7,
    url: 'https://github.com/fixture/repo/pull/7',
    base_ref: 'refs/heads/main',
    head_ref: 'refs/heads/topic',
    head_oid: head,
    state: 'OPEN',
    merged_at: null,
  };
  let base = head;
  if (merge) {
    base = git(
      repo,
      [
        'commit-tree',
        `${head}^{tree}`,
        '-p',
        originalBase,
        ...(merge === 'merge-commit' ? ['-p', head] : []),
      ],
      `${merge} result\n`,
    )
      .toString()
      .trim();
  }
  if (missingBase) {
    const clone = temporaryDirectory('cleanup-fetch-origin-');
    git(repo, ['clone', '--no-local', '-q', repo, clone]);
    git(clone, ['config', 'user.name', 'Fixture']);
    git(clone, ['config', 'user.email', 'fixture@example.test']);
    git(clone, ['checkout', '-qB', 'main']);
    fs.writeFileSync(path.join(clone, conflict ? 'dirty' : 'untouched'), 'new fetched base\n');
    git(clone, ['add', conflict ? 'dirty' : 'untouched']);
    git(clone, ['commit', '-qm', 'base advance']);
    base = gitText(clone, ['rev-parse', 'HEAD']);
    const bin = temporaryDirectory('cleanup-fetch-bin-');
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('fetch')) {
  if (args.at(-1)?.startsWith('refs/heads/main:refs/codex-cleanup/fetch/') !== true || !args.includes('--no-write-fetch-head') || !args.includes('--no-tags')) process.exit(90);
  const at = args.indexOf('https://github.com/fixture/repo.git');
  if (at < 0) process.exit(91);
  args[at] = ${JSON.stringify(clone)};
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior ?? ''}`;
    onTestFinished(() => {
      process.env.PATH = prior;
    });
  }
  let remote: string | null = head;
  let deletions = 0;
  const gateway: EvidenceGateway = {
    proof: () => ({ ...proof }),
    remote: (_repo, _endpoint, ref) => (ref === proof.head_ref ? remote : base),
    deleteRemote: (_repo, endpoint, ref, expected) => {
      assert.equal(endpoint, 'https://github.com/fixture/repo.git');
      assert.equal(ref, proof.head_ref);
      assert.equal(expected, head);
      assert.equal(remote, expected);
      deletions++;
      remote = null;
    },
  };
  captureShipReceipt(repo, 29, 'build-run', 'origin', 'main', 'topic', proof.url, gateway);
  proof.state = 'MERGED';
  proof.merged_at = '2026-09-07T00:00:00Z';
  fs.writeFileSync(path.join(repo, 'dirty'), 'staged\n');
  git(repo, ['add', 'dirty']);
  fs.writeFileSync(path.join(repo, 'dirty'), 'unstaged\n');
  fs.chmodSync(path.join(repo, 'dirty'), 0o755);
  fs.writeFileSync(path.join(repo, 'untracked'), 'untracked\n');
  fs.writeFileSync(path.join(repo, 'ignored'), 'ignored\n');
  const before = inventoryRepository(repo);
  const { prepared_digest: id } = prepareCleanup(
    repo,
    'cleanup-run',
    29,
    tracking ? 'refs/remotes/origin/topic' : null,
    gateway,
  );
  assert.deepEqual(inventoryRepository(repo), before);
  return {
    repo,
    gateway,
    id,
    before,
    head,
    base,
    deletions: () => deletions,
    setRemote: (v: string | null) => {
      remote = v;
    },
  };
}

test('cleanup restores staged/unstaged/modes/ignored/untracked state and preserves unrelated same-OID branch', () => {
  const f = fixture({ legacy: true });
  assert.throws(() => runCleanup(f.repo, 'cleanup-run', f.id, f.gateway));
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const result = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(result.status, 'cleaned', result.reason ?? '');
  const after = inventoryRepository(f.repo);
  assert.deepEqual(after.files, f.before.files);
  assert.deepEqual(after.index, f.before.index);
  assert.equal(after.branch, 'refs/heads/main');
  assert.equal(after.refs['refs/heads/unrelated'], f.head);
  assert.equal(after.refs['refs/heads/topic'], undefined);
  assert.equal(f.deletions(), 1);
});

for (const boundary of [
  'fetch',
  'capture',
  'register',
  'materialize',
  'checkout',
  'restore',
  'remote',
  'config',
  'local',
  'recovery',
  'fetch_cleanup',
]) {
  test(`interrupted ${boundary} reconciles without replaying remote deletion`, () => {
    const f = fixture();
    approveCleanup(f.repo, 'cleanup-run', f.id);
    const stopped = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway, (step) => {
      if (step === boundary) throw new Error('simulated process interruption');
    });
    assert.equal(stopped.status, 'resumable');
    assert.equal(stopped.pending, boundary, stopped.reason ?? '');
    const resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
    assert.equal(resumed.status, 'cleaned', resumed.reason ?? '');
    assert.equal(f.deletions(), 1);
    assert.deepEqual(inventoryRepository(f.repo).files, f.before.files);
  });
}

test('ambiguous remote outcome never resends and retains local/recovery targets until verified absence', () => {
  const f = fixture();
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const gateway = {
    ...f.gateway,
    deleteRemote() {
      throw new Error('request outcome unknown');
    },
  };
  const stopped = runCleanup(f.repo, 'cleanup-run', f.id, gateway);
  assert.equal(stopped.pending, 'remote');
  const resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.match(resumed.reason!, /cleanup_remote_ambiguous/);
  assert.equal(f.deletions(), 0);
  assert.equal(gitText(f.repo, ['rev-parse', 'refs/heads/topic']), f.head);
  assert.equal(gitText(f.repo, ['rev-parse', resumed.recovery_ref!]), resumed.recovery_oid);
  f.setRemote(null);
  assert.equal(runCleanup(f.repo, 'cleanup-run', f.id, f.gateway).status, 'cleaned');
  assert.equal(f.deletions(), 0);
});

test('observed remote recreation after confirmed deletion blocks subsequent local deletion', () => {
  const f = fixture();
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const stopped = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway, (step) => {
    if (step === 'config') {
      f.setRemote(f.head);
      throw new Error('recreated remote');
    }
  });
  assert.equal(stopped.pending, 'config');
  const resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.match(resumed.reason!, /recreated/);
  assert.equal(gitText(f.repo, ['rev-parse', 'refs/heads/topic']), f.head);
  assert.equal(f.deletions(), 1);
});

test('approval rejects any prepared inventory drift and a different task', () => {
  const f = fixture();
  assert.throws(() => approveCleanup(f.repo, 'different-task', f.id), /different input\/task/);
  fs.writeFileSync(path.join(f.repo, 'ignored'), 'changed after preview');
  assert.throws(() => approveCleanup(f.repo, 'cleanup-run', f.id), /inventory drift/);
  assert.equal(f.deletions(), 0);
});

for (const boundary of [
  'fetch',
  'capture',
  'register',
  'materialize',
  'checkout',
  'restore',
  'remote',
  'config',
  'local',
  'recovery',
  'fetch_cleanup',
]) {
  test(`pending ${boundary} publication interruption preserves the exact intent`, () => {
    const f = fixture();
    approveCleanup(f.repo, 'cleanup-run', f.id);
    const original = fs.linkSync;
    fs.linkSync = (source, destination) => {
      original(source, destination);
      if (String(destination).includes('/cleanup/journal/')) {
        const { value } = JSON.parse(fs.readFileSync(String(source), 'utf8'));
        if (value.step === boundary && value.phase === 'pending')
          throw new Error('publication durability uncertain');
      }
    };
    try {
      assert.equal(runCleanup(f.repo, 'cleanup-run', f.id, f.gateway).status, 'resumable');
    } finally {
      fs.linkSync = original;
    }
    let resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
    if (boundary === 'remote') {
      assert.match(resumed.reason!, /cleanup_remote_ambiguous/);
      assert.equal(f.deletions(), 0);
      f.setRemote(null); // Simulate the independently completed manual resolution.
      resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
    }
    assert.equal(resumed.status, 'cleaned', resumed.reason ?? '');
    assert.deepEqual(inventoryRepository(f.repo).files, f.before.files);
    assert.equal(f.deletions(), boundary === 'remote' ? 0 : 1);
  });
}

test('journal genesis survives consumed approval; a missing final revision cannot claim completion', () => {
  const f = fixture();
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const stopped = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway, (step) => {
    if (step === 'restore') throw new Error('stop');
  });
  assert.equal(stopped.pending, 'restore');
  const root = path.join(f.repo, '.codex', 'workflow-artifacts', 'cleanup');
  fs.unlinkSync(path.join(root, 'approval', `${f.id}.json`));
  const completed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(completed.status, 'cleaned', completed.reason ?? '');
  fs.unlinkSync(path.join(root, 'report', `${f.id}.json`));
  for (const file of fs.readdirSync(path.join(root, 'journal'))) {
    const record = JSON.parse(fs.readFileSync(path.join(root, 'journal', file), 'utf8'));
    if (record.value.step === 'fetch_cleanup' && record.value.phase === 'done')
      fs.unlinkSync(path.join(root, 'journal', file));
  }
  assert.throws(() => runCleanup(f.repo, 'cleanup-run', f.id, f.gateway), /truncated/);
});

test('topic drift before atomic local deletion preserves the changed ref and explicitly selected tracking ref', () => {
  const f = fixture({ tracking: true });
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const stopped = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway, (step) => {
    if (step === 'config') throw new Error('stop before local deletion');
  });
  assert.equal(stopped.pending, 'config');
  const other = git(
    f.repo,
    ['commit-tree', `${f.head}^{tree}`, '-p', f.head],
    'independent commit\n',
  )
    .toString()
    .trim();
  git(f.repo, ['update-ref', 'refs/heads/topic', other, f.head]);
  const resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(resumed.status, 'resumable');
  assert.match(resumed.reason!, /topic ref moved/);
  assert.equal(gitText(f.repo, ['rev-parse', 'refs/heads/topic']), other);
  assert.equal(gitText(f.repo, ['rev-parse', 'refs/remotes/origin/topic']), f.head);
  assert.equal(gitText(f.repo, ['rev-parse', stopped.recovery_ref!]), stopped.recovery_oid);
});

test('a changed owned recovery ref stops before materialization or deletion', () => {
  const f = fixture();
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const stopped = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway, (step) => {
    if (step === 'register') throw new Error('stop');
  });
  git(f.repo, ['update-ref', stopped.recovery_ref!, f.head, stopped.recovery_oid!]);
  const resumed = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.match(resumed.reason!, /recovery ref mismatch/);
  assert.equal(f.deletions(), 0);
  assert.deepEqual(inventoryRepository(f.repo).files, f.before.files);
});

test('missing verified base fetches only its approved owned ref and restores dirty state onto the advanced base', () => {
  const f = fixture({ missingBase: true });
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const result = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(result.status, 'cleaned', result.reason ?? '');
  assert.equal(gitText(f.repo, ['rev-parse', 'HEAD']), f.base);
  assert.equal(fs.readFileSync(path.join(f.repo, 'untouched'), 'utf8'), 'new fetched base\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'dirty'), 'utf8'), 'unstaged\n');
  assert.equal(gitText(f.repo, ['show', ':dirty']), 'staged');
  assert.equal(gitText(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/codex-cleanup']), '');
  assert.equal(f.deletions(), 1);
}, 30_000);

test('cleanup from a linked worktree uses one repository artifact owner and checks each current Git file once', () => {
  const f = fixture({ linkedCurrent: true });
  const primary = cleanupRepository(f.repo);
  assert.notEqual(primary, f.repo);
  assert.equal(cleanupArtifactDirectory(f.repo), cleanupArtifactDirectory(primary));
  assert.deepEqual(selectSource(f.repo, 29), selectSource(primary, 29));
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const result = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(result.status, 'cleaned', result.reason ?? '');
  assert.equal(gitText(f.repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  assert.deepEqual(inventoryRepository(f.repo).files, f.before.files);
  assert.deepEqual(inventoryRepository(f.repo).worktrees, f.before.worktrees);
}, 30_000);

test('a fetched-base restore conflict reports blocked with canonical recovery and zero deletion', () => {
  const f = fixture({ missingBase: true, conflict: true });
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const result = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(result.status, 'blocked', result.reason ?? '');
  assert.match(result.reason!, /cleanup_restore_conflict/);
  assert.equal(gitText(f.repo, ['rev-parse', result.recovery_ref!]), result.recovery_oid);
  assert.equal(f.deletions(), 0);
  assert.deepEqual(inventoryRepository(f.repo).files, f.before.files);
  const again = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
  assert.equal(again.status, 'blocked');
  assert.equal(again.recovery_oid, result.recovery_oid);
}, 30_000);

test('a ref race after inventory comparison fails the local expected-OID transaction without deleting its other target', () => {
  const f = fixture({ tracking: true });
  const other = git(f.repo, ['commit-tree', `${f.head}^{tree}`, '-p', f.head], 'racing commit\n')
    .toString()
    .trim();
  approveCleanup(f.repo, 'cleanup-run', f.id);
  const original = fs.writeFileSync;
  let configDone = false,
    previews = 0;
  fs.writeFileSync = (file, data, options) => {
    original(file, data, options);
    if (configDone && String(file).endsWith('/config-preview') && ++previews === 2)
      git(f.repo, ['update-ref', 'refs/heads/topic', other, f.head]);
  };
  let result;
  try {
    result = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway, (step) => {
      if (step === 'config') configDone = true;
    });
  } finally {
    fs.writeFileSync = original;
  }
  assert.equal(result.pending, 'local', result.reason ?? '');
  assert.match(result.reason!, /cleanup_git_error/);
  assert.equal(gitText(f.repo, ['rev-parse', 'refs/heads/topic']), other);
  assert.equal(gitText(f.repo, ['rev-parse', 'refs/remotes/origin/topic']), f.head);
  assert.equal(gitText(f.repo, ['rev-parse', result.recovery_ref!]), result.recovery_oid);
}, 30_000);

for (const merge of ['merge-commit', 'squash', 'rebase'] as const) {
  test(`${merge} completion uses exact PR evidence even when the original topic is not an ancestor`, () => {
    const f = fixture({ merge });
    if (merge !== 'merge-commit')
      assert.throws(() => git(f.repo, ['merge-base', '--is-ancestor', f.head, f.base]));
    approveCleanup(f.repo, 'cleanup-run', f.id);
    const result = runCleanup(f.repo, 'cleanup-run', f.id, f.gateway);
    assert.equal(result.status, 'cleaned', result.reason ?? '');
    assert.equal(gitText(f.repo, ['rev-parse', 'HEAD']), f.base);
    assert.deepEqual(inventoryRepository(f.repo).files, f.before.files);
    assert.equal(f.deletions(), 1);
  }, 30_000);
}
