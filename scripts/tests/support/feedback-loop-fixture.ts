import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../shared/values.ts';

export const repo = resolve(import.meta.dir, '../../..');
export const placed = 'scripts/feedback-loop';
export const header = "import { expect, test } from 'bun:test';\n";
// .feedback-loop.jsonとpackage scriptsが読むファイルです。実物をfixtureへ写して接続を確かめます。
const connection = [
  'scripts/test-runtime/feedback-test.ts',
  'scripts/test-runtime/report.ts',
  'scripts/test-runtime/runner.ts',
  'scripts/test-runtime/list-tests.ts',
  'scripts/shared/values.ts',
  `${placed}/runtime.mjs`,
  `${placed}/record-modules.ts`,
];

export function git(cwd: string, ...args: string[]) {
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

export async function readJson(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(isRecord(value), path);
  return value;
}

async function readScripts(names: string[]) {
  const manifest = await readJson(join(repo, 'package.json'));
  assert(isRecord(manifest.scripts));
  const { scripts } = manifest;
  return Object.fromEntries(
    names.map((name) => {
      const script = scripts[name];
      assert(typeof script === 'string', name);
      return [name, script];
    }),
  );
}

// 実repoの配線をGit管理の一時repoへ写し、基点のcommitへ含めて変更として数えないようにします。
export async function withFeedbackRepository(
  files: Record<string, string>,
  run: (cwd: string) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-wiring-')));
  const cwd = join(root, 'repo');
  try {
    const copies = await Promise.all(
      connection.map(async (path) => [path, await readFile(join(repo, path), 'utf8')] as const),
    );
    const contents = {
      ...Object.fromEntries(copies),
      // 実repoのテストを指す明示依存はfixtureに存在しないため外し、他の設定は実物を使います。
      '.feedback-loop.json': JSON.stringify({
        ...(await readJson(join(repo, '.feedback-loop.json'))),
        dependencies: [],
      }),
      'package.json': JSON.stringify({
        scripts: await readScripts(['test:affected', 'test:feedback', 'check:classification']),
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

// 外側の実行の記録と出力設定を、入れ子の実行へ持ち込みません。
export function nestedEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dirname(cwd) };
  for (const key of ['BUN_OPTIONS', 'CI', 'CLAUDECODE', 'AGENT', 'REPL_ID']) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOTAGENTS_RECORD_')) {
      delete env[key];
    }
  }
  return env;
}

export function runScript(cwd: string, name: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['run', name, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: nestedEnv(cwd),
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}
