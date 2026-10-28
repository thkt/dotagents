import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordFile } from '../../support/runner-affected.ts';
import {
  fixture,
  runAffected,
  readRecordFile,
  changeTarget,
  twoTests,
  header,
  git,
  sharedImporter,
} from '../../support/runner-affected.ts';
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
