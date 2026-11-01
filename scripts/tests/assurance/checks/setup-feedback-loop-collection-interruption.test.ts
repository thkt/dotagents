import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baseEnv,
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  retainedRecords,
  run,
  setup,
} from '../../support/feedback-loop-batch.ts';
import type { Fixture } from '../../support/feedback-loop-batch.ts';
import { cancelFeedbackCommand } from '../../support/feedback-loop-cancellation.ts';

const vitestConfig = { ...config, runner: 'vitest' };
Reflect.deleteProperty(vitestConfig, 'bunArgs');
// 公開CLI境界の制御用fixture。実Vitestのworker取消は既存の導入検証で扱う。
const vitestFiles = {
  'node_modules/vitest/package.json': JSON.stringify({
    name: 'vitest',
    type: 'module',
    bin: { vitest: './vitest.mjs' },
    exports: { './package.json': './package.json', './node': './node.mjs' },
  }),
  'node_modules/vitest/node.mjs': `import { resolve } from 'node:path';
export const parseCLI = () => ({ options: {} });
export const createVitest = async () => ({
  config: {},
  getRelevantTestSpecifications: async () => ['a', 'b'].map(name => ({ moduleId: resolve('test/' + name + '.test.ts') })),
  close: async () => {},
});
`,
  'node_modules/vitest/vitest.mjs': `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
const output = process.argv.find(arg => arg.startsWith('--outputFile='));
if (!output) throw new Error('JSON report output was not requested');
writeFileSync(output.slice('--outputFile='.length), JSON.stringify({
  success: true, numTotalTestSuites: 2, numPassedTestSuites: 2,
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: ['a', 'b'].map(name => ({
    name: resolve('test/' + name + '.test.ts'), status: 'passed', message: '',
    assertionResults: [{ title: name, fullName: name, ancestorTitles: [], status: 'passed', failureMessages: [] }],
  })),
}));
`,
};

function generated(f: Fixture, node: boolean, mode: 'affected' | 'classification') {
  const result = spawnSync(
    node ? 'node' : process.execPath,
    ['scripts/feedback-loop/runtime.mjs', mode],
    { cwd: f.repo, encoding: 'utf8', timeout: 15000, env: baseEnv(f) },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}

for (const target of ['Bun', 'Node', 'apply']) {
  test(`${target}公開入口の収集中取消はcollectorとpipeを回収し、次回実行へ復帰する`, async () => {
    const node = target === 'Node';
    await fixture(
      {
        ...files,
        ...(node ? vitestFiles : {}),
        '.feedback-loop.json': JSON.stringify({
          ...(node ? vitestConfig : config),
          collect: ['node', 'scripts/collect.mjs'],
          prepare: [process.execPath, '-e', "console.log('PREPARE_COMPLETED')"],
        }),
        'scripts/collect.mjs': `import { readdirSync, writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {}, 1000);
} else {
  console.error('COLLECT_DIAGNOSTIC');
  const paths = readdirSync('test').filter(path => path.endsWith('.test.ts')).map(path => 'test/' + path);
  console.log(JSON.stringify(paths).replace(',', ',' + ' '.repeat(256 * 1024)));
}
`,
        'test/a.test.ts': `${header}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => expect(value).toBeGreaterThan(0));
`,
      },
      async (f) => {
        installed(f);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const classified = generated(f, node, 'classification');
        expect(JSON.parse(classified.stdout)).toMatchObject({
          quality: ['test/a.test.ts', 'test/b.test.ts'],
          assurance: [],
        });
        expect(classified.stdout).not.toContain('COLLECT_DIAGNOSTIC');
        expect(classified.stdout + classified.stderr).not.toContain('PREPARE_COMPLETED');
        generated(f, node, 'affected');
        const original = node ? undefined : await readFile(recordFile(f.repo), 'utf8');
        await cancelFeedbackCommand(f, target === 'apply' ? 'apply' : 'runtime');
        expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
        if (original !== undefined) {
          expect(await readFile(recordFile(f.repo), 'utf8')).toBe(original);
        }
        if (target === 'apply') {
          const reapplied = run(f, [
            setup,
            'apply',
            '--repo',
            f.repo,
            '--feedback-command',
            'bun run test:affected',
          ]);
          expect(reapplied.code, reapplied.output).toBe(0);
        }
        const repaired = generated(f, node, 'affected');
        expect(repaired.stdout).toContain('quality選択:');
        if (original !== undefined) {
          expect(await retainedRecords(f)).toContain(original);
        }
      },
    );
  }, 20000);
}

for (const stderr of ['0', '1']) {
  test(`Node準備処理のstderr継続=${stderr}でホストtimeout後も子とpipeを回収する`, async () => {
    await fixture(
      {
        ...files,
        ...vitestFiles,
        '.feedback-loop.json': JSON.stringify({
          ...vitestConfig,
          prepare: ['node', 'scripts/prepare.mjs'],
        }),
        'scripts/prepare.mjs': `import { writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  process.on('SIGTERM', () => writeFileSync(process.env.CANCEL_TRACE + '.term', 'received'));
  process.stderr.on('error', () => {});
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {
    if (process.env.CANCEL_STDERR === '1') process.stderr.write('PREPARE_RUNNING\\n');
  }, 10);
} else console.log('PREPARE_COMPLETED');
`,
        'test/a.test.ts': `${header}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => expect(value).toBeGreaterThan(0));
`,
      },
      async (f) => {
        installed(f);
        await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 2;\n');
        const control = generated(f, true, 'affected');
        expect(control.stdout.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        await cancelFeedbackCommand(f, 'host', {
          timeoutMs: 700,
          env: { CANCEL_STDERR: stderr },
        });
        expect(await readFile(join(f.signals, 'cancel-trace.json.term'), 'utf8')).toBe('received');
        expect(existsSync(join(f.signals, 'test-started'))).toBe(false);
        const repaired = generated(f, true, 'affected');
        expect(repaired.stdout.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        expect(repaired.stdout).toContain('quality選択:');
      },
    );
  }, 20000);
}
