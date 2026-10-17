import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { appendHistory, importHistory } from '../fixtures/workspace/src/history.ts';
import { help } from '../fixtures/workspace/src/help.ts';
import { saveProfile } from '../fixtures/workspace/src/profile.ts';
import { retryLimit, batchWindowMs } from '../fixtures/workspace/src/retry.ts';

const fixture = resolve(import.meta.dir, '../fixtures/workspace');
const behavior = [
  'messages-behavior.test.ts',
  'results-behavior.test.ts',
  'work-areas.test.ts',
  'profile.test.ts',
  'retry.test.ts',
];
const acceptance = ['messages.test.ts', 'guide.test.ts', 'results.test.ts'];

test('scoping課題の資料は保存形式・設定・誤記と既存保証の不足を再現する', () => {
  const value = { version: 1, other: '既存データ' };
  expect(JSON.parse(saveProfile(value))).toEqual(value);
  expect(retryLimit).toBe(3);
  expect(batchWindowMs).toBe(100);
  expect(help).toBe('結果を保孫する');
  const saved: unknown[] = [];
  const write = (item: unknown) => saved.push(item);
  appendHistory({ id: '1', status: 'success', artifact: 'output.txt' }, write);
  appendHistory({ id: '2', status: 'failure', reason: '容量不足' }, write);
  importHistory('{"id":"3","status":"success"}', write);
  importHistory('{"id":"4","status":"failure"}', write);
  expect(saved).toHaveLength(4);
  expect(saved.slice(2)).toEqual([
    { id: '3', status: 'success' },
    { id: '4', status: 'failure' },
  ]);
  expect(() => importHistory('{"status":"success","artifact":"output.txt"}', write)).toThrow(
    'idが必要です',
  );
  expect(saved).toHaveLength(4);
});

function check(root: string, files: string[]) {
  const result = spawnSync(
    process.execPath,
    ['test', ...files.map((file) => `eval/fixtures/workspace/tests/${file}`)],
    { cwd: root, encoding: 'utf8', timeout: 10000 },
  );
  assert(!result.error, String(result.error));
  assert(result.signal === null, `検証プロセスが未完了: ${result.signal}`);
  return { code: result.status, output: result.stdout + result.stderr };
}

async function withWorkspace(action: (root: string, workspace: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'public-task-fixtures-'));
  const workspace = join(root, 'eval/fixtures/workspace');
  try {
    await mkdir(dirname(workspace), { recursive: true });
    await cp(fixture, workspace, { recursive: true });
    await action(root, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function replace(workspace: string, path: string, before: string, after: string) {
  const file = join(workspace, path);
  const text = await readFile(file, 'utf8');
  assert(text.includes(before), `反例の注入箇所がない: ${path}`);
  await writeFile(file, text.replace(before, after));
}

async function reference(workspace: string) {
  await replace(workspace, 'src/messages.ts', '処理が完了しました。', '保存が完了しました。');
  await replace(workspace, 'README.md', 'docs/old-guide.md', 'docs/current-guide.md');
  for (const [before, after] of [
    ['artifactエラー', '成功結果には成果物参照が必要です。'],
    ['reasonエラー', '失敗結果には理由が必要です。'],
    ['状態エラー', '結果の状態が不正です。'],
  ]) {
    assert(before && after);
    await replace(workspace, 'src/results.ts', before, after);
  }
}

test('課題の修正前は既存保証が通り、3件の変更要求だけが意図した理由で失敗する', async () => {
  await withWorkspace(async (root) => {
    expect(check(root, behavior).code).toBe(0);
    for (const [file, reason] of [
      ['messages.test.ts', '保存が完了しました。'],
      ['guide.test.ts', 'docs/current-guide.md'],
      ['results.test.ts', '成功結果には成果物参照が必要です。'],
    ]) {
      assert(file && reason);
      const result = check(root, [file]);
      expect(result.code).toBe(1);
      expect(result.output).toContain(reason);
      expect(result.output).not.toMatch(/Cannot find|SyntaxError|error: Cannot/);
    }
  });
});

test('参照用成果物は正常・失敗・取消・適用外と要求文言を満たす', async () => {
  await withWorkspace(async (root, workspace) => {
    await reference(workspace);
    const result = check(root, [...behavior, ...acceptance]);
    expect(result.code, result.output).toBe(0);
  });
});

// 参照解・反例をモデル入力へ含めず、通常の独立テストの検出力だけを確認する。
for (const [name, file, before, after, tests] of [
  [
    '旧リンクを残したまま別リンクだけを追加',
    'README.md',
    'docs/current-guide.md',
    'docs/old-guide.md)\n\n[現在の案内](docs/current-guide.md',
    ['guide.test.ts'],
  ],
  ['帳票呼出元の取消伝達漏れ', 'src/reports.ts', '  }, signal);', '  });', ['work-areas.test.ts']],
  [
    '通知条件の拡大',
    'src/messages.ts',
    "state === 'running' && event === 'complete'",
    "event === 'complete'",
    ['messages-behavior.test.ts'],
  ],
  [
    '失敗時の内部領域の漏れ',
    'src/archive.ts',
    'await rm(directory, { recursive: true, force: true });',
    'void directory;',
    ['work-areas.test.ts'],
  ],
  [
    '外部所有の領域を削除',
    'src/preview.ts',
    'signal?.throwIfAborted();\n  return result;',
    "signal?.throwIfAborted();\n  await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true });\n  return result;",
    ['work-areas.test.ts'],
  ],
  [
    '取消を成功に変換',
    'src/preview.ts',
    'signal?.throwIfAborted();\n  return result;',
    'return result;',
    ['work-areas.test.ts'],
  ],
  [
    '適用外への検査拡大',
    'src/results.ts',
    "if (record.kind === 'event') { write(value as Event); return null; }",
    "if (record.kind === 'event') return '適用外を誤って拒否';",
    ['results-behavior.test.ts'],
  ],
  [
    '違反入力の保存',
    'src/results.ts',
    "return '成功結果には成果物参照が必要です。';",
    "{ write(value as Result); return '成功結果には成果物参照が必要です。'; }",
    ['results-behavior.test.ts'],
  ],
  [
    '過去データの互換性破壊',
    'src/load-profile.js',
    'value.last_folder',
    'value.directory',
    ['profile.test.ts'],
  ],
] as const) {
  test(`反例を拒否する: ${name}`, async () => {
    await withWorkspace(async (root, workspace) => {
      await reference(workspace);
      await replace(workspace, file, before, after);
      const result = check(root, [...tests]);
      expect(result.code).toBe(1);
      expect(result.output).toContain('expect(');
      expect(result.output).not.toMatch(/Cannot find|SyntaxError|error: Cannot/);
    });
  });
}

test('共通化の別実装も実際の呼出元経由の検証を通る', async () => {
  await withWorkspace(async (root, workspace) => {
    await writeFile(
      join(workspace, 'src/resource.ts'),
      `
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
export async function use<T>(path: string, owned: boolean, action: (directory: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const directory = owned ? await mkdtemp(join(path, 'shared-')) : path;
  try {
    signal?.throwIfAborted();
    const result = await action(directory);
    signal?.throwIfAborted();
    return result;
  } finally {
    if (owned) await rm(directory, { recursive: true, force: true });
  }
}
`,
    );
    for (const [file, name, owned] of [
      ['archive.ts', 'exportArchive', true],
      ['preview.ts', 'renderPreview', false],
    ] as const) {
      await writeFile(
        join(workspace, 'src', file),
        `
import { use } from './resource.ts';
export function ${name}<T>(path: string, action: (directory: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return use(path, ${owned}, action, signal);
}
`,
      );
    }
    const result = check(root, ['work-areas.test.ts']);
    expect(result.code, result.output).toBe(0);
  });
});
