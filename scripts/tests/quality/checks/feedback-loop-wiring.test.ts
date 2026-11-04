import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const repo = resolve(import.meta.dir, '../../../..');
const placed = 'scripts/feedback-loop';
const bundled = 'skills/setup-feedback-loop/scripts';
// .feedback-loop.jsonとpackage scriptsが読むファイルです。実物をfixtureへ写して接続を確かめます。
const connection = [
  'scripts/test-runtime/feedback-test.ts',
  'scripts/test-runtime/report.ts',
  'scripts/test-runtime/runner.ts',
  'scripts/shared/values.ts',
  'scripts/test-runtime/list-tests.ts',
  `${placed}/runtime.mjs`,
  `${placed}/record-modules.ts`,
];
const header = "import { expect, test } from 'bun:test';\n";
const qualityRelated = 'scripts/tests/quality/related.test.ts';
const qualityOther = 'scripts/tests/quality/other.test.ts';
const input = 'scripts/lib/input.ts';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.excludesFile=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function readScript(name: string) {
  const manifest: unknown = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert(isRecord(manifest) && isRecord(manifest.scripts));
  const script = manifest.scripts[name];
  assert(typeof script === 'string');
  return script;
}

async function withRepository(files: Record<string, string>, run: (cwd: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-wiring-')));
  const cwd = join(root, 'repo');
  try {
    const copies = await Promise.all(
      connection.map(async (path) => [path, await readFile(join(repo, path), 'utf8')] as const),
    );
    const config: unknown = JSON.parse(await readFile(join(repo, '.feedback-loop.json'), 'utf8'));
    assert(isRecord(config));
    const contents = {
      ...Object.fromEntries(copies),
      // 実repoのテストを指す明示依存はfixtureに存在しないため外し、他の設定は実物を使います。
      '.feedback-loop.json': JSON.stringify({ ...config, dependencies: [] }),
      'package.json': JSON.stringify({
        scripts: { 'test:affected': await readScript('test:affected') },
      }),
      ...files,
    };
    for (const [path, body] of Object.entries(contents)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), body);
    }
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'base');
    await run(cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function affected(cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dirname(cwd) };
  // 外側の実行の記録と出力設定を、入れ子の実行へ持ち込みません。
  for (const key of ['BUN_OPTIONS', 'CI', 'CLAUDECODE', 'AGENT', 'REPL_ID']) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOTAGENTS_RECORD_')) {
      delete env[key];
    }
  }
  const result = spawnSync(process.execPath, ['run', 'test:affected'], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: result.stdout + result.stderr };
}

test('配置済みの生成物は同梱の生成物と一致し、generated.jsonのsha256とも一致する', async () => {
  const runtime = await readFile(join(repo, placed, 'runtime.mjs'), 'utf8');
  const bundledRuntime = await readFile(join(repo, bundled, 'runtime.mjs'), 'utf8');
  expect(runtime).toBe(
    bundledRuntime.replaceAll('__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__', 'bun'),
  );
  const recorder = await readFile(join(repo, placed, 'record-modules.ts'), 'utf8');
  expect(recorder).toBe(await readFile(join(repo, bundled, 'record-modules.ts'), 'utf8'));
  const generated: unknown = JSON.parse(
    await readFile(join(repo, placed, 'generated.json'), 'utf8'),
  );
  assert(isRecord(generated));
  const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');
  expect(generated.files).toEqual({
    [`${placed}/runtime.mjs`]: sha256(runtime),
    [`${placed}/record-modules.ts`]: sha256(recorder),
  });
});

test('test:affectedはqualityだけを2workerで実行し、次の変更では関連するqualityへ絞る', async () => {
  await withRepository(
    {
      [input]: 'export const value = 1;\n',
      [qualityRelated]: `${header}test('related', async () => { console.log('RELATED_RAN'); expect((await import('../../lib/input.ts')).value).toBeGreaterThan(0); });\n`,
      [qualityOther]: `${header}test('other', () => console.log('OTHER_RAN'));\n`,
      'scripts/tests/assurance/guard.test.ts': `${header}test('guard', () => console.log('ASSURANCE_RAN'));\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, input), 'export const value = 2;\n');
      const first = affected(cwd);
      expect(first.code, first.output).toBe(0);
      expect(first.output).toContain('RELATED_RAN');
      expect(first.output).toContain('OTHER_RAN');
      expect(first.output).not.toContain('ASSURANCE_RAN');
      expect(first.output).toContain('--parallel=2');
      await writeFile(join(cwd, input), 'export const value = 3;\n');
      const second = affected(cwd);
      expect(second.code, second.output).toBe(0);
      expect(second.output).toContain('RELATED_RAN');
      expect(second.output).not.toContain('OTHER_RAN');
      expect(second.output).toContain('--only-failures');
    },
  );
});

test('test:affectedはテストへCI=trueとgitの自動maintenance停止を渡す', async () => {
  await withRepository(
    {
      [qualityRelated]: `${header}import { spawnSync } from 'node:child_process';
const config = (key: string) => spawnSync('git', ['config', key], { encoding: 'utf8' }).stdout.trim();
test('environment', () => {
  expect(process.env.CI).toBe('true');
  expect(config('maintenance.auto')).toBe('false');
  expect(config('gc.auto')).toBe('0');
  console.log('ENVIRONMENT_CHECKED');
});\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.output).toContain('ENVIRONMENT_CHECKED');
      expect(result.code, result.output).toBe(0);
    },
  );
});

for (const [name, body, diagnostic] of [
  [
    '1ファイルだけのtest.only',
    `${header}test.only('only', () => {});\ntest('other', () => expect(1).toBe(2));\n`,
    '.only is disabled',
  ],
  ['skip', `${header}test('run', () => {});\ntest.skip('skipped', () => {});\n`, 'skip'],
] as const) {
  test(`test:affectedは${name}を成功にしない`, async () => {
    await withRepository({ [qualityRelated]: body }, async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
    });
  });
}

test('test:affectedのテスト失敗は起動入口を通しても非ゼロ終了で返す', async () => {
  await withRepository(
    { [qualityRelated]: `${header}test('fails', () => expect(1).toBe(2));\n` },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('1 fail');
    },
  );
});

test('実行環境を整える起動入口はテストの依存記録を変えない', async () => {
  await withRepository(
    {
      'scripts/lib/unrelated.ts': 'export const unrelated = 1;\n',
      [qualityRelated]: `${header}test('plain', () => expect(1).toBe(1));\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.code, result.output).toBe(0);
      const recordFile = join(cwd, git(cwd, 'rev-parse', '--git-path', 'dotagents/test-deps.json'));
      const records: unknown = JSON.parse(await readFile(recordFile, 'utf8'));
      expect(records).toEqual({ [join(cwd, qualityRelated)]: [join(cwd, qualityRelated)] });
    },
  );
});
