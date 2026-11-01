import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  config,
  files,
  fixture,
  header,
  installed,
  retainedRecords,
  run,
  seed,
} from '../../support/feedback-loop-batch.ts';
import { cancelFeedbackCommand } from '../../support/feedback-loop-cancellation.ts';

// 公開CLI境界の制御用fixture。実Vitestのworker終了は固定版の導入検証でも確認する。
const vitestCLI = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.env.CANCEL_TRACE) {
  const worker = spawn(process.execPath, ['--input-type=module', '-e', "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid })); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((done, fail) => { worker.once('close', done); worker.once('error', fail); });
  process.exitCode = 1;
} else {
  const report = {
    success: true, numTotalTestSuites: 2, numPassedTestSuites: 2,
    numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: ['a', 'b'].map(name => ({
      name: resolve('test/' + name + '.test.ts'), status: 'passed', message: '',
      assertionResults: [{ title: name, fullName: name, ancestorTitles: [], status: 'passed', failureMessages: [] }],
    })),
  };
  const output = process.argv.find(arg => arg.startsWith('--outputFile='));
  if (!output) throw new Error('JSON report output was not requested');
  writeFileSync(output.slice('--outputFile='.length), JSON.stringify(report));
}
`;

for (const target of ['host', 'runtime'] as const) {
  test(`prepare実行中の${target}取消は処理とpipeを解放し、テスト本体を開始しない`, async () => {
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify({
          ...config,
          prepare: [process.execPath, '--no-env-file', 'scripts/prepare.ts'],
        }),
        'scripts/prepare.ts': `import { writeFileSync } from 'node:fs';
if (process.env.CANCEL_TRACE) {
  writeFileSync(process.env.CANCEL_TRACE, JSON.stringify({ child: process.pid, parent: process.ppid }));
  setInterval(() => {}, 1000);
} else console.log('PREPARE_COMPLETED');\n`,
        'test/a.test.ts': `${header}import { writeFileSync } from 'node:fs';
import { value } from '../src/input.ts';
if (process.env.CANCEL_STARTED) writeFileSync(process.env.CANCEL_STARTED, 'started');
test('a', () => { expect(value).toBeGreaterThan(0); console.log('QUALITY_A_COMPLETED'); });\n`,
      },
      async (f) => {
        installed(f);
        const original = await seed(f);
        await cancelFeedbackCommand(f, target);
        expect(
          existsSync(join(f.signals, 'test-started')),
          '準備中の取消後にテスト本体が開始しました',
        ).toBe(false);
        expect(await retainedRecords(f)).toContain(original);
        const repaired = run(f, ['run', 'test:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output.match(/PREPARE_COMPLETED/g)).toHaveLength(1);
        expect(repaired.output).toContain('QUALITY_A_COMPLETED');
      },
    );
  }, 20000);

  test(`Vitest実行中の${target}取消はCLI・workerとpipeを解放して成功扱いしない`, async () => {
    const vitestConfig = { ...config, runner: 'vitest' };
    Reflect.deleteProperty(vitestConfig, 'bunArgs');
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify(vitestConfig),
        'node_modules/vitest/package.json': JSON.stringify({
          name: 'vitest',
          type: 'module',
          bin: { vitest: './vitest.mjs' },
          exports: { './package.json': './package.json', './node': './node.mjs' },
        }),
        'node_modules/vitest/node.mjs': 'export {};\n',
        'node_modules/vitest/vitest.mjs': vitestCLI,
      },
      async (f) => {
        installed(f);
        await writeFile(join(f.repo, 'scripts/changed.ts'), 'export {};\n');
        const control = run(f, ['run', 'test:affected']);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain('quality選択: 2');
        await cancelFeedbackCommand(f, target);
        const repaired = run(f, ['run', 'test:affected']);
        expect(repaired.code, repaired.output).toBe(0);
        expect(repaired.output).toContain('quality選択: 2');
      },
    );
  }, 20000);
}
