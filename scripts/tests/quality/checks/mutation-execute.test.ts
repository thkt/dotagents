import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withoutAutoMaintenance } from '../../../test-runtime/runner.ts';
import { planMutants, readChanges, selectMutants } from '../../../test-runtime/mutation/mutants.ts';
import type { Changes } from '../../../test-runtime/mutation/mutants.ts';
import {
  createCopy,
  executeMutation,
  formatReport,
} from '../../../test-runtime/mutation/execute.ts';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, encoding: 'utf8', env: withoutAutoMaintenance(process.env) },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

type Tier = string;

const sources: Record<string, string> = {
  'scripts/a.ts': 'export const a = (n: number) => n < 1;\n',
  'scripts/b.ts': 'export const b = (n: number) => n > 2;\n',
  'scripts/c.ts': 'export const c = (n: number) => n >= 3;\n',
};
const changes: Changes = {
  hunks: Object.entries(sources).map(([file, text]) => ({
    file,
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: 1,
    added: [{ line: 1, text: text.trimEnd() }],
    deleted: [],
  })),
  sources: new Map(Object.entries(sources)),
  ignoredFiles: [],
};

// 実行の順序と、実行時の一時コピーの内容を記録する模擬runnerで実行する。
async function execute(results: boolean[]) {
  const copy = await mkdtemp(join(tmpdir(), 'mutation-execute-'));
  try {
    await write(copy, sources);
    const calls: { tier: Tier; files: string }[] = [];
    let selected = 0;
    const plan = planMutants(changes);
    const result = await executeMutation({
      copy,
      run: async (tier) => {
        const files = (
          await Promise.all(Object.keys(sources).map((file) => readFile(join(copy, file), 'utf8')))
        ).join('');
        calls.push({ tier, files });
        expect(tier).toBe('quality');
        const passed = results.shift();
        assert(passed !== undefined, `unexpected ${tier} run`);
        return { passed, ms: 1, timedOut: false };
      },
      select: async () => {
        selected++;
        return selectMutants(plan, 10, async () => true);
      },
    });
    const restored = await Promise.all(
      Object.entries(sources).map(
        async ([file, text]) => (await readFile(join(copy, file), 'utf8')) === text,
      ),
    );
    return { result, calls, selected, plan, restored };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

test('T-005 基準の品質テスト 実行が 3 回とも成功しないときは変異を実行せず専用の終了コードで止まる', async () => {
  for (const baseline of [[false], [true, false], [true, true, false]]) {
    const { result, calls, selected } = await execute([...baseline]);
    // 終了コード3はscripts/README.mdで利用者へ案内した値。
    expect(result.exitCode).toBe(3);
    expect(calls).toHaveLength(baseline.length);
    expect(selected).toBe(0);
    expect('execution' in result).toBe(false);
  }
  const passing = await execute([true, true, true, true, true, true]);
  expect(passing.result.exitCode).toBe(0);
  expect(passing.calls.filter((call) => call.tier === 'quality')).toHaveLength(6);
});

test('T-006 変異を入れた品質テスト 実行の失敗は再実行で確かめた場合だけ検出として数える', async () => {
  // 基準3回の後、aは失敗・再失敗、bは失敗・再成功、cは成功。
  const { result, calls, restored, plan } = await execute([
    true,
    true,
    true,
    false,
    false,
    false,
    true,
    true,
  ]);
  assert(result.exitCode === 0);
  const statuses = result.execution.outcomes.map((outcome) => [
    outcome.mutant.file,
    outcome.status,
  ]);
  expect(statuses).toEqual([
    ['scripts/a.ts', 'killed'],
    ['scripts/b.ts', 'unstable'],
    ['scripts/c.ts', 'survived'],
  ]);
  expect(calls.slice(3, 5).every((call) => call.files.includes('n <= 1'))).toBe(true);
  expect(calls.slice(5, 7).every((call) => call.files.includes('n >= 2'))).toBe(true);
  expect(calls[7]?.files).toContain('n > 3');
  expect(restored).toEqual([true, true, true]);
  const report = formatReport(plan, result.selection, result.execution);
  expect(report).toContain('検出 1 / 生き残り 1 / 不安定 1');
});

test('T-007 実際の checkout を変えずに未コミットの変更を含む一時コピーで変異を実行する', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mutation-checkout-'));
  let copy = '';
  try {
    git(repo, 'init', '-q');
    await write(repo, { 'scripts/a.ts': 'export const a = (n: number) => n < 1;\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    await write(repo, {
      'scripts/a.ts': 'export const a = (n: number) => n < 5;\n',
      'scripts/new.ts': 'export const on = true;\n',
    });
    const before = {
      status: git(repo, 'status', '--porcelain', '--untracked-files=all'),
      a: await readFile(join(repo, 'scripts/a.ts'), 'utf8'),
      added: await readFile(join(repo, 'scripts/new.ts'), 'utf8'),
    };
    const plan = planMutants(await readChanges(repo, base));
    copy = await createCopy(repo);
    expect(copy).not.toBe(repo);
    const seen: string[] = [];
    const result = await executeMutation({
      copy,
      run: async () => {
        seen.push(
          (await readFile(join(copy, 'scripts/a.ts'), 'utf8')) +
            (await readFile(join(copy, 'scripts/new.ts'), 'utf8')),
        );
        return { passed: true, ms: 1, timedOut: false };
      },
      select: () => selectMutants(plan, 10, async () => true),
    });
    assert(result.exitCode === 0);
    expect(seen.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => before.a + before.added));
    expect(seen.slice(3)).toEqual([
      'export const a = (n: number) => n <= 5;\n' + before.added,
      before.a + 'export const on = false;\n',
    ]);
    expect({
      status: git(repo, 'status', '--porcelain', '--untracked-files=all'),
      a: await readFile(join(repo, 'scripts/a.ts'), 'utf8'),
      added: await readFile(join(repo, 'scripts/new.ts'), 'utf8'),
    }).toEqual(before);
  } finally {
    await rm(repo, { recursive: true, force: true });
    if (copy) {
      await rm(copy, { recursive: true, force: true });
    }
  }
});

test('品質集合は変異の判定後に第二段で重複して追試しない', async () => {
  // 基準3回、aは検出のため2回、bとcは各1回。同じ集合を第二段で再実行しない。
  const run = await execute([true, true, true, false, false, true, true]);
  assert(run.result.exitCode === 0);
  expect(run.calls).toHaveLength(7);
  expect(run.calls.every((call) => call.tier === 'quality')).toBe(true);
  expect(run.result.execution.outcomes.map((outcome) => outcome.status)).toEqual([
    'killed',
    'survived',
    'survived',
  ]);
  const report = formatReport(run.plan, run.result.selection, run.result.execution);
  expect(report).toContain('検出 1 / 生き残り 2 / 不安定 0');
  expect(report).not.toContain('quality だけが検出した候補');
});

test('未追跡の入れ子のgit repoがあっても一時コピーを作り、通常ファイルだけを写す', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mutation-nested-'));
  let copy = '';
  try {
    git(repo, 'init', '-q');
    await write(repo, { 'scripts/a.ts': 'export const a = 1;\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    await mkdir(join(repo, 'vendor/sub'), { recursive: true });
    git(join(repo, 'vendor/sub'), 'init', '-q');
    await write(repo, { 'vendor/sub/inner.ts': 'export const inner = 1;\n', 'notes.txt': 'n\n' });
    copy = await createCopy(repo);
    expect(await readFile(join(copy, 'scripts/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(copy, 'notes.txt'), 'utf8')).toBe('n\n');
    expect(existsSync(join(copy, 'vendor/sub'))).toBe(false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    if (copy) {
      await rm(copy, { recursive: true, force: true });
    }
  }
});
