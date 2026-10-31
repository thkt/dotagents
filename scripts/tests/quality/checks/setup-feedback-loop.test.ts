import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import { baseEnv, fixture, git, header } from '../../support/runner-affected.ts';

// Issue #466とdocs/wiki/setup-feedback-loop-contract.mdの公開入口を使う。
// 内部export・記録形式・生成ファイルの分割は期待値にしない。
const setup = resolve(import.meta.dir, '../../../feedback-loop/setup.ts');
type Fixture = Parameters<Parameters<typeof fixture>[1]>[0];

function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  if (args.includes(setup)) {
    expect(existsSync(setup), '公開入口が未実装です。入力拒否の成功とは扱いません').toBe(true);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: f.repo,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...baseEnv(f), ...env },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
}

async function snapshot(repo: string) {
  const entries = await readdir(repo, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes('/.git/'),
  );
  return Object.fromEntries(
    await Promise.all(
      files.map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(repo.length + 1), await readFile(path, 'utf8')] as const;
      }),
    ),
  );
}

function object(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  assert(isRecord(parsed));
  return parsed;
}

const config = {
  version: 1,
  runner: 'bun',
  base: 'main',
  collect: [process.execPath, 'scripts/collect.ts'],
  testGlobs: ['test/*.test.ts'],
  assurance: [{ path: 'test/assurance.test.ts', reason: '資源解放の確認' }],
  fullCheck: [process.execPath, 'run', 'check'],
  prepare: [],
  bunArgs: ['--no-env-file'],
  testArgs: ['--timeout', '15000'],
  globalChanges: ['scripts/**'],
  dependencies: [{ inputs: ['data/*.json'], tests: ['test/a.test.ts'] }],
};

const files = {
  'package.json': JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'bun@1.4.4',
    scripts: { check: 'bun test test', 'lint:fix': 'echo explicit-fix' },
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
  'scripts/probe.ts':
    "console.error('PROBE_DIAGNOSTIC scripts/probe.ts; rerun: bun run check:feedback'); process.exit(process.env.PROBE_FAIL === '1' ? 7 : 0);\n",
  'src/input.ts': 'export const value = 1;\n',
  'data/value.json': '{"value":1}\n',
  'test/a.test.ts':
    header +
    "import { value } from '../src/input.ts'; test('value', () => { console.log('QUALITY_A'); expect(value).toBeLessThan(3); });\n",
  'test/b.test.ts':
    header + "test('normal', () => { console.log('QUALITY_B'); expect(1).toBe(1); });\n",
  'test/assurance.test.ts':
    header + "test('cleanup', () => { console.log('ASSURANCE_RAN'); expect(1).toBe(1); });\n",
};

function apply(f: Fixture, bunArgs: string[] = []) {
  const result = run(f, [
    ...bunArgs,
    setup,
    'apply',
    '--repo',
    f.repo,
    '--feedback-command',
    'bun scripts/probe.ts && bun run test:affected',
  ]);
  expect(result.code, result.output).toBe(0);
}

for (const manager of ['bun@1.4.4', 'npm@11.0.0']) {
  test(`inspectは${manager}の公開項目を読み、ローカル差分を書き換えない`, async () => {
    const pkg = {
      packageManager: manager,
      scripts: { check: 'echo existing' },
      devDependencies: { eslint: '9.0.0' },
    };
    await fixture({ 'package.json': JSON.stringify(pkg), 'notes.txt': 'local' }, async (f) => {
      await writeFile(join(f.repo, 'notes.txt'), 'uncommitted');
      const before = await snapshot(f.repo);
      const result = run(f, [setup, 'inspect', '--repo', f.repo]);
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        packageManager: manager.split('@')[0],
        scripts: pkg.scripts,
        devDependencies: pkg.devDependencies,
      });
      const inspected = object(result.stdout);
      assert(Array.isArray(inspected.configFiles));
      for (const path of inspected.configFiles) {
        assert(typeof path === 'string');
        expect(Object.hasOwn(before, path)).toBe(true);
      }
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

test('installは同じ固定版を更新せず、別版と範囲指定を変更前に拒否する', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({
        packageManager: 'bun@1.4.4',
        devDependencies: { oxlint: '1.89.0' },
      }),
    },
    async (f) => {
      const before = await snapshot(f.repo);
      const same = run(f, [setup, 'install', '--repo', f.repo, '--package', 'oxlint@1.89.0']);
      expect(same.code, same.output).toBe(0);
      expect(await snapshot(f.repo)).toEqual(before);
      for (const requested of ['oxlint@1.90.0', 'fallow@latest', 'fallow@^3.34.1']) {
        const result = run(f, [setup, 'install', '--repo', f.repo, '--package', requested]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain(requested.split('@')[0] ?? '');
        expect(await snapshot(f.repo)).toEqual(before);
      }
    },
  );
});

test('applyの接続と再実行は既存check・設定・ローカル差分を保つ', async () => {
  await fixture(files, async (f) => {
    await writeFile(join(f.repo, 'local.txt'), 'keep local changes');
    const before = object(files['.dotagents.json']);
    apply(f);
    const pkg = object(await readFile(join(f.repo, 'package.json'), 'utf8'));
    assert(isRecord(pkg.scripts));
    expect(pkg.scripts.check).toBe('bun test test');
    expect(pkg.scripts['lint:fix']).toBe('echo explicit-fix');
    expect(pkg.scripts['check:feedback']).toBe('bun scripts/probe.ts && bun run test:affected');
    const target = object(await readFile(join(f.repo, '.dotagents.json'), 'utf8'));
    const { feedbackCheck, ...preserved } = target;
    expect(preserved).toEqual(before);
    assert(typeof feedbackCheck === 'string' || Array.isArray(feedbackCheck));
    expect(typeof feedbackCheck === 'string' ? feedbackCheck : feedbackCheck.join(' ')).toBe(
      'bun run check:feedback',
    );
    const installed = await snapshot(f.repo);
    expect(Object.keys(installed).some((path) => path.startsWith('scripts/feedback-loop/'))).toBe(
      true,
    );
    apply(f);
    expect(await snapshot(f.repo)).toEqual(installed);
    const classified = run(f, ['run', 'check:classification']);
    expect(classified.code, classified.output).toBe(0);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const feedback = run(f, ['run', 'check:feedback']);
    expect(feedback.code, feedback.output).toBe(0);
    expect(feedback.output).toContain('QUALITY_A');
    expect(feedback.output).toContain('QUALITY_B');
    expect(feedback.output).not.toContain('ASSURANCE_RAN');
    const failed = run(f, ['run', 'check:feedback'], { PROBE_FAIL: '1' });
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.output).toContain(
      'PROBE_DIAGNOSTIC scripts/probe.ts; rerun: bun run check:feedback',
    );
    expect(failed.output).not.toContain('QUALITY_A');
    expect(await readFile(join(f.repo, 'local.txt'), 'utf8')).toBe('keep local changes');
  });
});

for (const [manager, quotedRepo] of [
  ['bun', false],
  ['npm', false],
  ['bun', true],
] as const) {
  test(`初回applyの収集失敗後は案内どおりの再実行で${manager}管理${quotedRepo ? 'の空白・引用符パス' : ''}の導入が完了する`, async () => {
    const feedback = `printf '%s\\n' "SETUP'S FEEDBACK" && ${manager} run test:affected`;
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          private: true,
          type: 'module',
          packageManager: manager === 'bun' ? 'bun@1.4.4' : 'npm@11.0.0',
          scripts: { check: 'bun test test' },
        }),
        'scripts/collect.ts':
          "import { existsSync } from 'node:fs'; if (!existsSync('collection-ready')) { console.error('COLLECTION_NOT_READY'); process.exit(23); }\n" +
          files['scripts/collect.ts'],
      },
      async (initial) => {
        const repo = quotedRepo ? join(initial.repo, '..', "project 'quoted' space") : initial.repo;
        if (quotedRepo) {
          await rename(initial.repo, repo);
        }
        const f = { ...initial, repo };
        const env = { ...baseEnv(f), npm_config_cache: join(f.reports, 'npm-cache') };
        const before = await snapshot(repo);
        const failed = run(f, [setup, 'apply', '--repo', repo, '--feedback-command', feedback]);
        expect(failed.code, failed.output).toBe(1);
        expect(failed.output).toContain('COLLECTION_NOT_READY');
        expect(await snapshot(repo)).toEqual(before);
        const retry = /再実行: ([^\r\n]+)/.exec(failed.output)?.[1];
        assert(retry, failed.output);

        await writeFile(join(repo, 'collection-ready'), 'ready\n');
        const recovered = spawnSync('/bin/sh', ['-c', retry], {
          cwd: repo,
          encoding: 'utf8',
          timeout: 30000,
          env,
        });
        expect(recovered.error).toBeUndefined();
        expect(recovered.signal).toBeNull();
        expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
        const pkg = object(await readFile(join(repo, 'package.json'), 'utf8'));
        assert(isRecord(pkg.scripts));
        expect(pkg.scripts['check:feedback']).toBe(feedback);
        expect(typeof pkg.scripts['test:affected']).toBe('string');
        expect(typeof pkg.scripts['check:classification']).toBe('string');
        const target = object(await readFile(join(repo, '.dotagents.json'), 'utf8'));
        const { feedbackCheck } = target;
        assert(typeof feedbackCheck === 'string' || Array.isArray(feedbackCheck));
        expect(typeof feedbackCheck === 'string' ? feedbackCheck : feedbackCheck.join(' ')).toBe(
          `${manager} run check:feedback`,
        );
        expect(
          Object.keys(await snapshot(repo)).some((path) =>
            path.startsWith('scripts/feedback-loop/'),
          ),
        ).toBe(true);
        const connected = spawnSync(
          manager,
          ['run', quotedRepo ? 'check:classification' : 'check:feedback'],
          {
            cwd: repo,
            encoding: 'utf8',
            timeout: 30000,
            env,
          },
        );
        expect(connected.error).toBeUndefined();
        expect(connected.signal).toBeNull();
        const output = connected.stdout + connected.stderr;
        expect(connected.status, output).toBe(0);
        if (quotedRepo) {
          expect(JSON.parse(connected.stdout)).toMatchObject({
            quality: ['test/a.test.ts', 'test/b.test.ts'],
            assurance: ['test/assurance.test.ts'],
          });
        } else {
          expect(output).toContain("SETUP'S FEEDBACK");
          expect(output).toContain('QUALITY_A');
          expect(output).toContain('QUALITY_B');
        }
        expect(output).not.toContain('ASSURANCE_RAN');
      },
    );
  });
}

for (const [manager, runner] of [
  ['bun', 'bun'],
  ['npm', 'vitest'],
  ['npm', 'bun'],
  ['bun', 'vitest'],
] as const) {
  test(`生成入口は${manager}管理・${runner} runnerに対応する再実行方法を案内する`, async () => {
    const targetConfig = {
      ...config,
      runner,
      prepare: [process.execPath, 'scripts/prepare.ts'],
    };
    if (runner === 'vitest') {
      Reflect.deleteProperty(targetConfig, 'bunArgs');
    }
    await fixture(
      {
        ...files,
        'package.json': JSON.stringify({
          private: true,
          type: 'module',
          packageManager: manager === 'bun' ? 'bun@1.4.4' : 'npm@11.0.0',
          scripts: { check: 'echo existing' },
        }),
        '.feedback-loop.json': JSON.stringify(targetConfig),
        'scripts/prepare.ts': "console.log('PREPARE_RAN');\n",
        ...(runner === 'vitest'
          ? {
              'node_modules/vitest/package.json': JSON.stringify({
                name: 'vitest',
                type: 'module',
                bin: { vitest: './vitest.mjs' },
                exports: {
                  './package.json': './package.json',
                  './node': './node.mjs',
                },
              }),
              'node_modules/vitest/node.mjs': `import { resolve } from 'node:path';
export const parseCLI = () => ({ options: {} });
export const createVitest = async () => ({
  config: {},
  getRelevantTestSpecifications: async () => ['a', 'b'].map(name => ({ moduleId: resolve('test/' + name + '.test.ts') })),
  close: async () => {},
});\n`,
              'node_modules/vitest/vitest.mjs': `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
console.log('VITEST_CLI_RAN');
const selected = process.argv.filter(value => value.startsWith('test/') && value.endsWith('.test.ts'));
const argument = process.argv.find(value => value.startsWith('--outputFile='));
if (!argument) throw new Error('JSON report output was not requested');
writeFileSync(argument.slice('--outputFile='.length), JSON.stringify({
  success: true,
  numTotalTestSuites: selected.length, numPassedTestSuites: selected.length,
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: selected.length, numPassedTests: selected.length,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: selected.map(file => ({
    name: resolve(file), status: 'passed', message: '',
    assertionResults: [{ title: file, fullName: file, ancestorTitles: [], status: 'passed', failureMessages: [] }],
  })),
}));\n`,
            }
          : {}),
      },
      async (f) => {
        const applied = run(f, [
          setup,
          'apply',
          '--repo',
          f.repo,
          '--feedback-command',
          `${manager} run test:affected`,
        ]);
        expect(applied.code, applied.output).toBe(0);
        for (const script of ['check:classification', 'test:affected']) {
          const result = spawnSync(manager, ['run', script], {
            cwd: f.repo,
            encoding: 'utf8',
            timeout: 30000,
            env: baseEnv(f),
          });
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          const output = result.stdout + result.stderr;
          expect(result.status, output).toBe(0);
          const managers = [...output.matchAll(/再実行: (bun|npm) run test:affected/g)].map(
            (match) => match[1],
          );
          expect(managers.length, output).toBeGreaterThanOrEqual(
            script === 'check:classification' ? 1 : 3,
          );
          expect(new Set(managers), output).toEqual(new Set([manager]));
          if (script === 'test:affected') {
            expect(output).toContain('PREPARE_RAN');
            expect(output).toContain(runner === 'bun' ? 'QUALITY_A' : 'VITEST_CLI_RAN');
            expect(output).toContain('quality選択: 2');
          }
        }
      },
    );
  });
}

for (const scenario of [
  'duplicate',
  'outside',
  'empty-reason',
  'collection-mismatch',
  'command-conflict',
]) {
  test(`applyは${scenario}を配置前に拒否する`, async () => {
    await fixture(files, async (f) => apply(f));
    await fixture(files, async (f) => {
      const changed = structuredClone(config);
      const assurance = changed.assurance[0];
      assert(assurance);
      if (scenario === 'duplicate') {
        changed.assurance.push(assurance);
      }
      if (scenario === 'outside') {
        assurance.path = 'test/missing.test.ts';
      }
      if (scenario === 'empty-reason') {
        assurance.reason = '';
      }
      if (scenario === 'collection-mismatch') {
        changed.testGlobs = ['test/a.test.ts'];
      }
      await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
      if (scenario === 'command-conflict') {
        const pkg = object(files['package.json']);
        assert(isRecord(pkg.scripts));
        pkg.scripts['test:affected'] = 'echo local-command';
        await writeFile(join(f.repo, 'package.json'), JSON.stringify(pkg));
      }
      const before = await snapshot(f.repo);
      const result = run(f, [
        setup,
        'apply',
        '--repo',
        f.repo,
        '--feedback-command',
        'bun scripts/probe.ts',
      ]);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output.length).toBeGreaterThan(0);
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

test('生成入口は準備を一度だけ完了してからテストを実行し、準備失敗を伝える', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        prepare: [process.execPath, '--no-env-file', 'scripts/prepare.ts'],
      }),
      'scripts/prepare.ts': `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.PREPARE_LOG!, 'prepare\\n');
if (process.env.PREPARE_FAIL === '1') {
  console.error('PREPARE_DIAGNOSTIC: fixed dependencies or Python syntax; rerun: bun run check:feedback');
  process.exit(9);
}
writeFileSync(process.env.PREPARE_READY!, 'ready');
`,
      'test/a.test.ts':
        header +
        `import { appendFileSync, readFileSync } from 'node:fs';
test('prepared', () => {
  expect(readFileSync(process.env.PREPARE_READY!, 'utf8')).toBe('ready');
  appendFileSync(process.env.PREPARE_LOG!, 'test\\n');
  console.log('PREPARED_QUALITY');
});
`,
    },
    async (f) => {
      const log = join(f.signals, 'prepare.log');
      const ready = join(f.signals, 'ready');
      const env = { PREPARE_LOG: log, PREPARE_READY: ready };
      await writeFile(log, '');
      apply(f);
      const classified = run(f, ['run', 'check:classification'], env);
      expect(classified.code, classified.output).toBe(0);
      expect(await readFile(log, 'utf8')).toBe('');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      for (const failed of [false, true, false]) {
        await writeFile(log, '');
        await writeFile(ready, 'not ready');
        const result = run(f, ['run', 'check:feedback'], {
          ...env,
          PREPARE_FAIL: failed ? '1' : '0',
        });
        if (failed) {
          expect(result.code, result.output).not.toBe(0);
          expect(result.output).toContain('PREPARE_DIAGNOSTIC');
          expect(result.output).toContain('rerun: bun run check:feedback');
          expect(result.output).not.toContain('PREPARED_QUALITY');
          expect(result.output).not.toContain('QUALITY_B');
          expect(await readFile(log, 'utf8')).toBe('prepare\n');
        } else {
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain('PREPARED_QUALITY');
          expect(result.output).toContain('QUALITY_B');
          expect(await readFile(log, 'utf8')).toBe('prepare\ntest\n');
        }
      }
    },
  );
});

test('生成入口は新規qualityを収集し、未知入力を既知依存と混ぜても全qualityへ広げる', async () => {
  await fixture(files, async (f) => {
    apply(f);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'configured');
    const unchanged = run(f, ['run', 'test:affected']);
    expect(unchanged.code, unchanged.output).not.toBe(0);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const control = run(f, ['run', 'test:affected']);
    expect(control.code, control.output).toBe(0);
    expect(control.output).toContain('QUALITY_A');
    await writeFile(
      join(f.repo, 'test/new.test.ts'),
      header + "test('new', () => { console.log('NEW_QUALITY'); expect(1).toBe(1); });\n",
    );
    const classified = run(f, ['run', 'check:classification']);
    expect(classified.code, classified.output).toBe(0);
    await writeFile(join(f.repo, 'unknown.txt'), 'unmapped input');
    const mixed = run(f, ['run', 'test:affected']);
    expect(mixed.code, mixed.output).toBe(0);
    for (const marker of ['QUALITY_A', 'QUALITY_B', 'NEW_QUALITY']) {
      expect(mixed.output).toContain(marker);
    }
    expect(mixed.output).not.toContain('ASSURANCE_RAN');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
    const failed = run(f, ['run', 'test:affected']);
    expect(failed.output).toContain('QUALITY_A');
    expect(failed.output).toContain('1 fail');
    expect(failed.code, failed.output).not.toBe(0);
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const repaired = run(f, ['run', 'test:affected']);
    expect(repaired.code, repaired.output).toBe(0);
  });
});

test('再セットアップは配置済み補助ファイルのローカル変更を上書きしない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    const installed = await snapshot(f.repo);
    const generated = Object.keys(installed).find((path) =>
      path.startsWith('scripts/feedback-loop/'),
    );
    assert(generated, '対象repoで実行する補助ファイルが必要です');
    await writeFile(join(f.repo, generated), `${installed[generated]}\n// local change\n`);
    const before = await snapshot(f.repo);
    const result = run(f, [
      setup,
      'apply',
      '--repo',
      f.repo,
      '--feedback-command',
      'bun scripts/probe.ts && bun run test:affected',
    ]);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(generated);
    expect(await snapshot(f.repo)).toEqual(before);
  });
});

for (const scenario of ['failed', 'invalid-json', 'duplicate', 'missing', 'omitted']) {
  test(`導入後の収集が${scenario}なら分類検査を成功扱いしない`, async () => {
    await fixture(files, async (f) => {
      apply(f);
      const control = run(f, ['run', 'check:classification']);
      expect(control.code, control.output).toBe(0);
      let source: string;
      if (scenario === 'failed') {
        source = "console.error('COLLECTION_FAILURE'); process.exit(7);\n";
      } else if (scenario === 'invalid-json') {
        source = "console.log('not JSON');\n";
      } else {
        const paths = ['test/a.test.ts', 'test/b.test.ts', 'test/assurance.test.ts'];
        if (scenario === 'duplicate') {
          paths.push('test/a.test.ts');
        } else if (scenario === 'missing') {
          paths.push('test/nonexistent.test.ts');
        } else {
          paths.pop();
        }
        source = `console.log(${JSON.stringify(JSON.stringify(paths))});\n`;
      }
      await writeFile(join(f.repo, 'scripts/collect.ts'), source);
      const before = await snapshot(f.repo);
      const result = run(f, ['run', 'check:classification']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output.trim().length).toBeGreaterThan(0);
      if (scenario === 'failed') {
        expect(result.output).toContain('COLLECTION_FAILURE');
      }
      expect(result.output).not.toContain('QUALITY_A');
      expect(result.output).not.toContain('ASSURANCE_RAN');
      expect(await snapshot(f.repo)).toEqual(before);
    });
  });
}

// 公開仕様補足の既定許容と全件未実行の拒否を、実Bunと生成入口で区別する。
for (const allowSkipped of [undefined, true, false]) {
  test(`Bun生成入口はallowSkipped=${String(allowSkipped)}でskip・todoと未実行を区別する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({ ...config, allowSkipped }),
      },
      async (f) => {
        apply(f);
        const control = run(f, ['run', 'check:feedback']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('QUALITY_A');
        expect(control.output).toContain('QUALITY_B');
        for (const kind of ['skip', 'todo']) {
          const unexecuted = header + `test.${kind}('unexecuted', () => expect(1).toBe(2));\n`;
          await writeFile(join(f.repo, 'test/b.test.ts'), unexecuted);
          const mixed = run(f, ['run', 'check:feedback']);
          expect(mixed.output).toContain('QUALITY_A');
          if (allowSkipped === false) {
            expect(mixed.code, mixed.output).not.toBe(0);
            expect(mixed.output).toMatch(/skip|todo|未実行|未完了|Unexecuted/i);
          } else {
            expect(mixed.code, mixed.output).toBe(0);
          }
          await writeFile(join(f.repo, 'test/a.test.ts'), unexecuted);
          const none = run(f, ['run', 'check:feedback']);
          expect(none.code, none.output).not.toBe(0);
          expect(none.output).toMatch(/skip|todo|未実行|未完了|Unexecuted|No completed/i);
          expect(none.output).not.toContain('QUALITY_A');
          expect(none.output).not.toContain('ASSURANCE_RAN');
          await writeFile(join(f.repo, 'test/a.test.ts'), files['test/a.test.ts']);
        }
        // 許容設定がassertion失敗まで許容しないことと、修正後の回復を確認する。
        await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts']);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
        const failed = run(f, ['run', 'check:feedback']);
        expect(failed.code, failed.output).not.toBe(0);
        expect(failed.output).toContain('toBeLessThan');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const repaired = run(f, ['run', 'check:feedback']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('QUALITY_A');
      },
    );
  });
}

for (const runner of ['bun', 'vitest']) {
  test(`${runner}のallowSkippedはboolean以外を配置前に拒否する`, async () => {
    await fixture(files, async (f) => {
      for (const invalid of ['false', 0, null, [], {}]) {
        const changed = { ...config, runner, allowSkipped: invalid };
        if (runner === 'vitest') {
          Reflect.deleteProperty(changed, 'bunArgs');
        }
        await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(changed));
        const before = await snapshot(f.repo);
        const result = run(f, [
          setup,
          'apply',
          '--repo',
          f.repo,
          '--feedback-command',
          'bun scripts/probe.ts',
        ]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain('allowSkipped');
        expect(await snapshot(f.repo)).toEqual(before);
      }
    });
  });
}

test('明示依存の入力とquality自身を同時に変更しても、変更したテストを実行する', async () => {
  await fixture(files, async (f) => {
    const normal = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
    expect(normal.code, normal.output).toBe(0);
    expect(normal.output).toContain('QUALITY_B');
    const changedTest =
      header + "test('changed', () => { console.log('CHANGED_QUALITY_B'); expect(1).toBe(2); });\n";
    await writeFile(join(f.repo, 'test/b.test.ts'), changedTest);
    const direct = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
    expect(direct.code, direct.output).toBe(1);
    expect(direct.output).toContain('CHANGED_QUALITY_B');
    expect(direct.output).toContain('1 fail');
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts']);
    apply(f);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'configured');
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    const recorded = run(f, ['run', 'test:affected']);
    expect(recorded.code, recorded.output).toBe(0);
    expect(recorded.output).toContain('QUALITY_A');
    expect(recorded.output).toContain('QUALITY_B');
    await writeFile(join(f.repo, 'src/input.ts'), files['src/input.ts']);
    await writeFile(join(f.repo, 'data/value.json'), '{"value":2}\n');
    const control = run(f, ['run', 'check:feedback']);
    expect(control.code, control.output).toBe(0);
    expect(control.output).toContain('QUALITY_A');
    await writeFile(
      join(f.repo, 'test/b.test.ts'),
      header +
        "test('changed', () => { console.log('CHANGED_QUALITY_B_SUCCESS'); expect(1).toBe(1); });\n",
    );
    const successfulMixed = run(f, ['run', 'check:feedback']);
    expect(successfulMixed.code, successfulMixed.output).toBe(0);
    expect(successfulMixed.output).toContain('QUALITY_A');
    expect(successfulMixed.output).toContain('CHANGED_QUALITY_B_SUCCESS');
    expect(successfulMixed.output).toContain('quality選択: 2');
    expect(successfulMixed.output).not.toContain('quality全件の理由:');
    expect(successfulMixed.output).not.toContain('ASSURANCE_RAN');
    await writeFile(join(f.repo, 'test/b.test.ts'), changedTest);
    const mixed = run(f, ['run', 'check:feedback']);
    expect(mixed.output).toContain('CHANGED_QUALITY_B');
    expect(mixed.output).toContain('1 fail');
    expect(mixed.output).not.toContain('ASSURANCE_RAN');
    expect(mixed.code, mixed.output).toBe(1);
    await writeFile(join(f.repo, 'test/b.test.ts'), files['test/b.test.ts'] + '// changed\n');
    const repaired = run(f, ['run', 'check:feedback']);
    expect(repaired.code, repaired.output).toBe(0);
    expect(repaired.output).toContain('QUALITY_A');
    expect(repaired.output).toContain('QUALITY_B');
  });
}, 60000);

test('明示dependenciesは同じ入力の通常importによる選択先を補足する', async () => {
  const shared = (value: number) => `export const value = ${value};\n`;
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        dependencies: [{ inputs: ['src/shared.ts'], tests: ['test/b.test.ts'] }],
      }),
      'src/shared.ts': shared(1),
      'test/a.test.ts':
        header +
        "import { value } from '../src/shared.ts'; test('imported value', () => { console.log('IMPORTED_QUALITY'); expect(value).toBeLessThan(3); });\n",
      'test/b.test.ts':
        header +
        "import { readFileSync } from 'node:fs'; test('file input', () => { console.log('FILE_QUALITY'); expect(readFileSync('src/shared.ts', 'utf8')).toMatch(/export const value = [123];/); });\n",
      'test/unrelated.test.ts':
        header +
        "test('unrelated', () => { console.log('UNRELATED_QUALITY'); expect(1).toBe(1); });\n",
    },
    async (f) => {
      const normal = run(f, ['--no-env-file', 'test', './test']);
      expect(normal.code, normal.output).toBe(0);
      for (const marker of ['IMPORTED_QUALITY', 'FILE_QUALITY', 'UNRELATED_QUALITY']) {
        expect(normal.output).toContain(marker);
      }
      await writeFile(join(f.repo, 'src/shared.ts'), shared(3));
      const direct = run(f, ['--no-env-file', 'test', './test/a.test.ts', './test/b.test.ts']);
      expect(direct.code, direct.output).toBe(1);
      expect(direct.output).toContain('toBeLessThan');
      expect(direct.output).toContain('1 pass');
      expect(direct.output).toContain('1 fail');
      await writeFile(join(f.repo, 'src/shared.ts'), shared(1));
      apply(f);
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-m', 'configured dependency union');
      // 記録は公開入口の初回成功で作り、保存形式や内部exportには依存しない。
      await writeFile(join(f.repo, 'src/shared.ts'), shared(1) + '// initial run\n');
      const initial = run(f, ['run', 'test:affected']);
      expect(initial.code, initial.output).toBe(0);
      for (const marker of ['IMPORTED_QUALITY', 'FILE_QUALITY', 'UNRELATED_QUALITY']) {
        expect(initial.output).toContain(marker);
      }
      expect(initial.output).not.toContain('ASSURANCE_RAN');
      for (const value of [2, 3, 2]) {
        await writeFile(join(f.repo, 'src/shared.ts'), shared(value));
        expect(git(f.repo, 'diff', '--name-only')).toBe('src/shared.ts');
        const result = run(f, ['run', 'test:affected']);
        expect(result.output).toContain('IMPORTED_QUALITY');
        expect(result.output).not.toContain('ASSURANCE_RAN');
        if (value === 3) {
          expect(result.code, result.output).toBe(1);
          expect(result.output).toContain('toBeLessThan');
          expect(result.output).toContain('1 fail');
        } else {
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain('FILE_QUALITY');
        }
      }
    },
  );
}, 60000);

// Issue #466要求3: 別の既知変更が選べても、削除・改名の旧パスを落とさない。
for (const operation of ['delete', 'rename']) {
  test(`生成入口は既知変更と${operation}の旧パスの影響先を両方実行する`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          dependencies: [
            { inputs: ['data/value.json'], tests: ['test/b.test.ts'] },
            { inputs: ['data/moved.json'], tests: ['test/a.test.ts'] },
          ],
        }),
        'test/b.test.ts':
          header +
          "import { existsSync } from 'node:fs'; test('required input', () => { console.log('OLD_PATH_QUALITY'); expect(existsSync('data/value.json')).toBe(true); });\n",
      },
      async (f) => {
        const original = join(f.repo, 'data/value.json');
        const moved = join(f.repo, 'data/moved.json');
        const control = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('OLD_PATH_QUALITY');
        if (operation === 'delete') {
          await unlink(original);
        } else {
          await rename(original, moved);
        }
        const direct = run(f, ['--no-env-file', 'test', './test/b.test.ts']);
        expect(direct.code, direct.output).toBe(1);
        expect(direct.output).toContain('OLD_PATH_QUALITY');
        expect(direct.output).toContain('1 fail');
        if (operation === 'rename') {
          await rename(moved, original);
        } else {
          await writeFile(original, files['data/value.json']);
        }

        apply(f);
        git(f.repo, 'add', '-A');
        git(f.repo, 'commit', '-m', '旧パスの依存を設定');
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const recorded = run(f, ['run', 'test:affected']);
        expect(recorded.code, recorded.output).toBe(0);
        expect(recorded.output).toContain('QUALITY_A');
        expect(recorded.output).toContain('OLD_PATH_QUALITY');
        if (operation === 'delete') {
          await unlink(original);
        } else {
          await rename(original, moved);
          // 改名先も既知の入力にし、未知入力による全件実行で旧パスの欠落を隠さない。
          git(f.repo, 'add', 'data/value.json', 'data/moved.json');
        }
        const affected = run(f, ['run', 'check:feedback']);
        expect(affected.output).toContain('QUALITY_A');
        expect(affected.output).toContain('OLD_PATH_QUALITY');
        expect(affected.output).toContain('1 fail');
        expect(affected.output).not.toContain('ASSURANCE_RAN');
        expect(affected.code, affected.output).toBe(1);

        await writeFile(original, files['data/value.json']);
        const repaired = run(f, ['run', 'check:feedback']);
        expect(repaired.code, repaired.output).toBe(0);
      },
    );
  }, 60000);
}

test('未commitの設定Bで取得した記録を、設定Aへ戻して部分選択の根拠にしない', async () => {
  await fixture(files, async (f) => {
    apply(f);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-m', 'configuration A');
    const alternate = structuredClone(config);
    alternate.assurance.push({ path: 'test/b.test.ts', reason: '資源解放だけを検証する対照' });
    await writeFile(join(f.repo, '.feedback-loop.json'), JSON.stringify(alternate));
    await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const control = run(f, ['run', 'test:affected']);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('QUALITY_A');
      expect(control.output).not.toContain('QUALITY_B');
      expect(control.output).not.toContain('ASSURANCE_RAN');
    }
    // Gitの差分から設定変更が消えても、記録時の設定との不一致は残る。
    await writeFile(join(f.repo, '.feedback-loop.json'), files['.feedback-loop.json']);
    expect(git(f.repo, 'diff', '--name-only')).toBe('src/input.ts');
    const restored = run(f, ['run', 'check:feedback']);
    expect(restored.code, restored.output).toBe(0);
    expect(restored.output).toContain('QUALITY_A');
    expect(restored.output).toContain('QUALITY_B');
    expect(restored.output).not.toContain('ASSURANCE_RAN');
    expect(restored.output).toMatch(/全件|設定|記録|整合/);
  });
}, 60000);

test('bunArgsの--no-env-fileを生成入口でも保ち、外側のBunによる先行読込みを防ぐ', async () => {
  const sentinel = 'DOTAGENTS_466_ENV_SENTINEL';
  await fixture(
    {
      ...files,
      '.env': `${sentinel}=fixture_only_no_secret\n`,
      '.feedback-loop.json': JSON.stringify({
        ...config,
        collect: [process.execPath, '--no-env-file', 'scripts/collect.ts'],
        globalChanges: ['scripts/**', 'src/**'],
      }),
      'scripts/collect.ts':
        `if (process.env.${sentinel}) throw new Error('COLLECT_ENV_LEAK');\n` +
        files['scripts/collect.ts'],
      'test/b.test.ts':
        header +
        `test('env', () => { console.log('ENV_QUALITY'); expect(process.env.${sentinel}).toBeUndefined(); });\n`,
    },
    async (f) => {
      const env = { [sentinel]: undefined };
      // fixtureの.envが有効で、既存の保護引数なら読まないことを先に確認する。
      const control = run(f, ['--no-env-file', 'test', './test/b.test.ts'], env);
      expect(control.code, control.output).toBe(0);
      expect(control.output).toContain('ENV_QUALITY');
      const unprotected = run(f, ['test', './test/b.test.ts'], env);
      expect(unprotected.code, unprotected.output).toBe(1);
      expect(unprotected.output).toContain('fixture_only_no_secret');
      expect(unprotected.output).toContain('1 fail');
      apply(f, ['--no-env-file']);
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-m', 'protected entrypoints');
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
      for (const command of ['check:classification', 'test:affected', 'check:feedback']) {
        const result = run(f, ['--no-env-file', 'run', command], env);
        expect(result.code, result.output).toBe(0);
        expect(result.output).not.toContain('COLLECT_ENV_LEAK');
        if (command !== 'check:classification') {
          expect(result.output).toContain('QUALITY_A');
          expect(result.output).toContain('ENV_QUALITY');
          expect(result.output).not.toContain('ASSURANCE_RAN');
        }
      }
    },
  );
}, 60000);
