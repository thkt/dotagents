import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  config,
  files,
  fixture,
  header,
  installed,
  recordFile,
  retainedRecords,
  run,
  seed,
} from '../../support/feedback-loop-batch.ts';

// 実Bunが終了した直後のレポート境界に不正を注入し、欠損の種類を個別に確認する。
// 生成物・内部export・依存記録は書き換えない。
const reportFault = `const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  const child = original(command, args, options);
  const observe = (args) => {
  const index = args.indexOf('--reporter-outfile');
  if (args.includes('test') && index >= 0 && process.env.REPORT_FAULT) {
    child.prependListener('close', () => {
      const path = args[index + 1];
      if (!fs.existsSync(path)) return;
      let text = fs.readFileSync(path, 'utf8');
      const suite = text.match(/<testsuite\\s[\\s\\S]*?<\\/testsuite>/)?.[0];
      if (!suite) throw new Error('No suite reached the fault boundary');
      const mode = process.env.REPORT_FAULT;
      const root = text.match(/<testsuites\\s[^>]*>/)[0];
      const count = Number(suite.match(/tests="(\\d+)"/)[1]);
      if (mode === 'missing' || mode === 'zero') {
        text = text.replace(root, root.replace(/tests="(\\d+)"/, (_, total) => 'tests="' + (Number(total) - count) + '"'));
        text = text.replace(suite, mode === 'missing' ? '' : suite.replace(/tests="\\d+"/, 'tests="0"').replace(/<testcase[\\s\\S]*?(?:\\/>|<\\/testcase>)/g, ''));
      }
      if (mode === 'count') {
        text = text.replace(root, root.replace(/tests="(\\d+)"/, (_, total) => 'tests="' + (Number(total) + 1) + '"'));
        text = text.replace(suite, suite.replace(/tests="(\\d+)"/, (_, total) => 'tests="' + (Number(total) + 1) + '"'));
      }
      if (mode === 'foreign') text = text.replace(suite, suite.replace(/file="[^"]+"/g, 'file="test/outside.test.ts"'));
      if (mode === 'failure') text = text.replace(suite, suite.replace('failures="0"', 'failures="1"'));
      fs.writeFileSync(path, text);
      fs.appendFileSync(process.env.REPORT_FAULT_MARKER, mode + '\\n');
    });
  }
  };
  observe(args);
  // 監視プロセス経由でも、実行argvを受け取って結果を読む前の境界へ接続する。
  const send = child.send;
  if (typeof send === 'function') child.send = function(message, ...rest) {
    if (message && Array.isArray(message.argv)) observe(message.argv);
    return send.call(this, message, ...rest);
  };
  return child;
};
require('node:module').syncBuiltinESMExports();
`;

for (const mode of ['missing', 'zero', 'count', 'foreign', 'failure']) {
  test(`一括結果の${mode}を終了0の成功記録へ採用しない`, async () => {
    await fixture({ ...files, 'scripts/report-fault.cjs': reportFault }, async (f) => {
      installed(f);
      const original = await seed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
      const pkg: unknown = JSON.parse(await readFile(join(f.repo, 'package.json'), 'utf8'));
      assert(isRecord(pkg) && isRecord(pkg.scripts));
      const command = pkg.scripts['test:affected'];
      assert(typeof command === 'string');
      const argv = command.split(' ');
      expect(argv.shift()).toBe('bun');
      const marker = join(f.signals, 'fault.log');
      const result = run(f, ['--preload', './scripts/report-fault.cjs', ...argv], {
        REPORT_FAULT: mode,
        REPORT_FAULT_MARKER: marker,
      });
      expect(await readFile(marker, 'utf8'), result.output).toContain(mode);
      expect(result.code, result.output).not.toBe(0);
      expect(await retainedRecords(f)).toContain(original);
      const current = await readFile(recordFile(f.repo), 'utf8');
      expect(current).not.toContain(join(f.repo, 'test/a.test.ts'));
      expect(current).not.toContain(join(f.repo, 'test/b.test.ts'));
    });
  });
}

test('読み込まれた0件ファイルは他ファイルの成功で埋め合わせない', async () => {
  await fixture(files, async (f) => {
    installed(f);
    const original = await seed(f);
    await writeFile(join(f.repo, 'test/b.test.ts'), "console.log('EMPTY_FILE_LOADED');\n");
    const result = run(f, ['run', 'test:affected']);
    expect(result.output).toContain('EMPTY_FILE_LOADED');
    expect(result.code, result.output).not.toBe(0);
    expect(await retainedRecords(f)).toContain(original);
  });
});

test('一部が完了してから失敗しても全候補の記録を部分成功へ更新しない', async () => {
  await fixture(
    {
      ...files,
      '.feedback-loop.json': JSON.stringify({ ...config, bunWorkers: 1 }),
      'test/b.test.ts': header + "test('b', () => expect(process.env.BATCH_FAIL).not.toBe('1'));\n",
      'test/c.test.ts': header + "test('c', () => expect(1).toBe(1));\n",
    },
    async (f) => {
      installed(f);
      const original = await seed(f);
      await writeFile(join(f.repo, 'src/input.ts'), 'export const value = 3;\n');
      await writeFile(join(f.repo, 'new-input.txt'), 'unknown input\n');
      const failed = run(f, ['run', 'test:affected'], { BATCH_FAIL: '1' });
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.output).toContain('(pass) a');
      expect(failed.output).toContain('(fail) b');
      expect(await retainedRecords(f)).toContain(original);
      const current = await readFile(recordFile(f.repo), 'utf8');
      for (const name of ['a', 'b', 'c']) {
        expect(current).not.toContain(join(f.repo, `test/${name}.test.ts`));
      }
      const repaired = run(f, ['run', 'test:affected']);
      expect(repaired.code, repaired.output).toBe(0);
      expect(repaired.output).toContain('quality選択: 3');
    },
  );
});
