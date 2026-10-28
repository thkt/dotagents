import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRecords,
  recordDirVariable,
  recorderEnv,
  recorderPath,
} from '../../../test-runtime/record-modules.ts';

async function fixture(
  files: Record<string, string>,
  run: (root: string, recordDir: string) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'record-modules-')));
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(root, name), body);
    }
    const recordDir = join(root, 'records');
    await mkdir(recordDir);
    await run(root, recordDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 外側の実行が記録器を付けていても、入れ子の実行へその状態を持ち込みません。
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOTAGENTS_RECORD_')) {
      delete env[key];
    }
  }
  return env;
}

function bunTest(root: string, recordDir: string, args: string[]) {
  const result = spawnSync(process.execPath, ['test', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: recorderEnv(baseEnv(), recordDir),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

const passing = "import { test, expect } from 'bun:test';\n";

test('テストから動的 import したモジュールは、そのテストファイルの記録に入る', async () => {
  await fixture(
    {
      'target.ts': 'export const value = 1;\n',
      'dynamic.test.ts':
        passing +
        "test('imports', async () => { expect((await import('./target.ts')).value).toBe(1); });\n",
    },
    async (root, recordDir) => {
      bunTest(root, recordDir, ['dynamic.test.ts']);
      const records = await readRecords(recordDir);
      expect([...(records.get(join(root, 'dynamic.test.ts')) ?? [])]).toContain(
        join(root, 'target.ts'),
      );
    },
  );
});

test('テストが起動した子の bun が読み込んだモジュールは、起動したテストファイルの記録に入る', async () => {
  await fixture(
    {
      'child-dependency.ts': 'export const value = 2;\n',
      'child-data.json': JSON.stringify({ value: '日本語🌸' }),
      'child.ts':
        "import { value } from './child-dependency.ts';\nimport data from './child-data';\nconsole.log(value);\nconsole.log(JSON.stringify(data));\n",
      'spawn.test.ts':
        "import { spawnSync } from 'node:child_process';\n" +
        passing +
        "test('spawns', () => {\n  const child = spawnSync(process.execPath, [`${import.meta.dir}/child.ts`], { env: process.env, encoding: 'utf8' });\n  expect(child.status).toBe(0);\n  expect(child.stdout.trim()).toBe('2\\n' + JSON.stringify({ value: '\\u65e5\\u672c\\u8a9e\\ud83c\\udf38' }));\n});\n",
    },
    async (root, recordDir) => {
      bunTest(root, recordDir, ['spawn.test.ts']);
      const records = await readRecords(recordDir);
      const recorded = [...(records.get(join(root, 'spawn.test.ts')) ?? [])];
      expect(recorded).toContain(join(root, 'child.ts'));
      expect(recorded).toContain(join(root, 'child-dependency.ts'));
      expect(recorded).toContain(join(root, 'child-data.json'));
    },
  );
});

test('同じモジュールを import する 2 ファイルを 2worker で実行すると、両方の記録にそのモジュールが入る', async () => {
  const importsShared =
    passing +
    "test('imports', async () => { expect((await import('./shared.ts')).value).toBe(3); expect((await import('./shared-data')).default.value).toBe('\\u65e5\\u672c\\u8a9e\\ud83c\\udf38'); });\n";
  await fixture(
    {
      'shared.ts': 'export const value = 3;\n',
      'shared-data.json': JSON.stringify({ value: '日本語🌸' }),
      'first.test.ts': importsShared,
      'second.test.ts': importsShared,
    },
    async (root, recordDir) => {
      bunTest(root, recordDir, [
        '--parallel=2',
        '--parallel-delay=0',
        'first.test.ts',
        'second.test.ts',
      ]);
      const records = await readRecords(recordDir);
      const first = [...(records.get(join(root, 'first.test.ts')) ?? [])];
      const second = [...(records.get(join(root, 'second.test.ts')) ?? [])];
      expect(first).toContain(join(root, 'shared.ts'));
      expect(second).toContain(join(root, 'shared.ts'));
      expect(first).toContain(join(root, 'shared-data.json'));
      expect(second).toContain(join(root, 'shared-data.json'));
      expect(first).not.toContain(join(root, 'second.test.ts'));
      expect(second).not.toContain(join(root, 'first.test.ts'));
    },
  );
});

test('利用者の BUN_OPTIONS を残して記録器を足し、空白を含む記録器のパスは拒否する', () => {
  const user = { BUN_OPTIONS: '--smol', KEEP: '1' };
  const env = recorderEnv(user, '/records');
  expect(env.BUN_OPTIONS?.split(/\s+/)).toEqual(['--smol', `--preload=${recorderPath}`]);
  expect(env.KEEP).toBe('1');
  expect(env[recordDirVariable]).toBe('/records');
  expect(user.BUN_OPTIONS).toBe('--smol');
  expect(recorderEnv({}, '/records').BUN_OPTIONS).toBe(`--preload=${recorderPath}`);
  expect(() => recorderEnv({}, '/records', '/tmp/with space/record-modules.ts')).toThrow(
    /whitespace|空白/,
  );
});

// 比較先をASCIIエスケープで書き、実値と期待値が同時に文字化けして通ることを防ぐ。
for (const source of [
  'ascii',
  'unicode',
  'json-ascii',
  'json',
  'json-dynamic',
  'json-extensionless',
  'json-dynamic-extensionless',
] as const) {
  for (const fails of [false, true]) {
    const expected =
      source === 'ascii' || source === 'json-ascii' ? 'hello' : '\u65e5\u672c\u8a9e\ud83c\udf38';
    const status = fails ? 1 : 0;
    const summary = fails ? '1 fail' : '1 pass';
    const module = source.startsWith('json') ? 'value.json' : 'value.ts';
    const specifier = source.endsWith('extensionless') ? './value' : './value.json';
    test(`記録の有無で値・assertion・完了件数を変えない: ${source} ${fails ? '失敗' : '成功'}`, async () => {
      await fixture(
        {
          [module]: source.startsWith('json')
            ? JSON.stringify({
                value: source === 'json-ascii' ? 'hello' : '日本語🌸',
                count: 7,
                nested: { enabled: true },
              }) + '\n'
            : `export const value = '${source === 'ascii' || source === 'json-ascii' ? 'hello' : '日本語🌸'}';\n`,
          'value.test.ts':
            passing +
            (source.startsWith('json')
              ? (source.includes('dynamic')
                  ? `const { default: data } = await import('${specifier}');\n`
                  : `import data from '${specifier}';\n`) + 'const { value } = data;\n'
              : "import { value } from './value.ts';\n") +
            `test('value', () => {\n` +
            `console.log('OBSERVED=' + JSON.stringify(value));\n` +
            `expect(value).toBe('${source === 'ascii' || source === 'json-ascii' ? 'hello' : '\\u65e5\\u672c\\u8a9e\\ud83c\\udf38'}');\n` +
            (source.startsWith('json')
              ? 'expect(data.count).toBe(7); expect(data.nested.enabled).toBe(true);\n'
              : '') +
            (fails ? "expect(value).toBe('INTENTIONAL_FAILURE');\n" : '') +
            '});\n',
        },
        async (root, recordDir) => {
          for (const recorded of [false, true]) {
            const result = spawnSync(process.execPath, ['test', 'value.test.ts'], {
              cwd: root,
              encoding: 'utf8',
              timeout: 30000,
              env: recorded ? recorderEnv(baseEnv(), recordDir) : baseEnv(),
            });
            const output = result.stdout + result.stderr;
            expect(result.error).toBeUndefined();
            expect(result.signal).toBeNull();
            expect(result.stdout, output).toContain(`OBSERVED=${JSON.stringify(expected)}`);
            expect(output).toMatch(/Ran 1 test across 1 file/);
            expect(result.status, output).toBe(status);
            expect(output).toContain(summary);
            expect(output.includes('INTENTIONAL_FAILURE')).toBe(fails);
          }
          const records = await readRecords(recordDir);
          expect([...(records.get(join(root, 'value.test.ts')) ?? [])]).toContain(
            join(root, module),
          );
        },
      );
    });
  }
}
