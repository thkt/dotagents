import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withoutAutoMaintenance } from '../../runner.ts';

const cli = resolve(import.meta.dir, '../../mutation/cli.ts');

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

// 小さな検証用repo。lintは`>= 5`を拒否し、feedbackテストはallowedだけを確かめる。
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
      'scripts/tests/feedback/limit.test.ts': [
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

test('T-012 検証用 repo の基準の feedback が失敗するときはコマンドが変異の報告を出さず専用の終了コードで終わる', async () => {
  await fixture(true, async (root) => {
    const result = mutate(root);
    // 終了コード3はscripts/README.mdで利用者へ案内した値。
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain('変異の実行');
    expect(result.stdout).not.toContain('生き残');
    expect(result.stderr).toContain('基準のfeedbackが1回目に失敗しました');
  });
});

async function until(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert(Date.now() < deadline, 'condition not reached');
    await Bun.sleep(50);
  }
}

test('実行中にSIGTERMを受けると子プロセスを止めて一時コピーを消す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-signal-'));
  try {
    const repo = join(root, 'repo');
    const temp = join(root, 'tmp');
    const probe = join(root, 'probe');
    await mkdir(repo);
    await mkdir(temp);
    await mkdir(probe);
    git(repo, 'init', '-q');
    // 基準のfeedbackが開始を記録してから待ち、止められなければ終了も記録する。
    await write(repo, {
      'package.json': JSON.stringify({ type: 'module' }),
      'scripts/tests/feedback/wait.test.ts': [
        "import { test } from 'bun:test';",
        "import { writeFileSync } from 'node:fs';",
        "test('wait', async () => {",
        "  writeFileSync(`${process.env.MUTATION_PROBE}/started`, '');",
        '  await Bun.sleep(2000);',
        "  writeFileSync(`${process.env.MUTATION_PROBE}/finished`, '');",
        '}, 10000);',
        '',
      ].join('\n'),
    });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const child = spawn(process.execPath, [cli, '--base', 'HEAD'], {
      cwd: repo,
      stdio: 'ignore',
      env: { ...withoutAutoMaintenance(process.env), TMPDIR: temp, MUTATION_PROBE: probe },
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    await until(() => existsSync(join(probe, 'started')), 15000);
    expect((await readdir(temp)).filter((name) => name.startsWith('mutate-diff-'))).toHaveLength(1);
    child.kill('SIGTERM');
    expect(await exited).not.toBe(0);
    await Bun.sleep(3000);
    expect(existsSync(join(probe, 'finished'))).toBe(false);
    expect((await readdir(temp)).filter((name) => name.startsWith('mutate-diff-'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
