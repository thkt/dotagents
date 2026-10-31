import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { baseEnv, fixture, git, header, recordFile } from '../../support/runner-affected.ts';

const setup = resolve(import.meta.dir, '../../../feedback-loop/setup.ts');
type Fixture = Parameters<Parameters<typeof fixture>[1]>[0];

function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...baseEnv(f),
      FEEDBACK_TRACE: join(f.signals, 'executed.log'),
      FEEDBACK_LOAD_BRANCH: '0',
      ...env,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr };
}

const config = {
  version: 1,
  runner: 'bun',
  base: 'main',
  collect: [process.execPath, 'scripts/collect.ts'],
  testGlobs: ['test/*.test.ts'],
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放だけを確認する対照' }],
  fullCheck: [process.execPath, 'run', 'check'],
  prepare: [],
  bunArgs: ['--no-env-file'],
  testArgs: ['--timeout', '15000'],
  globalChanges: ['scripts/**'],
  dependencies: [{ inputs: ['data/value.json', 'src/imported.ts'], tests: ['test/file.test.ts'] }],
};

const files = {
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test ./test' },
  }),
  '.dotagents.json': JSON.stringify({
    repository: 'example/fixture',
    remote: 'origin',
    baseBranch: 'main',
    setup: 'bun install --frozen-lockfile --ignore-scripts',
    check: ['bun', 'run', 'check'],
    ciChecks: ['checks', 'verify'],
    capture: null,
  }),
  '.feedback-loop.json': JSON.stringify(config),
  'scripts/collect.ts':
    "import { readdirSync } from 'node:fs'; console.log(JSON.stringify(readdirSync('test').filter(p => p.endsWith('.test.ts')).map(p => 'test/' + p)));\n",
  'src/imported.ts': 'export const value = 1;\n',
  'src/child.ts': 'export const value = 1;\n',
  'src/worker.ts': "import { value } from './child.ts'; console.log(value);\n",
  'data/value.json': '{"value":1}\n',
  'test/observe.ts': `import { appendFileSync } from 'node:fs';
export function observe(name: string) {
  appendFileSync(process.env.FEEDBACK_TRACE!, name + '\\n');
}\n`,
  'test/import.test.ts':
    header +
    "import { observe } from './observe.ts'; import { value } from '../src/imported.ts'; test('import', () => { observe('import'); expect(value).toBeLessThan(3); });\n",
  'test/child.test.ts':
    header +
    "import { observe } from './observe.ts'; import { execFileSync } from 'node:child_process'; test('child', () => { observe('child'); const value = Number(execFileSync(process.execPath, ['src/worker.ts'], { encoding: 'utf8' })); expect(value).toBeLessThan(3); });\n",
  'test/file.test.ts':
    header +
    "import { observe } from './observe.ts'; import { readFileSync } from 'node:fs'; test('file', () => { observe('file'); expect(JSON.parse(readFileSync('data/value.json', 'utf8')).value).toBeLessThan(3); expect(readFileSync('src/imported.ts', 'utf8')).toMatch(/value = [123];/); });\n",
  'test/unrelated.test.ts':
    header +
    "import { observe } from './observe.ts'; test('unrelated', () => { observe('unrelated'); expect(1).toBe(1); });\n",
  'test/assurance.test.ts':
    header +
    "import { observe } from './observe.ts'; import { value } from '../src/imported.ts'; test('cleanup', () => { observe('assurance'); expect(value).toBeGreaterThan(0); });\n",
};

async function installed(f: Fixture) {
  const result = run(f, [
    setup,
    'apply',
    '--repo',
    f.repo,
    '--feedback-command',
    'bun run test:affected',
  ]);
  expect(result.code, result.output).toBe(0);
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-m', 'configured');
  await writeFile(join(f.signals, 'executed.log'), '');
}

async function observations(f: Fixture) {
  const text = await readFile(join(f.signals, 'executed.log'), 'utf8');
  return text.trim().split('\n').filter(Boolean);
}

for (const scenario of [
  {
    name: '通常importと同じ入力の明示依存',
    inputs: ['src/imported.ts'],
    selected: ['file', 'import'],
  },
  { name: '子Bunの依存', inputs: ['src/child.ts'], selected: ['child'] },
  { name: '通常ファイル読込み', inputs: ['data/value.json'], selected: ['file'] },
  {
    name: '標準選択と補完のunion',
    inputs: ['src/imported.ts', 'src/child.ts', 'data/value.json'],
    selected: ['child', 'file', 'import'],
  },
]) {
  test(`Bun生成入口は${scenario.name}だけを実行し、無関係qualityとassuranceを除外する`, async () => {
    await fixture(files, async (f) => {
      await installed(f);
      for (const input of scenario.inputs) {
        const original = await readFile(join(f.repo, input), 'utf8');
        await writeFile(
          join(f.repo, input),
          original + (input.endsWith('.json') ? ' ' : '// seed\n'),
        );
      }
      const initial = run(f, ['run', 'test:affected']);
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).sort()).toEqual(['child', 'file', 'import', 'unrelated']);
      await writeFile(join(f.signals, 'executed.log'), '');
      for (const input of scenario.inputs) {
        await writeFile(
          join(f.repo, input),
          input.endsWith('.json') ? '{"value":2}\n' : 'export const value = 2;\n',
        );
      }
      expect(git(f.repo, 'diff', '--name-only').split('\n').sort()).toEqual(
        [...scenario.inputs].sort(),
      );
      if (scenario.inputs.includes('src/imported.ts')) {
        // 固定版の公開CLIを同じ入力とquality候補で直接動かし、補完前の集合を確認する。
        const native = run(f, [
          '--no-env-file',
          'test',
          '--changed=main',
          './test/import.test.ts',
          './test/child.test.ts',
          './test/file.test.ts',
          './test/unrelated.test.ts',
        ]);
        expect(native.code, native.output).toBe(0);
        expect(await observations(f)).toEqual(['import']);
        expect(native.output).toMatch(/--changed:.*running 1\/4 test file/);
        await writeFile(join(f.signals, 'executed.log'), '');
      }
      const selected = run(f, ['run', 'test:affected']);
      expect(selected.code, selected.output).toBe(0);
      const actual = await observations(f);
      expect(actual.sort(), selected.output).toEqual(scenario.selected);
      if (scenario.inputs.includes('src/imported.ts')) {
        expect(selected.output).toMatch(/--changed:.*running \d+\/\d+ test file/);
      }
      expect(selected.output).toContain('quality候補: 4');
      expect(selected.output).toContain(`quality選択: ${scenario.selected.length}`);
      expect(selected.output).not.toContain('quality全件の理由:');
    });
  }, 60000);
}

for (const mention of ['', '// data/value.json\n']) {
  test(`未知入力は${mention ? '無関係なコメントにパスがあっても' : 'パスへの言及がなくても'}全qualityで失敗を検出する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          dependencies: [{ inputs: ['src/imported.ts'], tests: ['test/file.test.ts'] }],
        }),
        'test/file.test.ts':
          header +
          "import { observe } from './observe.ts'; import { readFileSync } from 'node:fs'; import { join } from 'node:path'; test('file', () => { observe('file'); expect(JSON.parse(readFileSync(join('data', 'value.json'), 'utf8')).value).toBeLessThan(3); });\n",
        'test/unrelated.test.ts': files['test/unrelated.test.ts'] + mention,
      },
      async (f) => {
        await installed(f);
        await writeFile(join(f.repo, 'data/value.json'), '{"value":1}\n ');
        const initial = run(f, ['run', 'test:affected']);
        expect(initial.code, initial.output).toBe(0);
        expect((await observations(f)).sort()).toEqual(['child', 'file', 'import', 'unrelated']);
        await writeFile(join(f.repo, 'data/value.json'), '{"value":3}\n');
        expect(git(f.repo, 'diff', '--name-only')).toBe('data/value.json');
        await writeFile(join(f.signals, 'executed.log'), '');

        const failed = run(f, ['run', 'test:affected']);
        expect(failed.code, failed.output).not.toBe(0);
        expect(failed.output).toContain('(fail) file');
        expect((await observations(f)).sort(), failed.output).toEqual([
          'child',
          'file',
          'import',
          'unrelated',
        ]);
        expect(failed.output).toContain('quality全件の理由:');
      },
    );
  }, 60000);
}

// nativeの失敗を補完側の成功で上書きせず、失敗前の原記録を保つ。
test('標準関連テストの失敗・全件skipを成功にせず、失敗前の依存原記録を保持する', async () => {
  await fixture(
    {
      ...files,
      'test/import.test.ts': files['test/import.test.ts'].replace(
        "test('import'",
        "(value === 4 ? test.skip : test)('import'",
      ),
      'test/file.test.ts': files['test/file.test.ts'].replace(
        "test('file'",
        "(readFileSync('src/imported.ts', 'utf8').includes('value = 4;') ? test.skip : test)('file'",
      ),
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      const initial = run(f, ['run', 'test:affected']);
      expect(initial.code, initial.output).toBe(0);
      const original = await readFile(recordFile(f.repo), 'utf8');
      const directory = dirname(recordFile(f.repo));
      await writeFile(join(f.signals, 'executed.log'), '');
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 3;\n');
      const failed = run(f, ['run', 'test:affected']);
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.output).toContain('(fail) import');
      expect(await observations(f)).toContain('import');

      const afterNames = await readdir(directory, { recursive: true, withFileTypes: true });
      const after = await Promise.all(
        afterNames
          .filter((entry) => entry.isFile())
          .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
      );
      expect(after, '失敗前の原記録が失われています').toContain(original);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      const repaired = run(f, ['run', 'test:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      await writeFile(join(f.signals, 'executed.log'), '');
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 4;\n');
      const skipped = run(f, ['run', 'test:affected']);
      expect(skipped.code, skipped.output).not.toBe(0);
      expect(skipped.output).toMatch(/skip|未実行|No completed/i);
      expect(await observations(f)).toEqual([]);
      expect(failed.output).toMatch(/--changed:.*running \d+\/\d+ test file/);
    },
  );
}, 60000);

// 同じ変更に記録済みの依存先があっても、標準選択で見つかる別のqualityを落とさない。
test('Bun標準で選ばれる記録外のqualityを、記録と明示依存の選択集合へ加える', async () => {
  await fixture(
    {
      ...files,
      'src/conditional-route.ts': "export { value } from './imported.ts';\n",
      'test/native-only.test.ts':
        header +
        "import { observe } from './observe.ts'; test('conditional import', async () => { observe('native-only'); if (process.env.FEEDBACK_LOAD_BRANCH === '1') { const { value } = await import('../src/conditional-route.ts'); expect(value).toBeLessThan(3); } expect(1).toBe(1); });\n",
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 1;\n// seed\n');
      const initial = run(f, ['run', 'test:affected']);
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).sort()).toEqual([
        'child',
        'file',
        'import',
        'native-only',
        'unrelated',
      ]);
      await writeFile(join(f.signals, 'executed.log'), '');
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      expect(git(f.repo, 'diff', '--name-only')).toBe('src/imported.ts');
      const native = run(f, [
        '--no-env-file',
        'test',
        '--changed=main',
        './test/import.test.ts',
        './test/child.test.ts',
        './test/file.test.ts',
        './test/native-only.test.ts',
        './test/unrelated.test.ts',
      ]);
      expect(native.code, native.output).toBe(0);
      expect((await observations(f)).sort()).toEqual(['import', 'native-only']);
      expect(native.output).toMatch(/--changed:.*running 2\/5 test file/);
      await writeFile(join(f.signals, 'executed.log'), '');
      const affected = run(f, ['run', 'test:affected']);
      expect(affected.code, affected.output).toBe(0);
      expect((await observations(f)).sort(), affected.output).toEqual([
        'file',
        'import',
        'native-only',
      ]);
      expect(affected.output).toMatch(/--changed:.*running \d+\/\d+ test file/);
      expect(affected.output).toContain('quality候補: 5');
      expect(affected.output).toContain('quality選択: 3');
    },
  );
}, 60000);

// 出力の装飾だけで、正常な関連テストを失敗や全件実行へ変えない。
test('FORCE_COLORの有無で正常な関連qualityの成功と無関係qualityの除外を変えない', async () => {
  await fixture(
    {
      'package.json': files['package.json'],
      '.dotagents.json': files['.dotagents.json'],
      '.feedback-loop.json': JSON.stringify({ ...config, assurance: [], dependencies: [] }),
      'scripts/collect.ts': files['scripts/collect.ts'],
      'src/imported.ts': files['src/imported.ts'],
      'test/observe.ts': files['test/observe.ts'],
      'test/import.test.ts': files['test/import.test.ts'],
      'test/unrelated.test.ts': files['test/unrelated.test.ts'],
    },
    async (f) => {
      await installed(f);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 1;\n// seed\n');
      const initial = run(f, ['run', 'test:affected'], { FORCE_COLOR: '0', NO_COLOR: undefined });
      expect(initial.code, initial.output).toBe(0);
      expect((await observations(f)).sort()).toEqual(['import', 'unrelated']);
      await writeFile(join(f.repo, 'src/imported.ts'), 'export const value = 2;\n');
      expect(git(f.repo, 'diff', '--name-only')).toBe('src/imported.ts');
      for (const color of ['0', '1']) {
        const env = { FORCE_COLOR: color, NO_COLOR: undefined };
        await writeFile(join(f.signals, 'executed.log'), '');
        const native = run(
          f,
          [
            '--no-env-file',
            'test',
            '--changed=main',
            './test/import.test.ts',
            './test/unrelated.test.ts',
          ],
          env,
        );
        expect(native.code, native.output).toBe(0);
        expect(await observations(f)).toEqual(['import']);
        await writeFile(join(f.signals, 'executed.log'), '');
        const affected = run(f, ['run', 'test:affected'], env);
        expect(await observations(f), affected.output).toEqual(['import']);
        expect(affected.code, affected.output).toBe(0);
      }
    },
  );
}, 60000);
