import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadRecords, saveRecords } from '../../../test-runtime/affected-records.ts';
import { selectAffected } from '../../../test-runtime/affected.ts';

function git(root: string, ...args: string[]): string {
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
  return result.stdout.trim();
}

// 契約で決まっている保存先です。実装の recordsPath を使わず、git から直接求めます。
function storedPath(root: string): string {
  return join(resolve(root, git(root, 'rev-parse', '--git-dir')), 'dotagents', 'test-deps.json');
}

function withRepo(run: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'affected-records-')));
  try {
    git(root, 'init', '-b', 'main');
    writeFileSync(join(root, 'base.txt'), 'x');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'base');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function modules(root: string, ...names: string[]): Set<string> {
  return new Set(names.map((name) => join(root, name)));
}

test('実行したテストファイルの記録だけを置き換え、実行しなかったファイルの記録を残す', () => {
  withRepo((root) => {
    const a = join(root, 'a.test.ts');
    const b = join(root, 'b.test.ts');
    saveRecords({
      root,
      ran: new Map([
        [a, modules(root, 'a1.ts')],
        [b, modules(root, 'b1.ts')],
      ]),
      failed: [],
    });
    saveRecords({ root, ran: new Map([[a, modules(root, 'a2.ts')]]), failed: [] });

    const loaded = loadRecords(root);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.records.get(a)).toEqual(modules(root, 'a2.ts'));
    expect(loaded.records.get(b)).toEqual(modules(root, 'b1.ts'));

    // 記録は git dir の中の 1 ファイルだけで、置き換えに使った一時ファイルを残さない。
    expect(existsSync(storedPath(root))).toBe(true);
    expect(readdirSync(dirname(storedPath(root)))).toEqual(['test-deps.json']);

    // 別 worktree の記録は、その worktree の git dir に入り、元の worktree の記録に触れない。
    const linked = join(root, '..', `${root.split('/').pop()}-linked`);
    git(root, 'worktree', 'add', '-b', 'linked', linked);
    try {
      const linkedRoot = realpathSync(linked);
      expect(storedPath(linkedRoot)).not.toBe(storedPath(root));
      saveRecords({
        root: linkedRoot,
        ran: new Map([[a, modules(root, 'linked.ts')]]),
        failed: [],
      });
      expect(existsSync(storedPath(linkedRoot))).toBe(true);
      expect(loadRecords(linkedRoot).records.get(a)).toEqual(modules(root, 'linked.ts'));
      expect(loadRecords(root).records.get(a)).toEqual(modules(root, 'a2.ts'));
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

test('失敗したテストファイルの記録は消し、次回は記録なしとして選ばれる', () => {
  withRepo((root) => {
    const ok = join(root, 'ok.test.ts');
    const bad = join(root, 'bad.test.ts');
    saveRecords({
      root,
      ran: new Map([
        [ok, modules(root, 'ok.ts')],
        [bad, modules(root, 'bad.ts')],
      ]),
      failed: [],
    });
    // bad.test.ts は今回失敗した。実行はしたので ran にも入っているが、記録は残さない。
    saveRecords({
      root,
      ran: new Map([[bad, modules(root, 'bad.ts', 'half-read.ts')]]),
      failed: [bad],
    });

    const { records } = loadRecords(root);
    expect(records.has(bad)).toBe(false);
    expect(records.get(ok)).toEqual(modules(root, 'ok.ts'));

    // 記録なしのテストファイルは、自分が読んだと分かっていない変更でも選ばれる。
    const selection = selectAffected({
      root,
      changed: [join(root, 'ok.ts')],
      testFiles: [ok, bad],
      records,
      readText: () => '',
    });
    expect(selection).toEqual({ kind: 'tests', tests: [ok, bad] });
  });
});

test('読めない記録ファイルは記録なしとして扱い、警告を出して全テストを選ぶ', () => {
  const unreadable = [
    { label: 'JSON として壊れている', body: '{not json' },
    { label: '形が違う', body: '["a.test.ts"]' },
  ];
  for (const { label, body } of unreadable) {
    withRepo((root) => {
      const path = storedPath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);

      const loaded = loadRecords(root);
      expect(loaded.records.size, label).toBe(0);
      expect(loaded.warning, label).toContain('test-deps.json');

      const a = join(root, 'a.test.ts');
      const b = join(root, 'b.test.ts');
      const selection = selectAffected({
        root,
        changed: [join(root, 'a-dep.ts')],
        testFiles: [a, b],
        records: loaded.records,
        readText: () => '',
      });
      expect(selection, label).toEqual({ kind: 'all', reasons: [join(root, 'a-dep.ts')] });

      // 次の保存は、読めなかった記録を捨てて新しい記録を書く。
      saveRecords({ root, ran: new Map([[a, modules(root, 'a-dep.ts')]]), failed: [] });
      const reloaded = loadRecords(root);
      expect(reloaded.warning, label).toBeUndefined();
      expect(reloaded.records.get(a), label).toEqual(modules(root, 'a-dep.ts'));
    });
  }
});
