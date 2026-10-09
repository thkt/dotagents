import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import {
  authorTests,
  prepareTestBaseline,
  verifyTestArtifacts,
  type TestRecord,
} from '../../implement/test-author.ts';
import { command } from '../../shared/process.ts';
import { gitOutput, ok } from '../support/development.ts';

test('保護対象が空ならcheckoutを走査せず全記録の保存済み応答を境界ごとに照合する', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'test-artifacts-')));
  try {
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    await gitOutput(checkout, 'init', '-q');
    const records: TestRecord[] = [];
    for (const index of [1, 2]) {
      const stdout = JSON.stringify({
        targetId: `対象${index}`,
        status: 'unnecessary',
        findings: '既存検証で十分です。',
        files: [],
      });
      const prefix = join(root, `test-${index}`);
      await writeFile(`${prefix}.stdout`, stdout);
      records.push({
        prefix,
        targetId: `対象${index}`,
        stdoutHash: createHash('sha256').update(stdout).digest('hex'),
        files: {},
      });
    }
    await verifyTestArtifacts(checkout, []);
    await verifyTestArtifacts(checkout, records);
    for (const record of records) {
      const original = await readFile(`${record.prefix}.stdout`, 'utf8');
      await writeFile(`${record.prefix}.stdout`, `${original}\n`);
      await assert.rejects(verifyTestArtifacts(checkout, records), /テスト応答が変更/);
      expect(await readFile(`${record.prefix}.stdout`, 'utf8')).toBe(`${original}\n`);
      await writeFile(`${record.prefix}.stdout`, original);
      await verifyTestArtifacts(checkout, records);
    }
    // 照合対象がない場合、checkoutの存在やGitの状態には依存しません。
    await verifyTestArtifacts(join(root, 'checkoutなし'), records);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('保護対象があれば成功後も新しいcheckout観測から変更と削除を拒否する', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'test-artifacts-')));
  try {
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    await gitOutput(checkout, 'init', '-q');
    const baseline = join(root, 'baseline');
    await prepareTestBaseline(checkout, baseline);
    const source = 'process.exit(1);\n';
    const prepared = await authorTests(
      {
        cwd: checkout,
        baseline,
        prefix: join(root, 'test-1'),
        issue: '要求から定めた独立テスト成果物と保存応答を実装側で変更しない。',
        baseCommit: '修正前',
        check: ['bun', 'test'],
        actor: ['独立テスト担当'],
        previous: [],
      },
      async (argv, cwd, input, timeout, prefix) => {
        if (argv[0] === 'git') {
          return command(argv, cwd, input, timeout, prefix);
        }
        const match = input.match(/入力: (\{[^\n]+\})/);
        assert(match?.[1] && prefix);
        const context: unknown = JSON.parse(match[1]);
        assert(typeof context === 'object' && context !== null && 'targetId' in context);
        await writeFile(join(cwd, 'pending.test.js'), source);
        const response = ok(
          JSON.stringify({
            targetId: context.targetId,
            status: 'prepared',
            findings: '保存済み成果物を変更・削除した場合に拒否する条件を確認します。',
            files: ['pending.test.js'],
          }),
        );
        await writeFile(`${prefix}.stdout`, response.stdout);
        return response;
      },
    );
    expect(prepared.reply).toMatchObject({
      status: 'prepared',
      findings: '保存済み成果物を変更・削除した場合に拒否する条件を確認します。',
      files: ['pending.test.js'],
    });
    assert(prepared.record);
    const records = [prepared.record];
    const file = join(checkout, 'pending.test.js');
    await verifyTestArtifacts(checkout, records);
    await writeFile(file, 'process.exit(0);\n');
    await assert.rejects(verifyTestArtifacts(checkout, records), /実装側でテスト成果物が変更/);
    expect(await readFile(file, 'utf8')).toBe('process.exit(0);\n');
    await writeFile(file, source);
    await verifyTestArtifacts(checkout, records);
    await rm(file);
    await assert.rejects(verifyTestArtifacts(checkout, records), /実装側でテスト成果物が変更/);
    expect(await Bun.file(file).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
