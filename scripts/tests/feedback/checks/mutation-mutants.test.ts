import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withoutAutoMaintenance } from '../../../test-runtime/runner.ts';
import { planMutants, readChanges, selectMutants } from '../../../test-runtime/mutation/mutants.ts';
import type { Changes, Mutant } from '../../../test-runtime/mutation/mutants.ts';
import { formatReport } from '../../../test-runtime/mutation/execute.ts';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, encoding: 'utf8', env: withoutAutoMaintenance(process.env) },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

async function repository(
  base: Record<string, string>,
  change: Record<string, string>,
  run: (root: string, baseCommit: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'mutation-mutants-'));
  try {
    git(root, 'init', '-q');
    await write(root, base);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const commit = git(root, 'rev-parse', 'HEAD');
    await write(root, change);
    await run(root, commit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Hunk = Changes['hunks'][number];

const describe = (mutant: Mutant) =>
  `${mutant.file}:${mutant.line} ${mutant.operator} ${mutant.original} -> ${mutant.replacement}`;

test('T-001 変更差分の追加・変更行にだけ変異を作り、移動や整形だけの行には作らない', async () => {
  await repository(
    {
      'scripts/lib/limit.ts': [
        'export function low(n: number) {',
        '  return n < 3;',
        '}',
        'export function moved(n: number) {',
        '  return n > 1 && false;',
        '}',
        'export const wide = (n: number) => n >= 2;',
        'export const kept = (n: number) => n <= 9;',
        '',
      ].join('\n'),
      'scripts/test-runtime/runner.ts': 'export const ok = 1;\n',
      'scripts/tests/feedback/limit.test.ts': 'export const a = 1;\n',
    },
    {
      'scripts/lib/limit.ts': [
        'export function moved(n: number) {',
        '  return n > 1 && false;',
        '}',
        'export function low(n: number) {',
        '  return n <= 4;',
        '}',
        'export const wide = (n: number) =>',
        '  n >= 2;',
        'export const kept = (n: number) => n <= 9;',
        '',
      ].join('\n'),
      'scripts/test-runtime/runner.ts': 'export const ok = 1 === 1;\n',
      'scripts/tests/feedback/limit.test.ts': 'export const a = 1 < 2;\n',
      'scripts/lib/untracked.ts': 'export const on = true;\n',
      'docs/note.ts': 'export const off = false;\n',
    },
    async (root, base) => {
      const plan = planMutants(await readChanges(root, base));
      expect(plan.mutants.map(describe).sort()).toEqual([
        'scripts/lib/limit.ts:5 boundary-flip <= -> <',
        'scripts/lib/untracked.ts:1 boolean-flip true -> false',
        'scripts/test-runtime/runner.ts:1 condition-negation === -> !==',
      ]);
      expect(plan.movedLines).toBeGreaterThan(0);
    },
  );
});

const hunk = (file: string, newStart: number, added: string[], deleted: string[] = []): Hunk => ({
  file,
  oldStart: newStart,
  oldCount: deleted.length,
  newStart,
  newCount: added.length,
  added: added.map((text, index) => ({ line: newStart + index, text })),
  deleted,
});

const sources = new Map([
  ['scripts/a.ts', 'export const a = (n: number) => n < 1 && true;\n'],
  ['scripts/b.ts', 'export const b = (n: number) => n > 2 || false;\n'],
  ['scripts/c.ts', 'export const c = (n: number) => n >= 3 && true;\n'],
]);
const changed = {
  hunks: [...sources].map(([file, text]) => hunk(file, 1, [text.trimEnd()])),
  sources,
  ignoredFiles: [],
};

test('T-002 lint か型検査で失敗する変異は実行対象から外し、演算子別・ファイル別の破棄数として報告する', async () => {
  const plan = planMutants(changed);
  const checked: string[] = [];
  const selection = await selectMutants(plan, 10, async (mutant) => {
    checked.push(mutant.id);
    return !(mutant.operator === 'boolean-flip' || mutant.file === 'scripts/c.ts');
  });
  expect(checked).toHaveLength(plan.mutants.length);
  expect(selection.selected.map(describe)).toEqual([
    'scripts/a.ts:1 boundary-flip < -> <=',
    'scripts/b.ts:1 boundary-flip > -> >=',
  ]);
  expect(selection.discarded).toEqual({
    total: 4,
    byOperator: { 'boolean-flip': 3, 'boundary-flip': 1 },
    byFile: { 'scripts/a.ts': 1, 'scripts/b.ts': 1, 'scripts/c.ts': 2 },
  });
  expect(selection.unmutated).toEqual([{ hunk: 'scripts/c.ts:1', reason: 'discarded' }]);
  const report = formatReport(plan, selection, undefined);
  expect(report).toContain('破棄（lint・型検査で失敗）: 4');
  expect(report).toContain('演算子別: boolean-flip 3, boundary-flip 1');
  expect(report).toContain('ファイル別: scripts/a.ts 1, scripts/b.ts 1, scripts/c.ts 2');
});

test('T-003 行の削除だけの差分は変異を作れない削除行として報告し、生き残り 0 件の結果として扱わない', async () => {
  const plan = planMutants({
    hunks: [{ ...hunk('scripts/a.ts', 4, [], ['  assert(ready);']), newCount: 0 }],
    sources: new Map([['scripts/a.ts', 'export const a = 1;\n']]),
    ignoredFiles: [],
  });
  expect(plan.mutants).toEqual([]);
  expect(plan.unmutable).toEqual([{ hunk: 'scripts/a.ts:-4,1', reason: 'deleted-only' }]);
  const selection = await selectMutants(plan, 10, async () => true);
  const report = formatReport(plan, selection, {
    outcomes: [],
    qualityRequested: false,
  });
  expect(report).toContain('削除行だけ: scripts/a.ts:-4,1');
  expect(report).toContain('実行した変異は0件です');
  expect(report).not.toMatch(/すべて検出/);
});

test('T-004 変異数が上限を超えると決定的な順で選び、変異しなかった差分を一覧にする', async () => {
  const plan = planMutants(changed);
  const select = async () =>
    (await selectMutants(plan, 2, async () => true)).selected.map(describe);
  const first = await select();
  expect(first).toEqual([
    'scripts/a.ts:1 boundary-flip < -> <=',
    'scripts/b.ts:1 boundary-flip > -> >=',
  ]);
  expect(await select()).toEqual(first);
  const selection = await selectMutants(plan, 2, async () => true);
  expect(selection.unmutated).toEqual([{ hunk: 'scripts/c.ts:1', reason: 'cap' }]);
  expect(selection.skippedCandidates).toBe(plan.mutants.length - 2);
  expect(formatReport(plan, selection, undefined)).toContain(
    '上限で変異しなかった: scripts/c.ts:1',
  );
});

// ファイル全体を追加行として扱い、変更行の制限を受けない候補を並べる。
function planSource(source: string) {
  const file = 'scripts/a.ts';
  const lines = source.split('\n');
  return planMutants({
    hunks: [hunk(file, 1, lines)],
    sources: new Map([[file, source]]),
    ignoredFiles: [],
  }).mutants.map((mutant) => `${mutant.line} ${mutant.original} -> ${mutant.replacement}`);
}

test('文字列・テンプレート・正規表現・コメントの中の比較には変異を作らず、コードと埋め込み式の比較には作る', () => {
  const source = [
    'const quoted = \'a < b\' + "c > d";',
    'const template = `a < b ${n < 1} c > d`;',
    'const pattern = /a < b/.test(text);',
    '// a < b',
    '/* c > d */',
    'const real = n > 2;',
  ].join('\n');
  expect(planSource(source)).toEqual(['2 < -> <=', '6 > -> >=']);
});

for (const keyword of [
  'return',
  'typeof',
  'case',
  'await',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'else',
  'do',
  'instanceof',
]) {
  test(`キーワード ${keyword} の直後の/は正規表現の開始として扱い、後続の行の変異を失わない`, () => {
    const source = [
      `x = ${keyword} /["']/.test(c) && n < 5;`,
      `y = ${keyword} /[$\`]/.test(c) && n < 6;`,
      'const ok = n > 1;',
    ].join('\n');
    expect(planSource(source)).toEqual(['1 < -> <=', '2 < -> <=', '3 > -> >=']);
  });
}

test('値の直後の/は除算として扱い、同じ行の比較に変異を作る', () => {
  expect(planSource('const half = total / 2 > limit / 3;')).toEqual(['1 > -> >=']);
});

test('if・while・assertの条件を否定した変異を作る', () => {
  const source = [
    'if (ready) {',
    '}',
    'while (count > 0) {',
    '}',
    "assert(!done, 'message');",
    "assert(a && b, 'message');",
  ].join('\n');
  expect(planSource(source)).toEqual([
    '1 ready -> !ready',
    '3 count > 0 -> !(count > 0)',
    '3 > -> >=',
    '5 !done -> done',
    '6 a && b -> !(a && b)',
  ]);
});

for (const [name, value] of [
  ['diff.mnemonicPrefix', 'true'],
  ['diff.noprefix', 'true'],
  ['diff.srcPrefix', 'old/'],
  ['diff.dstPrefix', 'new/'],
] as const) {
  test(`利用者のgit設定 ${name} でdiffの接頭辞が変わっても変更ファイルを読み取る`, async () => {
    await repository(
      { 'scripts/lib/a.ts': 'export const a = (n: number) => n < 1;\n' },
      { 'scripts/lib/a.ts': 'export const a = (n: number) => n < 2;\n' },
      async (root, base) => {
        git(root, 'config', name, value);
        const plan = planMutants(await readChanges(root, base));
        expect(plan.mutants.map(describe)).toEqual(['scripts/lib/a.ts:1 boundary-flip < -> <=']);
        expect(plan.ignoredFiles).toEqual([]);
      },
    );
  });
}

test('空白を含むパスの変更ファイルにも変異を作る', async () => {
  await repository(
    { 'scripts/lib/a b.ts': 'export const a = (n: number) => n < 1;\n' },
    { 'scripts/lib/a b.ts': 'export const a = (n: number) => n < 2;\n' },
    async (root, base) => {
      const plan = planMutants(await readChanges(root, base));
      expect(plan.mutants.map(describe)).toEqual(['scripts/lib/a b.ts:1 boundary-flip < -> <=']);
    },
  );
});

test('対象外ファイルの削除行や部分一致を移動・整形とみなさず、変更した行に変異を作る', async () => {
  await repository(
    {
      'docs/note.md': 'const flag = n > 1;\n',
      'scripts/lib/a.ts': [
        'export async function f(n: number, count: number) {',
        '  await check(n > 1);',
        '  return count >= 10;',
        '}',
        '',
      ].join('\n'),
    },
    {
      'docs/note.md': 'removed\n',
      'scripts/lib/a.ts': [
        'export async function f(n: number, count: number) {',
        '  check(n > 1);',
        '  return count >= 1;',
        '}',
        'const flag = n > 1;',
        '',
      ].join('\n'),
    },
    async (root, base) => {
      const plan = planMutants(await readChanges(root, base));
      expect(plan.mutants.map(describe).sort()).toEqual([
        'scripts/lib/a.ts:2 boundary-flip > -> >=',
        'scripts/lib/a.ts:3 boundary-flip >= -> >',
        'scripts/lib/a.ts:5 boundary-flip > -> >=',
      ]);
      expect(plan.movedLines).toBe(0);
    },
  );
});

test('追加と削除が混在するhunkの削除行も変異を作れない差分として報告する', async () => {
  const plan = planMutants({
    hunks: [hunk('scripts/a.ts', 3, ['  return n < 2;'], ['  assert(ready);', '  return n < 1;'])],
    sources: new Map([['scripts/a.ts', 'a\nb\n  return n < 2;\n']]),
    ignoredFiles: [],
  });
  expect(plan.mutants.map(describe)).toEqual(['scripts/a.ts:3 boundary-flip < -> <=']);
  expect(plan.unmutable).toEqual([{ hunk: 'scripts/a.ts:-3,2', reason: 'deleted-lines' }]);
  const selection = await selectMutants(plan, 10, async () => true);
  expect(formatReport(plan, selection, undefined)).toContain(
    '削除した行（変異を作れないため、消したコードを確認する）: scripts/a.ts:-3,2',
  );
});

test('上限で一部の候補だけを検査したhunkは破棄ではなく上限で変異しなかった差分として報告する', async () => {
  const plan = planMutants({
    hunks: [
      hunk('scripts/a.ts', 1, ['export const a = (n: number) => n < 1 && n > 0;']),
      hunk('scripts/b.ts', 1, ['export const b = (n: number) => n <= 5;']),
    ],
    sources: new Map([
      ['scripts/a.ts', 'export const a = (n: number) => n < 1 && n > 0;\n'],
      ['scripts/b.ts', 'export const b = (n: number) => n <= 5;\n'],
    ]),
    ignoredFiles: [],
  });
  // 検査順はa.tsの<、b.tsの<=、a.tsの>。a.tsの<だけを破棄し、上限1件で止める。
  const selection = await selectMutants(plan, 1, async (mutant) => mutant.file !== 'scripts/a.ts');
  expect(selection.selected.map(describe)).toEqual(['scripts/b.ts:1 boundary-flip <= -> <']);
  expect(selection.unmutated).toEqual([{ hunk: 'scripts/a.ts:1', reason: 'cap' }]);
});
