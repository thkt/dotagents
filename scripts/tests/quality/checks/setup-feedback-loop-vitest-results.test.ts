import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, files, fixture, installed, run } from '../../support/feedback-loop-batch.ts';

// CLI境界の制御テスト。実Vitestとの互換性は固定版を使う導入検証で別に確認する。
const cli = `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const selected = process.argv.includes('related') ? ['a', 'b'] : ['a', 'b', 'c'];
const report = {
  success: true,
  numTotalTestSuites: selected.length, numPassedTestSuites: selected.length,
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: selected.length, numPassedTests: selected.length,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: selected.map(name => ({
    name: resolve('test/' + name + '.test.ts'), status: 'passed', message: '',
    assertionResults: [{ title: name, fullName: name, ancestorTitles: [], status: 'passed', failureMessages: [] }],
  })),
};
writeFileSync(process.env.VITEST_REPORT_BEFORE, JSON.stringify(report));
if (process.env.VITEST_RESULT_FAULT === 'missing') report.testResults.splice(1, 1);
const argument = process.argv.find(value => value.startsWith('--outputFile='));
if (!argument) throw new Error('JSON report output was not requested');
writeFileSync(argument.slice('--outputFile='.length), JSON.stringify(report));
writeFileSync(process.env.VITEST_REPORT_AFTER, JSON.stringify(report));
`;

for (const selection of ['full', 'related']) {
  test(`Vitestの${selection}実行は選択ファイルの結果欠落を成功にしない`, async () => {
    const vitestConfig = { ...config, runner: 'vitest' };
    Reflect.deleteProperty(vitestConfig, 'bunArgs');
    await fixture(
      {
        ...files,
        '.feedback-loop.json': JSON.stringify(vitestConfig),
        'test/c.test.ts': 'export {};\n',
        'node_modules/vitest/package.json': JSON.stringify({
          name: 'vitest',
          type: 'module',
          bin: { vitest: './vitest.mjs' },
          exports: { './package.json': './package.json', './node': './node.mjs' },
        }),
        'node_modules/vitest/vitest.mjs': cli,
        'node_modules/vitest/node.mjs': `import { resolve } from 'node:path';
export const parseCLI = () => ({ options: {} });
export const createVitest = async () => ({
  config: {},
  getRelevantTestSpecifications: async () => ['a', 'b'].map(name => ({ moduleId: resolve('test/' + name + '.test.ts') })),
  close: async () => {},
});\n`,
      },
      async (f) => {
        installed(f);
        const input = selection === 'full' ? 'scripts/changed.ts' : 'src/input.ts';
        await writeFile(join(f.repo, input), 'export const value = 2;\n');
        const env = {
          VITEST_REPORT_BEFORE: join(f.signals, 'before.json'),
          VITEST_REPORT_AFTER: join(f.signals, 'after.json'),
        };
        const control = run(f, ['run', 'test:affected'], env);
        expect(control.code, control.output).toBe(0);
        expect(control.output).toContain(`quality選択: ${selection === 'full' ? 3 : 2}`);
        expect(await readFile(env.VITEST_REPORT_AFTER, 'utf8')).toBe(
          await readFile(env.VITEST_REPORT_BEFORE, 'utf8'),
        );

        const missing = run(f, ['run', 'test:affected'], {
          ...env,
          VITEST_RESULT_FAULT: 'missing',
        });
        expect(await readFile(env.VITEST_REPORT_BEFORE, 'utf8')).toContain('/test/b.test.ts');
        expect(await readFile(env.VITEST_REPORT_AFTER, 'utf8')).not.toContain('/test/b.test.ts');
        expect(missing.code, missing.output).not.toBe(0);
        expect(missing.output).toMatch(/Vitest.*(?:欠落|一致|完了|件数)/);
        expect(missing.output).not.toContain('選択したqualityが成功しました');
      },
    );
  });
}
