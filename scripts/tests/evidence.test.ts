import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateEvidence } from '../evidence.ts';
import { isRecord } from '../values.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'evidence-report-'));
  roots.push(root);
  const source = join(root, 'evidence.json');
  const value: unknown = JSON.parse(
    await readFile(
      resolve(import.meta.dir, '../../docs/evidence/harness-review-2026-09-14.json'),
      'utf8',
    ),
  );
  assert(isRecord(value) && isRecord(value.control) && isRecord(value.report));
  value.control.passed = 8;
  value.control.failed = 1;
  value.control.exit_code = 1;
  value.unverified = ['外部サービスへの接続は未確認'];
  value.report.test_cleanup = [
    { target: 'A | B', removed: '実時間待機\n短い締め切り', retained: '明示した停止理由' },
  ];
  await writeFile(source, JSON.stringify(value));
  return { source, markdown: join(root, 'evidence.md'), value };
}

test('reports failed measurements, unverified scope and decisions from the source', async () => {
  const t = await fixture();
  await generateEvidence(t.source, false);
  const markdown = await readFile(t.markdown, 'utf8');
  expect(markdown).toContain('8件成功、1件失敗、終了コード1');
  expect(markdown).toContain('- 外部サービスへの接続は未確認');
  expect(markdown).toContain('| A &#124; B | 実時間待機<br>短い締め切り | 明示した停止理由 |');
  await generateEvidence(t.source, true);
});

for (const changed of ['source', 'markdown'] as const) {
  test(`detects ${changed} drift without rewriting either file`, async () => {
    const t = await fixture();
    await generateEvidence(t.source, false);
    if (changed === 'source') {
      t.value.unverified = ['新たに判明した未確認事項'];
      await writeFile(t.source, JSON.stringify(t.value));
    } else {
      await writeFile(t.markdown, '手動で成功と書き換えた報告\n');
    }
    const before = await Promise.all([readFile(t.source, 'utf8'), readFile(t.markdown, 'utf8')]);
    await assert.rejects(() => generateEvidence(t.source, true), /Evidence Markdown is stale/);
    expect(await Promise.all([readFile(t.source, 'utf8'), readFile(t.markdown, 'utf8')])).toEqual(
      before,
    );
  });
}

test('missing result or unknown format cannot overwrite an existing report', async () => {
  const t = await fixture();
  await writeFile(t.markdown, '既存の検証記録\n');
  for (const [invalid, error] of [
    [{ ...t.value, control: null }, /Expected an evidence object/],
    [{ ...t.value, schema_version: 2 }, /Unsupported evidence schema_version/],
  ] as const) {
    await writeFile(t.source, JSON.stringify(invalid));
    await assert.rejects(() => generateEvidence(t.source, false), error);
    expect(await readFile(t.markdown, 'utf8')).toBe('既存の検証記録\n');
  }
});
