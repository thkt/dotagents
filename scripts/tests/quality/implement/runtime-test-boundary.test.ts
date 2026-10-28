import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import manifest from '../../../../package.json';
import {
  authorTests,
  prepareTestBaseline,
  verifyTestArtifacts,
} from '../../../implement/test-author.ts';
import { command } from '../../../shared/process.ts';
import { gitOutput, ok } from '../../support/development.ts';

const runner = manifest.scripts['test:control'].match(/^bun (\S+\.ts)(?: |$)/)?.[1];
const mutation = manifest.scripts['mutate:diff'].match(/^bun (\S+\.ts)(?: |$)/)?.[1];
assert(runner && mutation, '設定されたテスト実行基盤の入口が必要です');

for (const runtime of [
  runner,
  join(dirname(runner), 'record-modules.ts'),
  mutation,
  join(dirname(mutation), 'execute.ts'),
]) {
  test(`独立テストが変更しなかった製品の実行基盤は実装修正できる: ${runtime}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-test-boundary-')));
    try {
      const checkout = join(root, 'checkout');
      await mkdir(join(checkout, dirname(runtime)), { recursive: true });
      await gitOutput(checkout, 'init', '-q');
      await writeFile(join(checkout, runtime), 'export const version = 1;\n');
      const baseline = join(root, 'baseline');
      await prepareTestBaseline(checkout, baseline);
      const prepared = await authorTests(
        {
          cwd: checkout,
          baseline,
          prefix: join(root, 'test-1'),
          issue:
            'Issue #463: 記録器・runner・変異実行基盤を修正し、独立テスト成果物の保護を維持する。',
          baseCommit: '修正前',
          check: ['bun', 'test'],
          actor: ['独立テスト担当'],
          previous: [],
          stage: 'initial',
        },
        async (argv, cwd, input, timeout, prefix) => {
          if (argv[0] === 'git') {
            return command(argv, cwd, input, timeout, prefix);
          }
          const match = input.match(/入力: (\{[^\n]+\})/);
          assert(match?.[1] && prefix);
          const context: unknown = JSON.parse(match[1]);
          assert(typeof context === 'object' && context !== null && 'targetId' in context);
          const response = ok(
            JSON.stringify({
              targetId: context.targetId,
              status: 'unnecessary',
              findings: '既存検証を維持し、製品コードは独立テスト担当が変更しません。',
              files: [],
            }),
          );
          await writeFile(`${prefix}.stdout`, response.stdout);
          return response;
        },
      );
      assert(prepared.record);
      await verifyTestArtifacts(checkout, [prepared.record]);
      await writeFile(join(checkout, runtime), 'export const version = 2;\n');
      await verifyTestArtifacts(checkout, [prepared.record]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('他repoのtests内コード・実テスト・fixtureと独立担当が変更した接続定義を保護する', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-test-protection-')));
  try {
    const checkout = join(root, 'checkout');
    const paths = [
      'scripts/tests/runner.ts',
      'tests/contract.ts',
      'fixtures/input.json',
      'src/contract.spec.ts',
      'checks/custom-loader.ts',
    ];
    for (const path of paths) {
      await mkdir(join(checkout, dirname(path)), { recursive: true });
      await writeFile(join(checkout, path), 'original\n');
    }
    await gitOutput(checkout, 'init', '-q');
    const baseline = join(root, 'baseline');
    await prepareTestBaseline(checkout, baseline);
    const prepared = await authorTests(
      {
        cwd: checkout,
        baseline,
        prefix: join(root, 'test-1'),
        issue: '独立テスト・fixtureと独立担当が変更した接続定義を実装側で変更しない。',
        baseCommit: '修正前',
        check: ['bun', 'test'],
        actor: ['独立テスト担当'],
        previous: [],
        stage: 'initial',
      },
      async (argv, cwd, input, timeout, prefix) => {
        if (argv[0] === 'git') {
          return command(argv, cwd, input, timeout, prefix);
        }
        const match = input.match(/入力: (\{[^\n]+\})/);
        assert(match?.[1] && prefix);
        const context: unknown = JSON.parse(match[1]);
        assert(typeof context === 'object' && context !== null && 'targetId' in context);
        await writeFile(join(cwd, 'checks/custom-loader.ts'), 'independent connection\n');
        const response = ok(
          JSON.stringify({
            targetId: context.targetId,
            status: 'prepared',
            findings: 'tests・fixtureの保護と、配置によらない独立担当の成果物保護を維持します。',
            files: ['checks/custom-loader.ts'],
          }),
        );
        await writeFile(`${prefix}.stdout`, response.stdout);
        return response;
      },
    );
    assert(prepared.record);
    expect(Object.keys(prepared.record.files).sort()).toEqual([...paths].sort());
    await verifyTestArtifacts(checkout, [prepared.record]);
    for (const path of paths) {
      await writeFile(join(checkout, path), 'implementation overwrite\n');
      await assert.rejects(
        verifyTestArtifacts(checkout, [prepared.record]),
        /実装側でテスト成果物が変更されました/,
      );
      await writeFile(
        join(checkout, path),
        path === 'checks/custom-loader.ts' ? 'independent connection\n' : 'original\n',
      );
      await verifyTestArtifacts(checkout, [prepared.record]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
