import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../shared/values.ts';

export const entry = resolve(import.meta.dir, '../../test-runtime/runner.ts');

type Fixture = {
  // 変更を数える git の作業ツリーです。
  repo: string;
  // runner の一時レポート置き場です。作業ツリーの外に置き、変更として数えられないようにします。
  reports: string;
  // 作業ツリーの外に置く、テストファイル同士の連絡用の置き場です。
  signals: string;
};

export function git(repo: string, ...args: string[]): string {
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
    { cwd: repo, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

// 契約で決まっている保存先です。実装を使わず、git から直接求めます。
export function recordFile(repo: string): string {
  return join(resolve(repo, git(repo, 'rev-parse', '--git-dir')), 'dotagents', 'test-deps.json');
}

export function readRecordFile(repo: string): Record<string, string[]> {
  const path = recordFile(repo);
  expect(existsSync(path), `記録ファイルがありません: ${path}`).toBe(true);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert(isRecord(parsed));
  const records: Record<string, string[]> = {};
  for (const [file, modules] of Object.entries(parsed)) {
    assert(Array.isArray(modules) && modules.every((module) => typeof module === 'string'));
    records[file] = modules;
  }
  return records;
}

// 外側の実行が記録器を付けていても、入れ子の実行へその状態を持ち込みません。
export function baseEnv(fixture: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', TMPDIR: fixture.reports };
  delete env.BUN_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOTAGENTS_RECORD_')) {
      delete env[key];
    }
  }
  return env;
}

export const header = "import { test, expect } from 'bun:test';\n";

const dynamicImporter = (marker: string) =>
  `${header}test('imports', async () => {
  console.log('${marker}');
  expect((await import('./target.ts')).value).toBeGreaterThan(0);
});\n`;

export const sharedImporter = (marker: string) =>
  `${header}test('imports', async () => {
  console.log('${marker}');
  expect((await import('./shared.ts')).value).toBe(3);
});\n`;

const plain = (marker: string) =>
  `${header}test('plain', () => {
  console.log('${marker}');
  expect(1).toBe(1);
});\n`;

export async function fixture(
  files: Record<string, string>,
  run: (fixture: Fixture) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-affected-')));
  const repo = join(root, 'repo');
  const reports = join(root, 'reports');
  const signals = join(root, 'signals');
  try {
    await mkdir(repo);
    await mkdir(reports);
    await mkdir(signals);
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), body);
    }
    git(repo, 'init', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    await run({ repo, reports, signals });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function runAffected(fixture: Fixture, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [entry, 'bun', '--affected', ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...baseEnv(fixture), ...env },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr };
}

export async function changeTarget(fixture: Fixture, value: number) {
  await writeFile(
    join(fixture.repo, 'scripts/tests/target.ts'),
    `export const value = ${value};\n`,
  );
}

export const twoTests = {
  'scripts/tests/target.ts': 'export const value = 1;\n',
  'scripts/tests/a.test.ts': dynamicImporter('A_RAN'),
  'scripts/tests/b.test.ts': plain('B_RAN'),
};
