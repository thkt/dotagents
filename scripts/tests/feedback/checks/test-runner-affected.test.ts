import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';

const entry = resolve(import.meta.dir, '../../../test-runtime/runner.ts');

type Fixture = {
  // 変更を数える git の作業ツリーです。
  repo: string;
  // runner の一時レポート置き場です。作業ツリーの外に置き、変更として数えられないようにします。
  reports: string;
  // 作業ツリーの外に置く、テストファイル同士の連絡用の置き場です。
  signals: string;
};

function git(repo: string, ...args: string[]): string {
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
function recordFile(repo: string): string {
  return join(resolve(repo, git(repo, 'rev-parse', '--git-dir')), 'dotagents', 'test-deps.json');
}

function readRecordFile(repo: string): Record<string, string[]> {
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
function baseEnv(fixture: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', TMPDIR: fixture.reports };
  delete env.BUN_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOTAGENTS_RECORD_')) {
      delete env[key];
    }
  }
  return env;
}

const header = "import { test, expect } from 'bun:test';\n";

const dynamicImporter = (marker: string) =>
  `${header}test('imports', async () => {
  console.log('${marker}');
  expect((await import('./target.ts')).value).toBeGreaterThan(0);
});\n`;

const sharedImporter = (marker: string) =>
  `${header}test('imports', async () => {
  console.log('${marker}');
  expect((await import('./shared.ts')).value).toBe(3);
});\n`;

const plain = (marker: string) =>
  `${header}test('plain', () => {
  console.log('${marker}');
  expect(1).toBe(1);
});\n`;

async function fixture(files: Record<string, string>, run: (fixture: Fixture) => Promise<void>) {
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

function runAffected(fixture: Fixture, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
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

async function changeTarget(fixture: Fixture, value: number) {
  await writeFile(
    join(fixture.repo, 'scripts/tests/target.ts'),
    `export const value = ${value};\n`,
  );
}

const twoTests = {
  'scripts/tests/target.ts': 'export const value = 1;\n',
  'scripts/tests/a.test.ts': dynamicImporter('A_RAN'),
  'scripts/tests/b.test.ts': plain('B_RAN'),
};

test('記録のない初回の--affected は全テストを実行し、git dir の中に記録を作る', async () => {
  await fixture(twoTests, async (f) => {
    await changeTarget(f, 2);
    const result = runAffected(f);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('A_RAN');
    expect(result.output).toContain('B_RAN');
    const records = readRecordFile(f.repo);
    expect(Object.keys(records).sort()).toEqual([
      join(f.repo, 'scripts/tests/a.test.ts'),
      join(f.repo, 'scripts/tests/b.test.ts'),
    ]);
    expect(records[join(f.repo, 'scripts/tests/a.test.ts')]).toContain(
      join(f.repo, 'scripts/tests/target.ts'),
    );
    expect(existsSync(join(f.repo, 'dotagents'))).toBe(false);
    expect(git(f.repo, 'status', '--porcelain')).not.toContain('test-deps');
  });
}, 60000);

test('動的 import でだけ届くモジュールを変えた 2 回目の--affected は、そのテストファイルだけを実行する', async () => {
  await fixture(twoTests, async (f) => {
    await changeTarget(f, 2);
    const first = runAffected(f);
    expect(first.code, first.output).toBe(0);
    await changeTarget(f, 3);
    const second = runAffected(f);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('A_RAN');
    expect(second.output).not.toContain('B_RAN');
    expect(second.output).toMatch(/Ran 1 test across 1 file/);
  });
}, 60000);

test('--parallel なしの--affected でも、同じモジュールを import する 2 ファイルの記録が両方に入る', async () => {
  await fixture(
    {
      'scripts/tests/shared.ts': 'export const value = 3;\n',
      'scripts/tests/first.test.ts': sharedImporter('FIRST_RAN'),
      'scripts/tests/second.test.ts': sharedImporter('SECOND_RAN'),
    },
    async (f) => {
      await writeFile(join(f.repo, 'scripts/tests/shared.ts'), 'export const value = 3; // 変更\n');
      const result = runAffected(f);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('FIRST_RAN');
      expect(result.output).toContain('SECOND_RAN');
      const records = readRecordFile(f.repo);
      const shared = join(f.repo, 'scripts/tests/shared.ts');
      expect(records[join(f.repo, 'scripts/tests/first.test.ts')]).toContain(shared);
      expect(records[join(f.repo, 'scripts/tests/second.test.ts')]).toContain(shared);
    },
  );
}, 60000);

test('変更がない--affected は変更なしと表示して非ゼロで終わり、テストを実行しない', async () => {
  await fixture(twoTests, async (f) => {
    const result = runAffected(f);
    expect(result.output).toContain('変更なし');
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).not.toContain('A_RAN');
    expect(result.output).not.toContain('B_RAN');
    expect(result.output).not.toMatch(/Ran \d+ tests? across/);
    expect(result.output).not.toContain('All tests executed.');
    expect(existsSync(recordFile(f.repo))).toBe(false);
  });
}, 60000);

test('選んだテストの成功は、選んだ件数と全体 check ではないことを表示して終わる', async () => {
  await fixture(twoTests, async (f) => {
    await changeTarget(f, 2);
    const first = runAffected(f);
    expect(first.code, first.output).toBe(0);
    await changeTarget(f, 3);
    const second = runAffected(f);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('A_RAN');
    expect(second.output).not.toContain('B_RAN');
    // 全部実行の成功と取り違えないよう、既存の完了表示は使いません。
    expect(second.output).not.toContain('All tests executed.');
    expect(second.output).toMatch(/選んだテストファイル\s*1\s*件/);
    expect(second.output).toMatch(/全体\s*check\D{0,10}ではありません/);
  });
}, 60000);

function terminateGroup(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    assert(Date.now() < deadline, message);
    await Bun.sleep(20);
  }
}

test('SIGINT で中断した--affected は記録ファイルを書き換えない', async () => {
  const hang =
    `${header}import { writeFileSync } from 'node:fs';\n` +
    `test('hang', async () => {
  const marker = process.env.HANG_MARKER;
  if (marker) {
    writeFileSync(marker, 'started');
    await new Promise(() => {});
  }
  expect((await import('./target.ts')).value).toBeGreaterThan(0);
}, 60000);\n`;
  await fixture(
    {
      'scripts/tests/target.ts': 'export const value = 1;\n',
      'scripts/tests/hang.test.ts': hang,
    },
    async (f) => {
      await changeTarget(f, 2);
      const first = runAffected(f);
      expect(first.code, first.output).toBe(0);
      const path = recordFile(f.repo);
      const before = readFileSync(path, 'utf8');
      const entriesBefore = readdirSync(dirname(path)).sort();

      await changeTarget(f, 3);
      const marker = join(f.signals, 'hang.started');
      const command = spawn(process.execPath, [entry, 'bun', '--affected'], {
        cwd: f.repo,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...baseEnv(f), HANG_MARKER: marker },
      });
      let output = '';
      command.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
      command.stderr.on('data', (data: Buffer) => {
        output += data.toString();
      });
      let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const ended = new Promise<void>((resolveEnded, reject) => {
        command.once('exit', (code, signal) => {
          result = { code, signal };
          resolveEnded();
        });
        command.once('error', reject);
      });
      try {
        await waitFor(
          () => existsSync(marker) || result !== undefined,
          `テストファイルが開始しませんでした: ${output}`,
        );
        expect(existsSync(marker), `選んだテストファイルが開始しません: ${output}`).toBe(true);
        command.kill('SIGINT');
        await waitFor(() => result !== undefined, `SIGINT で終了しません: ${output}`);
        expect(result?.code, output).not.toBe(0);
        expect(output).not.toContain('All tests executed.');
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(readdirSync(dirname(path)).sort()).toEqual(entriesBefore);
      } finally {
        terminateGroup(command.pid);
        await ended;
      }
    },
  );
}, 90000);

const failing = (marker: string) =>
  `${header}test('fails', () => {
  console.log('${marker}');
  expect(1).toBe(2);
});\n`;

const skipping = (marker: string) =>
  `${header}test('plain', () => {
  console.log('${marker}');
  expect(1).toBe(1);
});
test.skip('skipped', () => {});\n`;

test('失敗した--affected は、成功したテストファイルの記録を残し、失敗したファイルの記録だけを消す', async () => {
  await fixture(twoTests, async (f) => {
    await changeTarget(f, 2);
    const first = runAffected(f);
    expect(first.code, first.output).toBe(0);
    await writeFile(join(f.repo, 'scripts/tests/b.test.ts'), failing('B_FAILED'));
    await changeTarget(f, 3);
    const second = runAffected(f);
    expect(second.output).toContain('A_RAN');
    expect(second.output).toContain('B_FAILED');
    expect(second.code, second.output).not.toBe(0);
    const records = readRecordFile(f.repo);
    expect(records[join(f.repo, 'scripts/tests/a.test.ts')]).toContain(
      join(f.repo, 'scripts/tests/target.ts'),
    );
    expect(Object.keys(records)).not.toContain(join(f.repo, 'scripts/tests/b.test.ts'));
  });
}, 60000);

test('テストが成功してもskipを含む--affected は、選んだテストファイルの記録を消す', async () => {
  await fixture(twoTests, async (f) => {
    await changeTarget(f, 2);
    const first = runAffected(f);
    expect(first.code, first.output).toBe(0);
    await writeFile(join(f.repo, 'scripts/tests/b.test.ts'), skipping('B_SKIPPING'));
    await changeTarget(f, 3);
    const second = runAffected(f);
    expect(second.output).toContain('B_SKIPPING');
    expect(second.code, second.output).not.toBe(0);
    const records = readRecordFile(f.repo);
    expect(Object.keys(records)).not.toContain(join(f.repo, 'scripts/tests/a.test.ts'));
    expect(Object.keys(records)).not.toContain(join(f.repo, 'scripts/tests/b.test.ts'));
  });
}, 60000);
