import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { changedFiles, existingTestFiles, selectAffected } from '../../affected.ts';

function git(root: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

function write(root: string, path: string, text = 'x') {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function commit(root: string, message: string) {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
}

// main に base.ts・old.test.ts・touched.ts・quiet.ts を置き、work ブランチに切る。
function withRepo(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'affected-changes-'));
  try {
    git(root, 'init', '-b', 'main');
    write(root, 'base.ts');
    write(root, 'old.test.ts', 'test body for rename');
    write(root, 'touched.ts');
    write(root, 'quiet.ts');
    commit(root, 'base');
    git(root, 'switch', '-c', 'work');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function listed(root: string): string[] {
  return changedFiles({ root, base: 'main' }).sort();
}

test('main との分岐点以降の commit・未 commit の変更・未追跡ファイルを変更に数える', () => {
  withRepo((root) => {
    write(root, 'committed.ts');
    commit(root, 'work commit');
    // 分岐後に main だけが進んだ変更は、この枝の変更ではない。
    git(root, 'switch', 'main');
    write(root, 'main-only.ts');
    commit(root, 'main advances');
    git(root, 'switch', 'work');
    write(root, 'touched.ts', 'modified');
    write(root, 'untracked.ts');

    expect(listed(root)).toEqual(
      ['committed.ts', 'touched.ts', 'untracked.ts'].map((path) => join(root, path)),
    );
  });
});

test('rename は旧パスと新パスの両方を変更に数え、存在しないテストファイルは実行対象から除く', () => {
  withRepo((root) => {
    renameSync(join(root, 'old.test.ts'), join(root, 'new.test.ts'));
    commit(root, 'rename');

    const changed = listed(root);
    expect(changed).toEqual([join(root, 'new.test.ts'), join(root, 'old.test.ts')]);
    // old.test.ts は作業ツリーにない。
    expect(existingTestFiles(changed)).toEqual([join(root, 'new.test.ts')]);
  });
});

test('.claude/workspace/・docs/issues/・.issue-drafts/だけの変更は全部実行の理由にならない', () => {
  withRepo((root) => {
    write(root, '.claude/workspace/plan/state.json');
    write(root, 'docs/issues/draft.md');
    write(root, '.issue-drafts/451.md');
    expect(listed(root)).toEqual([]);

    // 除くのは 3 つのパスだけで、同じ docs 配下の別の変更は数える。
    write(root, 'docs/wiki/policy.md');
    write(root, 'touched.ts', 'modified');
    const changed = listed(root);
    expect(changed).toEqual([join(root, 'docs/wiki/policy.md'), join(root, 'touched.ts')]);

    const selection = selectAffected({
      root,
      changed,
      testFiles: [join(root, 'a.test.ts')],
      records: new Map([[join(root, 'a.test.ts'), new Set([join(root, 'touched.ts')])]]),
      readText: () => '',
    });
    expect(selection.kind === 'all' ? selection.reasons : []).toEqual([
      join(root, 'docs/wiki/policy.md'),
    ]);
  });
});
