import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import {
  authorTests,
  prepareTestBaseline,
  readPreparedTestRecord,
  verifyTestArtifacts,
  type TestRecord,
} from '../../../implement/test-author.ts';
import { command } from '../../../shared/process.ts';
import { gitOutput, ok } from '../../support/development.ts';

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

for (const status of ['unnecessary', 'prepared'] as const) {
  test(`削除・移動済み成果物の保護を次の独立テスト記録へ引き継ぐ: ${status}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'test-deleted-artifacts-')));
    try {
      const checkout = join(root, 'checkout');
      await mkdir(checkout);
      await gitOutput(checkout, 'init', '-q');
      const source = 'process.exit(1);\n';
      for (const path of ['removed.test.js', 'moved.test.js', 'retained.test.js']) {
        await writeFile(join(checkout, path), source);
      }
      const baseline = join(root, 'baseline');
      await prepareTestBaseline(checkout, baseline);
      const issue = '独立テストが削除・移動した成果物も次工程へ引き継ぎ、旧記録と保護を維持する。';
      const records: TestRecord[] = [];
      const originals = new Map<string, string>();
      for (const stage of ['initial', 'correction'] as const) {
        const prefix = join(root, stage);
        const prepared = await authorTests(
          {
            cwd: checkout,
            baseline,
            prefix,
            issue,
            baseCommit: '固定した修正前版',
            check: ['bun', 'test'],
            actor: ['模擬テスト担当'],
            previous: records,
            stage,
          },
          async (argv, cwd, input, timeout, output) => {
            if (argv[0] !== '模擬テスト担当') {
              return command(argv, cwd, input, timeout, output);
            }
            assert(output);
            const target: unknown = JSON.parse(await readFile(`${output}.target.json`, 'utf8'));
            assert(typeof target === 'object' && target !== null && 'targetId' in target);
            let files: string[] = [];
            if (stage === 'initial') {
              await mkdir(join(cwd, 'quality'));
              await writeFile(join(cwd, 'quality/moved.test.js'), source);
              await rm(join(cwd, 'removed.test.js'));
              await rm(join(cwd, 'moved.test.js'));
              files = ['removed.test.js', 'moved.test.js', 'quality/moved.test.js'];
            } else {
              // baselineには存在する旧パスが、次の担当の入力では削除済みであることを確認する。
              expect(await Bun.file(join(cwd, 'removed.test.js')).exists()).toBe(false);
              expect(await Bun.file(join(cwd, 'moved.test.js')).exists()).toBe(false);
              expect(await readFile(join(cwd, 'quality/moved.test.js'), 'utf8')).toBe(source);
              if (status === 'prepared') {
                await writeFile(join(cwd, 'retained.test.js'), 'process.exit(2);\n');
                files = ['retained.test.js'];
              }
            }
            const response = ok(
              JSON.stringify({
                targetId: target.targetId,
                status: stage === 'initial' ? 'prepared' : status,
                findings: '削除・移動と、後続工程への保護の引継ぎを確認する模擬担当。',
                files,
              }),
            );
            await writeFile(`${output}.stdout`, response.stdout);
            return response;
          },
        );
        assert(prepared.record);
        records.push(prepared.record);
        await verifyTestArtifacts(checkout, records);
        const saved = await readFile(`${prefix}.json`, 'utf8');
        expect(await readPreparedTestRecord(saved, issue, checkout)).toEqual(prepared.record);
        for (const suffix of ['json', 'stdout', 'target.json', 'prompt']) {
          const path = `${prefix}.${suffix}`;
          originals.set(path, await readFile(path, 'utf8'));
        }
      }
      const latest = records.at(-1);
      assert(latest);
      await verifyTestArtifacts(checkout, [latest]);
      for (const [path, original] of originals) {
        expect(await readFile(path, 'utf8')).toBe(original);
      }
      // 最新記録だけを新工程へ渡しても、旧パスの復元を許可しない。
      for (const path of ['removed.test.js', 'moved.test.js']) {
        await writeFile(join(checkout, path), source);
        await assert.rejects(verifyTestArtifacts(checkout, [latest]), /実装側でテスト成果物が変更/);
        await rm(join(checkout, path));
      }
      await verifyTestArtifacts(checkout, [latest]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('保護対象があれば成功後も新しいcheckout観測から内容・権限の変更と削除を拒否する', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'test-artifacts-')));
  try {
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    await gitOutput(checkout, 'init', '-q');
    const baseline = join(root, 'baseline');
    await prepareTestBaseline(checkout, baseline);
    const source = 'process.exit(1);\n';
    const request = {
      cwd: checkout,
      baseline,
      prefix: join(root, 'test-1'),
      issue: '要求から定めた独立テスト成果物と保存応答を実装側で変更しない。',
      baseCommit: '修正前',
      check: ['bun', 'test'],
      actor: ['独立テスト担当'],
      previous: [],
      stage: 'initial' as const,
    };
    const prepared = await authorTests(request, async (argv, cwd, input, timeout, prefix) => {
      if (argv[0] === 'git') {
        return command(argv, cwd, input, timeout, prefix);
      }
      const match = input.match(/入力: (\{[^\n]+\})/);
      assert(match?.[1] && prefix);
      const context: unknown = JSON.parse(match[1]);
      assert(typeof context === 'object' && context !== null && 'targetId' in context);
      await writeFile(join(cwd, 'pending.test.js'), source);
      await chmod(join(cwd, 'pending.test.js'), 0o755);
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
    });
    expect(prepared.reply).toMatchObject({
      status: 'prepared',
      findings: '保存済み成果物を変更・削除した場合に拒否する条件を確認します。',
      files: ['pending.test.js'],
    });
    assert(prepared.record);
    const records = [prepared.record];
    const file = join(checkout, 'pending.test.js');
    await verifyTestArtifacts(checkout, records);
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    await chmod(file, 0o644);
    await assert.rejects(verifyTestArtifacts(checkout, records), /実装側でテスト成果物が変更/);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await readFile(file, 'utf8')).toBe(source);
    await chmod(file, 0o755);
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
