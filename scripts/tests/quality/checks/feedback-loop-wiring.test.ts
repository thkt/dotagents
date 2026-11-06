import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../shared/values.ts';
import {
  header,
  placed,
  readJson,
  repo,
  runScript,
  withFeedbackRepository,
} from '../../support/feedback-loop-fixture.ts';

const bundled = 'skills/setup-feedback-loop/scripts';
const qualityRelated = 'scripts/tests/quality/related.test.ts';
const qualityOther = 'scripts/tests/quality/other.test.ts';
const assurance = 'scripts/tests/assurance/guard.test.ts';
const input = 'scripts/lib/input.ts';
const affected = (cwd: string) => runScript(cwd, 'test:affected');

test('配置済みの生成物は同梱の生成物と一致し、generated.jsonのsha256とも一致する', async () => {
  const runtime = await readFile(join(repo, placed, 'runtime.mjs'), 'utf8');
  const bundledRuntime = await readFile(join(repo, bundled, 'runtime.mjs'), 'utf8');
  expect(runtime).toBe(
    bundledRuntime.replaceAll('__FEEDBACK_LOOP_TARGET_PACKAGE_MANAGER__', 'bun'),
  );
  const recorder = await readFile(join(repo, placed, 'record-modules.ts'), 'utf8');
  expect(recorder).toBe(await readFile(join(repo, bundled, 'record-modules.ts'), 'utf8'));
  const generated: unknown = JSON.parse(
    await readFile(join(repo, placed, 'generated.json'), 'utf8'),
  );
  assert(isRecord(generated));
  const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');
  expect(generated.files).toEqual({
    [`${placed}/runtime.mjs`]: sha256(runtime),
    [`${placed}/record-modules.ts`]: sha256(recorder),
  });
});

test('実設定のdependenciesとglobalChangesは実在するファイルを指す', async () => {
  const config = await readJson(join(repo, '.feedback-loop.json'));
  assert(Array.isArray(config.dependencies) && Array.isArray(config.globalChanges));
  expect(config.dependencies.length).toBeGreaterThan(0);
  expect(config.globalChanges.length).toBeGreaterThan(0);
  const missing = (paths: unknown[]) =>
    paths.filter((path) => typeof path !== 'string' || !existsSync(join(repo, path)));
  expect(missing(config.globalChanges)).toEqual([]);
  for (const dependency of config.dependencies as unknown[]) {
    assert(isRecord(dependency));
    assert(Array.isArray(dependency.inputs) && Array.isArray(dependency.tests));
    expect(dependency.inputs.length).toBeGreaterThan(0);
    expect(dependency.tests.length).toBeGreaterThan(0);
    expect(missing(dependency.inputs)).toEqual([]);
    expect(missing(dependency.tests)).toEqual([]);
  }
});

test('実行環境の起動入口とその読み込み先を変更するとqualityを全件実行する', async () => {
  await withFeedbackRepository(
    {
      // 記録に現れる依存があっても、関連選択へ絞らず全件へ広げることを確かめます。
      [qualityRelated]: `${header}import '../../test-runtime/report.ts';\ntest('related', () => console.log('RELATED_RAN'));\n`,
      [qualityOther]: `${header}test('other', () => console.log('OTHER_RAN'));\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      expect(affected(cwd).code).toBe(0);
      await rm(join(cwd, 'changed.txt'));
      await writeFile(
        join(cwd, 'scripts/test-runtime/report.ts'),
        `${await readFile(join(cwd, 'scripts/test-runtime/report.ts'), 'utf8')}\n// changed\n`,
      );
      const result = affected(cwd);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('RELATED_RAN');
      expect(result.output).toContain('OTHER_RAN');
      expect(result.output).toContain('scripts/test-runtime/report.ts');
    },
  );
});

test('test:feedbackはtest:affectedと同じ選択を実行し、結果を返す', async () => {
  await withFeedbackRepository(
    {
      [qualityRelated]: `${header}test('related', () => console.log('RELATED_RAN'));\n`,
      [assurance]: `${header}test('guard', () => console.log('ASSURANCE_RAN'));\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const passed = runScript(cwd, 'test:feedback');
      expect(passed.code, passed.output).toBe(0);
      expect(passed.output).toContain('RELATED_RAN');
      expect(passed.output).not.toContain('ASSURANCE_RAN');
      await writeFile(
        join(cwd, qualityRelated),
        `${header}test('fails', () => expect(1).toBe(2));\n`,
      );
      expect(runScript(cwd, 'test:feedback').code).toBe(1);
    },
  );
});

test('check:classificationはqualityだけを収集集合として分類し、未確認を完了扱いしない', async () => {
  await withFeedbackRepository(
    {
      [qualityRelated]: `${header}test('related', () => {});\n`,
      [assurance]: `${header}test('guard', () => {});\n`,
    },
    async (cwd) => {
      const daily = runScript(cwd, 'check:classification');
      expect(daily.code, daily.output).toBe(0);
      const report: unknown = JSON.parse(daily.stdout.slice(daily.stdout.indexOf('{')));
      expect(report).toMatchObject({
        all: [qualityRelated],
        quality: [qualityRelated],
        assurance: [],
        review: { complete: false },
      });
      const complete = runScript(cwd, 'check:classification', '--', '--complete');
      expect(complete.code, complete.output).toBe(1);
      expect(complete.output).toContain(`unreviewed: ${qualityRelated}`);
    },
  );
});

test('test:affectedはqualityだけを2workerで実行し、次の変更では関連するqualityへ絞る', async () => {
  await withFeedbackRepository(
    {
      [input]: 'export const value = 1;\n',
      [qualityRelated]: `${header}test('related', async () => { console.log('RELATED_RAN'); expect((await import('../../lib/input.ts')).value).toBeGreaterThan(0); });\n`,
      [qualityOther]: `${header}test('other', () => console.log('OTHER_RAN'));\n`,
      [assurance]: `${header}test('guard', () => console.log('ASSURANCE_RAN'));\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, input), 'export const value = 2;\n');
      const first = affected(cwd);
      expect(first.code, first.output).toBe(0);
      expect(first.output).toContain('RELATED_RAN');
      expect(first.output).toContain('OTHER_RAN');
      expect(first.output).not.toContain('ASSURANCE_RAN');
      expect(first.output).toContain('--parallel=2');
      await writeFile(join(cwd, input), 'export const value = 3;\n');
      const second = affected(cwd);
      expect(second.code, second.output).toBe(0);
      expect(second.output).toContain('RELATED_RAN');
      expect(second.output).not.toContain('OTHER_RAN');
      expect(second.output).toContain('--only-failures');
    },
  );
});

test('test:affectedはテストへCI=trueとgitの自動maintenance停止を渡す', async () => {
  await withFeedbackRepository(
    {
      [qualityRelated]: `${header}import { spawnSync } from 'node:child_process';
const config = (key: string) => spawnSync('git', ['config', key], { encoding: 'utf8' }).stdout.trim();
test('environment', () => {
  expect(process.env.CI).toBe('true');
  expect(config('maintenance.auto')).toBe('false');
  expect(config('gc.auto')).toBe('0');
  console.log('ENVIRONMENT_CHECKED');
});\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.output).toContain('ENVIRONMENT_CHECKED');
      expect(result.code, result.output).toBe(0);
    },
  );
});

for (const [name, body, diagnostic] of [
  [
    '1ファイルだけのtest.only',
    `${header}test.only('only', () => {});\ntest('other', () => expect(1).toBe(2));\n`,
    '.only is disabled',
  ],
  ['skip', `${header}test('run', () => {});\ntest.skip('skipped', () => {});\n`, 'skip'],
] as const) {
  test(`test:affectedは${name}を成功にしない`, async () => {
    await withFeedbackRepository({ [qualityRelated]: body }, async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
    });
  });
}

test('test:affectedのテスト失敗は起動入口を通しても非ゼロ終了で返す', async () => {
  await withFeedbackRepository(
    { [qualityRelated]: `${header}test('fails', () => expect(1).toBe(2));\n` },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('1 fail');
    },
  );
});

test('実行環境を整える起動入口はテストの依存記録を変えない', async () => {
  await withFeedbackRepository(
    {
      'scripts/lib/unrelated.ts': 'export const unrelated = 1;\n',
      [qualityRelated]: `${header}test('plain', () => expect(1).toBe(1));\n`,
    },
    async (cwd) => {
      await writeFile(join(cwd, 'changed.txt'), 'x\n');
      const result = affected(cwd);
      expect(result.code, result.output).toBe(0);
      const recordFile = join(cwd, '.feedback-loop-records', 'test-deps.json');
      const records: unknown = JSON.parse(await readFile(recordFile, 'utf8'));
      expect(records).toEqual({ [join(cwd, qualityRelated)]: [join(cwd, qualityRelated)] });
    },
  );
});
