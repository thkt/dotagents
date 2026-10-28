import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withoutAutoMaintenance } from '../../../test-runtime/runner.ts';

const cli = resolve(import.meta.dir, '../../../test-runtime/mutation/cli.ts');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, encoding: 'utf8', env: withoutAutoMaintenance(process.env) },
  );
  assert.equal(result.status, 0, result.stderr);
}

async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

// 小さな検証用repo。lintは`>= 5`を拒否し、品質テストはallowedだけを確かめる。
async function fixture(expectedForThree: boolean, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mutation-cli-'));
  try {
    git(root, 'init', '-q');
    await write(root, {
      'package.json': JSON.stringify({
        type: 'module',
        scripts: { lint: 'bun lint.ts', typecheck: 'bun -e 0' },
      }),
      'lint.ts': [
        "import { readFileSync } from 'node:fs';",
        "if (readFileSync('scripts/lib/limit.ts', 'utf8').includes('>= 5')) process.exit(1);",
        '',
      ].join('\n'),
      'scripts/lib/limit.ts': [
        'export const legacy = 1;',
        'export function allowed(count: number) {',
        '  return count <= 1;',
        '}',
        '',
      ].join('\n'),
      'scripts/tests/quality/limit.test.ts': [
        "import { test, expect } from 'bun:test';",
        "import { allowed } from '../../lib/limit.ts';",
        "test('allowed', () => {",
        '  expect(allowed(2)).toBe(true);',
        `  expect(allowed(3)).toBe(${expectedForThree});`,
        '});',
        '',
      ].join('\n'),
    });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    await write(root, {
      'scripts/lib/limit.ts': [
        'export function allowed(count: number) {',
        '  return count <= 2;',
        '}',
        'export function enabled() {',
        '  return true;',
        '}',
        'export function blocked(count: number) {',
        '  return count > 5;',
        '}',
        '',
      ].join('\n'),
    });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mutate(cwd: string) {
  return spawnSync(process.execPath, [cli, '--base', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    env: withoutAutoMaintenance(process.env),
  });
}

test('T-011 小さな検証用 repo の変更差分に対してコマンドを実行すると検出・生き残り・作れなかった差分を 1 つの報告に出す', async () => {
  await fixture(false, async (root) => {
    const result = mutate(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('変異の実行: 検出 1 / 生き残り 1 / 不安定 0（実行 2 件）');
    expect(result.stdout).toMatch(
      /生き残った変異:\n {2}- scripts\/lib\/limit\.ts:5:\d+ boolean-flip: true -> false/,
    );
    expect(result.stdout).toContain('破棄（lint・型検査で失敗）: 1');
    expect(result.stdout).toContain('  演算子別: boundary-flip 1');
    expect(result.stdout).toContain('  削除行だけ: scripts/lib/limit.ts:-1,1');
    expect(result.stdout).toMatch(/所要時間: \d+(\.\d+)?秒/);
  });
});

test('旧mutation CLIは差分の対象・終了結果・変異の報告を新しい入口へ渡す', async () => {
  await fixture(false, async (root) => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dir, '../../mutation/cli.ts'), '--base', 'HEAD'],
      { cwd: root, encoding: 'utf8', env: withoutAutoMaintenance(process.env) },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('変異の実行: 検出 1 / 生き残り 1 / 不安定 0（実行 2 件）');
    expect(result.stdout).toContain('破棄（lint・型検査で失敗）: 1');
    expect(result.stdout).toContain('削除行だけ: scripts/lib/limit.ts:-1,1');
  });
});

test('T-012 検証用 repo の基準の品質テスト が失敗するときはコマンドが変異の報告を出さず専用の終了コードで終わる', async () => {
  await fixture(true, async (root) => {
    const result = mutate(root);
    // 終了コード3はscripts/README.mdで利用者へ案内した値。
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain('変異の実行');
    expect(result.stdout).not.toContain('生き残');
    expect(result.stderr).toMatch(/基準.*(?:quality|品質).*1回目.*失敗/);
  });
});
